import type { Jurisdiction } from "shared";
import { config } from "./config.js";

export type Advice = { jurisdiction: Jurisdiction; reason: string; filings: string[]; model: string };

const plans: Record<string, string> = {
  services: "sells services or software to clients",
  saas: "runs a subscription product",
  venture: "plans to raise money from investors",
};

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["jurisdiction", "reason", "filings"],
  properties: {
    jurisdiction: { type: "string", enum: ["wy-llc", "de-ccorp"] },
    reason: { type: "string" },
    filings: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5 },
  },
};

const system = [
  "You advise non-US founders forming their first US company.",
  "Choose exactly one: wy-llc (Wyoming single-member LLC) or de-ccorp (Delaware C-Corp).",
  "Default to wy-llc unless the founder plans to raise venture capital or issue stock options.",
  "reason: two plain sentences for a non-lawyer, mentioning their country when relevant to home-country tax.",
  "filings: the recurring US filings this choice creates, each one short line (for a foreign-owned single-member LLC include Form 5472 with pro forma 1120).",
  "Never claim to be a lawyer or accountant.",
].join(" ");

export async function advise(input: { country: string; plan: string; company: string }): Promise<Advice> {
  const response = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.nearAiKey()}` },
    body: JSON.stringify({
      model: config.nearAiModel,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Founder lives in ${input.country}. Company "${input.company || "unnamed"}" ${plans[input.plan] ?? plans.services}.`,
        },
      ],
      response_format: { type: "json_schema", json_schema: { name: "advice", strict: true, schema } },
    }),
  });
  if (!response.ok) throw new Error(`NEAR AI ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { choices: { message: { content: string } }[] };
  const content = body.choices[0]?.message.content ?? "";
  const parsed = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)) as Omit<Advice, "model">;
  if (parsed.jurisdiction !== "wy-llc" && parsed.jurisdiction !== "de-ccorp") throw new Error("Advisor returned an unknown entity type.");
  return { ...parsed, model: config.nearAiModel };
}
