import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { agentFetch, createAgent, redeemPayment, type AgentRow } from "./agents.js";
import { db } from "./db.js";

const sellerDir = new URL("../test/", import.meta.url).pathname;
async function seller(mode: string, port: number) {
  const child = spawn("node", ["pingpay-seller.mjs"], { cwd: sellerDir, env: { ...process.env, SETTLE_MODE: mode, PORT: String(port) } });
  await new Promise<void>((resolve) => child.stdout.on("data", (d) => String(d).includes("listening") && resolve()));
  return child;
}
const hosts: Record<string, number> = { "example.com": 18401, "example.org": 18402, "example.net": 18403, "www.example.com": 18404 };
const children = await Promise.all([seller("pending-then-success", 18401), seller("refunded", 18402), seller("always-pending", 18403), seller("no-quote", 18404)]);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (hosts[url.hostname]) return realFetch(`http://127.0.0.1:${hosts[url.hostname]}${url.pathname}${url.search}`, init);
  return realFetch(input, init);
}) as typeof fetch;
const sellerLog = async (host: string) => (await (await realFetch(`http://127.0.0.1:${hosts[host]}/log`)).json()) as { log: { path: string; body: any }[]; settles: number };

const transfers: { from: string; to: string; units: string; memo: string }[] = [];
const transfer = async (from: string, to: string, units: string, memo: string) => {
  transfers.push({ from, to, units, memo });
  return `FakeTx${transfers.length}`;
};

const company = `pp${Date.now() % 100000}.opencash.near`;
const columns = "id, company, name, account_id, public_key, api_key_prefix, per_tx_cap_units::text, daily_cap_units::text, allowlist, status, created_at";
async function activeAgent(name: string, perTx: string, daily: string): Promise<AgentRow> {
  const { agent } = await createAgent(company, { name, per_tx_cap: perTx, daily_cap: daily });
  return (await db().query<AgentRow>(`update agents set status = 'active' where id = $1 returning ${columns}`, [agent.id])).rows[0];
}
const payment = async (id: string) => (await db().query("select status, tx_hash, recipient, amount_units::text, receipt, operation from agent_payments where id = $1", [id])).rows[0];

try {
  const agent = await activeAgent("Buyer", "2", "10");

  const ok = await agentFetch(agent, { url: "https://example.com/data" }, transfer);
  assert.equal(ok.status, 200);
  assert.equal(ok.paid, true);
  assert.match(ok.body, /paid content/);
  assert.deepEqual(transfers[0], { from: agent.account_id, to: "d".repeat(64), units: "1004000", memo: "opencash x402" });
  const row = await payment(ok.payment_id!);
  assert.equal(row.status, "sent");
  assert.equal(row.receipt.success, true);
  assert.equal(row.receipt.transaction, "0xdeliveryOnBase");
  const log1 = await sellerLog("example.com");
  const verify = log1.log.find((l) => l.path.endsWith("/verify"))!.body;
  assert.equal(verify.paymentPayload.payload.refundTo, agent.account_id, "refundTo is the agent's own NEAR account");
  assert.equal(verify.paymentPayload.accepted.network, "near:mainnet", "the agent picked the NEAR origin, not Arbitrum");
  assert.equal(log1.settles, 2, "the agent re-presented the deposit after settlement_pending");
  console.log("✓ PingPay middleware: quote → cap check → deposit → pending → settled → paid content");

  const small = await activeAgent("Tiny", "1", "10");
  await assert.rejects(agentFetch(small, { url: "https://example.com/data" }, transfer), /per-payment cap/);
  assert.equal(transfers.length, 1, "no USDC moves when the quoted amount is over the cap");
  console.log("✓ quoted amount above the per-payment cap is refused before any transfer");

  const refunded = await agentFetch(agent, { url: "https://example.org/data" }, transfer);
  assert.equal(refunded.paid, false);
  assert.equal((await payment(refunded.payment_id!)).status, "refunded");
  console.log("✓ REFUNDED swap marks the payment refunded (no longer counts against caps)");

  const pending = await agentFetch(agent, { url: "https://example.net/data" }, transfer);
  assert.equal(pending.status, 202);
  assert.equal(pending.pending, true);
  await assert.rejects(agentFetch(agent, { url: "https://example.net/data" }, transfer), /still settling/);
  const transfersBefore = transfers.length;
  const redeemed = await redeemPayment(agent, pending.payment_id!, {});
  assert.equal(redeemed.paid, true);
  assert.match(redeemed.body, /paid content/);
  assert.equal(transfers.length, transfersBefore, "redeem pays nothing new");
  await assert.rejects(redeemPayment(agent, pending.payment_id!, {}), /already settled/);
  console.log("✓ slow settlement → 202 pending, second payment refused, redeem completes without paying again");

  await assert.rejects(agentFetch(agent, { url: "https://www.example.com/data" }, transfer), /invalid_exact_near_intents_quote_unavailable/);
  console.log("✓ refused quote surfaces PingPay's reason");
  console.log("pingpay end-to-end checks ok");
} finally {
  for (const c of children) c.kill();
  await db().query("delete from agent_payments where agent_id in (select id from agents where company = $1)", [company]);
  await db().query("delete from agents where company = $1", [company]);
  await db().end();
}
