import {
  emptyIntake,
  intakeHash,
  jurisdictions,
  signWithNearKey,
  signedRequest,
  validateIntake,
  type Intake,
  type IntakeStep,
  type Jurisdiction,
  type Member,
} from "shared";
import { api } from "../lib/api";
import { errorText, esc, query, queryAll, say } from "../lib/dom";
import { showToast } from "../lib/toast";
import { state } from "./state";

const order: IntakeStep[] = ["founder", "company", "owners", "ein"];
const form = query<HTMLFormElement>("[data-formation-form]");
const status = query("[data-formation-status]");
const nextButton = query<HTMLButtonElement>("[data-next]", form);
const prevButton = query<HTMLButtonElement>("[data-prev]", form);
const submitButton = query<HTMLButtonElement>("[data-submit]", form);
const askButton = query<HTMLButtonElement>("[data-ask]", form);
const owners: Record<"llc.members" | "corp.shareholders", Member[]> = { "llc.members": [], "corp.shareholders": [] };
let step = 0;

function input(name: string): HTMLInputElement | HTMLSelectElement {
  return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
}

function text(name: string): string {
  return input(name).value.trim();
}

function checked(name: string): boolean {
  return (input(name) as HTMLInputElement).checked;
}

function address(prefix: string) {
  return {
    line1: text(`${prefix}.line1`),
    line2: text(`${prefix}.line2`),
    city: text(`${prefix}.city`),
    region: text(`${prefix}.region`),
    postal: text(`${prefix}.postal`),
    country: text(`${prefix}.country`),
  };
}

function jurisdiction(): Jurisdiction {
  return text("company.jurisdiction") as Jurisdiction;
}

function founderName(): string {
  return `${text("founder.first_name")} ${text("founder.last_name")}`.trim();
}

function readIntake(): Intake {
  const base = emptyIntake(jurisdiction());
  return {
    founder: {
      first_name: text("founder.first_name"),
      last_name: text("founder.last_name"),
      email: text("founder.email"),
      phone: text("founder.phone"),
      country: text("founder.country"),
      date_of_birth: text("founder.date_of_birth"),
      nationality: text("founder.nationality"),
      address: address("founder.address"),
      tax_id_type: text("founder.tax_id_type") as Intake["founder"]["tax_id_type"],
      tax_id: text("founder.tax_id_type") === "none" ? "" : text("founder.tax_id"),
    },
    company: {
      jurisdiction: jurisdiction(),
      names: [0, 1, 2].map((i) => text(`company.names.${i}`)),
      industry: text("company.industry"),
      description: text("company.description"),
      website: text("company.website"),
      use_agent_address: checked("company.use_agent_address"),
      business_address: checked("company.use_agent_address") ? base.company.business_address : address("company.business_address"),
      fiscal_year_end_month: Number(text("company.fiscal_year_end_month")),
    },
    llc: { management: text("llc.management") as "member" | "manager", members: owners["llc.members"] },
    corp: {
      president: text("corp.president"),
      secretary: text("corp.secretary"),
      treasurer: text("corp.treasurer"),
      directors: text("corp.directors").split(",").map((d) => d.trim()).filter(Boolean),
      authorized_shares: Number(text("corp.authorized_shares")),
      par_value: text("corp.par_value"),
      shareholders: owners["corp.shareholders"],
    },
    ein: {
      order: checked("ein.order"),
      reason: text("ein.reason"),
      expects_employees: checked("ein.expects_employees"),
      employee_count: Number(text("ein.employee_count") || 0),
      first_wage_date: text("ein.first_wage_date"),
      principal_activity: text("ein.principal_activity"),
      line_of_business: text("ein.line_of_business"),
      excise_none: checked("ein.excise_none"),
    },
  };
}

function renderOwners(key: keyof typeof owners) {
  const wrap = query(`[data-owners="${key}"]`);
  wrap.innerHTML = owners[key]
    .map(
      (m, i) => `<div class="owner-row">
        <label class="gfield"><span>Full legal name</span><input data-owner-name="${i}" value="${esc(m.name)}" /></label>
        <label class="gfield"><span>Ownership %</span><input data-owner-pct="${i}" inputmode="decimal" value="${m.ownership_pct || ""}" /></label>
        <button type="button" class="gate__link" data-owner-remove="${i}" ${owners[key].length === 1 ? "hidden" : ""} aria-label="Remove">×</button>
      </div>`,
    )
    .join("");
  wrap.oninput = (event) => {
    const el = event.target as HTMLInputElement;
    if (el.dataset.ownerName) owners[key][Number(el.dataset.ownerName)].name = el.value;
    if (el.dataset.ownerPct) owners[key][Number(el.dataset.ownerPct)].ownership_pct = Number(el.value);
  };
  wrap.onclick = (event) => {
    const remove = (event.target as HTMLElement).dataset.ownerRemove;
    if (remove === undefined) return;
    owners[key].splice(Number(remove), 1);
    renderOwners(key);
  };
}

function prefillOwners() {
  const name = founderName();
  for (const key of Object.keys(owners) as (keyof typeof owners)[]) {
    if (owners[key].length === 0) owners[key].push({ name, ownership_pct: 100 });
    else if (owners[key].length === 1 && !owners[key][0].name) owners[key][0].name = name;
    renderOwners(key);
  }
  for (const role of ["corp.president", "corp.secretary", "corp.treasurer", "corp.directors"]) {
    if (!text(role)) input(role).value = name;
  }
}

function syncConditional() {
  for (const el of queryAll("[data-show-when]")) {
    const rule = el.dataset.showWhen!;
    const [name, expected] = rule.split(/!?=/);
    const field = input(name) as HTMLInputElement;
    const value = field.type === "checkbox" ? String(field.checked) : field.value;
    el.hidden = rule.includes("!=") ? value === expected : value !== expected;
  }
  for (const el of queryAll("[data-when-entity]")) el.hidden = el.dataset.whenEntity !== jurisdiction();
  for (const el of queryAll<HTMLInputElement>("[data-name-input]")) {
    el.placeholder = el.placeholder.replace(/ (LLC|Inc\.)$/, jurisdiction() === "wy-llc" ? " LLC" : " Inc.");
  }
}

function showStep(index: number) {
  step = index;
  for (const el of queryAll("[data-step]")) el.hidden = el.dataset.step !== order[step];
  for (const [i, el] of queryAll("[data-step-tab]").entries()) {
    el.classList.toggle("is-now", i === step);
    el.classList.toggle("is-done", i < step);
  }
  prevButton.hidden = step === 0;
  nextButton.hidden = step === order.length - 1;
  submitButton.hidden = step !== order.length - 1;
  if (order[step] === "owners") prefillOwners();
  say(status, "");
  form.scrollIntoView({ block: "start", behavior: "smooth" });
}

function stepErrors(): string | null {
  const intake = readIntake();
  const errors = validateIntake(intake, order[step]);
  return errors[0]?.message ?? null;
}

function showAdvice() {
  const advice = state.advice;
  query("[data-advice]").hidden = advice === null;
  if (!advice) return;
  query("[data-advice-pick]").textContent = jurisdictions[advice.jurisdiction].label;
  query("[data-advice-why]").textContent = advice.reason;
  query("[data-advice-filings]").innerHTML = advice.filings.map((f) => `<li>${esc(f)}</li>`).join("");
}

export function renderFormation() {
  const company = state.company;
  const filed = Boolean(company?.application_hash);
  query("[data-formation-start]").hidden = filed || !form.hidden;
  query("[data-formation-intro]").textContent = filed
    ? `Application on file for ${company?.legal_name}${company?.jurisdiction ? ` (${jurisdictions[company.jurisdiction].label})` : ""}. Its hash is recorded on NEAR.`
    : "Need a US entity for clients, Stripe or a bank? File a Wyoming LLC or Delaware C-Corp with the same details doola and Stripe Atlas ask for. Your answers are encrypted; only a hash goes on NEAR. Payments work without this.";
}

export function initFormation(onFiled: () => Promise<void>) {
  syncConditional();
  query("[data-formation-start]").addEventListener("click", () => {
    form.hidden = false;
    const company = state.company;
    if (company && !text("company.names.0")) input("company.names.0").value = `${company.legal_name} LLC`;
    if (company && !text("founder.country")) input("founder.country").value = company.country;
    renderFormation();
    showStep(0);
  });
  form.addEventListener("input", syncConditional);
  form.addEventListener("change", syncConditional);
  nextButton.addEventListener("click", () => {
    const error = stepErrors();
    if (error) return say(status, error, "error");
    showStep(step + 1);
  });
  prevButton.addEventListener("click", () => showStep(step - 1));
  for (const button of queryAll<HTMLButtonElement>("[data-add-owner]", form)) {
    button.addEventListener("click", () => {
      const key = button.dataset.addOwner as keyof typeof owners;
      owners[key].push({ name: "", ownership_pct: 0 });
      renderOwners(key);
    });
  }
  askButton.addEventListener("click", async () => {
    if (!text("founder.country")) return say(status, "Fill in your country on the first step.", "error");
    askButton.disabled = true;
    say(status, "Asking the advisor…");
    try {
      state.advice = await api.advise({ country: text("founder.country"), plan: text("plan"), company: text("company.names.0") });
      input("company.jurisdiction").value = state.advice.jurisdiction;
      syncConditional();
      say(status, "");
    } catch (error) {
      say(status, errorText(error), "error");
    } finally {
      askButton.disabled = false;
      showAdvice();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const session = state.session;
    if (!session) return;
    const intake = readIntake();
    const errors = validateIntake(intake);
    if (errors.length > 0) {
      showStep(order.indexOf(errors[0].step));
      return say(status, errors[0].message, "error");
    }
    submitButton.disabled = true;
    try {
      say(status, "Signing and sending your encrypted application…");
      const request = signedRequest(session.accountId, session.key, intakeHash(intake), signWithNearKey);
      const { company } = await api.submitApplication({ ...request, intake });
      state.company = company;
      form.hidden = true;
      showToast("Application submitted");
      await onFiled();
    } catch (error) {
      say(status, errorText(error), "error");
      submitButton.disabled = false;
    }
  });
}
