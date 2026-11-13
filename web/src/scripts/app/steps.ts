import { milestoneIndex, milestones, type CompanyStatus } from "shared";
import { esc } from "../lib/dom";

export function stepsHtml(status: CompanyStatus): string {
  const current = milestoneIndex(status);
  return milestones
    .map((m, index) => {
      const state = index < current ? "done" : index === current ? "now" : "next";
      return `<li class="step step--${state}"><i class="step__mark"></i><div><b>${esc(m.label)}</b><p>${esc(m.detail)}</p></div></li>`;
    })
    .join("");
}
