import { query, queryAll } from "../lib/dom";

const handlers = new Map<string, () => void>();

export function onTab(key: string, handler: () => void) {
  handlers.set(key, handler);
}

export function activateTab(key: string) {
  query("[data-dash]").dataset.tab = key;
  for (const button of queryAll<HTMLButtonElement>("[data-tab]")) button.setAttribute("aria-selected", String(button.dataset.tab === key));
  for (const panel of queryAll("[data-panel]")) panel.hidden = panel.dataset.panel !== key;
  handlers.get(key)?.();
}

export function initTabs() {
  for (const button of queryAll<HTMLButtonElement>("[data-tab]")) button.addEventListener("click", () => activateTab(button.dataset.tab!));
  document.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-goto]");
    if (target && query("[data-dash]").contains(target)) activateTab(target.dataset.goto!);
  });
  const menu = query("[data-account-menu]");
  const trigger = query<HTMLButtonElement>("[data-topbar-address]");
  const list = query("[data-account-menu-list]");
  const setOpen = (open: boolean) => {
    list.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  };
  trigger.addEventListener("click", () => setOpen(list.hidden));
  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target as Node)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
}
