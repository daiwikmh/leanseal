import { agreementKinds, agreementSigningSubject, toBase64, type Agreement, type AgreementKind } from "shared";
import { api } from "../lib/api";
import { agreementStatusTag, agreementSummaryHtml, consentText, documentHtml } from "../lib/agreementView";
import { date, errorText, esc, query, queryAll, say } from "../lib/dom";
import { businessAuth, passkeyAuth } from "../lib/near";
import { showToast } from "../lib/toast";
import { closeModal, openModal } from "./modal";
import { state } from "./state";

let filter: "company" | "party" = "company";
let list: Agreement[] = [];

function signLink(id: string): string {
  return `${location.origin}/sign?id=${encodeURIComponent(id)}`;
}

function parseParties(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((p) => p.trim().toLowerCase()).filter(Boolean))];
}

export async function loadAgreements() {
  if (!state.session) return;
  const wrap = query("[data-agreement-table]");
  try {
    const session = state.session;
    list = (await api.agreements(await passkeyAuth(session, "list-agreements", session.accountId), session.accountId, filter === "party")).sort((a, b) => b.created_at_ms - a.created_at_ms);
    wrap.classList.remove("table-wrap--loading");
    if (list.length === 0) {
      wrap.innerHTML = `<p class="empty">${filter === "party" ? "Nothing waiting for your signature." : "No agreements yet. Create your Operating Agreement or a client contract."}</p>`;
      return;
    }
    wrap.innerHTML = `<table class="data-table"><thead><tr><th>Title</th><th>Type</th><th>Created</th><th>Status</th></tr></thead><tbody>${list
      .map((a) => `<tr data-agreement="${esc(a.id)}"><td class="cell-identity">${esc(a.title)}</td><td class="cell-muted">${esc(agreementKinds[a.kind])}</td><td class="cell-muted">${date(a.created_at_ms)}</td><td>${agreementStatusTag(a)}</td></tr>`)
      .join("")}</tbody></table>`;
    for (const row of queryAll<HTMLTableRowElement>("tr[data-agreement]", wrap)) row.addEventListener("click", () => void openAgreement(row.dataset.agreement!));
  } catch (error) {
    wrap.classList.remove("table-wrap--loading");
    wrap.innerHTML = `<p class="error-text">${esc(errorText(error))}</p>`;
  }
}

async function openAgreement(id: string) {
  const session = state.session!;
  const agreement = await api.agreement(id);
  const mine = agreement.parties.includes(session.accountId) && !agreement.signatures.some((s) => s.account_id === session.accountId);
  const body = openModal(
    agreement.title,
    `${agreementSummaryHtml(agreement)}
     <span class="panel__label">Document</span><div data-doc><button type="button" class="btn btn--sm" data-load-doc>Show document</button></div>
     ${mine && agreement.status === "pending" ? `<label class="consent"><input type="checkbox" data-consent /> <span>${esc(consentText)}</span></label>` : ""}
     <p class="form-error" data-agreement-error></p>
     <div class="btn-row">
       ${mine && agreement.status === "pending" ? `<button type="button" class="btn btn--primary" data-sign disabled>Sign with my passkey</button>` : ""}
       <button type="button" class="btn" data-copy-sign>Copy signing link</button>
       ${agreement.company === session.accountId && agreement.status === "pending" ? `<button type="button" class="btn" data-void>Void</button>` : ""}
     </div>`,
  );
  body.closest(".modal")?.classList.add("modal--wide");
  const error = query("[data-agreement-error]", body);
  query("[data-load-doc]", body).addEventListener("click", async () => {
    try {
      const doc = await api.document(await passkeyAuth(session, "read-document", agreement.doc_hash), agreement.doc_hash, agreement.id);
      query("[data-doc]", body).innerHTML = documentHtml(doc);
    } catch (cause) {
      say(error, errorText(cause), "error");
    }
  });
  body.querySelector<HTMLInputElement>("[data-consent]")?.addEventListener("change", (event) => {
    query<HTMLButtonElement>("[data-sign]", body).disabled = !(event.target as HTMLInputElement).checked;
  });
  body.querySelector("[data-sign]")?.addEventListener("click", async () => {
    try {
      say(error, "Signing on NEAR…");
      await api.signAgreement(await passkeyAuth(session, "sign-agreement", agreementSigningSubject(agreement.id, agreement.doc_hash)), agreement.id);
      closeModal();
      showToast("Signed on NEAR");
      await loadAgreements();
    } catch (cause) {
      say(error, errorText(cause), "error");
    }
  });
  body.querySelector("[data-void]")?.addEventListener("click", async () => {
    try {
      await api.voidAgreement(await businessAuth(session, "void-agreement"), agreement.id);
      closeModal();
      showToast("Agreement voided");
      await loadAgreements();
    } catch (cause) {
      say(error, errorText(cause), "error");
    }
  });
  query("[data-copy-sign]", body).addEventListener("click", async () => {
    await navigator.clipboard.writeText(signLink(agreement.id));
    showToast("Signing link copied");
  });
}

function openNewAgreement() {
  const session = state.session!;
  const company = state.company;
  const formationKind: AgreementKind = company?.jurisdiction === "de-ccorp" ? "bylaws" : "operating-agreement";
  const invoices = state.invoices;
  const body = openModal(
    "New agreement",
    `<form data-agreement-form>
      <label class="field"><span>Type</span><select name="kind">
        <option value="${formationKind}">${agreementKinds[formationKind]} (from your formation answers)</option>
        <option value="service-agreement" ${invoices.length ? "" : "disabled"}>Client service agreement (from an invoice)</option>
        <option value="upload">Upload a PDF</option>
      </select></label>
      <div data-kind="service-agreement" hidden>
        <label class="field"><span>Invoice</span><select name="invoice">${invoices.map((i) => `<option value="${esc(i.id)}">${esc(i.id)} · ${esc(i.client_name)}</option>`).join("")}</select></label>
        <label class="field"><span>Additional terms (optional)</span><textarea name="terms" rows="3" placeholder="Two rounds of revisions. Delivery within 10 business days."></textarea></label>
      </div>
      <div data-kind="upload" hidden>
        <label class="field"><span>Title</span><input name="title" placeholder="Mutual NDA" /></label>
        <label class="field"><span>PDF, up to 5 MB</span><input name="file" type="file" accept="application/pdf" /></label>
      </div>
      <label class="field"><span>NEAR accounts that must sign</span><input name="parties" value="${esc(session.accountId)}" /></label>
      <p class="quote-line">Separate accounts with commas, e.g. your co-founder's <b>bo.near</b> or your client's wallet. Each party signs from their own account; opencash pays the gas for opencash accounts.</p>
      <p class="form-error" data-agreement-error></p>
      <button type="submit" class="btn btn--primary">Create and send for signature</button>
    </form>`,
  );
  const form = query<HTMLFormElement>("[data-agreement-form]", body);
  const error = query("[data-agreement-error]", body);
  const kindSelect = form.elements.namedItem("kind") as HTMLSelectElement;
  const sync = () => {
    for (const el of queryAll("[data-kind]", body)) el.hidden = el.dataset.kind !== kindSelect.value;
  };
  kindSelect.addEventListener("change", sync);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = query<HTMLButtonElement>("[type=submit]", form);
    const data = new FormData(form);
    const kind = kindSelect.value as AgreementKind;
    const parties = parseParties(String(data.get("parties")));
    if (parties.length === 0) return say(error, "Add at least one NEAR account.", "error");
    submit.disabled = true;
    try {
      let doc: { doc_hash: string; title: string };
      if (kind === "upload") {
        const file = (form.elements.namedItem("file") as HTMLInputElement).files?.[0];
        const title = String(data.get("title")).trim();
        if (!file || !title) throw new Error("Add a title and a PDF.");
        say(error, "Encrypting and uploading…");
        const bytes = new Uint8Array(await file.arrayBuffer());
        doc = await api.uploadDocument(await passkeyAuth(session, "upload-document", title), { title, mime: "application/pdf", content_base64: toBase64(bytes) });
      } else {
        say(error, "Generating the document…");
        doc = await api.generateDocument(await passkeyAuth(session, "generate-document", kind), {
          kind,
          parties,
          invoice_id: kind === "service-agreement" ? String(data.get("invoice")) : undefined,
          terms: kind === "service-agreement" ? String(data.get("terms")) : undefined,
        });
      }
      say(error, "Sending for signature…");
      await api.createAgreement(await businessAuth(session, "create-agreement"), {
        kind,
        title: doc.title,
        doc_hash: doc.doc_hash,
        parties,
        invoice_id: kind === "service-agreement" ? String(data.get("invoice")) : null,
      });
      closeModal();
      showToast("Agreement created");
      filter = "company";
      await loadAgreements();
    } catch (cause) {
      say(error, errorText(cause), "error");
      submit.disabled = false;
    }
  });
}

export function initAgreements() {
  for (const button of queryAll<HTMLButtonElement>("[data-agreement-filter] button")) {
    button.addEventListener("click", () => {
      filter = button.dataset.filter as typeof filter;
      for (const b of queryAll("[data-agreement-filter] button")) b.setAttribute("aria-pressed", String(b === button));
      void loadAgreements();
    });
  }
  query("[data-new-agreement]").addEventListener("click", openNewAgreement);
}
