import { accountUrl, agreementKinds, fromBase64, type Agreement, type StoredDocument } from "shared";
import { date, esc } from "./dom";

export function agreementStatusTag(a: Agreement): string {
  const tone = a.status === "executed" ? "paid" : a.status === "voided" ? "refunded" : "open";
  const label = a.status === "executed" ? "Executed" : a.status === "voided" ? "Voided" : `${a.signatures.length} of ${a.parties.length} signed`;
  return `<span class="tag tag--${tone}"><i class="tag__dot"></i>${label}</span>`;
}

export function partiesHtml(a: Agreement): string {
  return a.parties
    .map((p) => {
      const s = a.signatures.find((x) => x.account_id === p);
      const state = s ? `Signed ${date(s.signed_at_ms)}` : "Waiting";
      return `<div class="leg-row"><span><a href="${accountUrl(p)}" target="_blank" rel="noopener">${esc(p)}</a></span><span>${s ? "✓ " : ""}${state}</span></div>`;
    })
    .join("");
}

export function agreementSummaryHtml(a: Agreement): string {
  return `<div class="stat-grid">
    <div class="stat"><small>Type</small><b>${esc(agreementKinds[a.kind])}</b></div>
    <div class="stat"><small>Status</small><b>${agreementStatusTag(a)}</b></div>
    <div class="stat"><small>Created</small><b>${date(a.created_at_ms)}</b></div>
    <div class="stat"><small>ID</small><b class="mono">${esc(a.id)}</b></div>
  </div>
  <span class="panel__label">Document fingerprint on NEAR</span><p class="mono">${esc(a.doc_hash)}</p>
  <span class="panel__label">Parties</span><div class="line-items">${partiesHtml(a)}</div>`;
}

export function documentHtml(doc: StoredDocument): string {
  if (doc.mime === "application/pdf") {
    const url = URL.createObjectURL(new Blob([new Uint8Array(fromBase64(doc.content_base64))], { type: "application/pdf" }));
    return `<iframe class="doc-view doc-view--pdf" src="${url}" title="${esc(doc.title)}"></iframe>`;
  }
  return `<pre class="doc-view">${esc(new TextDecoder().decode(fromBase64(doc.content_base64)))}</pre>`;
}

export const consentText =
  "I have read this document, I agree to sign it electronically, and I intend my NEAR account's signature over its SHA-256 fingerprint to be my legally binding signature.";
