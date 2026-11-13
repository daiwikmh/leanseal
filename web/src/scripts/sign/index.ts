import { agreementSigningSubject, type Agreement } from "shared";
import { api } from "../lib/api";
import { agreementStatusTag, agreementSummaryHtml, consentText, documentHtml } from "../lib/agreementView";
import { errorText, query, say } from "../lib/dom";
import { passkeyAuth } from "../lib/near";
import { signInWithPasskey, type PasskeySession } from "../lib/passkey";
import { connectWallet, walletAuth, walletSignAgreement } from "../lib/wallet";

const id = new URLSearchParams(location.search).get("id") ?? "";
const message = query("[data-sign-message]");
let agreement: Agreement;
let signer: { accountId: string; auth: (action: string, subject: string) => Promise<string>; sign: () => Promise<unknown> } | null = null;

function render() {
  query("[data-sign-status]").outerHTML = `<span data-sign-status>${agreementStatusTag(agreement)}</span>`;
  query("[data-sign-company]").textContent = `From ${agreement.company}`;
  query("[data-sign-title]").textContent = agreement.title;
  query("[data-sign-summary]").innerHTML = agreementSummaryHtml(agreement);
  query("[data-sign-connect]").hidden = signer !== null || agreement.status !== "pending";
}

async function afterSignIn() {
  if (!signer) return;
  if (!agreement.parties.includes(signer.accountId) && agreement.company !== signer.accountId) {
    signer = null;
    render();
    return say(message, "That account is not a party to this agreement. Sign in with the account the sender listed.", "error");
  }
  say(message, "Opening the document…");
  const doc = await api.document(await signer.auth("read-document", agreement.doc_hash), agreement.doc_hash, agreement.id);
  query("[data-sign-doc]").hidden = false;
  query("[data-signer]").textContent = `Signed in as ${signer.accountId}`;
  query("[data-sign-doc-body]").innerHTML = documentHtml(doc);
  const canSign = agreement.status === "pending" && agreement.parties.includes(signer.accountId) && !agreement.signatures.some((s) => s.account_id === signer!.accountId);
  query("[data-consent-row]").hidden = !canSign;
  query("[data-sign-go]").hidden = !canSign;
  query("[data-consent-text]").textContent = consentText;
  say(message, canSign ? "" : "You have already signed, or this agreement is closed.");
  render();
}

query("[data-connect-wallet]").addEventListener("click", async () => {
  try {
    const accountId = await connectWallet();
    signer = { accountId, auth: walletAuth, sign: async () => api.signAgreement(await walletSignAgreement(agreement.id, agreement.doc_hash), agreement.id) };
    await afterSignIn();
  } catch (error) {
    say(message, errorText(error), "error");
  }
});

query("[data-use-passkey]").addEventListener("click", async () => {
  try {
    const session: PasskeySession = await signInWithPasskey();
    signer = {
      accountId: session.accountId,
      auth: (action, subject) => passkeyAuth(session, action, subject),
      sign: async () => api.signAgreement(await passkeyAuth(session, "sign-agreement", agreementSigningSubject(agreement.id, agreement.doc_hash)), agreement.id),
    };
    await afterSignIn();
  } catch (error) {
    say(message, errorText(error), "error");
  }
});

query("[data-consent]").addEventListener("change", (event) => {
  query<HTMLButtonElement>("[data-sign-go]").disabled = !(event.target as HTMLInputElement).checked;
});

query("[data-sign-go]").addEventListener("click", async () => {
  if (!signer) return;
  const button = query<HTMLButtonElement>("[data-sign-go]");
  button.disabled = true;
  try {
    say(message, "Sign with your wallet or passkey…");
    await signer.sign();
    agreement = await api.agreement(agreement.id);
    query("[data-consent-row]").hidden = true;
    button.hidden = true;
    say(message, agreement.status === "executed" ? "Signed. Every party has signed; the agreement is executed." : "Signed. Waiting for the other parties.");
    render();
  } catch (error) {
    say(message, errorText(error), "error");
    button.disabled = false;
  }
});

(async () => {
  if (!id) return say(message, "This link has no agreement id.", "error");
  try {
    agreement = await api.agreement(id);
    render();
  } catch (error) {
    say(message, errorText(error), "error");
  }
})();
