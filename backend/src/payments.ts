import { createIntentsClient, usdcAssetId, type Invoice, type IntentsToken, type Payment, type StatusResponse } from "shared";
import { config } from "./config.js";
import { emit } from "./developer.js";
import { teraToGas } from "near-api-js";
import { attestInvoice, operator, provider, view } from "./near.js";

const intents = createIntentsClient({ apiKey: config.oneClickJwt });

const offeredSymbols = new Set(["USDC", "USDT", "ETH", "SOL", "BTC", "wNEAR"]);
const offeredChains = new Set(["eth", "arb", "base", "op", "sol", "btc", "bsc", "pol", "tron", "avax", "near"]);
let tokenCache: { at: number; tokens: IntentsToken[] } | null = null;

export async function payTokens(): Promise<IntentsToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < 10 * 60_000) return tokenCache.tokens;
  const tokens = (await intents.getTokens())
    .filter((t) => offeredSymbols.has(t.symbol) && offeredChains.has(t.blockchain))
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.blockchain.localeCompare(b.blockchain));
  tokenCache = { at: Date.now(), tokens };
  return tokens;
}

export async function getInvoice(id: string): Promise<Invoice> {
  const invoice = await view<Invoice | null>("get_invoice", { id });
  if (!invoice) throw Object.assign(new Error("Invoice not found"), { statusCode: 404 });
  return invoice;
}

export async function quoteInvoice(id: string, originAsset: string, refundTo: string) {
  const invoice = await getInvoice(id);
  if (invoice.status === "paid") throw Object.assign(new Error("This invoice is already paid."), { statusCode: 409 });
  if (originAsset === usdcAssetId) throw Object.assign(new Error("Paying with USDC on NEAR? Use 'Pay with a NEAR wallet' instead; it settles instantly with no fee."), { statusCode: 400 });
  const tokens = await payTokens();
  const token = tokens.find((t) => t.assetId === originAsset);
  if (!token) throw Object.assign(new Error("That token is not offered."), { statusCode: 400 });
  const { quote } = await intents.requestQuote({
    dry: false,
    swapType: "EXACT_OUTPUT",
    originAsset,
    destinationAsset: usdcAssetId,
    amount: invoice.amount,
    recipient: invoice.company,
    refundTo,
    deadlineMs: 60 * 60_000,
  });
  if (!quote.depositAddress) throw new Error("Intents returned no deposit address.");
  const pending = await attestInvoice(id, "pending", { deposit_address: quote.depositAddress });
  await emit(pending.company, "invoice.pending", pending).catch(() => undefined);
  return {
    depositAddress: quote.depositAddress,
    depositMemo: quote.depositMemo,
    amountIn: quote.amountInFormatted,
    symbol: token.symbol,
    blockchain: token.blockchain,
    deadline: quote.deadline ?? new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

async function paymentFrom(status: StatusResponse): Promise<Payment> {
  const assetId = status.quoteResponse?.quoteRequest?.originAsset ?? "";
  const token = (await payTokens()).find((t) => t.assetId === assetId);
  const details = status.swapDetails;
  return {
    origin_asset: token?.symbol ?? assetId,
    origin_chain: token?.blockchain ?? "",
    amount_in: details?.amountInFormatted ?? "",
    amount_in_usd: details?.amountInUsd ?? "",
    origin_tx_url: details?.originChainTxHashes?.[0]?.explorerUrl ?? null,
    refund_reason: details?.refundReason ?? null,
  };
}

export async function invoiceStatus(id: string) {
  let invoice = await getInvoice(id);
  if (!invoice.deposit_address || invoice.status === "paid" || invoice.status === "refunded") {
    return { invoice, intents: null, originTx: invoice.payment?.origin_tx_url ?? null, settleTx: invoice.settle_tx };
  }
  const status = await intents.getStatus(invoice.deposit_address);
  const settleTx = status.swapDetails?.destinationChainTxHashes?.[0]?.hash ?? null;
  const originTx = status.swapDetails?.originChainTxHashes?.[0]?.explorerUrl ?? null;
  try {
    if (status.status === "SUCCESS") {
      invoice = await attestInvoice(id, "paid", { settle_tx: settleTx ?? undefined, payment: await paymentFrom(status) });
    } else if (status.status === "REFUNDED") {
      invoice = await attestInvoice(id, "refunded", { payment: await paymentFrom(status) });
    } else if (status.status === "FAILED") {
      invoice = await attestInvoice(id, "open");
    }
  } catch (error) {
    if (!String(error).includes("already paid")) throw error;
    return { invoice: await getInvoice(id), intents: status.status, originTx, settleTx };
  }
  if (status.status === "SUCCESS" || status.status === "REFUNDED" || status.status === "FAILED") {
    const type = invoice.status === "open" ? "invoice.failed" : `invoice.${invoice.status}`;
    await emit(invoice.company, type, invoice).catch(() => undefined);
  }
  return { invoice, intents: status.status, originTx, settleTx };
}

let watching = false;

export async function checkPending(log: (message: string) => void) {
  if (watching) return;
  watching = true;
  try {
    const pending = await view<Invoice[]>("list_pending", { from: 0, limit: 100 });
    for (const invoice of pending) {
      try {
        const result = await invoiceStatus(invoice.id);
        if (result.invoice.status !== "pending") log(`invoice ${invoice.id} is now ${result.invoice.status}`);
      } catch (error) {
        log(`invoice ${invoice.id} check failed: ${String(error)}`);
      }
    }
  } finally {
    watching = false;
  }
}

export async function recordWalletSettlement(id: string, txHash: string, payer: string) {
  const invoice = await getInvoice(id);
  if (invoice.status !== "paid" || invoice.payment?.payer !== payer) {
    throw Object.assign(new Error("This invoice isn't marked paid by that account on NEAR yet."), { statusCode: 409 });
  }
  if (invoice.settle_tx) return invoice;
  const tx = (await provider.viewTransactionStatus({ txHash, accountId: payer })) as unknown as {
    status: Record<string, unknown>;
    transaction: { signer_id: string; receiver_id: string; actions: { FunctionCall?: { method_name: string; args: string } }[] };
  };
  const call = tx.transaction.actions[0]?.FunctionCall;
  const args = call ? JSON.parse(Buffer.from(call.args, "base64").toString("utf8")) : {};
  const matches =
    tx.transaction.signer_id === payer &&
    tx.transaction.receiver_id === config.usdc &&
    call?.method_name === "ft_transfer_call" &&
    args.receiver_id === config.contract &&
    String(args.msg).trim() === id &&
    "SuccessValue" in tx.status;
  if (!matches) throw Object.assign(new Error("That transaction is not a successful payment of this invoice."), { statusCode: 400 });
  const recorded = await operator().callFunction<Invoice>({
    contractId: config.contract,
    methodName: "record_settlement",
    args: { id, settle_tx: txHash },
    gas: teraToGas(30),
  });
  await emit(recorded.company, "invoice.paid", recorded).catch(() => undefined);
  return recorded;
}
