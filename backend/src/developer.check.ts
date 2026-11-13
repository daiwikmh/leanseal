import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { db } from "./db.js";
import { companyForKey, createApiKey, createLink, createWebhook, dispatchWebhooks, emit, listApiKeys, publicLink, revokeApiKey, setLinkActive } from "./developer.js";

const company = `check-${Date.now()}.opencash.near`;

const { key, id } = await createApiKey(company, "CI");
assert.match(key, /^oc_live_/);
assert.equal(await companyForKey(`Bearer ${key}`), company, "a live key resolves to its company");
const stored = await db().query("select key_hash from api_keys where id = $1", [id]);
assert.ok(!JSON.stringify(stored.rows).includes(key), "only the hash is stored");
assert.equal((await listApiKeys(company)).length, 1);
await revokeApiKey(company, id);
await assert.rejects(companyForKey(`Bearer ${key}`), /revoked/);

let status = 500;
const received: { body: string; signature: string }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ body, signature: String(req.headers["opencash-signature"]) });
    res.writeHead(status).end();
  });
}).listen(0);
const port = (server.address() as { port: number }).port;
const hook = await createWebhook(company, `http://localhost:${port}/hook`);
await assert.rejects(createWebhook(company, "http://evil.example/hook"), /https/);

await emit(company, "invoice.paid", { id: "acme-1", amount: "5000000" });
await dispatchWebhooks();
let row = (await db().query("select status, attempts, last_status_code from webhook_deliveries where endpoint_id = $1", [hook.id])).rows[0];
assert.deepEqual([row.status, row.attempts, row.last_status_code], ["pending", 1, 500], "a 500 schedules a retry");

status = 200;
await db().query("update webhook_deliveries set next_attempt_at = now() where endpoint_id = $1", [hook.id]);
await dispatchWebhooks();
row = (await db().query("select status, attempts from webhook_deliveries where endpoint_id = $1", [hook.id])).rows[0];
assert.deepEqual([row.status, row.attempts], ["delivered", 2], "the retry delivers");

const last = received.at(-1)!;
const [t, v1] = last.signature.split(",").map((part) => part.split("=")[1]);
assert.equal(v1, createHmac("sha256", hook.secret).update(`${t}.${last.body}`).digest("hex"), "receiver can verify the HMAC signature");
assert.equal(JSON.parse(last.body).type, "invoice.paid");
server.close();

const link = await createLink(company, { title: "Design retainer", amount: "499" });
assert.match(link.id, /^[a-z0-9]{10}$/);
assert.equal((await publicLink(link.id)).amount, "499");
await setLinkActive(company, link.id, false);
await assert.rejects(publicLink(link.id), /not active/);
await assert.rejects(createLink(company, { title: "x", amount: "12.345" }), /49.00/);

await db().query("delete from webhook_endpoints where company = $1", [company]);
await db().query("delete from api_keys where company = $1", [company]);
await db().query("delete from payment_links where company = $1", [company]);
await db().end();
console.log("api keys + webhooks + links checks ok");
