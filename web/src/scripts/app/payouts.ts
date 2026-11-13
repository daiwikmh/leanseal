import { invoiceTotal, maxBatch, parsePayrollCsv, payoutStatusLabel, payoutsCsv, txUrl, type PayToken, type Payee, type Payout, type PayoutRequest } from "shared";
import { api } from "../lib/api";
import { date, errorText, esc, query, queryAll, say, usdc } from "../lib/dom";
import { businessAuth, sendUsdc } from "../lib/near";
import { showToast } from "../lib/toast";
import { state } from "./state";

const rowsEl = query("[data-payout-rows]");
const error = query("[data-payout-error]");
let mode: "single" | "payroll" = "single";
let tokens: PayToken[] = [];
let payees: Payee[] = [];
let history: Payout[] = [];
let quoted: Payout[] = [];

const tone: Record<Payout["status"], string> = { quoted: "open", sent: "pending", completed: "paid", refunded: "refunded", failed: "refunded", expired: "refunded" };

function tokenOptions(selected = ""): string {
  return tokens
    .map((t) => `<option value="${esc(t.assetId)}" ${t.assetId === selected ? "selected" : ""}>${esc(t.symbol)} on ${esc(t.blockchain)}</option>`)
    .join("");
}

function addRow(values: Partial<PayoutRequest> = {}) {
  rowsEl.insertAdjacentHTML(
    "beforeend",
    `<div class="payout-row">
      <label class="field"><span>Name</span><input data-f="payee_name" value="${esc(values.payee_name ?? "")}" placeholder="Ada Okafor" /></label>
      <label class="field"><span>Receives</span><select data-f="asset_id">${tokenOptions(values.asset_id)}</select></label>
      <label class="field"><span>Their address</span><input data-f="recipient" value="${esc(values.recipient ?? "")}" placeholder="0x… / wallet address" spellcheck="false" /></label>
      <label class="field"><span>USD</span><input data-f="amount" inputmode="decimal" value="${esc(values.amount ?? "")}" placeholder="250.00" /></label>
      <button type="button" class="chip" data-remove aria-label="Remove">×</button>
    </div>`,
  );
  refreshTotal();
}

function readRows(): PayoutRequest[] {
  return queryAll(".payout-row", rowsEl).map((row) => ({
    payee_name: query<HTMLInputElement>("[data-f=payee_name]", row).value.trim(),
    asset_id: query<HTMLSelectElement>("[data-f=asset_id]", row).value,
    recipient: query<HTMLInputElement>("[data-f=recipient]", row).value.trim(),
    amount: query<HTMLInputElement>("[data-f=amount]", row).value.trim(),
  }));
}

function refreshTotal() {
  try {
    query("[data-payout-total]").textContent = usdc(invoiceTotal(readRows().map((r) => ({ description: r.payee_name, amount: r.amount || "0" }))));
  } catch {
    query("[data-payout-total]").textContent = "—";
  }
}

function setMode(next: typeof mode) {
  mode = next;
  for (const b of queryAll("[data-payout-mode] button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  for (const el of queryAll("[data-payroll-only]")) el.hidden = mode !== "payroll";
  rowsEl.innerHTML = "";
  addRow();
  hideQuotes();
}

function hideQuotes() {
  quoted = [];
  query("[data-payout-quotes]").hidden = true;
  query<HTMLInputElement>("[data-payout-confirm]").checked = false;
  query<HTMLButtonElement>("[data-payout-send]").disabled = true;
}

function renderHistory() {
  const wrap = query("[data-payout-table]");
  wrap.classList.remove("table-wrap--loading");
  const shown = history.filter((p) => p.status !== "quoted" && p.status !== "expired");
  if (shown.length === 0) {
    wrap.innerHTML = `<p class="empty">No payouts yet.</p>`;
    return;
  }
  wrap.innerHTML = `<table class="data-table"><thead><tr><th>To</th><th>Receives</th><th>Date</th><th>Status</th><th class="cell-value">USDC</th></tr></thead><tbody>${shown
    .map(
      (p) => `<tr><td class="cell-identity">${esc(p.payee_name)}</td><td class="cell-muted">${esc(p.amount_out)} ${esc(p.symbol)} on ${esc(p.chain)}</td><td class="cell-muted">${date(Date.parse(p.created_at))}</td>
        <td><span class="tag tag--${tone[p.status]}"><i class="tag__dot"></i>${payoutStatusLabel[p.status]}</span>${p.transfer_tx ? ` <a href="${txUrl(p.transfer_tx)}" target="_blank" rel="noopener">↗</a>` : ""}${p.delivery_tx_url ? ` <a href="${esc(p.delivery_tx_url)}" target="_blank" rel="noopener">delivered ↗</a>` : ""}</td>
        <td class="cell-value">${usdc(p.amount_units)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function renderPayees() {
  const pick = query<HTMLSelectElement>("[data-payee-pick]");
  pick.innerHTML = `<option value="">+ From saved payees</option>${payees.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}`;
  const list = query("[data-payee-list]");
  list.innerHTML = payees.length
    ? `<table class="data-table"><tbody>${payees
        .map((p) => {
          const t = tokens.find((x) => x.assetId === p.asset_id);
          return `<tr><td class="cell-identity">${esc(p.name)}</td><td class="cell-muted">${esc(t ? `${t.symbol} on ${t.blockchain}` : p.asset_id)}</td><td class="cell-muted mono">${esc(p.recipient.slice(0, 10))}…</td><td class="cell-value"><button type="button" class="link-btn" data-payee-delete="${esc(p.id)}">Remove</button></td></tr>`;
        })
        .join("")}</tbody></table>`
    : `<p class="empty">Payees you send to are saved here automatically.</p>`;
}

export async function loadPayouts() {
  const session = state.session;
  if (!session) return;
  try {
    tokens = tokens.length ? tokens : await api.tokens();
    for (const select of queryAll<HTMLSelectElement>("[data-f=asset_id]", rowsEl)) if (select.options.length === 0) select.innerHTML = tokenOptions();
    if (rowsEl.children.length === 0) addRow();
    const [list, saved] = await Promise.all([api.payouts(await businessAuth(session, "list-payouts")), api.payees(await businessAuth(session, "list-payees"))]);
    history = list;
    payees = saved;
    renderHistory();
    renderPayees();
  } catch (cause) {
    query("[data-payout-table]").innerHTML = `<p class="error-text">${esc(errorText(cause))}</p>`;
  }
}

async function quote() {
  const session = state.session!;
  const items = readRows();
  if (items.length > maxBatch) return say(error, `Up to ${maxBatch} people per signature.`, "error");
  const button = query<HTMLButtonElement>("[data-payout-quote]");
  button.disabled = true;
  say(error, "Getting quotes from NEAR Intents…");
  try {
    const label = mode === "payroll" ? query<HTMLInputElement>("[data-batch-label]").value.trim() || `Payroll ${new Date().toISOString().slice(0, 10)}` : undefined;
    const result = await api.quotePayouts(await businessAuth(session, "quote-payouts"), { items, label });
    quoted = result.payouts;
    query("[data-payout-quote-rows]").innerHTML = quoted
      .map((p) => `<div class="leg-row"><span>${esc(p.payee_name)} receives <b>${esc(p.amount_out)} ${esc(p.symbol)}</b> on ${esc(p.chain)}</span><span>${usdc(p.amount_units)}</span></div>`)
      .join("");
    query("[data-payout-quotes]").hidden = false;
    say(error, "");
  } catch (cause) {
    say(error, errorText(cause), "error");
  } finally {
    button.disabled = false;
  }
}

async function send() {
  const session = state.session!;
  const button = query<HTMLButtonElement>("[data-payout-send]");
  button.disabled = true;
  say(error, "Signing with your passkey…");
  try {
    await sendUsdc(session, quoted);
    const auth = await businessAuth(session, "save-payee");
    await Promise.all(quoted.map((p) => api.savePayee(auth, { name: p.payee_name, asset_id: p.asset_id, recipient: p.recipient }).catch(() => undefined)));
    showToast(quoted.length === 1 ? "Payout sent" : `${quoted.length} payouts sent`);
    setMode(mode);
    say(error, "");
    await loadPayouts();
  } catch (cause) {
    say(error, errorText(cause), "error");
    button.disabled = false;
  }
}

export function initPayouts() {
  for (const b of queryAll<HTMLButtonElement>("[data-payout-mode] button")) b.addEventListener("click", () => setMode(b.dataset.mode as typeof mode));
  query("[data-add-row]").addEventListener("click", () => addRow());
  rowsEl.addEventListener("input", () => (refreshTotal(), hideQuotes()));
  rowsEl.addEventListener("click", (event) => {
    const remove = (event.target as HTMLElement).closest("[data-remove]");
    if (remove && rowsEl.children.length > 1) remove.closest(".payout-row")!.remove();
    refreshTotal();
    hideQuotes();
  });
  query<HTMLSelectElement>("[data-payee-pick]").addEventListener("change", (event) => {
    const select = event.target as HTMLSelectElement;
    const payee = payees.find((p) => p.id === select.value);
    select.value = "";
    if (!payee) return;
    const values = { payee_name: payee.name, asset_id: payee.asset_id, recipient: payee.recipient };
    const rows = queryAll(".payout-row", rowsEl);
    const empty = rows.find((r) => !query<HTMLInputElement>("[data-f=payee_name]", r).value);
    if (mode === "single" || empty) {
      (empty ?? rows[0]).remove();
    }
    addRow(values);
  });
  query<HTMLInputElement>("[data-payroll-file]").addEventListener("change", async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const parsed = parsePayrollCsv(await file.text());
    const missing: string[] = [];
    rowsEl.innerHTML = "";
    for (const r of parsed) {
      const token = tokens.find((t) => t.blockchain === r.chain && t.symbol === r.token);
      if (!token) missing.push(`${r.payee_name} (${r.token} on ${r.chain})`);
      addRow({ payee_name: r.payee_name, amount: r.amount, recipient: r.recipient, asset_id: token?.assetId });
    }
    say(error, missing.length ? `Pick a supported token for: ${missing.join(", ")}` : `${parsed.length} people imported.`, missing.length ? "error" : "info");
  });
  query("[data-payout-quote]").addEventListener("click", () => void quote());
  query<HTMLInputElement>("[data-payout-confirm]").addEventListener("change", (event) => {
    query<HTMLButtonElement>("[data-payout-send]").disabled = !(event.target as HTMLInputElement).checked;
  });
  query("[data-payout-send]").addEventListener("click", () => void send());
  query("[data-payout-export]").addEventListener("click", () => {
    const blob = new Blob([payoutsCsv(history.filter((p) => p.status !== "quoted"))], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.session?.accountId ?? "opencash"}-payouts.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  query("[data-payee-list]").addEventListener("click", async (event) => {
    const id = (event.target as HTMLElement).dataset.payeeDelete;
    if (!id || !state.session) return;
    await api.deletePayee(await businessAuth(state.session, "delete-payee"), id);
    payees = payees.filter((p) => p.id !== id);
    renderPayees();
  });
}
