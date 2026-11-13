import assert from "node:assert/strict";
import { createAgreement, getAgreement, listAgreements, signAgreement, signingSubject, voidAgreement } from "./agreements.js";
import { db } from "./db.js";

const company = `agr-${Date.now()}.opencash.near`;
const doc = `sha256:${"e".repeat(63)}${Date.now() % 10}`;
await db().query("insert into documents (doc_hash, company, title, mime, ciphertext, iv, auth_tag) values ($1, $2, 'NDA', 'text/plain', '\\x00', $3, $4) on conflict do nothing", [
  doc,
  company,
  Buffer.alloc(12),
  Buffer.alloc(16),
]);

await assert.rejects(createAgreement(company, { kind: "upload", title: "NDA", doc_hash: `sha256:${"0".repeat(64)}`, parties: [company] }), /document first/, "the document must exist and belong to the company");
await assert.rejects(createAgreement(company, { kind: "upload", title: "NDA", doc_hash: doc, parties: ["Not An Account!"] }), /not a NEAR account/);
const a = await createAgreement(company, { kind: "upload", title: "NDA", doc_hash: doc, parties: [company, "Bo.near", "bo.near"] });
assert.deepEqual(a.parties, [company, "bo.near"], "parties are normalised and de-duplicated");
assert.equal((await listAgreements("bo.near", true)).some((x) => x.id === a.id), true, "parties see it in their to-sign list");

const header = (account: string, subject: string) => Buffer.from(JSON.stringify({ accountId: account, publicKey: "ed25519:x", message: `opencash:sign-agreement:${subject}`, nonce: "n", signature: "s" })).toString("base64");
const as = (account: string, id = a.id) => async (_h: string | undefined, action: string, subject: string) => {
  assert.equal(action, "sign-agreement");
  assert.equal(subject, signingSubject(id, doc), "the signature covers the id and the document hash");
  return account;
};
await assert.rejects(signAgreement(a.id, header("mallory.near", ""), as("mallory.near")), /not a party/);
const once = await signAgreement(a.id, header(company, ""), as(company));
assert.equal(once.status, "pending");
await assert.rejects(signAgreement(a.id, header(company, ""), as(company)), /Already signed/);
const done = await signAgreement(a.id, header("bo.near", ""), as("bo.near"));
assert.equal(done.status, "executed", "executes when every party has signed");
assert.ok(done.executed_at_ms);
const stored = (await db().query("select message, signature from agreement_signatures where agreement_id = $1 and account_id = 'bo.near'", [a.id])).rows[0];
assert.equal(stored.signature, "s", "the signature evidence is kept");
await assert.rejects(voidAgreement(company, a.id), /pending/, "an executed agreement can't be voided");

const b = await createAgreement(company, { kind: "upload", title: "Second", doc_hash: doc, parties: ["bo.near"] });
await voidAgreement(company, b.id);
await assert.rejects(signAgreement(b.id, header("bo.near", ""), as("bo.near", b.id)), /not open/);
assert.equal((await getAgreement(b.id))!.status, "voided");

await db().query("delete from agreement_signatures where agreement_id in (select id from agreements where company = $1)", [company]);
await db().query("delete from agreements where company = $1", [company]);
await db().query("delete from documents where company = $1", [company]);
await db().end();
console.log("off-chain agreements checks ok");
