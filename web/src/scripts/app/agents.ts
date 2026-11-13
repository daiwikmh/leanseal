import { toUnits, usdcAssetId, type AgentView } from "shared";
import { api } from "../lib/api";
import { date, errorText, esc, query, say, usdc } from "../lib/dom";
import { businessAuth, createAgentAccount, sendUsdc } from "../lib/near";
import { showToast } from "../lib/toast";
import { closeModal, openModal } from "./modal";
import { state } from "./state";

let agents: AgentView[] = [];

const auth = (action: string) => businessAuth(state.session!, action);

function snippet(): string {
  const base = location.origin.replace(":4321", ":8787");
  return `# The agent's own key (Agents › Key). It can only spend this agent's balance.
curl ${base}/v1/agent -H "Authorization: Bearer $AGENT_KEY"

# Pay a NEAR account (an API provider, a data seller…)
curl -X POST ${base}/v1/agent/pay -H "Authorization: Bearer $AGENT_KEY" \\
  -H "Content-Type: application/json" -d '{"to":"data-provider.near","amount":"0.25","memo":"weather lookup"}'

# Fetch a URL behind an x402 paywall; opencash pays it in USDC on NEAR if it's within limits
curl -X POST ${base}/v1/agent/fetch -H "Authorization: Bearer $AGENT_KEY" \\
  -H "Content-Type: application/json" -d '{"url":"https://api.example.com/premium-report"}'`;
}

function render() {
  const wrap = query("[data-agent-list]");
  wrap.classList.remove("table-wrap--loading");
  wrap.innerHTML = agents.length
    ? `<table class="data-table"><tbody>${agents
        .map(
          (a) => `<tr data-agent="${esc(a.id)}"><td class="cell-identity">${esc(a.name)}<small class="cell-muted mono" style="display:block;font-weight:400">${esc(a.account_id)}</small></td>
            <td class="cell-muted">${a.balance === null ? "—" : `$${esc(a.balance)}`}<small style="display:block">spent $${esc(a.spent_24h)} / $${esc(a.daily_cap)} today</small></td>
            <td><span class="tag tag--${a.status === "active" ? "paid" : a.status === "frozen" ? "refunded" : "open"}"><i class="tag__dot"></i>${a.status}</span></td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="empty">No agents yet.</p>`;
}

export async function loadAgents() {
  query("[data-agent-snippet]").textContent = snippet();
  if (!state.session) return;
  try {
    agents = await api.agents(await auth("list-agents"));
    render();
  } catch (error) {
    query("[data-agent-list]").innerHTML = `<p class="error-text">${esc(errorText(error))}</p>`;
  }
}

async function openAgent(id: string) {
  const agent = agents.find((a) => a.id === id);
  if (!agent) return;
  const body = openModal(
    agent.name,
    `<p class="mono">${esc(agent.account_id)}</p>
     <div class="stat-grid"><div class="stat"><small>Balance</small><b>${agent.balance === null ? "—" : `$${esc(agent.balance)}`}</b></div><div class="stat"><small>Spent (24h)</small><b>$${esc(agent.spent_24h)}</b></div>
     <div class="stat"><small>Per payment</small><b>$${esc(agent.per_tx_cap)}</b></div><div class="stat"><small>Per 24h</small><b>$${esc(agent.daily_cap)}</b></div></div>
     <p class="panel__lede">Allowlist: ${agent.allowlist.length ? esc(agent.allowlist.join(", ")) : "anyone"}</p>
     <div class="field-row" style="margin-top:var(--sp-md)"><label class="field"><span>Fund with USDC</span><input data-fund-amount inputmode="decimal" placeholder="5.00" /></label><div class="field"><span>&nbsp;</span><button type="button" class="btn btn--primary" data-fund>Fund with passkey</button></div></div>
     <div class="btn-row" style="margin-top:var(--sp-md)">
       <button type="button" class="btn" data-agent-key>${agent.api_key_prefix ? "Rotate API key" : "Create API key"}</button>
       <button type="button" class="btn" data-agent-freeze>${agent.status === "frozen" ? "Unfreeze" : "Freeze"}</button>
       <button type="button" class="btn" data-agent-sweep>Sweep balance back</button>
     </div>
     <div class="warn-box" data-agent-secret hidden></div>
     <p class="form-error" data-agent-modal-error></p>
     <span class="panel__label">Payments</span><div class="line-items" data-agent-history>Loading…</div>`,
  );
  const error = query("[data-agent-modal-error]", body);
  const run = (task: () => Promise<void>) => task().catch((cause) => say(error, errorText(cause), "error"));
  api
    .agentPayments(await auth("agent-payments"), id)
    .then((rows) => {
      query("[data-agent-history]", body).innerHTML = rows.length
        ? rows.map((p) => `<div class="leg-row"><span>${esc(p.kind)} → ${esc(p.resource ?? p.recipient)} · ${date(Date.parse(p.created_at))}</span><span>$${esc(p.amount)} · ${esc(p.status)}</span></div>`).join("")
        : `<p class="cell-muted">No payments yet.</p>`;
    })
    .catch(() => undefined);
  query("[data-fund]", body).addEventListener("click", () =>
    run(async () => {
      const amount = query<HTMLInputElement>("[data-fund-amount]", body).value.trim();
      say(error, "Preparing the transfer…");
      const { payouts } = await api.quotePayouts(await auth("quote-payouts"), { items: [{ payee_name: agent.name, asset_id: usdcAssetId, recipient: agent.account_id, amount }] });
      say(error, "Signing with your passkey…");
      await sendUsdc(state.session!, payouts);
      showToast(`Funded ${agent.name} with ${usdc(toUnits(amount))}`);
      closeModal();
      await loadAgents();
    }),
  );
  query("[data-agent-key]", body).addEventListener("click", () =>
    run(async () => {
      const { key } = await api.agentKey(await auth("agent-key"), id);
      const box = query("[data-agent-secret]", body);
      box.hidden = false;
      box.innerHTML = `Agent API key (shown once; it can only spend this agent's balance within its limits):<br /><code class="mono">${esc(key)}</code>`;
    }),
  );
  query("[data-agent-freeze]", body).addEventListener("click", () =>
    run(async () => {
      await api.updateAgent(await auth("update-agent"), id, { frozen: agent.status !== "frozen" });
      closeModal();
      await loadAgents();
    }),
  );
  query("[data-agent-sweep]", body).addEventListener("click", () =>
    run(async () => {
      const result = await api.sweepAgent(await auth("sweep-agent"), id);
      showToast(`Swept $${result.amount} back to your account`);
      closeModal();
      await loadAgents();
    }),
  );
}

export function initAgents() {
  const form = query<HTMLFormElement>("[data-agent-form]");
  const error = query("[data-agent-error]");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      say(error, "Creating the agent…");
      const { agent, public_key } = await api.createAgent(await auth("create-agent"), {
        name: String(data.get("name")),
        per_tx_cap: String(data.get("per_tx_cap")),
        daily_cap: String(data.get("daily_cap")),
        allowlist: String(data.get("allowlist")).split(",").map((s) => s.trim()).filter(Boolean),
      });
      say(error, "Signing its account into existence with your passkey…");
      await createAgentAccount(state.session!, agent.account_id, public_key);
      form.reset();
      say(error, "");
      showToast(`${agent.name} is live`);
      await loadAgents();
    } catch (cause) {
      say(error, errorText(cause), "error");
    }
  });
  query("[data-agent-list]").addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-agent]");
    if (row) void openAgent(row.dataset.agent!);
  });
}
