import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { createNearPaymentFetch } from "@fastnear/x402";
import { createLocalNearSigner } from "@fastnear/x402/node";
import { Account, KeyPair, actions, teraToGas, type KeyPairString } from "near-api-js";
import { fromUnits, toUnits } from "shared";
import { config } from "./config.js";
import { db } from "./db.js";
import { emit } from "./developer.js";
import { depositHeader, hasExactNear, intentsEntry, isUsdc, paymentRequired, quoteHeader, quotedEntry, receiptOf, type Entry, type PaymentRequired, type Receipt } from "./intents402.js";
import { operator, provider, usdcBalance } from "./near.js";
import { registerForUsdc } from "./payouts.js";
import { open, seal } from "./vault.js";

export type AgentRow = {
  id: string;
  company: string;
  name: string;
  account_id: string;
  public_key: string;
  api_key_prefix: string | null;
  per_tx_cap_units: string;
  daily_cap_units: string;
  allowlist: string[];
  status: "creating" | "active" | "frozen";
  created_at: Date;
};

const publicColumns = "id, company, name, account_id, public_key, api_key_prefix, per_tx_cap_units::text, daily_cap_units::text, allowlist, status, created_at";
const accountPattern = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$|^[0-9a-f]{64}$/;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function money(value: string, field: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(value?.trim() ?? "")) fail(400, `${field} must look like 5.00`);
  const units = toUnits(value.trim());
  if (BigInt(units) <= 0n) fail(400, `${field} must be above zero.`);
  return units;
}

function present(agent: AgentRow, spent24h = "0", balance?: string) {
  return {
    id: agent.id,
    name: agent.name,
    account_id: agent.account_id,
    status: agent.status,
    per_tx_cap: fromUnits(agent.per_tx_cap_units),
    daily_cap: fromUnits(agent.daily_cap_units),
    spent_24h: fromUnits(spent24h),
    allowlist: agent.allowlist,
    api_key_prefix: agent.api_key_prefix,
    balance: balance === undefined ? null : fromUnits(balance),
    created_at: agent.created_at.toISOString(),
  };
}

async function spent24h(agentId: string): Promise<string> {
  const { rows } = await db().query<{ total: string }>(
    "select coalesce(sum(amount_units), 0)::text as total from agent_payments where agent_id = $1 and kind <> 'sweep' and status in ('reserved', 'sent') and created_at > now() - interval '24 hours'",
    [agentId],
  );
  return rows[0].total;
}

async function agentFor(company: string, id: string): Promise<AgentRow> {
  const { rows } = await db().query<AgentRow>(`select ${publicColumns} from agents where company = $1 and id = $2`, [company, id]);
  if (!rows[0]) fail(404, "Agent not found.");
  return rows[0];
}

export async function createAgent(company: string, body: { name: string; per_tx_cap: string; daily_cap: string; allowlist?: string[] }) {
  const name = body.name?.trim() ?? "";
  if (!name) fail(400, "Name the agent, e.g. Research bot.");
  const perTx = money(body.per_tx_cap, "Per-payment cap");
  const daily = money(body.daily_cap, "24-hour cap");
  if (BigInt(daily) < BigInt(perTx)) fail(400, "The 24-hour cap must be at least the per-payment cap.");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "agent";
  const accountId = `agent-${slug}-${randomBytes(2).toString("hex")}.${company}`;
  if (accountId.length > 64) fail(400, "Your account name is too long to create agent sub-accounts under it.");
  const key = KeyPair.fromRandom("ed25519");
  const sealed = seal(key.toString(), `agent:${accountId}`);
  const allowlist = [...new Set((body.allowlist ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))].slice(0, 50);
  const { rows } = await db().query<AgentRow>(
    `insert into agents (company, name, account_id, public_key, key_cipher, key_iv, key_tag, per_tx_cap_units, daily_cap_units, allowlist)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${publicColumns}`,
    [company, name.slice(0, 60), accountId, key.getPublicKey().toString(), sealed.ciphertext, sealed.iv, sealed.authTag, perTx, daily, allowlist],
  );
  return { agent: present(rows[0]), public_key: rows[0].public_key };
}

export async function pendingAgent(company: string, accountId: string): Promise<AgentRow | null> {
  const { rows } = await db().query<AgentRow>(`select ${publicColumns} from agents where company = $1 and account_id = $2 and status = 'creating'`, [company, accountId]);
  return rows[0] ?? null;
}

export async function activateAgent(accountId: string) {
  await registerForUsdc(accountId);
  await db().query("update agents set status = 'active' where account_id = $1 and status = 'creating'", [accountId]);
}

export async function listAgents(company: string) {
  const { rows } = await db().query<AgentRow>(`select ${publicColumns} from agents where company = $1 order by created_at desc`, [company]);
  return Promise.all(rows.map(async (a) => present(a, await spent24h(a.id), a.status === "creating" ? "0" : await usdcBalance(a.account_id).catch(() => "0"))));
}

export async function updateAgent(company: string, id: string, body: { per_tx_cap?: string; daily_cap?: string; allowlist?: string[]; frozen?: boolean }) {
  const agent = await agentFor(company, id);
  if (agent.status === "creating") fail(409, "Finish creating the agent first.");
  const perTx = body.per_tx_cap !== undefined ? money(body.per_tx_cap, "Per-payment cap") : agent.per_tx_cap_units;
  const daily = body.daily_cap !== undefined ? money(body.daily_cap, "24-hour cap") : agent.daily_cap_units;
  if (BigInt(daily) < BigInt(perTx)) fail(400, "The 24-hour cap must be at least the per-payment cap.");
  const allowlist = body.allowlist ? [...new Set(body.allowlist.map((a) => a.trim().toLowerCase()).filter(Boolean))].slice(0, 50) : agent.allowlist;
  const status = body.frozen === undefined ? agent.status : body.frozen ? "frozen" : "active";
  const { rows } = await db().query<AgentRow>(
    `update agents set per_tx_cap_units = $3, daily_cap_units = $4, allowlist = $5, status = $6 where company = $1 and id = $2 returning ${publicColumns}`,
    [company, id, perTx, daily, allowlist, status],
  );
  return present(rows[0], await spent24h(id));
}

export async function issueAgentKey(company: string, id: string) {
  await agentFor(company, id);
  const key = `oc_agent_${randomBytes(24).toString("base64url")}`;
  await db().query("update agents set api_key_hash = $3, api_key_prefix = $4 where company = $1 and id = $2", [company, id, sha256(key), key.slice(0, 14)]);
  return { key };
}

export async function agentForKey(authorization: string | undefined): Promise<AgentRow> {
  const key = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!key?.startsWith("oc_agent_")) fail(401, "Send the agent key as: Authorization: Bearer oc_agent_…");
  const { rows } = await db().query<AgentRow>(`select ${publicColumns} from agents where api_key_hash = $1`, [sha256(key)]);
  if (!rows[0]) fail(401, "Unknown agent key.");
  return rows[0];
}

export async function agentSelf(agent: AgentRow) {
  return present(agent, await spent24h(agent.id), await usdcBalance(agent.account_id).catch(() => "0"));
}

export async function agentPayments(company: string, id: string) {
  await agentFor(company, id);
  const { rows } = await db().query(
    "select id, kind, recipient, amount_units::text, resource, status, tx_hash, error, created_at from agent_payments where agent_id = $1 order by created_at desc limit 100",
    [id],
  );
  return rows.map((r) => ({ ...r, amount: fromUnits(r.amount_units), created_at: (r.created_at as Date).toISOString() }));
}

function allowed(agent: AgentRow, recipient: string, host: string | null): boolean {
  if (agent.allowlist.length === 0) return true;
  return agent.allowlist.includes(recipient.toLowerCase()) || (host !== null && agent.allowlist.includes(host.toLowerCase()));
}

export async function reserve(agentId: string, kind: "transfer" | "x402", recipient: string, units: string, resource: string | null, host: string | null): Promise<string> {
  const client = await db().connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<AgentRow>(`select ${publicColumns} from agents where id = $1 for update`, [agentId]);
    const agent = rows[0];
    if (!agent || agent.status !== "active") fail(403, "This agent is frozen or not active.");
    if (BigInt(units) > BigInt(agent.per_tx_cap_units)) fail(403, `Payment of ${fromUnits(units)} USDC is above the per-payment cap of ${fromUnits(agent.per_tx_cap_units)} USDC.`);
    if (!allowed(agent, recipient, host)) fail(403, `${host ?? recipient} is not on this agent's allowlist.`);
    const { rows: spent } = await client.query<{ total: string }>(
      "select coalesce(sum(amount_units), 0)::text as total from agent_payments where agent_id = $1 and kind <> 'sweep' and status in ('reserved', 'sent') and created_at > now() - interval '24 hours'",
      [agentId],
    );
    if (BigInt(spent[0].total) + BigInt(units) > BigInt(agent.daily_cap_units)) {
      fail(403, `This would exceed the 24-hour cap of ${fromUnits(agent.daily_cap_units)} USDC (already spent ${fromUnits(spent[0].total)}).`);
    }
    const { rows: inserted } = await client.query<{ id: string }>(
      "insert into agent_payments (agent_id, kind, recipient, amount_units, resource) values ($1, $2, $3, $4, $5) returning id",
      [agentId, kind, recipient, units, resource],
    );
    await client.query("commit");
    return inserted[0].id;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function settle(paymentId: string, ok: boolean, txHash: string | null, error: string | null) {
  await db().query("update agent_payments set status = $2, tx_hash = $3, error = $4 where id = $1", [paymentId, ok ? "sent" : "failed", txHash, error?.slice(0, 300) ?? null]);
}

async function agentSecret(accountId: string): Promise<KeyPairString> {
  const { rows } = await db().query<{ key_cipher: Buffer; key_iv: Buffer; key_tag: Buffer }>("select key_cipher, key_iv, key_tag from agents where account_id = $1", [accountId]);
  return open({ ciphertext: rows[0].key_cipher, iv: rows[0].key_iv, authTag: rows[0].key_tag, keyVersion: 1 }, `agent:${accountId}`) as KeyPairString;
}

async function relayedUsdcTransfer(fromAccount: string, to: string, units: string, memo: string): Promise<string> {
  await registerForUsdc(to);
  const agentAccount = new Account(fromAccount, provider, await agentSecret(fromAccount));
  const { signedDelegate } = await agentAccount.createSignedMetaTransaction({
    receiverId: config.usdc,
    actions: [actions.functionCall("ft_transfer", { receiver_id: to, amount: units, memo }, teraToGas(15), 1n)],
    blockHeightTtl: 120,
  });
  const outcome = await operator().relayMetaTransaction(signedDelegate);
  return outcome.transaction.hash;
}

export async function agentPay(agent: AgentRow, body: { to: string; amount: string; memo?: string }) {
  const to = body.to?.trim().toLowerCase() ?? "";
  if (!accountPattern.test(to)) fail(400, "`to` must be a NEAR account, e.g. data-provider.near.");
  const units = money(body.amount, "amount");
  const paymentId = await reserve(agent.id, "transfer", to, units, null, null);
  try {
    const txHash = await relayedUsdcTransfer(agent.account_id, to, units, (body.memo ?? `opencash agent ${agent.name}`).slice(0, 120));
    await settle(paymentId, true, txHash, null);
    await emit(agent.company, "agent.payment", { agent: agent.name, account: agent.account_id, to, amount: fromUnits(units), tx_hash: txHash }).catch(() => undefined);
    return { payment_id: paymentId, tx_hash: txHash, amount: fromUnits(units), to };
  } catch (error) {
    await settle(paymentId, false, null, String(error));
    throw error;
  }
}

const privateRanges = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::$/, /^::ffff:(10|127|192\.168|169\.254)\./i];

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(400, "url must be a full https:// URL.");
  }
  if (url.protocol !== "https:") fail(400, "Only https:// URLs can be fetched.");
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => fail(400, `Can't resolve ${url.hostname}.`));
  if (addresses.some((a) => privateRanges.some((r) => r.test(a.address)))) fail(400, "That URL points to a private or internal address.");
  return url;
}

type FetchInput = { url: string; method?: string; headers?: Record<string, string>; body?: string };
type Operation = { url: string; method: string; body: string | null; resource: PaymentRequired["resource"]; unquoted: Entry; quoted: Entry };

const settlementPolls = 12;
const pollMs = 5_000;

async function send(url: string, input: Omit<FetchInput, "url">, payment?: string): Promise<Response> {
  return fetch(url, {
    method: input.method ?? "GET",
    headers: { ...(input.headers ?? {}), ...(payment ? { "PAYMENT-SIGNATURE": payment } : {}) },
    body: input.body,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
}

async function result(response: Response, extra: { paid: boolean; tx_hash: string | null; payment_id?: string | null; pending?: boolean }) {
  const text = await response.text();
  return { status: response.status, ...extra, content_type: response.headers.get("content-type"), body: text.slice(0, 1_000_000) };
}

type Transfer = typeof relayedUsdcTransfer;

export async function agentFetch(agent: AgentRow, input: FetchInput, transfer: Transfer = relayedUsdcTransfer) {
  const url = await assertPublicUrl(input.url);
  const first = await send(url.toString(), input);
  if (first.status !== 402) return result(first, { paid: false, tx_hash: null });
  const required = await paymentRequired(first);
  const unquoted = required && intentsEntry(required, config.usdc);
  if (required && unquoted) return payIntents(agent, url, input, required, unquoted, transfer);
  if (required && !hasExactNear(required)) fail(402, "This paywall accepts no payment method an opencash agent can use (USDC on NEAR, direct or via NEAR Intents).");
  return payExactNear(agent, url, input);
}

async function payExactNear(agent: AgentRow, url: URL, input: FetchInput) {
  let paymentId: string | null = null;
  const inner = createLocalNearSigner({ accountId: agent.account_id, secretKey: (await agentSecret(agent.account_id)) as `ed25519:${string}` });
  const signer = {
    async createSignedDelegateAction(request: { x402Version: number; paymentRequirements: { network: string; asset: string; amount: string; payTo: string } }) {
      const req = request.paymentRequirements;
      if (req.network !== "near:mainnet" || !isUsdc(req.asset, config.usdc)) fail(402, `This paywall asks for ${req.asset} on ${req.network}; agents pay in USDC on NEAR mainnet only.`);
      paymentId = await reserve(agent.id, "x402", req.payTo, req.amount, url.toString(), url.hostname);
      await registerForUsdc(req.payTo).catch(() => undefined);
      return inner.createSignedDelegateAction(request as never);
    },
  };
  const paidFetch = createNearPaymentFetch({ signer, network: "near:mainnet" });
  let response: Response;
  try {
    response = await paidFetch(url.toString(), { method: input.method ?? "GET", headers: input.headers, body: input.body, redirect: "manual", signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    if (paymentId) await settle(paymentId, false, null, String(error));
    throw error;
  }
  const receipt = receiptOf(response);
  const txHash = receipt?.transaction ?? null;
  if (paymentId) {
    await settle(paymentId, Boolean(receipt?.success), txHash, receipt?.success ? null : `HTTP ${response.status} without a successful payment receipt`);
    if (receipt?.success) await emit(agent.company, "agent.payment", { agent: agent.name, account: agent.account_id, resource: url.toString(), tx_hash: txHash }).catch(() => undefined);
  }
  return result(response, { paid: Boolean(receipt?.success), tx_hash: txHash, payment_id: paymentId });
}

async function refusalReason(response: Response, required: PaymentRequired | null): Promise<string> {
  if (required?.error) return `: ${required.error}`;
  try {
    const body = (await response.clone().json()) as { invalidReason?: string; errorReason?: string; error?: string; invalidMessage?: string };
    const reason = body.invalidMessage ?? body.invalidReason ?? body.errorReason ?? body.error;
    return reason ? `: ${String(reason).slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

async function payIntents(agent: AgentRow, url: URL, input: FetchInput, required: PaymentRequired, unquoted: Entry, transfer: Transfer) {
  const { rows: open } = await db().query<{ id: string }>(
    "select id from agent_payments where agent_id = $1 and kind = 'x402' and status = 'sent' and operation is not null and receipt is null and resource = $2 and created_at > now() - interval '1 day' limit 1",
    [agent.id, url.toString()],
  );
  if (open[0]) fail(409, `Payment ${open[0].id} for this URL is still settling. Redeem it with POST /v1/agent/payments/${open[0].id}/redeem instead of paying again.`);
  const resource = required.resource ?? { url: url.toString() };
  const quoteResponse = await send(url.toString(), input, quoteHeader({ ...required, resource }, unquoted, agent.account_id));
  const second = quoteResponse.status === 402 ? await paymentRequired(quoteResponse) : null;
  const quoted = second && quotedEntry(second, unquoted);
  if (!quoted) fail(502, `The paywall did not return a NEAR Intents quote (HTTP ${quoteResponse.status}${await refusalReason(quoteResponse, second)}).`);
  const deadline = Date.parse(quoted.extra?.refundDeadline ?? "");
  if (Number.isFinite(deadline) && deadline - Date.now() < 30_000) fail(502, "The quote's deposit window is already closing. Try again.");
  const paymentId = await reserve(agent.id, "x402", quoted.payTo, quoted.amount, url.toString(), url.hostname);
  const operation: Operation = { url: url.toString(), method: input.method ?? "GET", body: input.body ?? null, resource, unquoted, quoted };
  await db().query("update agent_payments set operation = $2 where id = $1", [paymentId, JSON.stringify(operation)]);
  try {
    const txHash = await transfer(agent.account_id, quoted.payTo, quoted.amount, "opencash x402");
    await settle(paymentId, true, txHash, null);
  } catch (error) {
    await settle(paymentId, false, null, String(error));
    throw error;
  }
  return redeemPayment(agent, paymentId, { headers: input.headers });
}

export async function redeemPayment(agent: AgentRow, paymentId: string, input: { headers?: Record<string, string> }) {
  const { rows } = await db().query<{ operation: Operation | null; tx_hash: string | null; status: string; receipt: Receipt | null }>(
    "select operation, tx_hash, status, receipt from agent_payments where id = $1 and agent_id = $2",
    [paymentId, agent.id],
  );
  const row = rows[0];
  if (!row?.operation) fail(404, "No NEAR Intents payment with that id for this agent.");
  if (row.status !== "sent" || !row.tx_hash) fail(409, `This payment is ${row.status}; there is nothing to redeem.`);
  if (row.receipt?.success) fail(409, "This payment has already settled.");
  const op = row.operation;
  const url = await assertPublicUrl(op.url);
  const header = depositHeader(op.resource, op.unquoted, op.quoted, row.tx_hash);
  for (let attempt = 0; attempt < settlementPolls; attempt += 1) {
    const response = await send(url.toString(), { method: op.method, headers: input.headers, body: op.body ?? undefined }, header);
    const receipt = receiptOf(response);
    const pending = receipt?.errorReason === "settlement_pending" || response.status === 503 || response.status === 504;
    if (receipt && !pending) {
      const refunded = !receipt.success && ["REFUNDED", "FAILED"].includes(receipt.extra?.status ?? "");
      await db().query("update agent_payments set receipt = $2, status = $3, error = $4 where id = $1", [
        paymentId,
        JSON.stringify(receipt),
        refunded ? "refunded" : "sent",
        receipt.success ? null : (receipt.errorReason ?? "settlement failed").slice(0, 300),
      ]);
      if (receipt.success) await emit(agent.company, "agent.payment", { agent: agent.name, account: agent.account_id, resource: op.url, tx_hash: row.tx_hash, settlement: receipt.transaction }).catch(() => undefined);
      return result(response, { paid: receipt.success, tx_hash: row.tx_hash, payment_id: paymentId });
    }
    if (!pending) return result(response, { paid: false, tx_hash: row.tx_hash, payment_id: paymentId, pending: true });
    await response.body?.cancel();
    await sleep(pollMs);
  }
  return { status: 202, paid: false, pending: true, tx_hash: row.tx_hash, payment_id: paymentId, content_type: null, body: "" };
}

export async function sweepAgent(company: string, id: string) {
  const agent = await agentFor(company, id);
  if (agent.status === "creating") fail(409, "This agent has no account yet.");
  const balance = await usdcBalance(agent.account_id);
  if (BigInt(balance) === 0n) fail(400, "This agent's balance is already zero.");
  const { rows } = await db().query<{ id: string }>(
    "insert into agent_payments (agent_id, kind, recipient, amount_units) values ($1, 'sweep', $2, $3) returning id",
    [agent.id, company, balance],
  );
  try {
    const txHash = await relayedUsdcTransfer(agent.account_id, company, balance, `opencash agent sweep ${agent.name}`);
    await settle(rows[0].id, true, txHash, null);
    return { amount: fromUnits(balance), tx_hash: txHash };
  } catch (error) {
    await settle(rows[0].id, false, null, String(error));
    throw error;
  }
}
