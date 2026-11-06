import { keccak256 } from "viem";
import type { Address, Hex } from "viem";
import type { ChainClient } from "../../sealing-kit/src/drand.js";
import {
  checkOpenedTx, envelopeId, EnvelopeError, openWithBeacon, openWithKey,
} from "../../sealing-kit/src/envelope.js";
import type { Envelope } from "../../sealing-kit/src/envelope.js";
import { latestRound } from "../../sealing-kit/src/drand.js";
import type { ChainReader, Sidecar } from "./chain.js";
import type { NodeConfig } from "./config.js";
import { factsOf, rawBytes } from "./facts.js";

export type Status = "sealed" | "builder-submitted" | "deadline-submitted" | "junk" | "failed";

export interface Entry {
  id: Hex;
  env: Envelope;
  peer: string;
  status: Status;
  receivedAt: number;
  txHash?: Hex;
  openedBy?: string;
  note?: string;
}

export class AdmissionError extends Error {
  constructor(readonly rule: string, message: string) {
    super(`${rule}: ${message}`);
  }
}

const HEX = /^0x[0-9a-fA-F]*$/;
const slotOf = (env: Envelope) => `${env.label.sender.toLowerCase()}:${env.label.nonceKey}:${env.label.nonceSeq}`;

export class LeanSealNode {
  readonly entries = new Map<Hex, Entry>();
  private readonly peerTimes = new Map<string, number[]>();
  private readonly strikes = new Map<string, number>();

  constructor(
    private readonly cfg: NodeConfig,
    private readonly chain: ChainReader,
    private readonly drand: ChainClient,
    private readonly sidecar: Sidecar,
    private readonly now: () => number = Date.now,
  ) {}

  isBanned(peer: string): boolean {
    return (this.strikes.get(peer) ?? 0) >= this.cfg.peerStrikesBeforeBan;
  }

  private checkShape(env: Envelope): void {
    const l = env?.label;
    if (!l || l.version !== 1) throw new AdmissionError("shape", "unsupported envelope version");
    if (l.chainId !== this.cfg.chainId) throw new AdmissionError("shape", `chainId ${l.chainId} != ${this.cfg.chainId}`);
    if (![l.sender, l.txHash, env.box, env.boxNonce].every((h) => typeof h === "string" && HEX.test(h))) throw new AdmissionError("shape", "malformed hex field");
    if (![l.nonceKey, l.nonceSeq, l.maxCost].every((d) => typeof d === "string" && /^\d+$/.test(d))) throw new AdmissionError("shape", "malformed number field");
    if (!Number.isInteger(l.round) || typeof env.lockB !== "string") throw new AdmissionError("shape", "malformed round or time lock");
    if (l.nonceKey !== "0") throw new AdmissionError("shape", "only nonce key 0 is supported");
  }

  private checkBuilders(env: Envelope): void {
    const ids = env.label.builderIds;
    if (!Array.isArray(ids) || !Array.isArray(env.lockA)) throw new AdmissionError("builders", "builderIds and lockA must be lists");
    const unknown = ids.filter((id) => !this.cfg.builders[id]);
    if (unknown.length > 0) throw new AdmissionError("builders", `unknown builder ${unknown.join(",")}`);
    const lockIds = env.lockA.map((l) => l.builderId).sort().join(",");
    if (lockIds !== [...ids].sort().join(",")) throw new AdmissionError("builders", "locks do not match builderIds");
  }

  private async checkRound(env: Envelope): Promise<void> {
    const latest = await latestRound(this.drand);
    const { round } = env.label;
    if (round < latest + this.cfg.minRoundsAhead) throw new AdmissionError("round", `round ${round} opens too soon (latest ${latest})`);
    if (round > latest + this.cfg.maxRoundsAhead) throw new AdmissionError("round", `round ${round} is too far ahead (latest ${latest})`);
  }

  private pendingCost(sender: string): bigint {
    let sum = 0n;
    for (const e of this.entries.values()) {
      if (e.status === "sealed" && e.env.label.sender.toLowerCase() === sender) sum += BigInt(e.env.label.maxCost);
    }
    return sum;
  }

  private async checkSender(env: Envelope): Promise<void> {
    const sender = env.label.sender.toLowerCase() as Address;
    if ((await this.chain.codeSize(sender)) === 0) throw new AdmissionError("sender", "sender has no account code");
    const stake = await this.chain.stake(sender);
    if (stake.stake < this.cfg.minStakeWei || stake.withdrawTime !== 0n) throw new AdmissionError("sender", "sender is not staked");
    const nonce = await this.chain.nonce(sender);
    if (BigInt(env.label.nonceSeq) < nonce) throw new AdmissionError("sender", `nonce ${env.label.nonceSeq} already used (account at ${nonce})`);
    const need = BigInt(env.label.maxCost) + this.pendingCost(sender);
    if ((await this.chain.balance(sender)) < need) throw new AdmissionError("sender", `balance below ${need} wei needed`);
  }

  private checkPool(env: Envelope, id: Hex, peer: string): void {
    if (this.isBanned(peer)) throw new AdmissionError("peer", "peer is banned for junk");
    if (this.entries.has(id)) throw new AdmissionError("pool", "duplicate envelope");
    const slot = slotOf(env);
    const inSlot = [...this.entries.values()].filter((e) => e.status === "sealed" && slotOf(e.env) === slot).length;
    if (inSlot >= this.cfg.maxEnvelopesPerSlot) throw new AdmissionError("pool", `slot ${slot} is full`);
    const t = this.now();
    const recent = (this.peerTimes.get(peer) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= this.cfg.peerEnvelopesPerMinute) throw new AdmissionError("peer", "rate limit");
    recent.push(t);
    this.peerTimes.set(peer, recent);
  }

  async admit(env: Envelope, peer: string): Promise<Hex> {
    if (JSON.stringify(env ?? null).length > this.cfg.maxEnvelopeBytes) throw new AdmissionError("size", `envelope over ${this.cfg.maxEnvelopeBytes} bytes`);
    this.checkShape(env);
    this.checkBuilders(env);
    await this.checkRound(env);
    await this.checkSender(env);
    const id = envelopeId(env);
    this.checkPool(env, id, peer);
    this.entries.set(id, { id, env, peer, status: "sealed", receivedAt: this.now() });
    return id;
  }

  pendingFor(builderId: string): Entry[] {
    return [...this.entries.values()].filter((e) => e.status === "sealed" && e.env.label.builderIds.includes(builderId));
  }

  builderSubmitted(id: Hex, builderId: string, txHash: Hex): Entry {
    const e = this.must(id);
    if (!e.env.label.builderIds.includes(builderId)) throw new AdmissionError("builder", "not a chosen builder");
    if (txHash.toLowerCase() !== e.env.label.txHash.toLowerCase()) throw new AdmissionError("builder", "submitted hash does not match label.txHash");
    if (e.status !== "sealed") return e;
    e.status = "builder-submitted";
    e.openedBy = builderId;
    e.txHash = txHash;
    return e;
  }

  async reportJunk(id: Hex, builderId: string, keyHex: Hex): Promise<Entry> {
    const e = this.must(id);
    if (!e.env.label.builderIds.includes(builderId)) throw new AdmissionError("builder", "not a chosen builder");
    if (e.status !== "sealed") return e;
    let raw: Uint8Array;
    try {
      raw = openWithKey(e.env, rawBytes(keyHex));
    } catch (err) {
      throw new AdmissionError("junk-report", `revealed key does not open the box: ${(err as Error).message}`);
    }
    const verdict = await this.judgeAndSubmit(e, raw, builderId);
    if (verdict === "junk") return e;
    throw new AdmissionError("junk-report", "box holds a valid tx; it was submitted instead");
  }

  private async judgeAndSubmit(e: Entry, raw: Uint8Array, by: string): Promise<"junk" | "submitted"> {
    let facts: ReturnType<typeof factsOf>;
    try {
      facts = factsOf(raw);
      checkOpenedTx(e.env, facts);
    } catch (err) {
      this.markJunk(e, (err as Error).message);
      return "junk";
    }
    try {
      e.txHash = await this.sidecar.submit(facts.tx);
      await this.sidecar.relayNow();
      e.status = by === "deadline" ? "deadline-submitted" : "builder-submitted";
      e.openedBy = by;
    } catch (err) {
      const message = (err as Error).message;
      if (/already known/i.test(message)) {
        e.txHash = keccak256(raw);
        e.status = by === "deadline" ? "deadline-submitted" : "builder-submitted";
        e.openedBy = by;
        e.note = "already in the public mempool (released by a peer)";
      } else {
        e.status = "failed";
        e.note = message.slice(0, 300);
      }
    }
    return "submitted";
  }

  private markJunk(e: Entry, why: string): void {
    e.status = "junk";
    e.note = why.slice(0, 300);
    this.strikes.set(e.peer, (this.strikes.get(e.peer) ?? 0) + 1);
  }

  async tick(): Promise<void> {
    const due = [...this.entries.values()].filter((e) => e.status === "sealed");
    if (due.length === 0) return;
    const latest = await latestRound(this.drand);
    for (const e of due.filter((x) => x.env.label.round <= latest)) {
      let raw: Uint8Array;
      try {
        raw = await openWithBeacon(e.env, this.drand);
      } catch (err) {
        if (err instanceof EnvelopeError && /too early|future/i.test(err.message)) continue;
        this.markJunk(e, (err as Error).message);
        continue;
      }
      await this.judgeAndSubmit(e, raw, "deadline");
    }
  }

  status(id: Hex): Omit<Entry, "env"> & { round: number; sender: string } {
    const { env, ...rest } = this.must(id);
    return { ...rest, round: env.label.round, sender: env.label.sender };
  }

  private must(id: Hex): Entry {
    const e = this.entries.get(id);
    if (!e) throw new AdmissionError("unknown", `no envelope ${id}`);
    return e;
  }
}
