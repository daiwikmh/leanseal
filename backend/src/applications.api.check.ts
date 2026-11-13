import assert from "node:assert/strict";
import { emptyIntake, intakeHash, nearKeyFromPrf, signWithNearKey, signedRequest, type Intake } from "shared";

const base = "http://localhost:8787/api";
const key = nearKeyFromPrf(new Uint8Array(32).fill(9));

function intake(): Intake {
  const i = emptyIntake("wy-llc");
  i.founder = { ...i.founder, first_name: "Ada", last_name: "Okafor", email: "ada@example.com", phone: "+2348031234567", country: "Nigeria", address: { line1: "12 Marina", line2: "", city: "Lagos", region: "Lagos", postal: "101241", country: "Nigeria" } };
  i.company = { ...i.company, names: ["Acme Studio LLC", "", ""], description: "Design services" };
  i.llc.members = [{ name: "Ada Okafor", ownership_pct: 100 }];
  i.ein.line_of_business = "Design";
  return i;
}

async function post(body: unknown) {
  const r = await fetch(`${base}/applications`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as { error: string } };
}

const account = "aurora";
const good = intake();

const incomplete = emptyIntake();
let r = await post({ ...signedRequest(account, key, intakeHash(incomplete), signWithNearKey), intake: incomplete });
assert.equal(r.status, 400, "incomplete intake is rejected");

r = await post({ ...signedRequest(account, key, intakeHash(good), signWithNearKey), signed_at: Date.now() - 10 * 60_000, intake: good });
assert.equal(r.status, 401);
assert.match(r.body.error, /expired/);

r = await post({ ...signedRequest(account, key, "sha256:" + "0".repeat(64), signWithNearKey), intake: good });
assert.equal(r.status, 401, "signature over a different hash is rejected");
assert.match(r.body.error, /does not match/);

r = await post({ ...signedRequest(account, key, intakeHash(good), signWithNearKey), intake: good });
assert.equal(r.status, 403, "a valid signature from a key that is not on the account is rejected");
assert.match(r.body.error, /not a key of aurora/);

const read = await fetch(`${base}/applications/${account}?${new URLSearchParams({ ...Object.fromEntries(Object.entries(signedRequest(account, key, "read", signWithNearKey)).map(([k, v]) => [k, String(v)])) })}`);
assert.equal(read.status, 403, "reading someone else's application is rejected");
console.log("application endpoint checks ok");
