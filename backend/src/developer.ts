import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { teraToGas } from "near-api-js";
import { fromUnits, toUnits, type Invoice, type LineItem } from "shared";
import { config } from "./config.js";
import { db } from "./db.js";
import { operator } from "./near.js";
import { eventMessage } from "./chat/core.js";
import { notifyAccount } from "./chat/outbox.js";
import { open, seal } from "./vault.js";

const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
const retryMinutes = [1, 5, 30, 120];

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function randomId(length: number): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function payUrl(invoiceId: string): string {
  return `${config.webUrl}/pay?id=${encodeURIComponent(invoiceId)}`;
}

export async function createInvoiceFor(
  company: string,
  input: { client_name: string; due_ms: number; items: LineItem[]; source: "link" | "api" | "chat"; reference: string | null },
): Promise<Invoice> {
  return operator().callFunction<Invoice>({
    contractId: config.contract,
    methodName: "create_invoice_for",
    args: { company, client_name: input.client_name, due_ms: input.due_ms, items: input.items, source: input.source, reference: input.reference },
    gas: teraToGas(50),
  });
}

export type PaymentLink = { id: string; company: string; title: string; description: string; amount: string | null; active: boolean; created_at: string; url: string };

function linkRow(r: Record<string, unknown>): PaymentLink {
  return {
    id: r.id as string,
    company: r.company as string,
    title: r.title as string,
    description: r.description as string,
    amount: r.amount_units ? fromUnits(String(r.amount_units)) : null,
    active: r.active as boolean,
    created_at: (r.created_at as Date).toISOString(),
    url: `${config.webUrl}/link?id=${r.id}`,
  };
}

export async function createLink(company: string, body: { title: string; description?: string; amount?: string | null }) {
  if (!body.title?.trim()) fail(400, "Give the link a title.");
  if (body.amount && !/^\d+(\.\d{1,2})?$/.test(body.amount.trim())) fail(400, "Amount must look like 49.00, or leave it empty to let the payer choose.");
  const { rows } = await db().query(
    "insert into payment_links (id, company, title, description, amount_units) values ($1, $2, $3, $4, $5) returning *",
    [randomId(10), company, body.title.trim().slice(0, 120), (body.description ?? "").trim().slice(0, 300), body.amount ? toUnits(body.amount.trim()) : null],
  );
  return linkRow(rows[0]);
}

export async function listLinks(company: string) {
  const { rows } = await db().query("select * from payment_links where company = $1 order by created_at desc", [company]);
  return rows.map(linkRow);
}

export async function setLinkActive(company: string, id: string, active: boolean) {
  const { rows } = await db().query("update payment_links set active = $3 where company = $1 and id = $2 returning *", [company, id, active]);
  if (!rows[0]) fail(404, "Link not found.");
  return linkRow(rows[0]);
}

export async function publicLink(id: string) {
  const { rows } = await db().query("select * from payment_links where id = $1", [id]);
  if (!rows[0] || !rows[0].active) fail(404, "This payment link is not active.");
  return linkRow(rows[0]);
}

export async function payLink(id: string, body: { payer_name?: string; amount?: string }) {
  const link = await publicLink(id);
  const amount = link.amount ?? body.amount?.trim() ?? "";
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) < 1) fail(400, "Enter an amount of at least $1.00.");
  const invoice = await createInvoiceFor(link.company, {
    client_name: body.payer_name?.trim() || "Payment link customer",
    due_ms: Date.now() + 86_400_000,
    items: [{ description: link.title, amount }],
    source: "link",
    reference: `link:${link.id}`,
  });
  return { invoice_id: invoice.id, pay_url: payUrl(invoice.id) };
}

export async function createApiKey(company: string, name: string) {
  if (!name?.trim()) fail(400, "Name the key, e.g. Production server.");
  const key = `oc_live_${randomBytes(24).toString("base64url")}`;
  const { rows } = await db().query(
    "insert into api_keys (company, name, prefix, key_hash) values ($1, $2, $3, $4) returning id, name, prefix, created_at",
    [company, name.trim().slice(0, 80), key.slice(0, 12), sha256(key)],
  );
  return { ...rows[0], key };
}

export async function listApiKeys(company: string) {
  const { rows } = await db().query(
    "select id, name, prefix, created_at, last_used_at from api_keys where company = $1 and revoked_at is null order by created_at desc",
    [company],
  );
  return rows;
}

export async function revokeApiKey(company: string, id: string) {
  await db().query("update api_keys set revoked_at = now() where company = $1 and id = $2", [company, id]);
}

export async function companyForKey(authorization: string | undefined): Promise<string> {
  const key = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!key?.startsWith("oc_live_")) fail(401, "Send your API key as: Authorization: Bearer oc_live_…");
  const { rows } = await db().query<{ company: string }>(
    "update api_keys set last_used_at = now() where key_hash = $1 and revoked_at is null returning company",
    [sha256(key)],
  );
  if (!rows[0]) fail(401, "Unknown or revoked API key.");
  return rows[0].company;
}

export async function createWebhook(company: string, url: string) {
  if (!/^https:\/\/\S+$/.test(url ?? "") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url ?? "")) fail(400, "Webhook URLs must use https:// (http://localhost is allowed for testing).");
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const sealed = seal(secret, `webhook:${company}`);
  const { rows } = await db().query(
    "insert into webhook_endpoints (company, url, secret_cipher, secret_iv, secret_tag) values ($1, $2, $3, $4, $5) returning id, url, created_at",
    [company, url, sealed.ciphertext, sealed.iv, sealed.authTag],
  );
  return { ...rows[0], secret };
}

export async function listWebhooks(company: string) {
  const { rows } = await db().query(
    `select e.id, e.url, e.created_at,
       (select json_agg(d order by d.created_at desc) from (select event_type, status, attempts, last_status_code, created_at from webhook_deliveries where endpoint_id = e.id order by created_at desc limit 10) d) as recent
     from webhook_endpoints e where e.company = $1 and e.disabled_at is null order by e.created_at desc`,
    [company],
  );
  return rows;
}

export async function deleteWebhook(company: string, id: string) {
  await db().query("update webhook_endpoints set disabled_at = now() where company = $1 and id = $2", [company, id]);
}

export async function emit(company: string, type: string, data: unknown) {
  const event = { id: randomUUID(), type, created: new Date().toISOString(), data };
  await db().query(
    `insert into webhook_deliveries (endpoint_id, event_id, event_type, payload)
     select id, $2, $3, $4 from webhook_endpoints where company = $1 and disabled_at is null`,
    [company, event.id, type, JSON.stringify(event)],
  );
  const text = eventMessage(type, data as Record<string, unknown>);
  if (text) await notifyAccount(company, text);
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export async function dispatchWebhooks(fetcher: typeof fetch = fetch) {
  const { rows } = await db().query(
    `select d.id, d.payload, d.attempts, e.url, e.company, e.secret_cipher, e.secret_iv, e.secret_tag
     from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
     where d.status = 'pending' and d.next_attempt_at <= now() and e.disabled_at is null
     order by d.next_attempt_at limit 50`,
  );
  for (const r of rows) {
    const secret = open({ ciphertext: r.secret_cipher, iv: r.secret_iv, authTag: r.secret_tag, keyVersion: 1 }, `webhook:${r.company}`);
    const body = JSON.stringify(r.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    let code: number | null = null;
    let error: string | null = null;
    try {
      const response = await fetcher(r.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Opencash-Signature": signPayload(secret, timestamp, body) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      code = response.status;
    } catch (cause) {
      error = String(cause).slice(0, 300);
    }
    const attempts = r.attempts + 1;
    if (code !== null && code >= 200 && code < 300) {
      await db().query("update webhook_deliveries set status = 'delivered', attempts = $2, last_status_code = $3, delivered_at = now() where id = $1", [r.id, attempts, code]);
    } else {
      const wait = retryMinutes[attempts - 1];
      await db().query(
        `update webhook_deliveries set attempts = $2, last_status_code = $3, last_error = $4,
           status = $5, next_attempt_at = now() + make_interval(mins => $6) where id = $1`,
        [r.id, attempts, code, error, wait === undefined ? "failed" : "pending", wait ?? 0],
      );
    }
  }
}
