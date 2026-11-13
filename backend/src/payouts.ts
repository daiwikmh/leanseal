import { nearToYocto, teraToGas } from "near-api-js";
import { createIntentsClient, fromUnits, maxBatch, toUnits, txUrl, usdcAssetId, type Payee, type Payout, type PayoutRequest } from "shared";
import { config } from "./config.js";
import { db } from "./db.js";
import { accountExists, operator, usdcBalance, view } from "./near.js";
import { payTokens } from "./payments.js";

const intents = createIntentsClient({ apiKey: config.oneClickJwt });

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

const columns =
  "id, company, batch_id, kind, payee_name, asset_id, symbol, chain, recipient, amount_units::text, amount_out, deposit_address, deadline, status, transfer_tx, delivery_tx_url, refund_reason, created_at";

function row(r: Record<string, unknown>): Payout {
  return {
    ...(r as Payout),
    deadline: (r.deadline as Date).toISOString(),
    created_at: (r.created_at as Date).toISOString(),
  };
}

export async function registerForUsdc(account: string) {
  const balance = await operator().provider.callFunction({ contractId: config.usdc, method: "storage_balance_of", args: { account_id: account } });
  if (balance) return;
  await operator().callFunction({
    contractId: config.usdc,
    methodName: "storage_deposit",
    args: { account_id: account, registration_only: true },
    deposit: nearToYocto("0.00125"),
    gas: teraToGas(30),
  });
}

export async function quotePayouts(company: string, items: PayoutRequest[], label: string | null) {
  if (!Array.isArray(items) || items.length === 0 || items.length > maxBatch) fail(400, `Send between 1 and ${maxBatch} payouts at a time.`);
  const tokens = await payTokens();
  const parsed = items.map((item, i) => {
    const token = tokens.find((t) => t.assetId === item.asset_id);
    if (!token) fail(400, `Row ${i + 1}: that token or chain is not supported.`);
    if (!item.payee_name?.trim()) fail(400, `Row ${i + 1}: add the recipient's name.`);
    if (!item.recipient?.trim()) fail(400, `Row ${i + 1}: add the recipient's address on ${token.blockchain}.`);
    if (!/^\d+(\.\d{1,2})?$/.test(item.amount?.trim() ?? "")) fail(400, `Row ${i + 1}: amount must look like 250.00.`);
    return { ...item, token, units: toUnits(item.amount.trim()) };
  });
  const { rows: recent } = await db().query<{ n: string }>("select count(*) as n from payouts where company = $1 and created_at > now() - interval '1 hour'", [company]);
  if (Number(recent[0].n) + parsed.length > 100) fail(429, "Over 100 payout quotes in the last hour. Try again later.");
  const total = parsed.reduce((sum, p) => sum + BigInt(p.units), 0n);
  const balance = BigInt(await usdcBalance(company));
  if (total > balance) fail(400, `Your balance (${Number(balance) / 1e6} USDC) is below this payout total (${Number(total) / 1e6} USDC).`);

  const batch = label
    ? (await db().query<{ id: string }>("insert into payout_batches (company, label) values ($1, $2) returning id", [company, label.slice(0, 120)])).rows[0].id
    : null;
  const created: Payout[] = [];
  for (const [i, p] of parsed.entries()) {
    if (p.token.assetId === usdcAssetId) {
      const account = p.recipient.trim().toLowerCase();
      if (!nearAccountPattern.test(account)) fail(400, `Row ${i + 1}: "${p.recipient}" is not a NEAR account. Use a name like alice.near or a 64-character implicit account.`);
      if (account === company) fail(400, `Row ${i + 1}: that's your own account.`);
      if (!/^[0-9a-f]{64}$/.test(account) && !(await accountExists(account))) fail(400, `Row ${i + 1}: ${account} doesn't exist on NEAR.`);
      const { rows } = await db().query(
        `insert into payouts (company, batch_id, kind, payee_name, asset_id, symbol, chain, recipient, amount_units, amount_out, deposit_address, deadline)
         values ($1, $2, 'direct', $3, $4, 'USDC', 'near', $5, $6, $7, null, now() + interval '60 minutes') returning ${columns}`,
        [company, batch, p.payee_name.trim(), usdcAssetId, account, p.units, fromUnits(p.units)],
      );
      created.push(row(rows[0]));
      continue;
    }
    let quote;
    try {
      ({ quote } = await intents.requestQuote({
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset: usdcAssetId,
        destinationAsset: p.token.assetId,
        amount: p.units,
        recipient: p.recipient.trim(),
        refundTo: company,
        deadlineMs: 60 * 60_000,
      }));
    } catch (error) {
      fail(400, `Row ${i + 1} (${p.payee_name}): NEAR Intents could not quote this payout. Check the address is valid on ${p.token.blockchain}. ${String(error).slice(0, 160)}`);
    }
    if (!quote.depositAddress) fail(502, "NEAR Intents returned no deposit address.");
    const { rows } = await db().query(
      `insert into payouts (company, batch_id, payee_name, asset_id, symbol, chain, recipient, amount_units, amount_out, deposit_address, deadline)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${columns}`,
      [company, batch, p.payee_name.trim(), p.token.assetId, p.token.symbol, p.token.blockchain, p.recipient.trim(), p.units, quote.amountOutFormatted, quote.depositAddress, quote.deadline ?? new Date(Date.now() + 3_600_000)],
    );
    created.push(row(rows[0]));
  }
  return { batch_id: batch, payouts: created };
}

export const nearAccountPattern = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$|^[0-9a-f]{64}$/;

export async function quotedPayout(company: string, id: string): Promise<Payout | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { rows } = await db().query(`select ${columns} from payouts where company = $1 and id = $2 and status = 'quoted' and deadline > now()`, [company, id]);
  return rows[0] ? row(rows[0]) : null;
}

export async function markSent(company: string, ids: string[], txHash: string): Promise<Payout[]> {
  const { rows } = await db().query(
    `update payouts set
       status = case when kind = 'direct' then 'completed' else 'sent' end,
       delivery_tx_url = case when kind = 'direct' then $4 else delivery_tx_url end,
       transfer_tx = $3, updated_at = now()
     where company = $1 and id = any($2::uuid[]) and status = 'quoted' returning ${columns}`,
    [company, ids, txHash, txUrl(txHash)],
  );
  const sent = rows.map(row);
  await Promise.all(sent.filter((p) => p.deposit_address).map((p) => intents.submitDeposit(p.deposit_address!, txHash).catch(() => undefined)));
  return sent;
}

export async function listPayouts(company: string): Promise<Payout[]> {
  const { rows } = await db().query(`select ${columns} from payouts where company = $1 order by created_at desc limit 200`, [company]);
  return rows.map(row);
}

export async function checkPayouts(onChange: (payout: Payout) => Promise<void>) {
  await db().query("update payouts set status = 'expired', updated_at = now() where status = 'quoted' and deadline < now()");
  const { rows } = await db().query(`select ${columns} from payouts where status = 'sent' and kind = 'intents' order by created_at limit 100`);
  for (const payout of rows.map(row)) {
    const status = await intents.getStatus(payout.deposit_address!).catch(() => null);
    if (!status) continue;
    const next = status.status === "SUCCESS" ? "completed" : status.status === "REFUNDED" ? "refunded" : status.status === "FAILED" ? "failed" : null;
    if (!next) continue;
    const { rows: updated } = await db().query(
      `update payouts set status = $2, delivery_tx_url = $3, refund_reason = $4, updated_at = now() where id = $1 and status = 'sent' returning ${columns}`,
      [payout.id, next, status.swapDetails?.destinationChainTxHashes?.[0]?.explorerUrl ?? null, status.swapDetails?.refundReason ?? null],
    );
    if (updated[0]) await onChange(row(updated[0]));
  }
}

export async function listPayees(company: string): Promise<Payee[]> {
  const { rows } = await db().query<Payee>("select id, name, asset_id, recipient from payees where company = $1 order by name", [company]);
  return rows;
}

export async function savePayee(company: string, payee: Omit<Payee, "id">): Promise<Payee> {
  if (!payee.name?.trim() || !payee.asset_id || !payee.recipient?.trim()) fail(400, "A payee needs a name, a token and an address.");
  const { rows } = await db().query<Payee>(
    `insert into payees (company, name, asset_id, recipient) values ($1, $2, $3, $4)
     on conflict (company, name) do update set asset_id = excluded.asset_id, recipient = excluded.recipient
     returning id, name, asset_id, recipient`,
    [company, payee.name.trim(), payee.asset_id, payee.recipient.trim()],
  );
  return rows[0];
}

export async function deletePayee(company: string, id: string) {
  await db().query("delete from payees where company = $1 and id = $2", [company, id]);
}

export async function ensureCompany(account: string) {
  const company = await view<{ account_id: string } | null>("get_company", { account_id: account });
  if (!company) fail(403, "Only opencash business accounts can send payouts.");
}
