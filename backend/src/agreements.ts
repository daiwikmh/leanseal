import { randomBytes } from "node:crypto";
import type { Agreement, AgreementKind, Invoice } from "shared";
import { db } from "./db.js";
import { view } from "./near.js";
import { verifyNearAuth } from "./nearAuth.js";

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

const accountPattern = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$|^[0-9a-f]{64}$/;

async function load(where: string, params: unknown[]): Promise<Agreement[]> {
  const { rows } = await db().query(
    `select a.*, coalesce(json_agg(json_build_object('account_id', s.account_id, 'signed_at_ms', (extract(epoch from s.signed_at) * 1000)::bigint) order by s.signed_at)
       filter (where s.account_id is not null), '[]') as signatures
     from agreements a left join agreement_signatures s on s.agreement_id = a.id
     where ${where} group by a.id order by a.created_at desc limit 100`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    company: r.company,
    kind: r.kind,
    title: r.title,
    doc_hash: r.doc_hash,
    parties: r.parties,
    signatures: r.signatures.map((s: { account_id: string; signed_at_ms: string }) => ({ account_id: s.account_id, signed_at_ms: Number(s.signed_at_ms) })),
    status: r.status,
    invoice_id: r.invoice_id,
    created_at_ms: (r.created_at as Date).getTime(),
    executed_at_ms: r.executed_at ? (r.executed_at as Date).getTime() : null,
  }));
}

export async function getAgreement(id: string): Promise<Agreement | null> {
  return (await load("a.id = $1", [id]))[0] ?? null;
}

export async function listAgreements(account: string, asParty: boolean): Promise<Agreement[]> {
  return asParty ? load("$1 = any(a.parties)", [account]) : load("a.company = $1", [account]);
}

export async function createAgreement(
  company: string,
  body: { kind: AgreementKind; title: string; doc_hash: string; parties: string[]; invoice_id?: string | null },
): Promise<Agreement> {
  const parties = [...new Set((body.parties ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean))];
  if (parties.length === 0 || parties.length > 10) fail(400, "An agreement needs 1 to 10 NEAR accounts.");
  const bad = parties.find((p) => !accountPattern.test(p));
  if (bad) fail(400, `${bad} is not a NEAR account.`);
  if (!body.title?.trim()) fail(400, "Give the agreement a title.");
  const { rows: docs } = await db().query("select 1 from documents where doc_hash = $1 and company = $2", [body.doc_hash, company]);
  if (!docs[0]) fail(400, "Upload or generate the document first.");
  if (body.kind === "service-agreement") {
    const invoice = await view<Invoice | null>("get_invoice", { id: body.invoice_id ?? "" });
    if (!invoice || invoice.company !== company) fail(400, "A service agreement must reference one of your own invoices.");
  }
  const { rows: count } = await db().query<{ n: string }>("select count(*) as n from agreements where company = $1", [company]);
  const id = `${company.split(".")[0]}-a${Number(count[0].n) + 1}-${randomBytes(2).toString("hex")}`;
  await db().query(
    "insert into agreements (id, company, kind, title, doc_hash, parties, invoice_id) values ($1, $2, $3, $4, $5, $6, $7)",
    [id, company, body.kind, body.title.trim().slice(0, 200), body.doc_hash, parties, body.kind === "service-agreement" ? body.invoice_id : null],
  );
  return (await getAgreement(id))!;
}

export function signingSubject(id: string, docHash: string): string {
  return `${id}:${docHash}`;
}

export async function signAgreement(id: string, authHeader: string | undefined, verify = verifyNearAuth): Promise<Agreement> {
  const agreement = await getAgreement(id);
  if (!agreement) fail(404, "Agreement not found.");
  const signer = await verify(authHeader, "sign-agreement", signingSubject(id, agreement.doc_hash));
  if (agreement.status !== "pending") fail(409, "This agreement is not open for signing.");
  if (!agreement.parties.includes(signer)) fail(403, "You are not a party to this agreement.");
  if (agreement.signatures.some((s) => s.account_id === signer)) fail(409, "Already signed.");
  const auth = JSON.parse(Buffer.from(authHeader!, "base64").toString("utf8")) as { publicKey: string; message: string; nonce: string; signature: string };
  await db().query(
    "insert into agreement_signatures (agreement_id, account_id, public_key, message, nonce, signature) values ($1, $2, $3, $4, $5, $6)",
    [id, signer, auth.publicKey, auth.message, auth.nonce, auth.signature],
  );
  await db().query(
    `update agreements set status = 'executed', executed_at = now()
     where id = $1 and status = 'pending' and cardinality(parties) = (select count(*) from agreement_signatures where agreement_id = $1)`,
    [id],
  );
  return (await getAgreement(id))!;
}

export async function voidAgreement(company: string, id: string): Promise<Agreement> {
  const { rowCount } = await db().query("update agreements set status = 'voided' where id = $1 and company = $2 and status = 'pending'", [id, company]);
  if (!rowCount) fail(409, "Only a pending agreement you created can be voided.");
  return (await getAgreement(id))!;
}
