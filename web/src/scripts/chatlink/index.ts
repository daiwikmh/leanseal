import { api } from "../lib/api";
import { errorText, query, say } from "../lib/dom";
import { passkeyAuth } from "../lib/near";
import { signInWithPasskey, type PasskeySession } from "../lib/passkey";
import { devSession } from "../app/dev";

const code = new URLSearchParams(location.search).get("code") ?? "";
const status = query("[data-link-status]");

async function link(session: PasskeySession) {
  say(status, "Connecting…");
  const result = await api.linkChat(await passkeyAuth(session, "link-chat", code), code);
  say(status, `Connected to ${result.account}. Go back to your ${result.platform === "xmtp" ? "XMTP" : "Telegram"} chat.`);
}

query("[data-link-passkey]").addEventListener("click", () => signInWithPasskey().then(link).catch((e) => say(status, errorText(e), "error")));
document.querySelector("[data-link-dev]")?.addEventListener("click", () => link(devSession()).catch((e) => say(status, errorText(e), "error")));
const who = query("[data-link-who]");
if (!code) say(status, "This link has no code. Send 'link' to the bot for a new one.", "error");
api
  .chatCode(code)
  .then((info) => {
    who.textContent = `You are connecting the ${info.platform === "xmtp" ? "XMTP" : "Telegram"} chat ${info.label || "(no name shared)"} to your opencash account.`;
  })
  .catch((e) => {
    who.textContent = errorText(e);
  });
query<HTMLInputElement>("[data-link-confirm]").addEventListener("change", (event) => {
  const on = (event.target as HTMLInputElement).checked;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-link-passkey], [data-link-dev]")) b.disabled = !on;
});
