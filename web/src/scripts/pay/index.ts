import qrcode from "qrcode-generator";
import { toUnits, txUrl, usdcAssetId } from "shared";
import { api, statusLabel, type PayStatus, type PayToken, type PublicInvoice } from "../lib/api";
import { date, errorText, esc, query, say, usdc } from "../lib/dom";
import { showToast } from "../lib/toast";
import { connectWallet, walletPayInvoice } from "../lib/wallet";

const id = new URLSearchParams(location.search).get("id") ?? "";
const statusEl = query("[data-pay-status]");
const quoteLine = query("[data-pay-quote]");
const go = query<HTMLButtonElement>("[data-pay-go]");
const asset = query<HTMLSelectElement>("[data-pay-asset]");
const refund = query<HTMLInputElement>("[data-pay-refund]");
const progress = query("[data-pay-progress]");
let tokens: PayToken[] = [];
let timer = 0;

function setStatus(invoice: PublicInvoice | PayStatus["invoice"]) {
  statusEl.className = `tag tag--${invoice.status}`;
  statusEl.innerHTML = `<i class="tag__dot"></i>${statusLabel[invoice.status]}`;
}

function renderInvoice(invoice: PublicInvoice) {
  setStatus(invoice);
  query("[data-pay-from]").textContent = `${invoice.legal_name} · ${invoice.company}`;
  query("[data-pay-amount]").textContent = usdc(invoice.amount);
  query("[data-pay-due]").textContent = `Billed to ${invoice.client_name} · due ${date(invoice.due_ms)}`;
  query("[data-pay-items]").innerHTML = invoice.items
    .map((item) => `<div class="leg-row"><span>${esc(item.description)}</span><span>${usdc(toUnits(item.amount))}</span></div>`)
    .join("");
}

function renderReceipt(status: PayStatus) {
  const rows = [
    ["Status", statusLabel[status.invoice.status]],
    ["Intents", status.intents ?? "—"],
    ["Paid from", status.originTx ? `<a href="${esc(status.originTx)}" target="_blank" rel="noopener">origin transaction ↗</a>` : "—"],
    ["Settled on NEAR", status.settleTx ? `<a href="${txUrl(status.settleTx)}" target="_blank" rel="noopener">${esc(status.settleTx.slice(0, 12))}… ↗</a>` : "—"],
  ];
  query("[data-pay-receipt]").hidden = false;
  query("[data-pay-receipt-rows]").innerHTML = rows.map(([k, v]) => `<div class="leg-row"><span>${k}</span><span>${v}</span></div>`).join("");
}

async function poll() {
  try {
    const status = await api.status(id);
    setStatus(status.invoice);
    renderReceipt(status);
    say(progress, status.intents ? `Intents: ${status.intents.replace(/_/g, " ").toLowerCase()}` : "Waiting for your deposit…");
    if (status.invoice.status === "paid" || status.invoice.status === "refunded") {
      clearInterval(timer);
      query("[data-pay-form]").hidden = true;
      query("[data-pay-deposit]").hidden = status.invoice.status === "paid";
    }
  } catch (error) {
    say(progress, errorText(error), "error");
  }
}

async function start() {
  if (!id) return say(statusEl, "No invoice in this link.", "error");
  const invoice = await api.invoice(id);
  renderInvoice(invoice);
  if (invoice.status !== "open") {
    await poll();
    return;
  }
  query("[data-pay-form]").hidden = false;
  query("[data-pay-near]").hidden = false;
  query("[data-pay-near-go]").onclick = async () => {
    try {
      say(quoteLine, "");
      const payer = await connectWallet();
      say(progress, "Confirm the payment in your wallet…");
      query("[data-pay-deposit]").hidden = false;
      const tx = await walletPayInvoice(invoice.id, invoice.amount);
      say(progress, "Paid on NEAR. Recording the receipt…");
      await api.settled(invoice.id, { tx_hash: tx, payer }).catch(() => undefined);
      await poll();
    } catch (error) {
      say(progress, errorText(error), "error");
    }
  };
  tokens = (await api.tokens()).filter((t) => t.assetId !== usdcAssetId);
  asset.innerHTML = tokens.map((t, i) => `<option value="${i}">${esc(t.symbol)} on ${esc(t.blockchain)}</option>`).join("");
  go.disabled = false;
}

go.addEventListener("click", async () => {
  const token = tokens[Number(asset.value)];
  if (!token) return;
  if (!refund.value.trim()) return say(quoteLine, "Add a refund address on the chain you're paying from.", "error");
  go.disabled = true;
  say(quoteLine, "Getting a quote…");
  try {
    const quote = await api.quote(id, { originAsset: token.assetId, refundTo: refund.value.trim() });
    say(quoteLine, `Quote valid until ${new Date(quote.deadline).toLocaleTimeString()}.`);
    query("[data-pay-send]").textContent = `Send exactly ${quote.amountIn} ${quote.symbol} on ${quote.blockchain}`;
    query("[data-pay-address]").textContent = quote.depositAddress + (quote.depositMemo ? `  memo ${quote.depositMemo}` : "");
    const qr = qrcode(0, "M");
    qr.addData(quote.depositAddress);
    qr.make();
    query("[data-pay-qr]").innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
    query("[data-pay-deposit]").hidden = false;
    query("[data-pay-copy]").onclick = async () => {
      await navigator.clipboard.writeText(quote.depositAddress);
      showToast("Address copied");
    };
    clearInterval(timer);
    timer = window.setInterval(poll, 5000);
    void poll();
  } catch (error) {
    say(quoteLine, errorText(error), "error");
    go.disabled = false;
  }
});

start().catch((error) => say(statusEl, errorText(error), "error"));
