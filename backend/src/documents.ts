import { createHash } from "node:crypto";
import type { AgreementKind, Company, Intake, Invoice, StoredDocument } from "shared";
import { getAgreement } from "./agreements.js";
import { getBusiness } from "./business.js";
import { db } from "./db.js";
import { view } from "./near.js";
import { verifyNearAuth } from "./nearAuth.js";
import { bylaws, operatingAgreement, serviceAgreement } from "./templates.js";
import { open, seal } from "./vault.js";

const maxBytes = 5 * 1024 * 1024;

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function hashOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function store(company: string, title: string, mime: string, bytes: Buffer) {
  const docHash = hashOf(bytes);
  const sealed = seal(bytes.toString("base64"), docHash);
  await db().query(
    `insert into documents (doc_hash, company, title, mime, ciphertext, iv, auth_tag, key_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (doc_hash) do nothing`,
    [docHash, company, title, mime, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion],
  );
  return { doc_hash: docHash, title };
}

async function companyFor(account: string): Promise<Company> {
  const company = await getBusiness(account);
  if (!company) fail(403, "Only a registered opencash company can add documents.");
  return company;
}

export async function uploadDocument(auth: string | undefined, body: { title: string; mime: string; content_base64: string }) {
  const account = await verifyNearAuth(auth, "upload-document", body.title ?? "");
  await companyFor(account);
  if (body.mime !== "application/pdf" && body.mime !== "text/plain") fail(400, "Upload a PDF or a plain-text document.");
  const bytes = Buffer.from(body.content_base64 ?? "", "base64");
  if (bytes.length === 0 || bytes.length > maxBytes) fail(400, "Documents must be between 1 byte and 5 MB.");
  if (body.mime === "application/pdf" && bytes.subarray(0, 5).toString() !== "%PDF-") fail(400, "That file is not a PDF.");
  if (!body.title?.trim()) fail(400, "Give the document a title.");
  return store(account, body.title.trim().slice(0, 200), body.mime, bytes);
}

export async function generateDocument(
  auth: string | undefined,
  body: { kind: AgreementKind; parties: string[]; invoice_id?: string; terms?: string },
  loadIntake: (account: string) => Promise<Intake>,
) {
  const account = await verifyNearAuth(auth, "generate-document", body.kind);
  const company = await companyFor(account);
  const parties = body.parties?.length ? body.parties : [account];
  const now = Date.now();
  if (body.kind === "service-agreement") {
    const invoice = await view<Invoice | null>("get_invoice", { id: body.invoice_id ?? "" });
    if (!invoice || invoice.company !== account) fail(404, "Pick one of your own invoices.");
    const text = serviceAgreement(company, invoice, body.terms ?? "", parties, now);
    return store(account, `Service agreement · ${invoice.client_name} · ${invoice.id}`, "text/plain", Buffer.from(text, "utf8"));
  }
  const intake = await loadIntake(account);
  if (body.kind === "operating-agreement") {
    if (intake.company.jurisdiction !== "wy-llc") fail(400, "Operating Agreements are for LLCs. Generate Bylaws for a C-Corp.");
    return store(account, `Operating Agreement · ${intake.company.names[0]}`, "text/plain", Buffer.from(operatingAgreement(intake, company, parties, now), "utf8"));
  }
  if (body.kind === "bylaws") {
    if (intake.company.jurisdiction !== "de-ccorp") fail(400, "Bylaws are for corporations. Generate an Operating Agreement for an LLC.");
    return store(account, `Bylaws · ${intake.company.names[0]}`, "text/plain", Buffer.from(bylaws(intake, company, parties, now), "utf8"));
  }
  fail(400, "Unknown document kind.");
}

export async function readDocument(auth: string | undefined, docHash: string, agreementId: string): Promise<StoredDocument> {
  const account = await verifyNearAuth(auth, "read-document", docHash);
  const agreement = await getAgreement(agreementId);
  if (!agreement || agreement.doc_hash !== docHash) fail(404, "No agreement uses that document.");
  if (agreement.company !== account && !agreement.parties.includes(account)) fail(403, "Only the company and the parties can read this document.");
  const { rows } = await db().query<{ title: string; mime: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number }>(
    "select title, mime, ciphertext, iv, auth_tag, key_version from documents where doc_hash = $1",
    [docHash],
  );
  const row = rows[0];
  if (!row) fail(404, "Document file not found.");
  const content = open({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: row.key_version }, docHash);
  if (hashOf(Buffer.from(content, "base64")) !== docHash) fail(500, "Stored document does not match its hash.");
  return { doc_hash: docHash, title: row.title, mime: row.mime, content_base64: content };
}
