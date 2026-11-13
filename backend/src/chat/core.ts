import { formatUsd, payoutStatusLabel, statusLabel, type Invoice, type PayToken } from "shared";
import { config } from "../config.js";
import { createInvoiceFor, payUrl } from "../developer.js";
import { usdcBalance, view } from "../near.js";
import { payTokens } from "../payments.js";
import { listPayees, listPayouts, quotePayouts } from "../payouts.js";
import { createLinkCode, linkedAccount, unlink, type Platform } from "./outbox.js";

export type Command =
  | { kind: "help" }
  | { kind: "link" }
  | { kind: "unlink" }
  | { kind: "balance" }
  | { kind: "status" }
  | { kind: "pay"; name: string; amount: string; token: string | null; chain: string | null; address: string | null }
  | { kind: "request"; amount: string; from: string; description: string | null }
  | { kind: "unknown"; text: string };

const chainAliases: Record<string, string> = {
  arbitrum: "arb",
  arb: "arb",
  base: "base",
  ethereum: "eth",
  eth: "eth",
  mainnet: "eth",
  optimism: "op",
  op: "op",
  solana: "sol",
  sol: "sol",
  bitcoin: "btc",
  btc: "btc",
  bnb: "bsc",
  bsc: "bsc",
  polygon: "pol",
  pol: "pol",
  tron: "tron",
  avalanche: "avax",
  avax: "avax",
  near: "near",
};

const amountPattern = String.raw`\$?(\d+(?:\.\d{1,2})?)`;

export function parseCommand(input: string): Command {
  const text = input.trim().replace(/^\/(\w+)(@\w+)?/, "$1").replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  if (/^(start|help|hi|hello|menu)$/.test(lower)) return { kind: "help" };
  if (/^link$/.test(lower)) return { kind: "link" };
  if (/^unlink$/.test(lower)) return { kind: "unlink" };
  if (/^(balance|bal)$/.test(lower)) return { kind: "balance" };
  if (/^(status|history|activity)$/.test(lower)) return { kind: "status" };

  const pay = new RegExp(String.raw`^(?:pay|send)\s+(.+?)\s+${amountPattern}(?:\s+([a-z]{2,6}))?(?:\s+on\s+([a-z]+))?(?:\s+to\s+(\S+))?$`, "i").exec(text);
  if (pay) {
    const [, name, amount, token, chain, address] = pay;
    if (!address && /^(([a-z\d]+[-_])*[a-z\d]+\.)+(near|tg)$|^[0-9a-f]{64}$/.test(name.trim().toLowerCase())) {
      return { kind: "pay", name: name.trim().toLowerCase(), amount, token: token ? token.toUpperCase() : "USDC", chain: "near", address: name.trim().toLowerCase() };
    }
    return {
      kind: "pay",
      name: name.trim(),
      amount,
      token: token ? token.toUpperCase() : null,
      chain: chain ? (chainAliases[chain.toLowerCase()] ?? chain.toLowerCase()) : null,
      address: address ?? null,
    };
  }

  const request = new RegExp(String.raw`^(?:request|invoice|bill)\s+${amountPattern}\s+from\s+(.+?)(?:\s+for\s+(.+))?$`, "i").exec(text);
  if (request) {
    const [, amount, from, description] = request;
    return { kind: "request", amount, from: from.trim(), description: description?.trim() ?? null };
  }
  return { kind: "unknown", text };
}

export const helpText = [
  "opencash · Remittance for open worlds",
  "",
  "link — connect this chat to your opencash account",
  "balance — your USDC balance",
  "pay Ada 50 USDC on base to 0xabc… — send to anyone on any chain",
  "pay Ada 50 — pay a saved payee",
  "request 120 from Northwind for design work — get a pay link",
  "status — recent payments",
  "unlink — disconnect this chat",
  "",
  "Every payout is signed with your passkey on opencash. This chat never holds your keys.",
].join("\n");

function resolveToken(tokens: PayToken[], symbol: string, chain: string): PayToken | undefined {
  return tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase() && t.blockchain === chain);
}

export function sendUrl(ids: string[]): string {
  return `${config.webUrl}/send?ids=${ids.join(",")}`;
}

async function payCommand(account: string, cmd: Extract<Command, { kind: "pay" }>): Promise<string> {
  const tokens = await payTokens();
  let assetId: string | undefined;
  let recipient = cmd.address;
  if (!recipient) {
    const payee = (await listPayees(account)).find((p) => p.name.toLowerCase() === cmd.name.toLowerCase());
    if (!payee) return `I don't have a saved address for ${cmd.name}. Try: pay ${cmd.name} ${cmd.amount} USDC on base to 0x…`;
    recipient = payee.recipient;
    assetId = cmd.token && cmd.chain ? resolveToken(tokens, cmd.token, cmd.chain)?.assetId : payee.asset_id;
  } else {
    if (!cmd.chain) return `Which chain? e.g. pay ${cmd.name} ${cmd.amount} ${cmd.token ?? "USDC"} on base to ${recipient}`;
    assetId = resolveToken(tokens, cmd.token ?? "USDC", cmd.chain)?.assetId;
  }
  if (!assetId) return `${cmd.token ?? "USDC"} on ${cmd.chain} isn't supported. Chains: ${[...new Set(tokens.map((t) => t.blockchain))].join(", ")}.`;
  const { payouts } = await quotePayouts(account, [{ payee_name: cmd.name, asset_id: assetId, recipient, amount: cmd.amount }], null);
  const p = payouts[0];
  return [
    `Quote: ${p.payee_name} receives ${p.amount_out} ${p.symbol} on ${p.chain} for ${formatUsd(p.amount_units)} USDC.`,
    "Valid for 60 minutes. Sign it with your passkey:",
    sendUrl([p.id]),
    "I'll message you here when it's delivered.",
  ].join("\n");
}

async function requestCommand(account: string, platform: Platform, cmd: Extract<Command, { kind: "request" }>): Promise<string> {
  if (Number(cmd.amount) < 1) return "Requests start at $1.00.";
  const invoice = await createInvoiceFor(account, {
    client_name: cmd.from,
    due_ms: Date.now() + 14 * 86_400_000,
    items: [{ description: cmd.description ?? "Payment request", amount: cmd.amount }],
    source: "chat",
    reference: `chat:${platform}`,
  });
  return [`Invoice ${invoice.id} for ${formatUsd(invoice.amount)} to ${cmd.from}.`, "Send them this link; they can pay from any chain:", payUrl(invoice.id)].join("\n");
}

async function statusCommand(account: string): Promise<string> {
  const [payouts, invoices] = await Promise.all([listPayouts(account), view<Invoice[]>("list_invoices", { account_id: account, from: 0, limit: 100 })]);
  const lines = [
    ...invoices
      .sort((a, b) => b.created_at_ms - a.created_at_ms)
      .slice(0, 5)
      .map((i) => `↓ ${i.id} · ${i.client_name} · ${formatUsd(i.amount)} · ${statusLabel[i.status]}`),
    ...payouts
      .filter((p) => p.status !== "quoted" && p.status !== "expired")
      .slice(0, 5)
      .map((p) => `↑ ${p.payee_name} · ${p.amount_out} ${p.symbol} on ${p.chain} · ${payoutStatusLabel[p.status]}`),
  ];
  return lines.length ? lines.join("\n") : "No payments yet. Try: request 50 from Northwind";
}

const recentRequests = new Map<string, number[]>();

function allowRequest(account: string): boolean {
  const recent = (recentRequests.get(account) ?? []).filter((t) => Date.now() - t < 3_600_000);
  if (recent.length >= 20) return false;
  recentRequests.set(account, [...recent, Date.now()]);
  return true;
}

export async function handleMessage(platform: Platform, chatUserId: string, text: string, label = ""): Promise<string> {
  const cmd = parseCommand(text);
  if (cmd.kind === "help") return helpText;
  if (cmd.kind === "link") {
    const code = await createLinkCode(platform, chatUserId, label);
    return `Open this link and sign in with your passkey to connect this chat (valid 15 minutes):\n${config.webUrl}/chat-link?code=${code}`;
  }
  const account = await linkedAccount(platform, chatUserId);
  if (cmd.kind === "unknown") return `I didn't understand "${cmd.text.slice(0, 60)}".\n\n${helpText}`;
  if (!account) return "This chat isn't connected yet. Send: link";
  if (cmd.kind === "unlink") {
    await unlink(platform, chatUserId);
    return `Disconnected from ${account}.`;
  }
  if (cmd.kind === "balance") return `${account}: ${formatUsd(await usdcBalance(account))} USDC`;
  if (cmd.kind === "status") return statusCommand(account);
  if (!allowRequest(account)) return "You've made 20 payment requests or quotes in the last hour. Try again later.";
  if (cmd.kind === "pay") return payCommand(account, cmd);
  return requestCommand(account, platform, cmd);
}

export function eventMessage(type: string, data: Record<string, unknown>): string | null {
  const usd = (units: unknown) => formatUsd(String(units ?? "0"));
  const invoice = `${data.id} from ${data.client_name}`;
  switch (type) {
    case "invoice.pending":
      return `↓ Payment for invoice ${invoice} is in flight.`;
    case "invoice.paid":
      return `↓ Paid: invoice ${invoice}, ${usd(data.amount)} USDC received.`;
    case "invoice.refunded":
      return `↓ Invoice ${invoice}: payment refunded to the payer.`;
    case "payout.sent":
      return `↑ Sent ${usd(data.amount_units)} USDC to ${data.payee_name}; delivering ${data.amount_out} ${data.symbol} on ${data.chain}.`;
    case "payout.completed":
      return `↑ Delivered: ${data.payee_name} received ${data.amount_out} ${data.symbol} on ${data.chain}.${data.delivery_tx_url ? `\n${data.delivery_tx_url}` : ""}`;
    case "agent.payment":
      return `🤖 Agent ${data.agent} paid ${data.amount ? `${data.amount} USDC to ${data.to}` : `for ${data.resource}`}.`;
    case "payout.refunded":
    case "payout.failed":
      return `↑ Payout to ${data.payee_name} didn't complete; ${usd(data.amount_units)} USDC is refunded to your account.`;
    default:
      return null;
  }
}

