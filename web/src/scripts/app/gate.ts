import { handlePattern, network } from "shared";
import { api } from "../lib/api";
import { errorText, query, say } from "../lib/dom";
import { createPasskey, passkeysSupported, signInWithPasskey, type PasskeySession } from "../lib/passkey";
import { devCompany, devSession, undeployedCompany } from "./dev";
import { state } from "./state";

const gate = query("[data-gate]");
const startForm = query<HTMLFormElement>("[data-start-form]");
const signinForm = query<HTMLFormElement>("[data-signin-form]");
const status = query("[data-gate-status]");
const signinStatus = query("[data-signin-status]");
const startButton = query<HTMLButtonElement>("[data-start]");
const preview = query("[data-handle-preview]");

function text(name: string): string {
  return (startForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement).value.trim();
}

export function initGate(onReady: (session: PasskeySession) => Promise<void>) {
  if (!passkeysSupported()) say(status, "This browser has no passkey support. Use Chrome, Safari or Edge.", "error");

  startForm.addEventListener("input", () => {
    preview.textContent = `${text("handle").toLowerCase() || "acme"}.${network.parent}`;
  });

  startForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const handle = text("handle").toLowerCase();
    if (!text("business")) return say(status, "Enter your business name.", "error");
    if (!handlePattern.test(handle)) return say(status, "Account handle: lowercase letters, numbers and dashes.", "error");
    if (!text("country")) return say(status, "Choose your country.", "error");
    startButton.disabled = true;
    try {
      say(status, "Create your passkey…");
      const session = await createPasskey(`${handle}.${network.parent}`, text("founder") || text("business"));
      say(status, "Opening your USDC account on NEAR…");
      const { company } = await api.createCompany({ handle, legalName: text("business"), country: text("country"), publicKey: session.key.publicKey });
      state.company = company;
      await onReady(session);
    } catch (error) {
      say(status, errorText(error), "error");
      startButton.disabled = false;
    }
  });

  document.querySelector("[data-dev-login]")?.addEventListener("click", async () => {
    const session = devSession();
    try {
      say(status, `Dev mode: opening ${session.accountId} on NEAR…`);
      try {
        state.company = await devCompany(session);
      } catch (error) {
        if (!/does not exist|Missing env/.test(errorText(error))) throw error;
        state.company = undeployedCompany(session);
        state.preview = errorText(error);
      }
      await onReady(session);
    } catch (error) {
      say(status, `Dev mode: ${errorText(error)}`, "error");
    }
  });

  signinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      say(signinStatus, "Waiting for your passkey…");
      await onReady(await signInWithPasskey());
    } catch (error) {
      say(signinStatus, errorText(error), "error");
    }
  });

  query("[data-show-signin]").addEventListener("click", () => {
    startForm.hidden = true;
    signinForm.hidden = false;
  });
  query("[data-show-start]").addEventListener("click", () => {
    signinForm.hidden = true;
    startForm.hidden = false;
  });
}

export function hideGate() {
  gate.hidden = true;
  query("[data-dash]").hidden = false;
}
