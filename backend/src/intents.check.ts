import assert from "node:assert/strict";
import { createIntentsClient, usdcAssetId } from "shared";

const intents = createIntentsClient({ apiKey: process.env.ONECLICK_JWT });
const tokens = await intents.getTokens();
assert.ok(tokens.some((t) => t.assetId === usdcAssetId), "NEAR USDC is listed");
const arbUsdc = tokens.find((t) => t.blockchain === "arb" && t.symbol === "USDC");
assert.ok(arbUsdc, "Arbitrum USDC is listed");
const { quote } = await intents.requestQuote({
  dry: true,
  swapType: "EXACT_OUTPUT",
  originAsset: arbUsdc.assetId,
  destinationAsset: usdcAssetId,
  amount: "5000000",
  recipient: "aurora",
  refundTo: "0x126F2E536cF40FBcCa2069D5b47dC6D234F55517",
});
assert.equal(quote.amountOut, "5000000", "EXACT_OUTPUT delivers the invoice amount");
console.log(`dry quote ok: pay ${quote.amountInFormatted} Arbitrum USDC → receive ${quote.amountOutFormatted} NEAR USDC`);
