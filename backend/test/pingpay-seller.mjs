import express from "express";
import { agentPayX402 } from "@pingpay/agentpay-middleware";

const usdc = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const mode = process.env.SETTLE_MODE ?? "pending-then-success";
const amountIn = process.env.AMOUNT_IN ?? "1004000";
const depositAddress = "d".repeat(64);
const log = [];
let settles = 0;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function ping(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  log.push({ path: u.pathname, body, apiKey: init.headers?.["X-Api-Key"] });
  if (u.pathname.endsWith("/offers")) {
    return json(200, {
      accepts: [
        { scheme: "exact", network: "eip155:42161", amount: "", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", payTo: "", maxTimeoutSeconds: 300, extra: { assetTransferMethod: "near-intents", paymentFlow: "upfront", destination: { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: u.searchParams.get("amountOut"), recipient: "0xMerchant" } } },
        { scheme: "exact", network: "near:mainnet", amount: "", asset: usdc, payTo: "", maxTimeoutSeconds: 300, extra: { assetTransferMethod: "near-intents", paymentFlow: "upfront", indicativeAmount: "1003000", destination: { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: u.searchParams.get("amountOut"), recipient: "0xMerchant" } } },
      ],
    });
  }
  if (u.pathname.endsWith("/verify")) {
    const p = body.paymentPayload.payload;
    if (p.type !== "quote") return json(200, { isValid: false, invalidReason: "wrong_type" });
    if (!p.refundTo) return json(200, { isValid: false, invalidReason: "refund_address_required" });
    if (mode === "no-quote") return json(200, { isValid: false, invalidReason: "invalid_exact_near_intents_quote_unavailable" });
    return json(200, { isValid: true, extra: { depositAddress, amountIn, refundDeadline: new Date(Date.now() + 300_000).toISOString(), operationToken: "k1.9999999999.testmac" } });
  }
  if (u.pathname.endsWith("/settle")) {
    settles += 1;
    const p = body.paymentPayload.payload;
    const valid = p.type === "deposit" && p.operationToken === "k1.9999999999.testmac" && p.depositAddress === depositAddress && /^\w+$/.test(p.txHash ?? "");
    if (!valid) return json(402, { success: false, errorReason: "invalid_exact_near_intents_token_invalid", transaction: "", network: "near:mainnet" });
    if ((mode === "always-pending" && settles <= 12) || (mode === "pending-then-success" && settles === 1)) {
      return json(200, { success: false, errorReason: "settlement_pending", transaction: p.txHash, network: "near:mainnet", extra: { status: "PROCESSING" } });
    }
    if (mode === "refunded") return json(402, { success: false, errorReason: "exact_near_intents_payment_failed", transaction: "", network: "near:mainnet", extra: { status: "REFUNDED" } });
    return json(200, { success: true, transaction: "0xdeliveryOnBase", network: "eip155:8453", payer: "agent", amount: "1000000", extra: { originNetwork: "near:mainnet", originTxHash: p.txHash } });
  }
  if (u.pathname.endsWith("/execution")) return json(200, { execute: true });
  return json(404, { error: "unknown" });
}

const app = express();
app.get("/log", (_req, res) => res.json({ log, settles }));
app.use(agentPayX402({ apiKey: "merchant-test-key", facilitatorUrl: "https://ping.test/agentpay/x402", fetchImpl: ping, routes: { "GET /data": { amountOut: "1000000", description: "Paid data" } } }));
app.get("/data", (_req, res) => res.json({ secret: "paid content" }));
const server = app.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => console.log(`listening ${server.address().port}`));
