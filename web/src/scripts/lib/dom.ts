import { formatUsd, type InvoiceStatus } from "shared";
import { statusLabel } from "./api";

export function query<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  return root.querySelector<T>(selector)!;
}

export function queryAll<T extends HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function say(el: HTMLElement, message: string, tone: "info" | "error" = "info") {
  el.textContent = message;
  el.dataset.tone = tone;
}

export const usdc = formatUsd;

export function moneyHtml(units: string): string {
  const [whole, cents] = usdc(units).split(".");
  return `${whole}<small>.${cents}</small>`;
}

export function date(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function short(account: string): string {
  return account.length > 28 ? `${account.slice(0, 10)}…${account.slice(-10)}` : account;
}

export function statusTag(status: InvoiceStatus): string {
  return `<span class="tag tag--${status}"><i class="tag__dot"></i>${statusLabel[status]}</span>`;
}
