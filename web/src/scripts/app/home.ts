import type { Invoice } from "shared";
import { api } from "../lib/api";
import { moneyHtml, query, short, usdc } from "../lib/dom";
import { showToast } from "../lib/toast";
import { bindRows, invoiceTable } from "./invoices";
import { openModal } from "./modal";
import { state } from "./state";

function sum(invoices: Invoice[]): string {
  return invoices.reduce((total, inv) => total + BigInt(inv.amount), 0n).toString();
}

export async function loadBalance() {
  if (!state.session) return;
  const { usdc: units } = await api.balance(state.session.accountId);
  query("[data-home-balance]").innerHTML = moneyHtml(units);
}

export function renderHome() {
  const { company, invoices, session } = state;
  if (!company || !session) return;
  query("[data-home-company]").textContent = company.legal_name;
  query("[data-home-account]").textContent = short(session.accountId);

  const month = new Date();
  month.setDate(1);
  month.setHours(0, 0, 0, 0);
  const paid = invoices.filter((inv) => inv.status === "paid" && inv.created_at_ms >= month.getTime());
  const waiting = invoices.filter((inv) => inv.status === "open" || inv.status === "pending");
  query("[data-stat-paid]").textContent = usdc(sum(paid));
  query("[data-stat-paid-sub]").textContent = `${paid.length} invoice${paid.length === 1 ? "" : "s"}`;
  query("[data-stat-open]").textContent = usdc(sum(waiting));
  query("[data-stat-open-sub]").textContent = `${waiting.length} invoice${waiting.length === 1 ? "" : "s"}`;

  const wrap = query("[data-home-invoices]");
  wrap.classList.remove("table-wrap--loading");
  wrap.innerHTML = invoiceTable(invoices.slice(0, 5), "No invoices yet. Create one and send the link.");
  bindRows(wrap);
}

export function initHome() {
  query("[data-home-refresh]").addEventListener("click", () => void loadBalance());
  query("[data-open-receive]").addEventListener("click", () => {
    const account = state.session?.accountId ?? "";
    const body = openModal(
      "Receive USDC",
      `<p class="panel__lede">Send USDC on NEAR straight to this account, or create an invoice so clients can pay from any chain.</p>
       <label class="field" style="margin-top:var(--sp-md)"><span>NEAR account</span><input readonly value="${account}" /></label>
       <div class="btn-row" style="margin-top:var(--sp-md)"><button type="button" class="btn btn--primary" data-copy>Copy account</button></div>`,
    );
    query("[data-copy]", body).addEventListener("click", async () => {
      await navigator.clipboard.writeText(account);
      showToast("Account copied");
    });
  });
}
