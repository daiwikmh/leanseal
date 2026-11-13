import { fromUnits, type Invoice } from "./company.js";
import { txUrl } from "./network.js";

const headers = [
  "Invoice ID",
  "Client",
  "Issue date",
  "Due date",
  "Paid date",
  "Description",
  "Invoice amount (USD)",
  "Received (USDC)",
  "Status",
  "Client paid with",
  "Amount client sent",
  "Client sent (USD)",
  "Payment transaction (client's chain)",
  "Settlement transaction (NEAR)",
  "Received by",
  "Refund reason",
];

function cell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function isoDate(ms: number | null): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "";
}

export function invoicesCsv(invoices: Invoice[]): string {
  const rows = invoices.map((invoice) => {
    const payment = invoice.payment;
    const paid = invoice.status === "paid";
    return [
      invoice.id,
      invoice.client_name,
      isoDate(invoice.created_at_ms),
      isoDate(invoice.due_ms),
      isoDate(invoice.paid_at_ms),
      invoice.items.map((item) => item.description).join("; "),
      fromUnits(invoice.amount),
      paid ? fromUnits(invoice.amount) : "",
      invoice.status,
      payment ? `${payment.origin_asset} on ${payment.origin_chain}` : "",
      payment?.amount_in ? `${payment.amount_in} ${payment.origin_asset}` : "",
      payment?.amount_in_usd ?? "",
      payment?.origin_tx_url ?? "",
      invoice.settle_tx ? txUrl(invoice.settle_tx) : "",
      invoice.company,
      payment?.refund_reason ?? "",
    ];
  });
  return [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

export function payoutsCsv(payouts: import("./payouts.js").Payout[]): string {
  const head = ["Payout ID", "Date", "Batch", "Recipient", "Sent (USDC)", "Recipient receives", "Token", "Chain", "Recipient address", "Status", "Transfer transaction (NEAR)", "Delivery transaction", "Refund reason"];
  const rows = payouts.map((p) => [
    p.id,
    p.created_at.slice(0, 10),
    p.batch_id ?? "",
    p.payee_name,
    fromUnits(p.amount_units),
    p.amount_out,
    p.symbol,
    p.chain,
    p.recipient,
    p.status,
    p.transfer_tx ? txUrl(p.transfer_tx) : "",
    p.delivery_tx_url ?? "",
    p.refund_reason ?? "",
  ]);
  return [head, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

export function parsePayrollCsv(text: string): { payee_name: string; amount: string; chain: string; token: string; recipient: string }[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = lines.map((line) => line.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
  const start = rows[0] && /name/i.test(rows[0][0]) ? 1 : 0;
  return rows.slice(start).map(([payee_name = "", amount = "", chain = "", token = "", recipient = ""]) => ({ payee_name, amount, chain: chain.toLowerCase(), token: token.toUpperCase(), recipient }));
}
