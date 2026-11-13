import { decodeSignedDelegate, type SignedDelegate } from "near-api-js";
import { maxBatch, type Payout } from "shared";
import { config } from "./config.js";
import { operator } from "./near.js";
import { emit } from "./developer.js";
import { activateAgent, pendingAgent } from "./agents.js";
import { markSent, quotedPayout, registerForUsdc } from "./payouts.js";

const sponsoredMethods = new Set(["create_invoice"]);
const maxGas = 100_000_000_000_000n;
const maxTransferGas = 30_000_000_000_000n;

type Delegate = SignedDelegate["delegateAction"];
type Lookup = (company: string, payoutId: string) => Promise<Payout | null>;
type AgentLookup = (company: string, accountId: string) => Promise<{ public_key: string } | null>;

function contractCallRefusal(delegate: Delegate): string | null {
  if (delegate.actions.length !== 1) return "One action per relayed call.";
  const call = delegate.actions[0]?.functionCall;
  if (!call) return "Only function calls are sponsored.";
  if (!sponsoredMethods.has(call.methodName)) return `${call.methodName} is not sponsored.`;
  if (call.deposit !== 0n) return "Sponsored calls cannot attach a deposit.";
  if (call.gas > maxGas) return "Too much gas requested.";
  return null;
}

async function payoutRefusal(delegate: Delegate, lookup: Lookup): Promise<string | null> {
  if (delegate.actions.length === 0 || delegate.actions.length > maxBatch) return `Send 1 to ${maxBatch} payouts per signature.`;
  const seen = new Set<string>();
  for (const action of delegate.actions) {
    const call = action.functionCall;
    if (!call || call.methodName !== "ft_transfer") return "Only USDC transfers to quoted payouts are sponsored.";
    if (call.deposit !== 1n) return "A USDC transfer must attach exactly 1 yoctoNEAR.";
    if (call.gas > maxTransferGas) return "Too much gas requested.";
    let args: { receiver_id?: string; amount?: string; memo?: string };
    try {
      args = JSON.parse(Buffer.from(call.args).toString("utf8"));
    } catch {
      return "Unreadable transfer arguments.";
    }
    const id = args.memo?.replace(/^opencash payout /, "") ?? "";
    if (!id || seen.has(id)) return "Each transfer must carry its own payout id in the memo.";
    seen.add(id);
    const payout = await lookup(delegate.senderId, id);
    if (!payout) return "That transfer is not a live payout quote for this account. Quote it again.";
    const expected = payout.kind === "direct" ? payout.recipient : payout.deposit_address;
    if (args.receiver_id !== expected) return "The transfer goes to a different address than the quote.";
    if (args.amount !== payout.amount_units) return "The transfer amount does not match the quote.";
  }
  return null;
}

async function agentCreationRefusal(delegate: Delegate, agents: AgentLookup): Promise<string | null> {
  const prefix = delegate.receiverId.slice(0, -(delegate.senderId.length + 1));
  if (!prefix || prefix.includes(".")) return "Agents must be direct sub-accounts of the business.";
  const [create, add] = delegate.actions;
  if (delegate.actions.length !== 2 || !create?.createAccount || !add?.addKey) return "Agent creation must be exactly CreateAccount + AddKey.";
  if (!add.addKey.accessKey.permission.fullAccess) return "The agent key must be the one opencash generated.";
  const pending = await agents(delegate.senderId, delegate.receiverId);
  if (!pending) return "Create the agent in opencash first.";
  if (add.addKey.publicKey.toString() !== pending.public_key) return "The agent key must be the one opencash generated.";
  return null;
}

export async function refusal(delegate: Delegate, lookup: Lookup = quotedPayout, agents: AgentLookup = pendingAgent): Promise<string | null> {
  if (!delegate.senderId.endsWith(`.${config.parent}`)) return "Only opencash business accounts are sponsored.";
  if (delegate.receiverId.endsWith(`.${delegate.senderId}`)) return agentCreationRefusal(delegate, agents);
  if (delegate.receiverId === config.contract) return contractCallRefusal(delegate);
  if (delegate.receiverId === config.usdc) return payoutRefusal(delegate, lookup);
  return "Only calls to the opencash registry and quoted USDC payouts are sponsored.";
}

export async function relay(base64: string) {
  let signed: SignedDelegate;
  try {
    signed = decodeSignedDelegate(Buffer.from(base64, "base64"));
  } catch {
    throw Object.assign(new Error("signedDelegate is not a valid NEAR signed delegate."), { statusCode: 400 });
  }
  const refused = await refusal(signed.delegateAction);
  if (refused) throw Object.assign(new Error(refused), { statusCode: 403 });
  if (signed.delegateAction.receiverId === config.usdc) {
    const receivers = signed.delegateAction.actions.map((a) => JSON.parse(Buffer.from(a.functionCall!.args).toString("utf8")).receiver_id as string);
    for (const receiver of receivers) await registerForUsdc(receiver);
  }
  const outcome = await operator().relayMetaTransaction(signed);
  const txHash = outcome.transaction.hash;
  if (signed.delegateAction.receiverId === config.usdc) {
    const ids = signed.delegateAction.actions.map((a) => String(JSON.parse(Buffer.from(a.functionCall!.args).toString("utf8")).memo).replace(/^opencash payout /, ""));
    const sent = await markSent(signed.delegateAction.senderId, ids, txHash);
    await Promise.all(sent.map((p) => emit(p.company, p.status === "completed" ? "payout.completed" : "payout.sent", p).catch(() => undefined)));
  }
  if (signed.delegateAction.receiverId.endsWith(`.${signed.delegateAction.senderId}`)) await activateAgent(signed.delegateAction.receiverId);
  return { txHash, outcome };
}
