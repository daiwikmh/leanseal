import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalIntake, emptyIntake, intakeHash } from "shared";
import { db } from "./db.js";
import { open, seal } from "./vault.js";

const intake = emptyIntake("wy-llc");
intake.founder.tax_id_type = "itin";
intake.founder.tax_id = "912-70-1234";
const plaintext = JSON.stringify(intake);

const sealed = seal(plaintext, "acme.opencash.near");
assert.ok(!sealed.ciphertext.toString("utf8").includes("912-70-1234"), "ciphertext hides the ITIN");
assert.equal(open(sealed, "acme.opencash.near"), plaintext, "round trip");
assert.throws(() => open(sealed, "mallory.opencash.near"), "ciphertext is bound to its account");
const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
tampered.ciphertext[0] ^= 1;
assert.throws(() => open(tampered, "acme.opencash.near"), "tampering is detected");

const hash = intakeHash(intake);
assert.match(hash, /^sha256:[0-9a-f]{64}$/);
assert.equal(hash, `sha256:${createHash("sha256").update(canonicalIntake(intake)).digest("hex")}`, "browser hash equals node hash");
const account = `check-${Date.now()}.opencash.near`;
await db().query("insert into applications (account_id, intake_hash, ciphertext, iv, auth_tag) values ($1,$2,$3,$4,$5)", [account, hash, sealed.ciphertext, sealed.iv, sealed.authTag]);
const row = (await db().query("select * from applications where account_id = $1", [account])).rows[0];
assert.equal(row.intake_hash, hash);
assert.ok(!JSON.stringify(row).includes("912-70-1234"), "the row never contains the plaintext ITIN");
await assert.rejects(db().query("insert into applications (account_id, intake_hash, ciphertext, iv, auth_tag) values ($1,$2,$3,$4,$5)", ["x.near", "md5:abc", sealed.ciphertext, sealed.iv, sealed.authTag]), "hash format is enforced by the database");
await db().query("delete from applications where account_id = $1", [account]);
await db().end();
console.log("applications vault + database checks ok");
