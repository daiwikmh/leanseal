export type Jurisdiction = "wy-llc" | "de-ccorp";

export type CompanyStatus = "draft" | "filed" | "ein" | "active";

export type InvoiceStatus = "open" | "pending" | "paid" | "refunded";

export type LineItem = { description: string; amount: string };

export type Company = {
  account_id: string;
  owner: string;
  legal_name: string;
  jurisdiction: Jurisdiction | null;
  country: string;
  status: CompanyStatus;
  created_at_ms: number;
  updated_at_ms: number;
  doc_hashes: string[];
  application_hash: string | null;
};

export type Payment = {
  origin_asset: string;
  origin_chain: string;
  amount_in: string;
  amount_in_usd: string;
  origin_tx_url: string | null;
  refund_reason: string | null;
  payer?: string | null;
};

export type Invoice = {
  id: string;
  company: string;
  client_name: string;
  amount: string;
  due_ms: number;
  items: LineItem[];
  status: InvoiceStatus;
  created_at_ms: number;
  deposit_address: string | null;
  settle_tx: string | null;
  paid_at_ms: number | null;
  payment: Payment | null;
  source: "direct" | "link" | "api" | "chat";
  reference: string | null;
};

export const jurisdictions: Record<Jurisdiction, { label: string; short: string; summary: string }> = {
  "wy-llc": {
    label: "Wyoming LLC",
    short: "WY LLC",
    summary: "Low fees, no state income tax, simple annual report. Best for solo founders and service businesses.",
  },
  "de-ccorp": {
    label: "Delaware C-Corp",
    short: "DE C-Corp",
    summary: "The standard for raising venture capital and issuing stock options.",
  },
};

export const milestones: { key: CompanyStatus; label: string; detail: string }[] = [
  { key: "draft", label: "Account live", detail: "Your NEAR business account exists and can receive USDC today." },
  { key: "filed", label: "Formation filed", detail: "Articles submitted to the state." },
  { key: "ein", label: "EIN issued", detail: "IRS tax ID received. Without an SSN this takes 10–35 business days." },
  { key: "active", label: "Ready for banking", detail: "Documents complete. Connect a US bank or card processor." },
];

export function milestoneIndex(status: CompanyStatus): number {
  return milestones.findIndex((m) => m.key === status);
}

export const usdcDecimals = 6;

export function toUnits(value: string, decimals = usdcDecimals): string {
  const [whole, fraction = ""] = value.trim().split(".");
  return BigInt(`${whole || "0"}${fraction.padEnd(decimals, "0").slice(0, decimals)}`).toString();
}

export function fromUnits(units: string, decimals = usdcDecimals): string {
  const padded = units.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function invoiceTotal(items: LineItem[]): string {
  return items.reduce((sum, item) => sum + BigInt(toUnits(item.amount)), 0n).toString();
}

export function formatUsd(units: string): string {
  const [whole, fraction = ""] = fromUnits(units).split(".");
  return `$${Number(whole).toLocaleString("en-US")}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

export const handlePattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
