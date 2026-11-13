import assert from "node:assert/strict";
import { KeyPair, KeyPairSigner, actions, buildDelegateAction, type KeyPairString } from "near-api-js";
import { nearKeyFromPrf } from "shared";
import { agentForKey, assertPublicUrl, createAgent, issueAgentKey, reserve, updateAgent } from "./agents.js";
import { db } from "./db.js";

process.env.PARENT_ACCOUNT = "opencash.near";
const { refusal } = await import("./relayer.js");

const company = `agt${Date.now() % 100000}.opencash.near`;
await assert.rejects(createAgent(company, { name: "Bot", per_tx_cap: "10", daily_cap: "5" }), /at least the per-payment cap/);
await assert.rejects(createAgent(company, { name: "Bot", per_tx_cap: "abc", daily_cap: "5" }), /must look like/);
const { agent, public_key } = await createAgent(company, { name: "Research bot", per_tx_cap: "2", daily_cap: "5", allowlist: ["data.near", "API.example.com"] });
assert.match(agent.account_id, new RegExp(`^agent-research-bot-[0-9a-f]{4}\\.${company.replace(/\./g, "\\.")}$`));
assert.match(public_key, /^ed25519:/);
const raw = (await db().query("select key_cipher from agents where id = $1", [agent.id])).rows[0];
assert.ok(!Buffer.from(raw.key_cipher).toString("utf8").includes("ed25519:"), "the agent secret key is encrypted at rest");

await assert.rejects(reserve(agent.id, "transfer", "data.near", "1000000", null, null), /frozen or not active/, "a not-yet-created agent can't spend");
await db().query("update agents set status = 'active' where id = $1", [agent.id]);
await assert.rejects(reserve(agent.id, "transfer", "data.near", "2500000", null, null), /per-payment cap/);
await assert.rejects(reserve(agent.id, "transfer", "evil.near", "1000000", null, null), /allowlist/);
await reserve(agent.id, "x402", "seller.near", "1000000", "https://api.example.com/x", "api.example.com");
await reserve(agent.id, "transfer", "data.near", "2000000", null, null);
const race = await Promise.allSettled([reserve(agent.id, "transfer", "data.near", "2000000", null, null), reserve(agent.id, "transfer", "data.near", "2000000", null, null)]);
assert.equal(race.filter((r) => r.status === "fulfilled").length, 1, "two simultaneous payments can't both slip under the 24-hour cap");
assert.match(String((race.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /24-hour cap/);
await db().query("update agent_payments set status = 'failed' where agent_id = $1 and amount_units = 2000000", [agent.id]);
await reserve(agent.id, "transfer", "data.near", "2000000", null, null);
await updateAgent(company, agent.id, { frozen: true });
await assert.rejects(reserve(agent.id, "transfer", "data.near", "100000", null, null), /frozen/, "a frozen agent can't spend");

const { key } = await issueAgentKey(company, agent.id);
assert.equal((await agentForKey(`Bearer ${key}`)).id, agent.id);
const stored = (await db().query("select api_key_hash from agents where id = $1", [agent.id])).rows[0];
assert.notEqual(stored.api_key_hash, key, "only the key's hash is stored");
await assert.rejects(agentForKey("Bearer oc_agent_nope"), /Unknown agent key/);

for (const bad of ["http://api.example.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://10.0.0.5/x", "https://169.254.169.254/latest/meta-data"]) {
  await assert.rejects(assertPublicUrl(bad), /https|private|internal|resolve/, bad);
}
assert.equal((await assertPublicUrl("https://example.com/x")).hostname, "example.com");

const business = nearKeyFromPrf(new Uint8Array(32).fill(4));
const signer = new KeyPairSigner(KeyPair.fromString(business.secretKey as KeyPairString));
async function delegate(receiverId: string, list: ReturnType<typeof actions.createAccount>[]) {
  const d = buildDelegateAction({ senderId: company, receiverId, actions: list, nonce: 1n, maxBlockHeight: 100n, publicKey: KeyPair.fromString(business.secretKey as KeyPairString).getPublicKey() });
  return (await signer.signDelegateAction(d)).signedDelegate.delegateAction;
}
const pendingLookup = async (_c: string, account: string) => (account === agent.account_id ? { public_key } : null);
const { PublicKey } = await import("near-api-js");
const ok = await delegate(agent.account_id, [actions.createAccount(), actions.addFullAccessKey(PublicKey.fromString(public_key))]);
assert.equal(await refusal(ok, undefined, pendingLookup), null, "creating the pending agent with opencash's key is sponsored");
const otherKey = KeyPair.fromRandom("ed25519").getPublicKey();
assert.match((await refusal(await delegate(agent.account_id, [actions.createAccount(), actions.addFullAccessKey(otherKey)]), undefined, pendingLookup))!, /opencash generated/);
assert.match((await refusal(await delegate(agent.account_id, [actions.createAccount(), actions.addFullAccessKey(PublicKey.fromString(public_key)), actions.transfer(10n ** 24n)]), undefined, pendingLookup))!, /exactly CreateAccount \+ AddKey/, "no NEAR transfer rides along");
assert.match((await refusal(await delegate(`x.${agent.account_id}`, [actions.createAccount(), actions.addFullAccessKey(PublicKey.fromString(public_key))]), undefined, pendingLookup))!, /direct sub-accounts/);

await db().query("delete from agent_payments where agent_id = $1", [agent.id]);
await db().query("delete from agents where company = $1", [company]);
await db().end();
console.log("agent wallet checks ok");
