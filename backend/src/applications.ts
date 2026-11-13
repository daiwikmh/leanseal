import { applicationMessage, canonicalIntake, intakeHash, validateIntake, verifyNearSignature, type Intake } from "shared";
import { getBusiness, recordFormation } from "./business.js";
import { db } from "./db.js";
import { provider } from "./near.js";
import { open, seal } from "./vault.js";

const freshMs = 5 * 60_000;

export type SignedRequest = { account_id: string; public_key: string; signed_at: number; signature: string };

function fail(statusCode: number, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { statusCode, details });
}

async function authorize(request: SignedRequest, subject: string) {
  if (!Number.isFinite(request.signed_at) || Math.abs(Date.now() - request.signed_at) > freshMs) fail(401, "Signature expired. Sign again.");
  const message = applicationMessage(request.account_id, request.signed_at, subject);
  if (!verifyNearSignature(request.public_key, message, request.signature)) fail(401, "Signature does not match.");
  try {
    await provider.viewAccessKey({ accountId: request.account_id, publicKey: request.public_key });
  } catch {
    fail(403, `That key is not a key of ${request.account_id}.`);
  }
}

export async function submitApplication(request: SignedRequest & { intake: Intake }) {
  const errors = validateIntake(request.intake);
  if (errors.length > 0) fail(400, errors[0].message, errors);
  const hash = intakeHash(request.intake);
  await authorize(request, hash);
  const company = await getBusiness(request.account_id);
  if (!company) fail(404, "Open the company account before submitting the application.");
  const sealed = seal(canonicalIntake(request.intake), request.account_id);
  await db().query(
    `insert into applications (account_id, intake_hash, ciphertext, iv, auth_tag, key_version)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (account_id) do update set intake_hash = excluded.intake_hash, ciphertext = excluded.ciphertext,
       iv = excluded.iv, auth_tag = excluded.auth_tag, key_version = excluded.key_version, updated_at = now()`,
    [request.account_id, hash, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion],
  );
  await recordFormation(request.account_id, request.intake.company.names[0], request.intake.company.jurisdiction, hash);
  const recorded = (await getBusiness(request.account_id))!;
  return { application_hash: hash, company: recorded };
}

export async function readApplication(request: SignedRequest) {
  await authorize(request, "read");
  const { rows } = await db().query<{ intake_hash: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number; updated_at: Date }>(
    "select intake_hash, ciphertext, iv, auth_tag, key_version, updated_at from applications where account_id = $1",
    [request.account_id],
  );
  const row = rows[0];
  if (!row) fail(404, "No application on file for this account.");
  const intake = JSON.parse(open({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: row.key_version }, request.account_id)) as Intake;
  return { intake, application_hash: row.intake_hash, updated_at: row.updated_at.toISOString() };
}

export async function loadApplication(account: string): Promise<Intake> {
  const { rows } = await db().query<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number }>(
    "select ciphertext, iv, auth_tag, key_version from applications where account_id = $1",
    [account],
  );
  const row = rows[0];
  if (!row) fail(404, "Submit your formation application first; the document is generated from it.");
  return JSON.parse(open({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: row.key_version }, account)) as Intake;
}
