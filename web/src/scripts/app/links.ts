import type { PaymentLink } from "shared";
import { api } from "../lib/api";
import { errorText, esc, query, say } from "../lib/dom";
import { businessAuth } from "../lib/near";
import { showToast } from "../lib/toast";
import { state } from "./state";

let links: PaymentLink[] = [];

function linkUrl(link: PaymentLink): string {
  return `${location.origin}/link?id=${link.id}`;
}

function render() {
  const wrap = query("[data-link-table]");
  wrap.classList.remove("table-wrap--loading");
  wrap.innerHTML = links.length
    ? `<table class="data-table"><tbody>${links
        .map(
          (l) => `<tr><td class="cell-identity">${esc(l.title)}<small class="cell-muted" style="display:block;font-weight:400">${l.amount ? `$${esc(l.amount)}` : "Payer chooses amount"}</small></td>
            <td><span class="tag tag--${l.active ? "paid" : "refunded"}"><i class="tag__dot"></i>${l.active ? "Live" : "Off"}</span></td>
            <td class="cell-value"><button type="button" class="link-btn" data-copy-link="${esc(l.id)}">Copy link</button> · <button type="button" class="link-btn" data-toggle-link="${esc(l.id)}">${l.active ? "Turn off" : "Turn on"}</button></td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="empty">No links yet.</p>`;
}

export async function loadLinks() {
  if (!state.session) return;
  try {
    links = await api.links(await businessAuth(state.session, "list-links"));
    render();
  } catch (error) {
    query("[data-link-table]").innerHTML = `<p class="error-text">${esc(errorText(error))}</p>`;
  }
}

export function initLinks() {
  const form = query<HTMLFormElement>("[data-link-form]");
  const error = query("[data-link-error]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      const link = await api.createLink(await businessAuth(state.session!, "create-link"), {
        title: String(data.get("title")),
        description: String(data.get("description")),
        amount: String(data.get("amount")).trim() || null,
      });
      links = [link, ...links];
      render();
      form.reset();
      say(error, "");
      await navigator.clipboard.writeText(linkUrl(link)).catch(() => undefined);
      showToast("Link created and copied");
    } catch (cause) {
      say(error, errorText(cause), "error");
    }
  });
  query("[data-link-table]").addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const copy = links.find((l) => l.id === target.dataset.copyLink);
    if (copy) {
      await navigator.clipboard.writeText(linkUrl(copy));
      return showToast("Link copied");
    }
    const toggle = links.find((l) => l.id === target.dataset.toggleLink);
    if (toggle) {
      const updated = await api.setLinkActive(await businessAuth(state.session!, "update-link"), toggle.id, !toggle.active);
      links = links.map((l) => (l.id === updated.id ? updated : l));
      render();
    }
  });
}
