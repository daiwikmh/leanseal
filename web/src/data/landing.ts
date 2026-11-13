export type FolderIconKind = "terminal" | "bins" | "limits";

export type FolderPage = {
  label: string;
  title: string;
  description: string;
  facts: [label: string, value: string][];
  caption: string;
  icon: FolderIconKind;
};

export const folderPages: FolderPage[] = [
  {
    label: "GET PAID",
    title: "Any chain in.\nUSDC out.",
    description:
      "Invoices, reusable payment links and a checkout API. Customers pay with what they already hold; you receive the exact amount in USDC on NEAR.",
    facts: [
      ["CUSTOMERS PAY", "USDC, ETH, SOL, BTC…"],
      ["ROUTED BY", "NEAR Intents"],
      ["YOU RECEIVE", "Exact USDC"],
      ["STATUS", "On-chain, with proof"],
    ],
    caption: "Built for customers who don't care about crypto.",
    icon: "limits",
  },
  {
    label: "PAY OUT",
    title: "USDC in.\nAny chain out.",
    description:
      "Pay a contractor, a supplier or a whole payroll. Each person gets the token and chain they want; you sign once with your passkey.",
    facts: [
      ["PAYOUTS", "One or many"],
      ["PAYROLL", "Up to 20 per signature"],
      ["DELIVERY", "NEAR Intents"],
      ["GAS", "Paid by opencash"],
    ],
    caption: "Remittances without the wire fees.",
    icon: "bins",
  },
  {
    label: "BUILD ON IT",
    title: "An API.\nNot just an app.",
    description:
      "API keys, checkouts, invoices and signed webhooks, so your product can take any-chain payments without touching a bridge.",
    facts: [
      ["API", "/v1/checkouts · /v1/invoices"],
      ["WEBHOOKS", "HMAC-signed, retried"],
      ["KEYS", "Shown once, hashed"],
      ["CUSTODY", "Never ours"],
    ],
    caption: "Payments infrastructure for real businesses.",
    icon: "terminal",
  },
];

export const steps = [
  {
    name: "Open",
    position: "issue",
    insert: "ONE PASSKEY",
    glyph: "⌘",
    description: "One passkey tap opens a USDC business account on NEAR. No seed phrase, no wallet app, no NEAR to buy.",
  },
  {
    name: "Get paid",
    position: "verify",
    insert: "ANY CHAIN",
    glyph: "↓",
    description: "Send an invoice, share a payment link or call the checkout API. Customers pay from any chain; you receive USDC.",
  },
  {
    name: "Pay out",
    position: "collateral",
    insert: "ANY CHAIN",
    glyph: "↑",
    description: "Pay one person or a whole payroll. Each recipient gets the token and chain they choose. One signature, no gas.",
  },
  {
    name: "Reconcile",
    position: "settlement",
    insert: "ON-CHAIN",
    glyph: "↗",
    description: "Every status is recorded with links to both chains. Webhooks tell your systems; CSV exports tell your accountant.",
  },
] as const;

export const phone = {
  invoices: [
    ["N", "Northwind", "Paid · USDC on Arbitrum", "+$1,250.50"],
    ["A", "Ada Okafor", "Payout · USDC on Base", "−$1,200.00"],
    ["P", "Pro plan checkout", "Paid · ETH on Base", "+$49.00"],
  ],
} as const;

export const demoSteps = [
  {
    name: "Customer pays",
    description: "Northwind pays a $1,250.50 invoice with USDC on Arbitrum. NEAR Intents delivers exactly $1,250.50 USDC to acme.opencash.near.",
    next: "Webhook fires",
  },
  {
    name: "Webhook fires",
    description: "Your server receives invoice.paid, signed with HMAC-SHA256, with links to the payment on Arbitrum and the settlement on NEAR.",
    next: "Run payroll",
  },
  {
    name: "Run payroll",
    description: "You upload a CSV of three contractors. One wants USDC on Base, one SOL, one USDT on Tron. You sign once with your passkey.",
    next: "Everyone is paid",
  },
  {
    name: "Everyone is paid",
    description: "Each payout is delivered on its own chain. Statuses, transaction links and a payroll CSV are ready for your accountant.",
    next: "Start again",
  },
] as const;
