import { accountUrl } from "shared";
import { api } from "../lib/api";
import { date, esc, query, queryAll } from "../lib/dom";
import { businessAuth } from "../lib/near";
import { forget } from "../lib/passkey";
import { showToast } from "../lib/toast";
import { state } from "./state";

export function renderAccount() {
  const session = state.session;
  if (!session) return;
  api
    .chatInfo()
    .then((info) => {
      const tg = query("[data-chat-telegram]");
      tg.innerHTML = info.telegram ? `<a href="https://t.me/${info.telegram}" target="_blank" rel="noopener">@${info.telegram} ↗</a>` : "Not configured";
      query("[data-chat-xmtp]").textContent = info.xmtp ?? "Not configured";
    })
    .catch(() => undefined);
  void renderChatLinks();
  query("[data-topbar-address]").textContent = session.accountId;
  query("[data-account-id]").textContent = session.accountId;
  query("[data-account-key]").textContent = `${session.key.publicKey.slice(0, 20)}…`;
  query<HTMLAnchorElement>("[data-account-explorer]").href = accountUrl(session.accountId);
}

export function initAccount() {
  for (const button of queryAll("[data-copy-account]")) {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(state.session?.accountId ?? "");
      showToast("Account copied");
    });
  }
  for (const button of queryAll("[data-sign-out]")) {
    button.addEventListener("click", () => {
      state.session = null;
      forget();
      location.reload();
    });
  }
}

async function renderChatLinks() {
  const session = state.session;
  if (!session) return;
  const wrap = query("[data-chat-links]");
  try {
    const links = await api.chatLinks(await businessAuth(session, "list-chats"));
    wrap.innerHTML = links
      .map(
        (l) => `<div class="setting-row"><span class="setting-row__label">${l.platform === "xmtp" ? "XMTP" : "Telegram"} · ${esc(l.label || l.chat_user_id.slice(0, 12))}</span><span class="setting-row__value">connected ${date(Date.parse(l.linked_at))}</span><button type="button" class="link-btn" data-unlink-chat="${esc(l.platform)}|${esc(l.chat_user_id)}">Disconnect</button></div>`,
      )
      .join("");
  } catch {
    wrap.innerHTML = "";
  }
}

document.addEventListener("click", async (event) => {
  const value = (event.target as HTMLElement).dataset.unlinkChat;
  if (!value || !state.session) return;
  const [platform, id] = value.split("|");
  await api.unlinkChat(await businessAuth(state.session, "unlink-chat"), platform, id);
  showToast("Chat disconnected");
  await renderChatLinks();
});
