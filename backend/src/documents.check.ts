import assert from "node:assert/strict";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { signMessage } from "near-api-js/nep413";
import { authMessage, authNonce, emptyIntake, encodeAuth, nearAuthRecipient, nearKeyFromPrf, toBase64, type Company, type Intake, type Invoice } from "shared";
import { verifyNearAuth } from "./nearAuth.js";
import { bylaws, operatingAgreement, serviceAgreement } from "./templates.js";

const key = nearKeyFromPrf(new Uint8Array(32).fill(5));
const signer = new Account("aurora", new JsonRpcProvider({ url: "https://rpc.mainnet.near.org" }), key.secretKey as KeyPairString);

async function header(action: string, subject: string, nowMs = Date.now(), message = authMessage(action, subject)) {
  const nonce = authNonce(nowMs);
  const signed = await signMessage({ signerAccount: signer, payload: { message, recipient: nearAuthRecipient, nonce } });
  return encodeAuth({ accountId: "aurora", publicKey: key.publicKey, signature: toBase64(signed.signature), nonce: toBase64(nonce), message });
}

await assert.rejects(verifyNearAuth(undefined, "read-document", "x"), /Sign in/);
await assert.rejects(verifyNearAuth(await header("upload-document", "x"), "read-document", "x"), /different action/);
await assert.rejects(verifyNearAuth(await header("read-document", "x", Date.now() - 10 * 60_000), "read-document", "x"), /expired/);
await assert.rejects(verifyNearAuth(await header("read-document", "x"), "read-document", "x"), /NEAR signature rejected/, "a valid NEP-413 signature from a key not on the account is refused");

const intake: Intake = emptyIntake("wy-llc");
intake.company.names = ["Acme Studio LLC", "", ""];
intake.company.description = "Design services";
intake.llc.members = [{ name: "Ada Okafor", ownership_pct: 70 }, { name: "Bo Chen", ownership_pct: 30 }];
const company = { account_id: "acme.opencash.near", legal_name: "Acme Studio LLC" } as Company;
const oa = operatingAgreement(intake, company, ["acme.opencash.near", "bo.near"], Date.UTC(2026, 10, 12));
assert.ok(oa.includes("OPERATING AGREEMENT OF ACME STUDIO LLC"));
assert.ok(oa.includes("Ada Okafor: 70%") && oa.includes("Bo Chen: 30%"));
assert.ok(oa.includes("taxed as a partnership"), "two members means partnership taxation");
assert.ok(oa.includes("Signed by NEAR account: bo.near"));
assert.ok(oa.startsWith("TEMPLATE"), "every document starts with the template notice");

const corp = emptyIntake("de-ccorp");
corp.company.names = ["Acme Inc.", "", ""];
corp.corp = { ...corp.corp, president: "Ada", secretary: "Ada", treasurer: "Ada", directors: ["Ada"], shareholders: [{ name: "Ada", ownership_pct: 100 }] };
assert.ok(bylaws(corp, company, ["acme.opencash.near"], 0).includes("10,000,000 shares of common stock, par value $0.00001"));

const invoice = { id: "acme-1", client_name: "Northwind", amount: "1250500000", due_ms: Date.UTC(2026, 10, 30), items: [{ description: "Design sprint", amount: "1250.50" }] } as Invoice;
const sa = serviceAgreement(company, invoice, "Two rounds of revisions.", ["acme.opencash.near", "northwind.near"], 0);
assert.ok(sa.includes("$1,250.50 under invoice acme-1") && sa.includes("Two rounds of revisions."));
console.log("near auth + templates checks ok");
