import { accountUrl, jurisdictions, milestones, network, signWithNearKey, signedRequest } from "shared";
import { api } from "../lib/api";
import { date, errorText, esc, query } from "../lib/dom";
import { state } from "./state";
import { stepsHtml } from "./steps";

const fallbackFilings: Record<string, string[]> = {
  "wy-llc": [
    "Form 5472 + pro forma 1120 every year (foreign-owned single-member LLC)",
    "Wyoming Annual Report on the first day of your formation month",
    "Registered agent renewal",
  ],
  "de-ccorp": [
    "Form 1120 corporate tax return every year",
    "Form 5472 if a foreign shareholder owns 25% or more",
    "Delaware franchise tax and annual report by March 1",
  ],
};

export function renderCompany() {
  const company = state.company;
  if (!company) return;
  query("[data-company-name]").textContent = company.legal_name;
  query("[data-company-type]").textContent = company.jurisdiction ? jurisdictions[company.jurisdiction].label : "No US entity yet · payments work without one";
  query("[data-company-country]").textContent = company.country;
  query("[data-company-status]").textContent = milestones.find((m) => m.key === company.status)?.label ?? company.status;
  query("[data-company-opened]").textContent = date(company.created_at_ms);
  query<HTMLAnchorElement>("[data-company-record]").href = accountUrl(network.contract);
  query("[data-company-steps]").innerHTML = stepsHtml(company.status);
  const filings: string[] = state.advice?.filings ?? (company.jurisdiction ? fallbackFilings[company.jurisdiction] : []);
  query("[data-company-filings]").innerHTML = filings.length
    ? filings.map((f) => `<li>${esc(f)}</li>`).join("")
    : "<li>Appear here once you choose an entity in the formation application.</li>";
  const hash = company.application_hash;
  query("[data-application-state]").textContent = hash
    ? "Your answers are stored encrypted. This hash on NEAR proves exactly what you submitted."
    : "No application on file yet.";
  query("[data-application-hash]").textContent = hash ?? "";
  query("[data-application-view]").hidden = !hash;
  query("[data-company-docs]").innerHTML = company.doc_hashes.length
    ? company.doc_hashes.map((h) => `<li>${esc(h)}</li>`).join("")
    : "<li>No documents recorded yet. Hashes appear here as each filing completes.</li>";
}

function row(label: string, value: string): string {
  return `<div class="leg-row"><span>${esc(label)}</span><span>${esc(value || "—")}</span></div>`;
}

export function initCompany() {
  const button = query<HTMLButtonElement>("[data-application-view]");
  const body = query("[data-application-body]");
  button.addEventListener("click", async () => {
    const session = state.session;
    if (!session) return;
    button.disabled = true;
    try {
      const { intake } = await api.readApplication(signedRequest(session.accountId, session.key, "read", signWithNearKey));
      const f = intake.founder;
      const owners = intake.company.jurisdiction === "wy-llc" ? intake.llc.members : intake.corp.shareholders;
      body.innerHTML = [
        row("Founder", `${f.first_name} ${f.last_name}`),
        row("Email", f.email),
        row("Phone", f.phone),
        row("Home address", [f.address.line1, f.address.city, f.address.region, f.address.postal, f.address.country].filter(Boolean).join(", ")),
        row("US tax ID", f.tax_id_type === "none" ? "None (SS-4 signature needed)" : `${f.tax_id_type.toUpperCase()} on file`),
        row("Names", intake.company.names.filter(Boolean).join(" · ")),
        row("Industry", intake.company.industry),
        row("Description", intake.company.description),
        row("Owners", owners.map((o) => `${o.name} ${o.ownership_pct}%`).join(", ")),
        row("EIN", intake.ein.order ? `${intake.ein.reason} · ${intake.ein.principal_activity}` : "Not requested"),
      ].join("");
      body.hidden = false;
      button.hidden = true;
    } catch (error) {
      body.hidden = false;
      body.innerHTML = `<p class="error-text">${esc(errorText(error))}</p>`;
      button.disabled = false;
    }
  });
}
