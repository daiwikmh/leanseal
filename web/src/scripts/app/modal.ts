import { query } from "../lib/dom";

const overlay = query("[data-modal]");
const title = query("[data-modal-title]");
const body = query("[data-modal-body]");

export function openModal(heading: string, html: string): HTMLElement {
  title.textContent = heading;
  body.innerHTML = html;
  overlay.hidden = false;
  return body;
}

export function closeModal() {
  overlay.hidden = true;
  body.innerHTML = "";
}

query("[data-modal-close]").addEventListener("click", closeModal);
overlay.addEventListener("click", (event) => {
  if (event.target === overlay) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !overlay.hidden) closeModal();
});
