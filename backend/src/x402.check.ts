import assert from "node:assert/strict";
import { KeyPair, KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate, teraToGas } from "near-api-js";
import { network as nearNetwork } from "shared";

process.env.X402_RELAYER_PRIVATE_KEY = KeyPair.fromRandom("ed25519").toString();
const { depositHeader, hasExactNear, intentsEntry, isUsdc, paymentRequired, quoteHeader, quotedEntry, receiptOf } = await import("./intents402.js");
const { hourlySettlements, refuseRequirements, settle, supported, verify } = await import("./facilitator.js");
const { provider } = await import("./near.js");
const { createAgent, redeemPayment } = await import("./agents.js");
const { db } = await import("./db.js");

const usdc = nearNetwork.usdc;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

const unquoted = { scheme: "exact", network: "near:mainnet", amount: "", asset: `nep141:${usdc}`, payTo: "", maxTimeoutSeconds: 300, extra: { assetTransferMethod: "near-intents", paymentFlow: "upfront", destination: { network: "eip155:8453", amount: "1000000" } } };
const other = { ...unquoted, network: "eip155:42161", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" };
const required = { x402Version: 2, resource: { url: "https://api.example.com/data" }, accepts: [other, unquoted] };

const fromHeader = await paymentRequired(new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": b64(required) } }));
assert.deepEqual(fromHeader, required);
assert.deepEqual(await paymentRequired(new Response(JSON.stringify(required), { status: 402 })), required, "falls back to the JSON body");
assert.equal(await paymentRequired(new Response("nope", { status: 402 })), null);
assert.ok(isUsdc(usdc, usdc) && isUsdc(`nep141:${usdc}`, usdc) && !isUsdc("wrap.near", usdc));
assert.equal(intentsEntry(required, usdc), unquoted, "picks the NEAR-origin USDC intents entry");
assert.equal(intentsEntry({ ...required, accepts: [other] }, usdc), null, "skips origins an agent can't pay from");
assert.equal(intentsEntry({ ...required, accepts: [{ ...unquoted, extra: { ...unquoted.extra, paymentFlow: "deferred" } }] }, usdc), null);
assert.ok(!hasExactNear(required) && hasExactNear({ ...required, accepts: [{ ...unquoted, extra: {} }] }));

const quote = unb64(quoteHeader(required, unquoted, "agent-x.acme.opencash.near"));
assert.deepEqual(quote.payload, { type: "quote", refundTo: "agent-x.acme.opencash.near" });
assert.deepEqual(quote.accepted, unquoted);
assert.equal(quote.resource.url, required.resource.url);

const deposit = "a".repeat(64);
const quotedRow = { ...unquoted, amount: "1004000", payTo: deposit, extra: { ...unquoted.extra, operationToken: "k1.1.mac", refundDeadline: new Date(Date.now() + 300_000).toISOString() } };
const second = { ...required, accepts: [other, quotedRow] };
assert.equal(quotedEntry(second, unquoted), quotedRow);
assert.equal(quotedEntry({ ...second, accepts: [{ ...quotedRow, payTo: "" }] }, unquoted), null, "an entry without a deposit address is not payable");
assert.equal(quotedEntry({ ...second, accepts: [{ ...quotedRow, amount: "0" }] }, unquoted), null);
const dep = unb64(depositHeader(required.resource, unquoted, quotedRow, "TxHash111"));
assert.deepEqual(dep.payload, { type: "deposit", operationToken: "k1.1.mac", depositAddress: deposit, txHash: "TxHash111" });
assert.deepEqual(dep.accepted, unquoted, "the deposit payload echoes the unquoted entry");
assert.equal(receiptOf(new Response(null, { headers: { "PAYMENT-RESPONSE": b64({ success: false, errorReason: "settlement_pending" }) } }))?.errorReason, "settlement_pending");

const company = `x4${Date.now() % 100000}.opencash.near`;
const payment = (over: Record<string, unknown> = {}) => ({
  paymentPayload: { x402Version: 2, accepted: {}, payload: {} } as never,
  paymentRequirements: { scheme: "exact", network: "near:mainnet", asset: usdc, amount: "50000", payTo: company, maxTimeoutSeconds: 60, extra: {}, ...over } as never,
});
assert.equal(refuseRequirements(company, payment()), null);
assert.match(refuseRequirements(company, payment({ payTo: "someone-else.near" }))!, /payTo must be your opencash account/);
assert.match(refuseRequirements(company, payment({ asset: "wrap.near" }))!, /USDC on NEAR only/);
assert.match(refuseRequirements(company, payment({ network: "near:testnet" }))!, /near:mainnet only/);
assert.match(refuseRequirements(company, payment({ amount: "9999" }))!, /minimum x402 price/);
assert.equal((await settle(company, payment({ payTo: "evil.near" }))).success, false, "the relayer never sponsors a payment to another account");

await db().query(
  "insert into x402_settlements (company, payer, amount_units, transaction) select $1, 'p.near', 50000, $1 || '-' || g from generate_series(1, $2) g",
  [company, hourlySettlements],
);
await assert.rejects(settle(company, payment()), /per hour/, "the relayer's gas spend per business is capped");
await db().query("delete from x402_settlements where company = $1", [company]);

const kinds = (supported() as { kinds: { network: string; scheme: string }[] }).kinds;
assert.ok(kinds.some((k) => k.network === "near:mainnet" && k.scheme === "exact"), "the facilitator advertises exact on near:mainnet");

const { agent } = await createAgent(company, { name: "Redeemer", per_tx_cap: "1", daily_cap: "2" });
const row = (await db().query(`select id, company, name, account_id, public_key, api_key_prefix, per_tx_cap_units::text, daily_cap_units::text, allowlist, status, created_at from agents where id = $1`, [agent.id])).rows[0];
const { rows: pay } = await db().query("insert into agent_payments (agent_id, kind, recipient, amount_units, resource) values ($1, 'transfer', 'x.near', 1, null) returning id", [agent.id]);
await assert.rejects(redeemPayment(row, pay[0].id, {}), /No NEAR Intents payment/);
await db().query("update agent_payments set operation = '{}'::jsonb where id = $1", [pay[0].id]);
await assert.rejects(redeemPayment(row, pay[0].id, {}), /nothing to redeem/, "an unsent deposit can't be redeemed");
await db().query("delete from agent_payments where agent_id = $1", [agent.id]);
await db().query("delete from agents where id = $1", [agent.id]);

try {
  const live = (await (await fetch("https://pay.pingpay.io/agentpay/x402/supported", { signal: AbortSignal.timeout(10_000) })).json()) as { kinds: { network: string; extra?: { assetTransferMethod?: string } }[] };
  assert.ok(live.kinds.some((k) => k.network === "near:mainnet" && k.extra?.assetTransferMethod === "near-intents"), "PingPay accepts near:mainnet as an origin");
  console.log("pingpay live /supported: near:mainnet origin ok");
} catch (error) {
  console.log(`pingpay live /supported skipped: ${String(error)}`);
}

try {
  const payTo = "relay.aurora";
  const signerKey = KeyPair.fromRandom("ed25519");
  const block = await provider.viewBlock({ finality: "final" });
  const delegate = buildDelegateAction({
    senderId: "near",
    receiverId: usdc,
    actions: [actions.functionCall("ft_transfer", { receiver_id: payTo, amount: "10000" }, teraToGas(30), 1n)],
    nonce: 1n,
    maxBlockHeight: BigInt(block.header.height) + 30n,
    publicKey: signerKey.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(signerKey).signDelegateAction(delegate);
  const signedDelegateAction = Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
  const reqs = (amount: string) => ({ scheme: "exact", network: "near:mainnet", asset: usdc, amount, payTo, maxTimeoutSeconds: 60, extra: {} });
  const ask = (amount: string) => verify(payTo, { paymentPayload: { x402Version: 2, accepted: reqs(amount), payload: { signedDelegateAction } }, paymentRequirements: reqs(amount) } as never);
  assert.equal((await ask("10000")).invalidReason, "invalid_exact_near_access_key_not_found", "a key the payer doesn't own is rejected on mainnet");
  assert.equal((await ask("20000")).invalidReason, "invalid_exact_near_payload_amount_mismatch", "a changed price is rejected");
  console.log("facilitator live mainnet verify: foreign key + amount mismatch rejected");
} catch (error) {
  if (error instanceof assert.AssertionError) throw error;
  console.log(`facilitator live mainnet verify skipped: ${String(error)}`);
}

await db().end();
console.log("x402 intents + facilitator checks ok");
