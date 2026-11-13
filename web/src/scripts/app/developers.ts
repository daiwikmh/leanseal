import type { ApiKey, Webhook, X402Settlement } from "shared";
import { api } from "../lib/api";
import { date, errorText, esc, query, say } from "../lib/dom";
import { businessAuth } from "../lib/near";
import { showToast } from "../lib/toast";
import { state } from "./state";

let keys: ApiKey[] = [];
let hooks: Webhook[] = [];
let sales: X402Settlement[] = [];

function snippet(): string {
  const base = location.origin.replace(":4321", ":8787");
  return `# Create a checkout (customer pays from any chain, you get USDC on NEAR)
curl -X POST ${base}/v1/checkouts \\
  -H "Authorization: Bearer $OPENCASH_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":"49.00","description":"Pro plan · 1 month","reference":"order_8812"}'

# → { "id": "acme-7", "status": "open", "pay_url": "${location.origin}/pay?id=acme-7", ... }

# Create an invoice
curl -X POST ${base}/v1/invoices \\
  -H "Authorization: Bearer $OPENCASH_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"client_name":"Northwind","due_date":"2026-12-01","items":[{"description":"Design sprint","amount":"1250.50"}]}'

# Read status
curl ${base}/v1/invoices/acme-7 -H "Authorization: Bearer $OPENCASH_KEY"

// Verify a webhook (Node)
const [t, v1] = req.headers["opencash-signature"].split(",").map((p) => p.split("=")[1]);
const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(\`\${t}.\${rawBody}\`).digest("hex");
if (expected !== v1 || Date.now() / 1000 - Number(t) > 300) throw new Error("bad signature");

// Sell an endpoint with x402 (Node, @fastnear/x402)
import { createNearResourceServer } from "@fastnear/x402/server";
const server = createNearResourceServer({
  facilitators: {
    url: "${base}/x402/facilitator",
    createAuthHeaders: async () => {
      const h = { Authorization: \`Bearer \${process.env.OPENCASH_KEY}\` };
      return { verify: h, settle: h, supported: h };
    },
  },
});
// accepts: { scheme: "exact", network: "near:mainnet", payTo: "${state.session?.accountId ?? "acme.opencash.near"}", price: "$0.01" }`;
}

function render() {
  query("[data-key-table]").innerHTML = keys.length
    ? `<table class="data-table"><tbody>${keys
        .map((k) => `<tr><td class="cell-identity">${esc(k.name)}</td><td class="cell-muted mono">${esc(k.prefix)}…</td><td class="cell-muted">${k.last_used_at ? `used ${date(Date.parse(k.last_used_at))}` : "never used"}</td><td class="cell-value"><button type="button" class="link-btn" data-revoke="${esc(k.id)}">Revoke</button></td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="empty">No API keys.</p>`;
  query("[data-hook-list]").innerHTML = hooks
    .map(
      (h) => `<div class="leg-row"><span class="mono">${esc(h.url)}</span><span><button type="button" class="link-btn" data-hook-delete="${esc(h.id)}">Remove</button></span></div>
      ${(h.recent ?? []).map((d) => `<div class="leg-row cell-muted"><span>${esc(d.event_type)}</span><span>${esc(d.status)}${d.last_status_code ? ` · HTTP ${d.last_status_code}` : ""} · ${d.attempts} attempt(s)</span></div>`).join("")}`,
    )
    .join("");
  query("[data-x402-list]").innerHTML = sales.length
    ? `<table class="data-table"><tbody>${sales
        .map((p) => `<tr><td class="cell-identity mono">${esc(p.payer)}</td><td class="cell-muted">${esc(p.resource ?? "")}</td><td class="cell-muted">${date(Date.parse(p.created_at))}</td><td class="cell-value">${esc(p.amount)} USDC</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="empty">No x402 sales yet.</p>`;
}

export async function loadDevelopers() {
  query("[data-dev-snippet]").textContent = snippet();
  const session = state.session;
  if (!session) return;
  try {
    [keys, hooks, sales] = await Promise.all([
      api.apiKeys(await businessAuth(session, "list-keys")),
      api.webhooks(await businessAuth(session, "list-webhooks")),
      api.x402Settlements(await businessAuth(session, "x402-settlements")),
    ]);
    render();
  } catch (error) {
    say(query("[data-dev-error]"), errorText(error), "error");
  }
}

export function initDevelopers() {
  const error = query("[data-dev-error]");
  query<HTMLFormElement>("[data-key-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    try {
      const created = await api.createApiKey(await businessAuth(state.session!, "create-key"), String(new FormData(form).get("name")));
      const box = query("[data-new-key]");
      box.hidden = false;
      box.innerHTML = `Copy this key now; it won't be shown again:<br /><code class="mono">${esc(created.key)}</code>`;
      form.reset();
      await loadDevelopers();
    } catch (cause) {
      say(error, errorText(cause), "error");
    }
  });
  query<HTMLFormElement>("[data-hook-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    try {
      const created = await api.createWebhook(await businessAuth(state.session!, "create-webhook"), String(new FormData(form).get("url")).trim());
      const box = query("[data-new-secret]");
      box.hidden = false;
      box.innerHTML = `Signing secret (shown once):<br /><code class="mono">${esc(created.secret)}</code>`;
      form.reset();
      await loadDevelopers();
    } catch (cause) {
      say(error, errorText(cause), "error");
    }
  });
  query("[data-key-table]").addEventListener("click", async (event) => {
    const id = (event.target as HTMLElement).dataset.revoke;
    if (!id) return;
    await api.revokeApiKey(await businessAuth(state.session!, "revoke-key"), id);
    await loadDevelopers();
  });
  query("[data-hook-list]").addEventListener("click", async (event) => {
    const id = (event.target as HTMLElement).dataset.hookDelete;
    if (!id) return;
    await api.deleteWebhook(await businessAuth(state.session!, "delete-webhook"), id);
    await loadDevelopers();
  });
  query("[data-hook-test]").addEventListener("click", async () => {
    try {
      await api.testWebhook(await businessAuth(state.session!, "test-webhook"));
      showToast("Test event queued");
      setTimeout(() => void loadDevelopers(), 12_000);
    } catch (cause) {
      say(error, errorText(cause), "error");
    }
  });
}
