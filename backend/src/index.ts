import cors from "@fastify/cors";
import Fastify from "fastify";
import { fromUnits, handlePattern, type AgreementKind, type Intake, type Invoice, type Payee, type PayoutRequest } from "shared";
import { advise } from "./advisor.js";
import { loadApplication, readApplication, submitApplication, type SignedRequest } from "./applications.js";
import { generateDocument, readDocument, uploadDocument } from "./documents.js";
import { config } from "./config.js";
import { accountExists, openCompany, usdcBalance, view } from "./near.js";
import { checkPending, getInvoice, invoiceStatus, payTokens, quoteInvoice, recordWalletSettlement } from "./payments.js";
import { relay } from "./relayer.js";
import { createAgreement, getAgreement, listAgreements, signAgreement, voidAgreement } from "./agreements.js";
import { agentFetch, agentForKey, agentPay, agentPayments, agentSelf, createAgent, issueAgentKey, listAgents, redeemPayment, sweepAgent, updateAgent } from "./agents.js";
import { listSettlements, settle as settleX402, supported as x402Supported, verify as verifyX402, type FacilitatorRequest } from "./facilitator.js";
import { getBusiness } from "./business.js";
import { describeLinkCode, dispatchOutbox, enqueue, listLinks as listChatLinks, redeemLinkCode, unlinkFor, type Platform, type Sender } from "./chat/outbox.js";
import { telegram } from "./chat/telegram.js";
import { xmtp } from "./chat/xmtp.js";
import { checkPayouts, deletePayee, ensureCompany, listPayees, listPayouts, quotePayouts, savePayee } from "./payouts.js";
import { verifyNearAuth } from "./nearAuth.js";
import {
  companyForKey,
  createApiKey,
  createInvoiceFor,
  createLink,
  createWebhook,
  deleteWebhook,
  dispatchWebhooks,
  emit,
  listApiKeys,
  listLinks,
  listWebhooks,
  payLink,
  payUrl,
  publicLink,
  revokeApiKey,
  setLinkActive,
} from "./developer.js";

const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 });
await app.register(cors, { origin: true, methods: ["GET", "POST", "PATCH", "DELETE"] });

const openings = new Map<string, number[]>();

function allowOpening(ip: string): boolean {
  const recent = (openings.get(ip) ?? []).filter((t) => Date.now() - t < 60 * 60_000);
  if (recent.length >= 3) return false;
  openings.set(ip, [...recent, Date.now()]);
  return true;
}

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

app.setErrorHandler((error: Error & { statusCode?: number; details?: unknown }, _request, reply) => {
  const status = error.statusCode ?? 500;
  if (status >= 500) app.log.error(error);
  reply.status(status).send({ error: error.message, ...(error.details ? { details: error.details } : {}) });
});

app.get("/api/health", async () => ({ ok: true, contract: config.contract, parent: config.parent }));

app.post<{ Body: { country: string; plan: string; company: string } }>("/api/advisor", async (request) => {
  const { country, plan, company } = request.body ?? ({} as never);
  if (!country || !plan) fail(400, "country and plan are required");
  return advise({ country, plan, company: company ?? "" });
});

app.post<{
  Body: { handle: string; legalName: string; country: string; publicKey: string };
}>("/api/companies", async (request) => {
  const { handle, legalName, country, publicKey } = request.body ?? ({} as never);
  if (!handlePattern.test(handle ?? "")) fail(400, "Handle: lowercase letters, numbers and dashes, 1-32 characters.");
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(publicKey ?? "")) fail(400, "Invalid passkey public key.");
  if (!legalName?.trim() || !country?.trim()) fail(400, "Business name and country are required.");
  if (await accountExists(`${handle}.${config.parent}`)) fail(409, `${handle}.${config.parent} is taken. Pick another handle.`);
  if (!allowOpening(request.ip)) fail(429, "Too many companies opened from this network. Try again in an hour.");
  return openCompany({ handle, publicKey, legalName: legalName.trim(), country: country.trim() });
});

app.get<{ Params: { account: string } }>("/api/companies/:account", async (request) => {
  const company = await getBusiness(request.params.account);
  if (!company) fail(404, "No company is registered for this account.");
  return company;
});

app.get<{ Params: { account: string } }>("/api/companies/:account/balance", async (request) => ({
  usdc: await usdcBalance(request.params.account),
}));

app.get<{ Params: { account: string } }>("/api/companies/:account/invoices", async (request) =>
  view<Invoice[]>("list_invoices", { account_id: request.params.account, from: 0, limit: 100 }),
);

app.post<{ Body: { signedDelegate: string } }>("/api/relay", async (request) => {
  if (!request.body?.signedDelegate) fail(400, "signedDelegate is required");
  const { txHash } = await relay(request.body.signedDelegate);
  return { txHash };
});

app.get<{ Params: { id: string } }>("/api/invoices/:id", async (request) => {
  const invoice = await getInvoice(request.params.id);
  const company = await getBusiness(invoice.company);
  return { ...invoice, legal_name: company?.legal_name ?? invoice.company, jurisdiction: company?.jurisdiction ?? null };
});

app.get("/api/tokens", async () => payTokens());

app.get<{ Querystring: { account: string; as_party?: string } }>("/api/agreements", async (request) => {
  if (!request.query.account) fail(400, "account is required");
  const account = await verifyNearAuth(request.headers["x-near-auth"] as string | undefined, "list-agreements", request.query.account);
  return listAgreements(account, request.query.as_party === "1");
});

app.post<{ Body: { kind: AgreementKind; title: string; doc_hash: string; parties: string[]; invoice_id?: string | null } }>("/api/agreements", async (request) =>
  createAgreement(await business(request, "create-agreement"), request.body ?? ({} as never)),
);
app.post<{ Params: { id: string } }>("/api/agreements/:id/sign", async (request) => signAgreement(request.params.id, request.headers["x-near-auth"] as string | undefined));
app.post<{ Params: { id: string } }>("/api/agreements/:id/void", async (request) => voidAgreement(await business(request, "void-agreement"), request.params.id));

app.get<{ Params: { id: string } }>("/api/agreements/:id", async (request) => {
  const agreement = await getAgreement(request.params.id);
  if (!agreement) fail(404, "Agreement not found.");
  return agreement;
});

app.post<{ Body: { title: string; mime: string; content_base64: string } }>("/api/documents", async (request) =>
  uploadDocument(request.headers["x-near-auth"] as string | undefined, request.body ?? ({} as never)),
);

app.post<{ Body: { kind: AgreementKind; parties: string[]; invoice_id?: string; terms?: string } }>("/api/documents/generate", async (request) =>
  generateDocument(request.headers["x-near-auth"] as string | undefined, request.body ?? ({} as never), loadApplication),
);

app.get<{ Params: { hash: string }; Querystring: { agreement: string } }>("/api/documents/:hash", async (request) =>
  readDocument(request.headers["x-near-auth"] as string | undefined, request.params.hash, request.query.agreement ?? ""),
);

async function business(request: { headers: Record<string, unknown> }, action: string): Promise<string> {
  const account = await verifyNearAuth(request.headers["x-near-auth"] as string | undefined, action, "business");
  await ensureCompany(account);
  return account;
}

app.post<{ Body: { items: PayoutRequest[]; label?: string } }>("/api/payouts/quote", async (request) =>
  quotePayouts(await business(request, "quote-payouts"), request.body?.items ?? [], request.body?.label?.trim() || null),
);

app.get("/api/payouts", async (request) => listPayouts(await business(request, "list-payouts")));

app.get("/api/payees", async (request) => listPayees(await business(request, "list-payees")));

app.post<{ Body: Omit<Payee, "id"> }>("/api/payees", async (request) => savePayee(await business(request, "save-payee"), request.body ?? ({} as never)));

app.delete<{ Params: { id: string } }>("/api/payees/:id", async (request) => {
  await deletePayee(await business(request, "delete-payee"), request.params.id);
  return { ok: true };
});

app.post<{ Body: { title: string; description?: string; amount?: string | null } }>("/api/links", async (request) =>
  createLink(await business(request, "create-link"), request.body ?? ({} as never)),
);
app.get("/api/links", async (request) => listLinks(await business(request, "list-links")));
app.patch<{ Params: { id: string }; Body: { active: boolean } }>("/api/links/:id", async (request) =>
  setLinkActive(await business(request, "update-link"), request.params.id, Boolean(request.body?.active)),
);
app.get<{ Params: { id: string } }>("/api/public/links/:id", async (request) => {
  const link = await publicLink(request.params.id);
  const company = await getBusiness(link.company);
  return { ...link, legal_name: company?.legal_name ?? link.company };
});
const linkPayments = new Map<string, number[]>();
app.post<{ Params: { id: string }; Body: { payer_name?: string; amount?: string } }>("/api/public/links/:id/pay", async (request) => {
  const recent = (linkPayments.get(request.ip) ?? []).filter((t) => Date.now() - t < 3_600_000);
  if (recent.length >= 20) fail(429, "Too many payments started from this network. Try again later.");
  linkPayments.set(request.ip, [...recent, Date.now()]);
  return payLink(request.params.id, request.body ?? {});
});

app.post<{ Body: { name: string } }>("/api/developer/keys", async (request) => createApiKey(await business(request, "create-key"), request.body?.name ?? ""));
app.get("/api/developer/keys", async (request) => listApiKeys(await business(request, "list-keys")));
app.delete<{ Params: { id: string } }>("/api/developer/keys/:id", async (request) => {
  await revokeApiKey(await business(request, "revoke-key"), request.params.id);
  return { ok: true };
});
app.post<{ Body: { url: string } }>("/api/developer/webhooks", async (request) => createWebhook(await business(request, "create-webhook"), request.body?.url ?? ""));
app.get("/api/developer/webhooks", async (request) => listWebhooks(await business(request, "list-webhooks")));
app.delete<{ Params: { id: string } }>("/api/developer/webhooks/:id", async (request) => {
  await deleteWebhook(await business(request, "delete-webhook"), request.params.id);
  return { ok: true };
});
app.post("/api/developer/webhooks/test", async (request) => {
  const company = await business(request, "test-webhook");
  await emit(company, "test.ping", { message: "Hello from opencash", company });
  return { ok: true };
});

type ApiItem = { description: string; amount: string };
function apiInvoice(invoice: Invoice) {
  return { ...invoice, amount_usd: fromUnits(invoice.amount), pay_url: payUrl(invoice.id) };
}

app.post<{ Body: { client_name: string; due_date?: string; items: ApiItem[]; reference?: string } }>("/v1/invoices", async (request) => {
  const company = await companyForKey(request.headers.authorization);
  const body = request.body ?? ({} as never);
  if (!body.client_name?.trim() || !Array.isArray(body.items) || body.items.length === 0) fail(400, "client_name and items[] are required.");
  const due = body.due_date ? Date.parse(body.due_date) : Date.now() + 14 * 86_400_000;
  if (!Number.isFinite(due)) fail(400, "due_date must be an ISO date, e.g. 2026-12-01.");
  return apiInvoice(await createInvoiceFor(company, { client_name: body.client_name, due_ms: due, items: body.items, source: "api", reference: body.reference ?? null }));
});

app.post<{ Body: { amount: string; description: string; customer_name?: string; reference?: string } }>("/v1/checkouts", async (request) => {
  const company = await companyForKey(request.headers.authorization);
  const body = request.body ?? ({} as never);
  if (!/^\d+(\.\d{1,2})?$/.test(body.amount ?? "") || !body.description?.trim()) fail(400, "amount (e.g. \"49.00\") and description are required.");
  return apiInvoice(
    await createInvoiceFor(company, {
      client_name: body.customer_name?.trim() || "Checkout customer",
      due_ms: Date.now() + 86_400_000,
      items: [{ description: body.description, amount: body.amount }],
      source: "api",
      reference: body.reference ?? null,
    }),
  );
});

app.get<{ Params: { id: string } }>("/v1/invoices/:id", async (request) => {
  const company = await companyForKey(request.headers.authorization);
  const invoice = await view<Invoice | null>("get_invoice", { id: request.params.id });
  if (!invoice || invoice.company !== company) fail(404, "Invoice not found.");
  return apiInvoice(invoice);
});

app.get<{ Querystring: { status?: string } }>("/v1/invoices", async (request) => {
  const company = await companyForKey(request.headers.authorization);
  const list = await view<Invoice[]>("list_invoices", { account_id: company, from: 0, limit: 100 });
  return list.filter((i) => !request.query.status || i.status === request.query.status).map(apiInvoice);
});

const chatInfo: { telegram: string | null; xmtp: string | null } = { telegram: null, xmtp: null };

app.get("/api/chat/info", async () => chatInfo);

app.get<{ Params: { code: string } }>("/api/chat/code/:code", async (request) => describeLinkCode(request.params.code));

app.get("/api/chat/links", async (request) => listChatLinks(await business(request, "list-chats")));

app.delete<{ Params: { platform: Platform; id: string } }>("/api/chat/links/:platform/:id", async (request) => {
  await unlinkFor(await business(request, "unlink-chat"), request.params.platform, request.params.id);
  return { ok: true };
});

app.post<{ Body: { code: string } }>("/api/chat/link", async (request) => {
  const code = request.body?.code ?? "";
  const account = await verifyNearAuth(request.headers["x-near-auth"] as string | undefined, "link-chat", code);
  await ensureCompany(account);
  const linked = await redeemLinkCode(code, account);
  await enqueue(linked.platform, linked.chatUserId, `Connected to ${account}. Send "help" to see what I can do.`);
  return { account, platform: linked.platform };
});

app.post<{ Body: { name: string; per_tx_cap: string; daily_cap: string; allowlist?: string[] } }>("/api/agents", async (request) =>
  createAgent(await business(request, "create-agent"), request.body ?? ({} as never)),
);
app.get("/api/agents", async (request) => listAgents(await business(request, "list-agents")));
app.patch<{ Params: { id: string }; Body: { per_tx_cap?: string; daily_cap?: string; allowlist?: string[]; frozen?: boolean } }>("/api/agents/:id", async (request) =>
  updateAgent(await business(request, "update-agent"), request.params.id, request.body ?? {}),
);
app.post<{ Params: { id: string } }>("/api/agents/:id/key", async (request) => issueAgentKey(await business(request, "agent-key"), request.params.id));
app.post<{ Params: { id: string } }>("/api/agents/:id/sweep", async (request) => sweepAgent(await business(request, "sweep-agent"), request.params.id));
app.get<{ Params: { id: string } }>("/api/agents/:id/payments", async (request) => agentPayments(await business(request, "agent-payments"), request.params.id));

app.get("/v1/agent", async (request) => agentSelf(await agentForKey(request.headers.authorization)));
app.post<{ Body: { to: string; amount: string; memo?: string } }>("/v1/agent/pay", async (request) =>
  agentPay(await agentForKey(request.headers.authorization), request.body ?? ({} as never)),
);
app.post<{ Body: { url: string; method?: string; headers?: Record<string, string>; body?: string } }>("/v1/agent/fetch", async (request) =>
  agentFetch(await agentForKey(request.headers.authorization), request.body ?? ({} as never)),
);

app.post<{ Params: { id: string }; Body: { headers?: Record<string, string> } }>("/v1/agent/payments/:id/redeem", async (request) =>
  redeemPayment(await agentForKey(request.headers.authorization), request.params.id, request.body ?? {}),
);

app.get("/x402/facilitator/supported", async () => x402Supported());
app.post<{ Body: FacilitatorRequest }>("/x402/facilitator/verify", async (request) => verifyX402(await companyForKey(request.headers.authorization), request.body));
app.post<{ Body: FacilitatorRequest }>("/x402/facilitator/settle", async (request) => settleX402(await companyForKey(request.headers.authorization), request.body));
app.get("/api/x402/settlements", async (request) => listSettlements(await business(request, "x402-settlements")));

app.post<{ Body: SignedRequest & { intake: Intake } }>("/api/applications", async (request) => {
  const body = request.body ?? ({} as never);
  if (!body.account_id || !body.public_key || !body.signature || !body.intake) fail(400, "account_id, public_key, signed_at, signature and intake are required");
  return submitApplication(body);
});

app.get<{ Params: { account: string }; Querystring: { public_key: string; signed_at: string; signature: string } }>(
  "/api/applications/:account",
  async (request) => {
    const { public_key, signed_at, signature } = request.query;
    if (!public_key || !signed_at || !signature) fail(400, "public_key, signed_at and signature are required");
    return readApplication({ account_id: request.params.account, public_key, signed_at: Number(signed_at), signature });
  },
);

app.post<{ Params: { id: string }; Body: { originAsset: string; refundTo: string } }>("/api/invoices/:id/quote", async (request) => {
  const { originAsset, refundTo } = request.body ?? ({} as never);
  if (!originAsset || !refundTo) fail(400, "originAsset and refundTo are required");
  return quoteInvoice(request.params.id, originAsset, refundTo);
});

app.post<{ Params: { id: string }; Body: { tx_hash: string; payer: string } }>("/api/invoices/:id/settled", async (request) => {
  const { tx_hash, payer } = request.body ?? ({} as never);
  if (!tx_hash || !payer) fail(400, "tx_hash and payer are required");
  return recordWalletSettlement(request.params.id, tx_hash, payer);
});

app.get<{ Params: { id: string } }>("/api/invoices/:id/status", async (request) => invoiceStatus(request.params.id));

await app.listen({ port: config.port, host: "0.0.0.0" });

if (process.env.OPERATOR_PRIVATE_KEY) {
  setInterval(() => {
    checkPending((message) => app.log.info(message)).catch((error) => app.log.warn(`pending check skipped: ${String(error)}`));
    checkPayouts(async (payout) => {
      app.log.info(`payout ${payout.id} is now ${payout.status}`);
      await emit(payout.company, `payout.${payout.status}`, payout);
    }).catch((error) => app.log.warn(`payout check skipped: ${String(error)}`));
  }, config.watchMs);
} else {
  app.log.warn("OPERATOR_PRIVATE_KEY not set: background payment watcher is off");
}

if (process.env.DATABASE_URL) {
  setInterval(() => {
    dispatchWebhooks().catch((error) => app.log.warn(`webhook dispatch skipped: ${String(error)}`));
  }, 10_000);

  const senders: Partial<Record<Platform, Sender>> = {};
  const log = (message: string) => app.log.info(message);
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const bot = telegram(process.env.TELEGRAM_BOT_TOKEN, log);
    const me = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`).then((r) => r.json() as Promise<{ ok: boolean; result?: { username: string } }>).catch(() => null);
    chatInfo.telegram = me?.ok ? (me.result?.username ?? null) : null;
    bot.start();
    senders.telegram = bot.send;
    app.log.info(`telegram bot online as @${chatInfo.telegram ?? "unknown"}`);
  }
  if (process.env.XMTP_WALLET_KEY) {
    try {
      const agent = await xmtp(log);
      chatInfo.xmtp = agent.address ?? null;
      senders.xmtp = agent.send;
    } catch (error) {
      app.log.warn(`xmtp agent not started: ${String(error)}`);
    }
  }
  setInterval(() => {
    dispatchOutbox(senders).catch((error) => app.log.warn(`chat outbox skipped: ${String(error)}`));
  }, 5_000);
}
