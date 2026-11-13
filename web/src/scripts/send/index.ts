import type { Payout } from "shared";
import { api } from "../lib/api";
import { errorText, esc, query, say, usdc } from "../lib/dom";
import { businessAuth, sendUsdc } from "../lib/near";
import { signInWithPasskey, type PasskeySession } from "../lib/passkey";
import { devSession } from "../app/dev";

const ids = (new URLSearchParams(location.search).get("ids") ?? "").split(",").filter(Boolean);
const status = query("[data-send-status]");
let session: PasskeySession;
let payouts: Payout[] = [];

async function review(next: PasskeySession) {
  session = next;
  say(status, "Loading the quote…");
  const all = await api.payouts(await businessAuth(session, "list-payouts"));
  payouts = all.filter((p) => ids.includes(p.id));
  if (payouts.length === 0) throw new Error(`No payouts from this link belong to ${session.accountId}.`);
  const ready = payouts.filter((p) => p.status === "quoted" && Date.parse(p.deadline) > Date.now());
  query("[data-send-signin]").hidden = true;
  query("[data-send-review]").hidden = false;
  query("[data-send-account]").textContent = `From ${session.accountId}`;
  query("[data-send-rows]").innerHTML = payouts
    .map((p) => `<div class="leg-row"><span>${esc(p.payee_name)} receives <b>${esc(p.amount_out)} ${esc(p.symbol)}</b> on ${esc(p.chain)}${p.status === "quoted" ? "" : ` · ${esc(p.status)}`}</span><span>${usdc(p.amount_units)}</span></div>`)
    .join("");
  if (ready.length === 0) {
    query("[data-send-confirm]").closest("label")!.hidden = true;
    query("[data-send-go]").hidden = true;
    say(status, "Nothing left to send: these payouts were already sent or the quote expired. Ask the bot again.");
    return;
  }
  payouts = ready;
  say(status, "");
}

query("[data-send-passkey]").addEventListener("click", () => signInWithPasskey().then(review).catch((e) => say(status, errorText(e), "error")));
document.querySelector("[data-send-dev]")?.addEventListener("click", () => review(devSession()).catch((e) => say(status, errorText(e), "error")));
query<HTMLInputElement>("[data-send-confirm]").addEventListener("change", (event) => {
  query<HTMLButtonElement>("[data-send-go]").disabled = !(event.target as HTMLInputElement).checked;
});
query("[data-send-go]").addEventListener("click", async () => {
  const button = query<HTMLButtonElement>("[data-send-go]");
  button.disabled = true;
  try {
    say(status, "Signing with your passkey…");
    await sendUsdc(session, payouts);
    button.hidden = true;
    say(status, "Sent. Your chat will tell you when it's delivered.");
  } catch (error) {
    say(status, errorText(error), "error");
    button.disabled = false;
  }
});
if (ids.length === 0) say(status, "This link has no payouts.", "error");
