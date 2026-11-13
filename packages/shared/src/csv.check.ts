import assert from "node:assert/strict";
import { invoicesCsv } from "./csv.js";
import type { Invoice } from "./company.js";

const base: Invoice = {
  id: "acme-1",
  company: "acme.opencash.near",
  client_name: "Northwind, Inc.",
  amount: "1250500000",
  due_ms: Date.UTC(2026, 10, 25),
  items: [{ description: "Design \"sprint\"", amount: "1250.50" }],
  status: "paid",
  created_at_ms: Date.UTC(2026, 10, 11),
  deposit_address: "0xdep",
  settle_tx: "SettleHash",
  paid_at_ms: Date.UTC(2026, 10, 12),
  payment: { origin_asset: "USDC", origin_chain: "arb", amount_in: "1263.0", amount_in_usd: "1262.9", origin_tx_url: "https://arbiscan.io/tx/0xabc", refund_reason: null },
  source: "direct",
  reference: null,
};
const open: Invoice = { ...base, id: "acme-2", status: "open", paid_at_ms: null, payment: null, settle_tx: null };
const lines = invoicesCsv([base, open]).split("\r\n");
assert.equal(lines.length, 3);
assert.ok(lines[0].startsWith("Invoice ID,Client,Issue date,Due date,Paid date"));
assert.equal(lines[1], 'acme-1,"Northwind, Inc.",2026-11-11,2026-11-25,2026-11-12,"Design ""sprint""",1250.5,1250.5,paid,USDC on arb,1263.0 USDC,1262.9,https://arbiscan.io/tx/0xabc,https://nearblocks.io/txns/SettleHash,acme.opencash.near,');
assert.equal(lines[2].split(",").length >= 16, true);
assert.ok(lines[2].includes(",open,"), "open invoice has empty paid fields");
console.log("csv check ok");
