import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Jurisdiction } from "./company.js";

export type Address = { line1: string; line2: string; city: string; region: string; postal: string; country: string };

export type Founder = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  country: string;
  date_of_birth: string;
  nationality: string;
  address: Address;
  tax_id_type: "none" | "ssn" | "itin";
  tax_id: string;
};

export type Member = { name: string; ownership_pct: number };

export type Intake = {
  founder: Founder;
  company: {
    jurisdiction: Jurisdiction;
    names: string[];
    industry: string;
    description: string;
    website: string;
    use_agent_address: boolean;
    business_address: Address;
    fiscal_year_end_month: number;
  };
  llc: { management: "member" | "manager"; members: Member[] };
  corp: {
    president: string;
    secretary: string;
    treasurer: string;
    directors: string[];
    authorized_shares: number;
    par_value: string;
    shareholders: Member[];
  };
  ein: {
    order: boolean;
    reason: string;
    expects_employees: boolean;
    employee_count: number;
    first_wage_date: string;
    principal_activity: string;
    line_of_business: string;
    excise_none: boolean;
  };
};

export const designators: Record<Jurisdiction, string[]> = {
  "wy-llc": ["LLC", "L.L.C.", "Limited Liability Company"],
  "de-ccorp": ["Inc.", "Corp.", "Corporation", "Incorporated"],
};

export const industries = [
  "Software & SaaS",
  "Design & creative services",
  "Consulting & professional services",
  "Marketing & advertising",
  "E-commerce & online retail",
  "Education & training",
  "Media & content",
  "Finance & fintech",
  "Health & wellness",
  "Other",
];

export const einReasons = ["Started new business", "Banking purpose", "Hired employees", "Changed type of organization", "Other"];

export const principalActivities = [
  "Other (services)",
  "Retail",
  "Wholesale",
  "Finance & insurance",
  "Real estate",
  "Construction",
  "Manufacturing",
  "Transportation & warehousing",
  "Health care & social assistance",
  "Accommodation & food service",
];

export const exciseItems = [
  "Highway vehicles weighing 55,000 lbs or more",
  "Gambling or wagering",
  "Federal excise taxes (Form 720)",
  "Alcohol, tobacco or firearms",
  "Payroll tax under $1,000 a year (Form 944)",
];

export const emptyAddress = (): Address => ({ line1: "", line2: "", city: "", region: "", postal: "", country: "" });

export function emptyIntake(jurisdiction: Jurisdiction = "wy-llc"): Intake {
  return {
    founder: {
      first_name: "",
      last_name: "",
      email: "",
      phone: "",
      country: "",
      date_of_birth: "",
      nationality: "",
      address: emptyAddress(),
      tax_id_type: "none",
      tax_id: "",
    },
    company: {
      jurisdiction,
      names: ["", "", ""],
      industry: industries[0],
      description: "",
      website: "",
      use_agent_address: true,
      business_address: emptyAddress(),
      fiscal_year_end_month: 12,
    },
    llc: { management: "member", members: [] },
    corp: {
      president: "",
      secretary: "",
      treasurer: "",
      directors: [],
      authorized_shares: 10_000_000,
      par_value: "0.00001",
      shareholders: [],
    },
    ein: {
      order: true,
      reason: einReasons[0],
      expects_employees: false,
      employee_count: 0,
      first_wage_date: "",
      principal_activity: principalActivities[0],
      line_of_business: "",
      excise_none: true,
    },
  };
}

export type IntakeStep = "founder" | "company" | "owners" | "ein";

export type IntakeError = { step: IntakeStep; field: string; message: string };

const filled = (value: string) => value.trim().length > 0;

function checkAddress(address: Address, step: IntakeStep, prefix: string, errors: IntakeError[]) {
  for (const key of ["line1", "city", "region", "postal", "country"] as const) {
    if (!filled(address[key])) errors.push({ step, field: `${prefix}.${key}`, message: `Address ${key === "line1" ? "line 1" : key} is required.` });
  }
}

function checkShares(members: Member[], step: IntakeStep, field: string, label: string, errors: IntakeError[]) {
  if (members.length === 0) return errors.push({ step, field, message: `Add at least one ${label}.` });
  if (members.some((m) => !filled(m.name))) errors.push({ step, field, message: `Every ${label} needs a full name.` });
  if (members.some((m) => !(m.ownership_pct > 0))) errors.push({ step, field, message: `Every ${label} needs an ownership share above 0%.` });
  const total = members.reduce((sum, m) => sum + m.ownership_pct, 0);
  if (Math.abs(total - 100) > 0.001) errors.push({ step, field, message: `Ownership must add up to 100% (now ${total}%).` });
}

export function validateIntake(intake: Intake, only?: IntakeStep): IntakeError[] {
  const errors: IntakeError[] = [];
  const f = intake.founder;
  if (!filled(f.first_name) || !filled(f.last_name)) errors.push({ step: "founder", field: "founder.name", message: "Legal first and last name are required, as on your ID." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) errors.push({ step: "founder", field: "founder.email", message: "A valid email is required. The IRS signature link is sent there." });
  if (!/^\+[1-9]\d{6,14}$/.test(f.phone.replace(/[\s()-]/g, ""))) errors.push({ step: "founder", field: "founder.phone", message: "Phone must be in international format, e.g. +91 98765 43210." });
  if (!filled(f.country)) errors.push({ step: "founder", field: "founder.country", message: "Country of residence is required." });
  if (f.date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(f.date_of_birth)) errors.push({ step: "founder", field: "founder.date_of_birth", message: "Date of birth must be YYYY-MM-DD." });
  checkAddress(f.address, "founder", "founder.address", errors);
  if (f.tax_id_type !== "none" && !/^\d{3}-?\d{2}-?\d{4}$/.test(f.tax_id.trim())) errors.push({ step: "founder", field: "founder.tax_id", message: "SSN/ITIN must be 9 digits (XXX-XX-XXXX)." });

  const c = intake.company;
  const suffixes = designators[c.jurisdiction];
  const [first, ...alternates] = c.names.map((n) => n.trim());
  if (!first) errors.push({ step: "company", field: "company.names", message: "Enter at least one company name." });
  for (const name of [first, ...alternates].filter(Boolean)) {
    if (!suffixes.some((s) => name.toLowerCase().endsWith(` ${s.toLowerCase()}`))) {
      errors.push({ step: "company", field: "company.names", message: `"${name}" must end with ${suffixes.slice(0, 2).join(" or ")}.` });
    }
  }
  if (!filled(c.industry)) errors.push({ step: "company", field: "company.industry", message: "Pick an industry." });
  if (!filled(c.description) || c.description.trim().length > 50) errors.push({ step: "company", field: "company.description", message: "Describe the business in 50 characters or fewer." });
  if (c.website && !/^https?:\/\/\S+\.\S+/.test(c.website.trim())) errors.push({ step: "company", field: "company.website", message: "Website must start with https://." });
  if (!c.use_agent_address) checkAddress(c.business_address, "company", "company.business_address", errors);
  if (!(c.fiscal_year_end_month >= 1 && c.fiscal_year_end_month <= 12)) errors.push({ step: "company", field: "company.fiscal_year_end_month", message: "Fiscal year end must be a month from 1 to 12." });

  if (c.jurisdiction === "wy-llc") {
    checkShares(intake.llc.members, "owners", "llc.members", "member", errors);
  } else {
    const k = intake.corp;
    for (const role of ["president", "secretary", "treasurer"] as const) {
      if (!filled(k[role])) errors.push({ step: "owners", field: `corp.${role}`, message: `Name the ${role}. One person may hold every role.` });
    }
    if (k.directors.filter(filled).length === 0) errors.push({ step: "owners", field: "corp.directors", message: "Add at least one director." });
    if (!(Number.isInteger(k.authorized_shares) && k.authorized_shares > 0)) errors.push({ step: "owners", field: "corp.authorized_shares", message: "Authorized shares must be a whole number above 0." });
    if (!/^\d+(\.\d+)?$/.test(k.par_value)) errors.push({ step: "owners", field: "corp.par_value", message: "Par value must be a number, e.g. 0.00001." });
    checkShares(k.shareholders, "owners", "corp.shareholders", "shareholder", errors);
  }

  const e = intake.ein;
  if (e.order) {
    if (!einReasons.includes(e.reason)) errors.push({ step: "ein", field: "ein.reason", message: "Pick a reason for applying." });
    if (e.expects_employees) {
      if (!(e.employee_count > 0)) errors.push({ step: "ein", field: "ein.employee_count", message: "How many employees do you expect in the next 12 months?" });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.first_wage_date)) errors.push({ step: "ein", field: "ein.first_wage_date", message: "First wage date must be YYYY-MM-DD." });
    }
    if (!principalActivities.includes(e.principal_activity)) errors.push({ step: "ein", field: "ein.principal_activity", message: "Pick the principal activity." });
    if (!filled(e.line_of_business)) errors.push({ step: "ein", field: "ein.line_of_business", message: "Describe what you sell or the service you provide." });
    if (!e.excise_none) errors.push({ step: "ein", field: "ein.excise_none", message: "Excise activities need a specialist; opencash can't file this EIN for you." });
  }

  return only ? errors.filter((err) => err.step === only) : errors;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export function canonicalIntake(intake: Intake): string {
  return JSON.stringify(sortKeys(intake));
}

export function intakeHash(intake: Intake): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalIntake(intake))))}`;
}

export function applicationMessage(accountId: string, signedAtMs: number, intakeHash: string): string {
  return `opencash/application/v1\n${accountId}\n${signedAtMs}\n${intakeHash}`;
}

export function signedRequest(
  accountId: string,
  key: { publicKey: string; secretKey: string },
  subject: string,
  sign: (secretKey: string, message: string) => string,
) {
  const signed_at = Date.now();
  return { account_id: accountId, public_key: key.publicKey, signed_at, signature: sign(key.secretKey, applicationMessage(accountId, signed_at, subject)) };
}
