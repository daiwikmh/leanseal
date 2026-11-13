import { api } from "../lib/api";
import { lastAccount, type PasskeySession } from "../lib/passkey";
import { initAccount, renderAccount } from "./account";
import { initAgreements, loadAgreements } from "./agreements";
import { initPayouts, loadPayouts } from "./payouts";
import { initLinks, loadLinks } from "./links";
import { initAgents, loadAgents } from "./agents";
import { initDevelopers, loadDevelopers } from "./developers";
import { initCompany, renderCompany } from "./company";
import { initFormation, renderFormation } from "./formation";
import { hideGate, initGate } from "./gate";
import { initHome, loadBalance, renderHome } from "./home";
import { initInvoices, loadInvoices, renderInvoices } from "./invoices";
import "./modal";
import { state } from "./state";
import { activateTab, initTabs, onTab } from "./tabs";

async function enter(session: PasskeySession) {
  state.session = session;
  state.company ??= await api.company(session.accountId);
  hideGate();
  renderAccount();
  renderHome();
  renderCompany();
  activateTab("home");
  const banner = document.querySelector<HTMLElement>("[data-preview]");
  if (banner && state.preview) {
    banner.hidden = false;
    banner.querySelector("[data-preview-reason]")!.textContent = state.preview;
  }
  await Promise.allSettled([loadInvoices().then(() => (renderHome(), renderInvoices())), loadBalance()]);
  if (state.preview) {
    for (const el of document.querySelectorAll<HTMLElement>(".table-wrap--loading")) {
      el.classList.remove("table-wrap--loading");
      el.innerHTML = `<p class="empty">Nothing yet: the registry contract isn't deployed.</p>`;
    }
  }
}

initTabs();
initHome();
initInvoices();
initAccount();
initCompany();
initAgreements();
initPayouts();
initLinks();
initAgents();
initDevelopers();
initFormation(async () => renderCompany());
initGate(enter);
onTab("invoices", renderInvoices);
onTab("company", () => (renderCompany(), renderFormation()));
onTab("agreements", () => void loadAgreements());
onTab("payouts", () => void loadPayouts());
onTab("links", () => void loadLinks());
onTab("agents", () => void loadAgents());
onTab("developers", () => void loadDevelopers());

if (lastAccount()) {
  document.querySelector<HTMLButtonElement>("[data-show-signin]")?.click();
}
