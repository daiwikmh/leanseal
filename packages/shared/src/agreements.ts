export type AgreementKind = "operating-agreement" | "bylaws" | "service-agreement" | "upload";
export type AgreementStatus = "pending" | "executed" | "voided";

export type Agreement = {
  id: string;
  company: string;
  kind: AgreementKind;
  title: string;
  doc_hash: string;
  parties: string[];
  signatures: { account_id: string; signed_at_ms: number }[];
  status: AgreementStatus;
  invoice_id: string | null;
  created_at_ms: number;
  executed_at_ms: number | null;
};

export type StoredDocument = { doc_hash: string; title: string; mime: string; content_base64: string };

export const agreementKinds: Record<AgreementKind, string> = {
  "operating-agreement": "Operating Agreement",
  bylaws: "Bylaws",
  "service-agreement": "Client service agreement",
  upload: "Uploaded document",
};

export const nearAuthRecipient = "opencash";

export type NearAuth = { accountId: string; publicKey: string; signature: string; nonce: string; message: string };

export function authMessage(action: string, subject: string): string {
  return `opencash:${action}:${subject}`;
}

export function authNonce(nowMs = Date.now()): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  new DataView(nonce.buffer).setBigUint64(0, BigInt(nowMs));
  return nonce;
}

export function nonceTime(nonce: Uint8Array): number {
  return Number(new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).getBigUint64(0));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export function encodeAuth(auth: NearAuth): string {
  return toBase64(new TextEncoder().encode(JSON.stringify(auth)));
}

export function agreementSigningSubject(id: string, docHash: string): string {
  return `${id}:${docHash}`;
}
