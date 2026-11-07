import type { Hex } from "viem";
import type { ChainClient } from "../../sealing-kit/src/drand.js";
import { quicknet } from "../../sealing-kit/src/drand.js";
import type { Envelope } from "../../sealing-kit/src/envelope.js";
import { httpSidecar, viemChain } from "./chain.js";
import type { ChainReader, Sidecar } from "./chain.js";
import { loadConfig } from "./config.js";
import type { NodeConfig } from "./config.js";
import { viemHookChain } from "./hookChain.js";
import { LeanSealNode } from "./node.js";
import { REVEAL_RULES, RevealDesk } from "./reveal.js";
import type { RevealTicket } from "./reveal.js";
import { methods as nodeMethods } from "./server.js";

/** Door checks in the order `LeanSealNode.admit` runs them. */
export const SEAL_RULES = [
  { id: "SEAL-010", name: "size", text: "Envelope is at most maxEnvelopeBytes of JSON", rule: "size", re: /./ },
  { id: "SEAL-020", name: "shape", text: "Version 1, this chain id, well-formed hex and number fields, nonce key 0", rule: "shape", re: /./ },
  { id: "SEAL-030", name: "builders", text: "Every chosen builder is known and has exactly one ML-KEM lock; none chosen means public release at the deadline", rule: "builders", re: /./ },
  { id: "SEAL-040", name: "deadline", text: "The drand deadline round is between minRoundsAhead and maxRoundsAhead", rule: "round", re: /./ },
  { id: "SEAL-050", name: "sender-code", text: "The sender is a deployed account", rule: "sender", re: /account code/ },
  { id: "SEAL-051", name: "sender-stake", text: "The sender is staked in the ERC-8421 registry and not unstaking", rule: "sender", re: /staked/ },
  { id: "SEAL-052", name: "nonce", text: "The labelled nonce is not already used on chain", rule: "sender", re: /nonce/ },
  { id: "SEAL-053", name: "solvency", text: "Balance covers this envelope's max cost plus the sender's other sealed envelopes", rule: "sender", re: /balance/ },
  { id: "SEAL-060", name: "peer-ban", text: "The sending peer is not banned for junk envelopes", rule: "peer", re: /banned/ },
  { id: "SEAL-070", name: "duplicate", text: "The envelope id is not already in the pool", rule: "pool", re: /duplicate/ },
  { id: "SEAL-071", name: "slot", text: "At most maxEnvelopesPerSlot sealed envelopes per (sender, nonce)", rule: "pool", re: /slot/ },
  { id: "SEAL-061", name: "rate", text: "The sending peer is under peerEnvelopesPerMinute", rule: "peer", re: /rate limit/ },
] as const;

export type Verdict = "pass" | "fail" | "skipped";
export interface SealCheck { rule: string; name: string; verdict: Verdict; detail?: string }
export interface SealAdmission {
  id: number;
  kind: "envelope" | "ticket";
  envelopeId?: Hex;
  sender?: string;
  nonce?: string;
  round?: number;
  peer: string;
  source: "rpc" | "gossip";
  at: number;
  outcome: "accepted" | "rejected";
  checks: SealCheck[];
}

type Rule = { id: string; name: string; rule: string; re: RegExp };

/** Every rule passes, or rules before the failing one pass and the rest are skipped. */
export function checksFor(err?: unknown, rules: readonly Rule[] = SEAL_RULES): SealCheck[] {
  const e = err as { rule?: unknown; message?: string } | undefined;
  const failed = e && typeof e.rule === "string"
    ? rules.findIndex((r) => r.rule === e.rule && r.re.test(e.message ?? ""))
    : -1;
  const checks: SealCheck[] = rules.map((r, i) => {
    const verdict: Verdict = err === undefined ? "pass" : failed === -1 ? "skipped" : i < failed ? "pass" : i === failed ? "fail" : "skipped";
    return verdict === "fail" ? { rule: r.id, name: r.name, verdict, detail: (err as Error).message } : { rule: r.id, name: r.name, verdict };
  });
  if (err !== undefined && failed === -1) checks.push({ rule: `${rules[0].id.split("-")[0]}-000`, name: "other", verdict: "fail", detail: (err as Error).message });
  return checks;
}

/** The sidecar's handle on this mempool's own p2p gossip topic. */
export interface SealedTopic {
  networked: boolean;
  publish(data: Uint8Array): Promise<number>;
  subscribe(handler: (data: Uint8Array, peer: string) => Promise<void>): void;
}

const encode = (msg: Envelope | RevealTicket) => new TextEncoder().encode(JSON.stringify(msg));
const decode = (data: Uint8Array) => JSON.parse(new TextDecoder().decode(data)) as Envelope | RevealTicket;
const isTicket = (msg: Envelope | RevealTicket): msg is RevealTicket => (msg as RevealTicket)?.kind === "batch-reveal";

export interface SealedMempool {
  mempoolId: string;
  node: LeanSealNode;
  desk?: RevealDesk;
  admissions: SealAdmission[];
  methods: Record<string, (params: unknown[], peer: string) => unknown>;
  stop(): void;
}

const MAX_ADMISSIONS = 500;

export function sealedMempool(mempoolId: string, cfg: NodeConfig, chain: ChainReader, drand: ChainClient, sidecar: Sidecar, now: () => number = Date.now, gossip?: SealedTopic, desk?: RevealDesk): SealedMempool {
  const node = new LeanSealNode(cfg, chain, drand, sidecar, now);
  const admissions: SealAdmission[] = [];
  let nextId = 1;
  const base = nodeMethods(node);
  const record = (env: Envelope | undefined, peer: string, source: SealAdmission["source"], outcome: SealAdmission["outcome"], checks: SealCheck[], envelopeId?: Hex) => {
    const l = env?.label;
    admissions.unshift({ id: nextId++, kind: "envelope", envelopeId, sender: l?.sender, nonce: l?.nonceSeq, round: l?.round, peer, source, at: now(), outcome, checks });
    admissions.length = Math.min(admissions.length, MAX_ADMISSIONS);
  };
  const admit = async (env: Envelope, peer: string, source: SealAdmission["source"]) => {
    try {
      const id = await node.admit(env, peer);
      record(env, peer, source, "accepted", checksFor(), id);
      return id;
    } catch (err) {
      record(env, peer, source, "rejected", checksFor(err));
      throw err;
    }
  };
  const admitTicket = async (t: RevealTicket, peer: string, source: SealAdmission["source"]) => {
    if (!desk) throw new Error("this node runs no batch reveal desk");
    const base = { kind: "ticket" as const, sender: t?.user, nonce: t?.batchRound, round: t?.round, peer, source };
    try {
      const id = await desk.admit(t, peer);
      admissions.unshift({ id: nextId++, ...base, envelopeId: id, at: now(), outcome: "accepted", checks: checksFor(undefined, REVEAL_RULES) });
      return id;
    } catch (err) {
      admissions.unshift({ id: nextId++, ...base, at: now(), outcome: "rejected", checks: checksFor(err, REVEAL_RULES) });
      throw err;
    } finally {
      admissions.length = Math.min(admissions.length, MAX_ADMISSIONS);
    }
  };
  gossip?.subscribe(async (data, peer) => {
    const msg = decode(data);
    if (isTicket(msg)) await admitTicket(msg, peer, "gossip");
    else await admit(msg, peer, "gossip");
  });
  const timer = setInterval(() => {
    node.tick().catch(() => undefined);
    desk?.tick().catch(() => undefined);
  }, cfg.tickMs);
  timer.unref?.();
  return {
    mempoolId,
    node,
    desk,
    admissions,
    stop: () => clearInterval(timer),
    methods: {
      ...base,
      leanseal_sendEnvelope: async (params, peer) => {
        const env = params[0] as Envelope;
        const id = await admit(env, peer, "rpc");
        const gossipedTo = gossip ? await gossip.publish(encode(env)).catch(() => 0) : 0;
        return { id, mempoolId, gossipedTo };
      },
      leanseal_sendRevealTicket: async (params, peer) => {
        const t = params[0] as RevealTicket;
        const id = await admitTicket(t, peer, "rpc");
        const gossipedTo = gossip ? await gossip.publish(encode(t)).catch(() => 0) : 0;
        return { id, mempoolId, gossipedTo };
      },
      leanseal_ticketStatus: (params) => {
        if (!desk) throw new Error("this node runs no batch reveal desk");
        return desk.status(params[0] as Hex);
      },
      leanseal_listAdmissions: (params) => {
        const limit = Math.min(Number((params[0] as { limit?: number } | undefined)?.limit ?? 50), MAX_ADMISSIONS);
        return admissions.slice(0, limit);
      },
      leanseal_mempoolInfo: () => ({
        mempoolId,
        rules: SEAL_RULES.map(({ id, name, text }) => ({ id, name, text })),
        builders: Object.keys(cfg.builders),
        gossip: gossip?.networked ?? false,
        batchHook: cfg.batchHook ?? null,
        revealRules: REVEAL_RULES.map(({ id, name, text }) => ({ id, name, text })),
        tickets: desk ? [...desk.tickets.values()].filter((e) => e.status === "locked").length : 0,
        lastKeeperError: desk?.lastKeeperError ?? null,
        pending: [...node.entries.values()].filter((e) => e.status === "sealed").length,
      }),
    },
  };
}

/** ERC-8421 custom mempool entry point, loaded by the sidecar. */
export async function createMempool({ mempoolId, options, gossip }: { mempoolId: string; options?: { configFile?: string }; gossip?: SealedTopic }) {
  if (!options?.configFile) throw new Error("leanseal mempool needs options.configFile");
  const cfg = loadConfig(options.configFile);
  const drand = quicknet();
  const desk = cfg.batchHook && cfg.keeperKeyFile
    ? new RevealDesk(
      { chainId: cfg.chainId, hook: cfg.batchHook, maxTicketBytes: cfg.maxTicketBytes, maxRoundsAhead: cfg.maxRoundsAhead, peerTicketsPerMinute: cfg.peerEnvelopesPerMinute },
      await viemHookChain(cfg.ethrexUrl, cfg.chainId, cfg.batchHook, cfg.keeperKeyFile),
      drand,
    )
    : undefined;
  return sealedMempool(mempoolId, cfg, viemChain(cfg.ethrexUrl, cfg.stakingRegistry), drand, httpSidecar(cfg.sidecarUrl, cfg.relayAfterSubmit), Date.now, gossip, desk);
}
