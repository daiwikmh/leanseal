import { invoiceTotal, invoicesCsv, toUnits, txUrl, type Invoice, type LineItem } from "shared";
import { api } from "../lib/api";
import { date, errorText, esc, query, queryAll, say, statusTag, usdc } from "../lib/dom";
import { relayCall } from "../lib/near";
import { showToast } from "../lib/toast";
import { closeModal, openModal } from "./modal";
import { state } from "./state";

let filter: "all" | "open" | "paid" = "all";

export function payLink(id: string): string {
  return `${location.origin}/pay?id=${encodeURIComponent(id)}`;
}

export function invoiceTable(invoices: Invoice[], empty: string): string {
  if (invoices.length === 0) return `<p class="empty">${esc(empty)}</p>`;
  const rows = invoices
    .map(
      (inv) => `<tr data-invoice="${esc(inv.id)}">
        <td class="cell-identity">${esc(inv.client_name)}</td>
        <td class="cell-muted">${esc(inv.items[0]?.description ?? "")}</td>
        <td class="cell-muted">Due ${date(inv.due_ms)}</td>
        <td>${statusTag(inv.status)}</td>
        <td class="cell-value">${usdc(inv.amount)}</td>
      </tr>`,
    )
    .join("");
  return `<table class="data-table"><thead><tr><th>Client</th><th>For</th><th>Due</th><th>Status</th><th class="cell-value">Amount</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function bindRows(root: HTMLElement) {
  for (const row of queryAll<HTMLTableRowElement>("tr[data-invoice]", root)) {
    row.addEventListener("click", () => openInvoice(row.dataset.invoice!));
  }
}

export async function loadInvoices() {
  if (!state.session) return;
  const account = state.session.accountId;
  const list = await api.invoices(account);
  const pending = list.filter((inv) => inv.status === "pending");
  const checked = await Promise.all(pending.map((inv) => api.status(inv.id).then((s) => s.invoice).catch(() => inv)));
  const fresh = new Map(checked.map((inv) => [inv.id, inv]));
  state.invoices = list.map((inv) => fresh.get(inv.id) ?? inv).sort((a, b) => b.created_at_ms - a.created_at_ms);
}

function paymentHtml(inv: Invoice): string {
  const p = inv.payment;
  const rows: [string, string][] = [];
  if (inv.paid_at_ms) rows.push(["Paid on", date(inv.paid_at_ms)]);
  if (p) {
    rows.push(["Client paid with", esc(`${p.origin_asset} on ${p.origin_chain}`)]);
    if (p.amount_in) rows.push(["Client sent", esc(`${p.amount_in} ${p.origin_asset}${p.amount_in_usd ? ` (≈ $${p.amount_in_usd})` : ""}`)]);
    if (p.refund_reason) rows.push(["Refund reason", esc(p.refund_reason)]);
  }
  if (p?.origin_tx_url) rows.push(["Payment transaction", `<a href="${esc(p.origin_tx_url)}" target="_blank" rel="noopener">client's chain ↗</a>`]);
  if (inv.settle_tx) rows.push(["Settlement", `<a href="${txUrl(inv.settle_tx)}" target="_blank" rel="noopener">NEAR ${esc(inv.settle_tx.slice(0, 10))}… ↗</a>`]);
  if (inv.deposit_address && inv.status === "pending") rows.push(["Deposit address", `<span class="mono">${esc(inv.deposit_address)}</span>`]);
  if (rows.length === 0) return "";
  return `<span class="panel__label">Payment</span><div class="line-items">${rows.map(([k, v]) => `<div class="leg-row"><span>${k}</span><span>${v}</span></div>`).join("")}</div>`;
}

export function renderInvoices() {
  const wrap = query("[data-invoice-table]");
  wrap.classList.remove("table-wrap--loading");
  const shown = state.invoices.filter((inv) =>
    filter === "all" ? true : filter === "paid" ? inv.status === "paid" : inv.status === "open" || inv.status === "pending",
  );
  wrap.innerHTML = invoiceTable(shown, "No invoices here yet.");
  bindRows(wrap);
}

function openInvoice(id: string) {
  const inv = state.invoices.find((i) => i.id === id);
  if (!inv) return;
  const link = payLink(inv.id);
  const items = inv.items.map((i) => `<div class="leg-row"><span>${esc(i.description)}</span><span>${usdc(toUnits(i.amount))}</span></div>`).join("");
  const body = openModal(
    `Invoice to ${inv.client_name}`,
    `<div class="stat-grid"><div class="stat"><small>Amount</small><b>${usdc(inv.amount)}</b></div><div class="stat"><small>Status</small><b>${statusTag(inv.status)}</b></div><div class="stat"><small>Due</small><b>${date(inv.due_ms)}</b></div><div class="stat"><small>ID</small><b class="mono">${esc(inv.id)}</b></div></div>
     <div class="line-items">${items}</div>
     ${paymentHtml(inv)}
     <label class="field"><span>Pay link</span><input readonly value="${esc(link)}" /></label>
     <div class="btn-row" style="margin-top:var(--sp-md)"><button type="button" class="btn btn--primary" data-copy-link>Copy pay link</button><a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Open</a></div>`,
  );
  query("[data-copy-link]", body).addEventListener("click", async () => {
    await navigator.clipboard.writeText(link);
    showToast("Pay link copied");
  });
}

function itemRow(): string {
  return `<div class="line-item"><label class="field"><span>Description</span><input name="desc" required placeholder="Design sprint, week 1" /></label><label class="field"><span>USD</span><input name="amount" required inputmode="decimal" pattern="\\d+(\\.\\d{1,2})?" placeholder="250.00" /></label><button type="button" class="chip" data-remove aria-label="Remove line">×</button></div>`;
}

export function openNewInvoice() {
  const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const body = openModal(
    "New invoice",
    `<form data-invoice-form>
      <div class="field-row"><label class="field"><span>Client</span><input name="client" required placeholder="Northwind Inc." /></label><label class="field"><span>Due date</span><input name="due" type="date" required value="${due}" /></label></div>
      <div class="line-items" data-items>${itemRow()}</div>
      <button type="button" class="btn btn--quiet" data-add-item>+ Add line</button>
      <div class="line-total"><span>Total</span><span data-total>$0.00</span></div>
      <p class="quote-line">Your client pays from any chain and token. You receive USDC at ${esc(state.session?.accountId ?? "")}. Gas is on opencash.</p>
      <p class="form-error" data-invoice-error></p>
      <button type="submit" class="btn btn--primary">Create invoice</button>
    </form>`,
  );
  const form = query<HTMLFormElement>("[data-invoice-form]", body);
  const itemsEl = query("[data-items]", body);
  const error = query("[data-invoice-error]", body);

  const items = (): LineItem[] =>
    queryAll(".line-item", itemsEl).map((row) => ({
      description: query<HTMLInputElement>("[name=desc]", row).value.trim(),
      amount: query<HTMLInputElement>("[name=amount]", row).value.trim() || "0",
    }));

  const refresh = () => {
    try {
      query("[data-total]", body).textContent = usdc(invoiceTotal(items()));
    } catch {
      query("[data-total]", body).textContent = "—";
    }
  };

  form.addEventListener("input", refresh);
  query("[data-add-item]", body).addEventListener("click", () => itemsEl.insertAdjacentHTML("beforeend", itemRow()));
  itemsEl.addEventListener("click", (event) => {
    const remove = (event.target as HTMLElement).closest("[data-remove]");
    if (remove && queryAll(".line-item", itemsEl).length > 1) remove.closest(".line-item")!.remove();
    refresh();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = query<HTMLButtonElement>("[type=submit]", form);
    submit.disabled = true;
    say(error, "Signing with your passkey key…");
    try {
      const data = new FormData(form);
      const input = {
        client_name: String(data.get("client")).trim(),
        due_ms: new Date(String(data.get("due"))).getTime(),
        items: items(),
      };
      await relayCall(state.session!, "create_invoice", input);
      await loadInvoices();
      renderInvoices();
      closeModal();
      showToast("Invoice created");
      if (state.invoices[0]) openInvoice(state.invoices[0].id);
    } catch (cause) {
      say(error, errorText(cause), "error");
      submit.disabled = false;
    }
  });
}

export function initInvoices() {
  for (const button of queryAll<HTMLButtonElement>("[data-invoice-filter] button")) {
    button.addEventListener("click", () => {
      filter = button.dataset.filter as typeof filter;
      for (const b of queryAll("[data-invoice-filter] button")) b.setAttribute("aria-pressed", String(b === button));
      renderInvoices();
    });
  }
  for (const button of queryAll("[data-new-invoice]")) button.addEventListener("click", openNewInvoice);
  query("[data-export-csv]").addEventListener("click", () => {
    const blob = new Blob([invoicesCsv(state.invoices)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.session?.accountId ?? "opencash"}-invoices.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}
