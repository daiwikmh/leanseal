import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "viem";
import type { Address, Hex } from "viem";
import type { ChainClient } from "../../sealing-kit/src/drand.js";
import { generateBuilderKeys, seal } from "../../sealing-kit/src/envelope.js";
import type { Envelope } from "../../sealing-kit/src/envelope.js";
import { latestRound, quicknet } from "../../sealing-kit/src/drand.js";
import type { ChainReader, Sidecar } from "../src/chain.js";
import { DEFAULTS } from "../src/config.js";
import type { NodeConfig } from "../src/config.js";
import { factsOf } from "../src/facts.js";
import { checksFor, SEAL_RULES, sealedMempool } from "../src/mempool.js";
import type { SealAdmission, SealedMempool, SealedTopic } from "../src/mempool.js";
import { AdmissionError } from "../src/node.js";

const RAW = hexToBytes(readFileSync(new URL("./fixtures/pq-swap.raw", import.meta.url), "utf8").trim() as Hex);
const FACTS = factsOf(RAW);
const SENDER = FACTS.sender as Address;
const b1 = generateBuilderKeys();
let drand: ChainClient;
let pools: SealedMempool[] = [];

const cfg: NodeConfig = {
  ...DEFAULTS,
  ethrexUrl: "unused",
  sidecarUrl: "unused",
  stakingRegistry: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f",
  builders: { b1: { publicKey: bytesToHex(b1.publicKey) } },
};

const chainOf = (stake = 10n ** 16n): ChainReader => ({
  codeSize: async () => 3000,
  nonce: async () => FACTS.nonceSeq,
  balance: async () => 10n ** 18n,
  stake: async () => ({ stake, unstakeDelaySec: 86400, withdrawTime: 0n }),
});

const sidecar: Sidecar = {
  submit: async () => "0x00",
  relayNow: async () => undefined,
  status: async () => "Submitted",
};

function pool(stake?: bigint): SealedMempool {
  const p = sealedMempool("QmTestMempool", cfg, chainOf(stake), drand, sidecar);
  pools.push(p);
  return p;
}

async function envelope(roundsAhead = 5, publicOnly = false): Promise<Envelope> {
  return seal({
    rawTx: RAW, chainId: 1337, sender: SENDER, nonceKey: 0n, nonceSeq: FACTS.nonceSeq, maxCost: FACTS.maxCost,
    round: (await latestRound(drand)) + roundsAhead,
    builders: publicOnly ? [] : [{ builderId: "b1", publicKey: b1.publicKey }],
    drand,
  });
}

class Bus {
  private handlers: Array<{ node: string; fn: (data: Uint8Array, peer: string) => Promise<void> }> = [];
  outcomes: string[] = [];
  topic(node: string): SealedTopic {
    return {
      networked: true,
      publish: async (data) => {
        const others = this.handlers.filter((h) => h.node !== node);
        for (const h of others) {
          await h.fn(data, node).then(() => this.outcomes.push(`${h.node}:accept`), () => this.outcomes.push(`${h.node}:ignore`));
        }
        return others.length;
      },
      subscribe: (fn) => { this.handlers.push({ node, fn }); },
    };
  }
}

function gossipPool(bus: Bus, node: string): SealedMempool {
  const p = sealedMempool("QmTestMempool", cfg, chainOf(), drand, sidecar, Date.now, bus.topic(node));
  pools.push(p);
  return p;
}

const verdicts = (a: SealAdmission) => Object.fromEntries(a.checks.map((c) => [c.rule, c.verdict]));
const send = (p: SealedMempool, env: Envelope) => p.methods.leanseal_sendEnvelope([env], "peer-1") as Promise<{ id: Hex; mempoolId: string }>;

beforeAll(() => {
  drand = quicknet();
});

afterEach(() => {
  pools.forEach((p) => p.stop());
  pools = [];
});

describe("sealed mempool admission report", () => {
  it("records every SEAL rule as passed for an accepted envelope", async () => {
    const p = pool();
    const { id, mempoolId } = await send(p, await envelope());
    expect(mempoolId).toBe("QmTestMempool");
    const [a] = p.methods.leanseal_listAdmissions([{ limit: 5 }], "x") as SealAdmission[];
    expect(a.outcome).toBe("accepted");
    expect(a.envelopeId).toBe(id);
    expect(a.sender?.toLowerCase()).toBe(SENDER.toLowerCase());
    expect(a.checks.map((c) => c.rule)).toEqual(SEAL_RULES.map((r) => r.id));
    expect(a.checks.every((c) => c.verdict === "pass")).toBe(true);
  });

  it("an unstaked sender fails SEAL-051: earlier rules pass, later ones are skipped", async () => {
    const p = pool(0n);
    await expect(send(p, await envelope())).rejects.toThrow(/not staked/);
    const [a] = p.methods.leanseal_listAdmissions([], "x") as SealAdmission[];
    const v = verdicts(a);
    expect(a.outcome).toBe("rejected");
    expect([v["SEAL-010"], v["SEAL-040"], v["SEAL-050"]]).toEqual(["pass", "pass", "pass"]);
    expect(v["SEAL-051"]).toBe("fail");
    expect([v["SEAL-052"], v["SEAL-053"], v["SEAL-061"]]).toEqual(["skipped", "skipped", "skipped"]);
    expect(a.checks.find((c) => c.rule === "SEAL-051")?.detail).toMatch(/not staked/);
  });

  it("a deadline that opens too soon fails SEAL-040", async () => {
    const p = pool();
    await expect(send(p, await envelope(0))).rejects.toThrow(/too soon/);
    const [a] = p.methods.leanseal_listAdmissions([], "x") as SealAdmission[];
    expect(verdicts(a)["SEAL-040"]).toBe("fail");
    expect(verdicts(a)["SEAL-030"]).toBe("pass");
  });

  it("a resent envelope fails SEAL-070 and the first stays accepted", async () => {
    const p = pool();
    const env = await envelope();
    await send(p, env);
    await expect(send(p, env)).rejects.toThrow(/duplicate/);
    const [second, first] = p.methods.leanseal_listAdmissions([], "x") as SealAdmission[];
    expect(first.outcome).toBe("accepted");
    expect(verdicts(second)["SEAL-070"]).toBe("fail");
    expect(verdicts(second)["SEAL-060"]).toBe("pass");
  });

  it("mempoolInfo publishes the rule set and pending count", async () => {
    const p = pool();
    await send(p, await envelope());
    const info = p.methods.leanseal_mempoolInfo([], "x") as { mempoolId: string; rules: { id: string }[]; builders: string[]; pending: number };
    expect(info.mempoolId).toBe("QmTestMempool");
    expect(info.rules).toHaveLength(SEAL_RULES.length);
    expect(info.builders).toEqual(["b1"]);
    expect(info.pending).toBe(1);
  });

  it("an error outside the rule set is reported as SEAL-000", () => {
    const checks = checksFor(new Error("boom"));
    expect(checks.every((c) => c.rule === "SEAL-000" || c.verdict === "skipped")).toBe(true);
    expect(checks.at(-1)).toEqual({ rule: "SEAL-000", name: "other", verdict: "fail", detail: "boom" });
    expect(checksFor(new AdmissionError("size", "too big"))[0].verdict).toBe("fail");
  });
});

describe("sealed mempool gossip (public, no private relay)", () => {
  it("an envelope sent to one node is gossiped and admitted by its peer", async () => {
    const bus = new Bus();
    const a = gossipPool(bus, "A");
    const b = gossipPool(bus, "B");
    const { id, gossipedTo } = await a.methods.leanseal_sendEnvelope([await envelope(5, true)], "alice") as { id: Hex; gossipedTo: number };
    expect(gossipedTo).toBe(1);
    expect(bus.outcomes).toEqual(["B:accept"]);
    const [onB] = b.methods.leanseal_listAdmissions([], "x") as SealAdmission[];
    expect(onB).toMatchObject({ envelopeId: id, source: "gossip", peer: "A", outcome: "accepted" });
    expect(b.node.entries.get(id)?.status).toBe("sealed");
  });

  it("a public-release envelope (no builder) passes SEAL-030 and no builder can claim it", async () => {
    const p = pool();
    const env = await envelope(5, true);
    expect(env.lockA).toEqual([]);
    const { id } = await send(p, env);
    expect(p.node.pendingFor("b1")).toEqual([]);
    expect(p.node.entries.get(id)?.status).toBe("sealed");
  });

  it("an invalid gossiped envelope is recorded as rejected and not forwarded", async () => {
    const bus = new Bus();
    gossipPool(bus, "A");
    const b = gossipPool(bus, "B");
    const bad = await envelope(0, true);
    await bus.topic("A").publish(new TextEncoder().encode(JSON.stringify(bad)));
    expect(bus.outcomes).toEqual(["B:ignore"]);
    const [onB] = b.methods.leanseal_listAdmissions([], "x") as SealAdmission[];
    expect(onB.source).toBe("gossip");
    expect(onB.checks.find((c) => c.rule === "SEAL-040")?.verdict).toBe("fail");
  });
});
