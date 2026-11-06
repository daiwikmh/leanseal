import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, keccak256 } from "viem";
import type { Address, Hex } from "viem";
import { randomBytes } from "@noble/hashes/utils.js";
import type { ChainClient } from "../../sealing-kit/src/drand.js";
import { generateBuilderKeys, seal, unwrapBuilderKey } from "../../sealing-kit/src/envelope.js";
import type { Envelope } from "../../sealing-kit/src/envelope.js";
import { latestRound, quicknet } from "../../sealing-kit/src/drand.js";
import { Builder } from "../src/builder.js";
import type { NodeApi } from "../src/builder.js";
import type { ChainReader, Sidecar } from "../src/chain.js";
import { DEFAULTS } from "../src/config.js";
import type { NodeConfig } from "../src/config.js";
import { factsOf } from "../src/facts.js";
import { LeanSealNode } from "../src/node.js";

const RAW = hexToBytes(readFileSync(new URL("./fixtures/pq-swap.raw", import.meta.url), "utf8").trim() as Hex);
const FACTS = factsOf(RAW);
const SENDER = FACTS.sender as Address;
const b1 = generateBuilderKeys();
const b2 = generateBuilderKeys();
let drand: ChainClient;

const cfg = (over: Partial<NodeConfig> = {}): NodeConfig => ({
  ...DEFAULTS,
  ethrexUrl: "unused",
  sidecarUrl: "unused",
  stakingRegistry: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f",
  builders: { b1: { publicKey: bytesToHex(b1.publicKey) }, b2: { publicKey: bytesToHex(b2.publicKey) } },
  ...over,
});

type ChainState = { code: number; nonce: bigint; balance: bigint; stake: bigint; withdrawTime: bigint };
const chainOf = (s: Partial<ChainState> = {}): ChainReader => {
  const st: ChainState = { code: 3000, nonce: FACTS.nonceSeq, balance: 10n ** 18n, stake: 10n ** 16n, withdrawTime: 0n, ...s };
  return {
    codeSize: async () => st.code,
    nonce: async () => st.nonce,
    balance: async () => st.balance,
    stake: async () => ({ stake: st.stake, unstakeDelaySec: 86400, withdrawTime: st.withdrawTime }),
  };
};

class FakeSidecar implements Sidecar {
  submitted: Hex[] = [];
  relays = 0;
  async submit(tx: Parameters<Sidecar["submit"]>[0]): Promise<Hex> {
    const raw = (await import("@forshtat/hegota-support/tx")).encodeTx((await import("../src/facts.js")).profile, tx);
    const hash = keccak256(raw);
    this.submitted.push(hash);
    return hash;
  }
  async relayNow() { this.relays++; }
  async status() { return "Submitted"; }
}

const api = (node: LeanSealNode): NodeApi => ({
  pendingFor: async (id) => node.pendingFor(id).map((e) => ({ id: e.id, env: e.env })),
  builderSubmitted: async (id, b, h) => node.builderSubmitted(id, b, h),
  reportJunk: async (id, b, k) => node.reportJunk(id, b, k),
});

async function envelope(opts: { rawTx?: Uint8Array; roundsAhead?: number; builders?: ("b1" | "b2")[]; nonceSeq?: bigint; maxCost?: bigint } = {}): Promise<Envelope> {
  const keys = { b1, b2 };
  return seal({
    rawTx: opts.rawTx ?? RAW,
    chainId: 1337,
    sender: SENDER,
    nonceKey: 0n,
    nonceSeq: opts.nonceSeq ?? FACTS.nonceSeq,
    maxCost: opts.maxCost ?? FACTS.maxCost,
    round: (await latestRound(drand)) + (opts.roundsAhead ?? 5),
    builders: (opts.builders ?? ["b1"]).map((id) => ({ builderId: id, publicKey: keys[id].publicKey })),
    drand,
  });
}

beforeAll(() => {
  drand = quicknet();
});

describe("door checks", () => {
  it("admits a well-formed envelope from a staked, funded PQ account", async () => {
    const node = new LeanSealNode(cfg(), chainOf(), drand, new FakeSidecar());
    const id = await node.admit(await envelope(), "peerA");
    expect(node.status(id).status).toBe("sealed");
  });

  const rejects: [string, Partial<ChainState>, RegExp][] = [
    ["sender without code", { code: 0 }, /no account code/],
    ["unstaked sender", { stake: 0n }, /not staked/],
    ["sender that started unstaking", { withdrawTime: 123n }, /not staked/],
    ["used nonce", { nonce: FACTS.nonceSeq + 1n }, /already used/],
    ["sender that cannot pay", { balance: 1n }, /balance below/],
  ];
  for (const [name, state, err] of rejects) {
    it(`rejects ${name}`, async () => {
      const node = new LeanSealNode(cfg(), chainOf(state), drand, new FakeSidecar());
      await expect(node.admit(await envelope(), "peerA")).rejects.toThrow(err);
    });
  }

  it("rejects a round that opens too soon", async () => {
    const node = new LeanSealNode(cfg(), chainOf(), drand, new FakeSidecar());
    await expect(node.admit(await envelope({ roundsAhead: 0 }), "peerA")).rejects.toThrow(/too soon/);
  });

  it("rejects a round too far ahead", async () => {
    const node = new LeanSealNode(cfg(), chainOf(), drand, new FakeSidecar());
    await expect(node.admit(await envelope({ roundsAhead: 500 }), "peerA")).rejects.toThrow(/too far/);
  });

  it("rejects an unknown builder", async () => {
    const node = new LeanSealNode(cfg({ builders: { b2: { publicKey: "0x00" } } }), chainOf(), drand, new FakeSidecar());
    await expect(node.admit(await envelope({ builders: ["b1"] }), "peerA")).rejects.toThrow(/unknown builder/);
  });

  it("rejects the wrong chain", async () => {
    const node = new LeanSealNode(cfg({ chainId: 1 }), chainOf(), drand, new FakeSidecar());
    await expect(node.admit(await envelope(), "peerA")).rejects.toThrow(/chainId/);
  });

  it("rejects an oversized envelope", async () => {
    const node = new LeanSealNode(cfg({ maxEnvelopeBytes: 1000 }), chainOf(), drand, new FakeSidecar());
    await expect(node.admit(await envelope(), "peerA")).rejects.toThrow(/over 1000 bytes/);
  });

  it("rejects duplicates, caps a nonce slot, and rate-limits a peer", async () => {
    const node = new LeanSealNode(cfg({ maxEnvelopesPerSlot: 2, peerEnvelopesPerMinute: 3 }), chainOf(), drand, new FakeSidecar());
    const e1 = await envelope();
    await node.admit(e1, "peerA");
    await expect(node.admit(e1, "peerA")).rejects.toThrow(/duplicate/);
    await node.admit(await envelope(), "peerA");
    await expect(node.admit(await envelope(), "peerB")).rejects.toThrow(/slot .* is full/);
    await node.admit(await envelope({ nonceSeq: FACTS.nonceSeq + 1n }), "peerA");
    await expect(node.admit(await envelope({ nonceSeq: FACTS.nonceSeq + 2n }), "peerA")).rejects.toThrow(/rate limit/);
  });

  it("counts pending envelopes against the sender's balance", async () => {
    const node = new LeanSealNode(cfg(), chainOf({ balance: FACTS.maxCost + FACTS.maxCost / 2n }), drand, new FakeSidecar());
    await node.admit(await envelope(), "peerA");
    await expect(node.admit(await envelope({ nonceSeq: FACTS.nonceSeq + 1n }), "peerA")).rejects.toThrow(/balance below/);
  });
});

describe("builder path", () => {
  it("the chosen builder opens, submits the exact signed tx, and the deadline does not resubmit", async () => {
    const sidecar = new FakeSidecar();
    const node = new LeanSealNode(cfg(), chainOf(), drand, sidecar);
    const id = await node.admit(await envelope({ builders: ["b1", "b2"] }), "peerA");
    const out = await new Builder("b1", b1.secretKey, api(node), sidecar).poll();
    expect(out).toEqual([{ id, outcome: "submitted", detail: keccak256(RAW) }]);
    expect(sidecar.submitted).toEqual([keccak256(RAW)]);
    expect(node.status(id)).toMatchObject({ status: "builder-submitted", openedBy: "b1", txHash: keccak256(RAW) });
    expect(await new Builder("b2", b2.secretKey, api(node), sidecar).poll()).toEqual([]);
    await node.tick();
    expect(sidecar.submitted.length).toBe(1);
  });

  it("a builder that was not chosen sees nothing", async () => {
    const node = new LeanSealNode(cfg(), chainOf(), drand, new FakeSidecar());
    await node.admit(await envelope({ builders: ["b1"] }), "peerA");
    expect(await new Builder("b2", b2.secretKey, api(node), new FakeSidecar()).poll()).toEqual([]);
  });

  it("a builder cannot claim a submission for a different tx", async () => {
    const node = new LeanSealNode(cfg(), chainOf(), drand, new FakeSidecar());
    const id = await node.admit(await envelope(), "peerA");
    expect(() => node.builderSubmitted(id, "b1", `0x${"11".repeat(32)}`)).toThrow(/does not match/);
  });
});

describe("junk handling", () => {
  it("junk inside a valid-looking label is reported by the builder, proven with the key, and the peer gets a strike", async () => {
    const sidecar = new FakeSidecar();
    const node = new LeanSealNode(cfg({ peerStrikesBeforeBan: 1 }), chainOf(), drand, sidecar);
    const id = await node.admit(await envelope({ rawTx: randomBytes(3000) }), "mallory");
    const out = await new Builder("b1", b1.secretKey, api(node), sidecar).poll();
    expect(out[0].outcome).toBe("junk-reported");
    expect(node.status(id).status).toBe("junk");
    expect(sidecar.submitted).toEqual([]);
    expect(node.isBanned("mallory")).toBe(true);
    await expect(node.admit(await envelope(), "mallory")).rejects.toThrow(/banned/);
  });

  it("a junk report against a real tx is refused and the tx is submitted instead", async () => {
    const sidecar = new FakeSidecar();
    const node = new LeanSealNode(cfg(), chainOf(), drand, sidecar);
    const env = await envelope();
    const id = await node.admit(env, "peerA");
    const key = bytesToHex(unwrapBuilderKey(env, "b1", b1.secretKey));
    await expect(node.reportJunk(id, "b1", key)).rejects.toThrow(/valid tx/);
    expect(sidecar.submitted).toEqual([keccak256(RAW)]);
    expect(node.isBanned("peerA")).toBe(false);
  });

  it("a junk report with a made-up key is refused", async () => {
    const node = new LeanSealNode(cfg(), chainOf(), drand, new FakeSidecar());
    const id = await node.admit(await envelope(), "peerA");
    await expect(node.reportJunk(id, "b1", bytesToHex(randomBytes(32)))).rejects.toThrow(/does not open the box/);
    expect(node.status(id).status).toBe("sealed");
  });

  it("a tx that costs more than its label promised is junk", async () => {
    const sidecar = new FakeSidecar();
    const node = new LeanSealNode(cfg(), chainOf(), drand, sidecar);
    const id = await node.admit(await envelope({ maxCost: 1n }), "peerA");
    const out = await new Builder("b1", b1.secretKey, api(node), sidecar).poll();
    expect(out[0].outcome).toBe("junk-reported");
    expect(node.status(id).note).toMatch(/maxCost/);
  });
});

describe("deadline fallback (live drand)", () => {
  it("a peer that already released the same tx counts as released, not failed", async () => {
    class KnownSidecar extends FakeSidecar {
      async submit(): Promise<Hex> { throw new Error("Frame transaction already known"); }
    }
    const node = new LeanSealNode(cfg(), chainOf(), drand, new KnownSidecar());
    const env = await envelope({ roundsAhead: 3 });
    const id = await node.admit(env, "peerA");
    while ((await latestRound(drand)) < env.label.round) await new Promise((r) => setTimeout(r, 1000));
    await node.tick();
    expect(node.status(id)).toMatchObject({ status: "deadline-submitted", openedBy: "deadline", txHash: keccak256(RAW) });
  }, 30_000);

  it("nobody opens it early; at the drand round the node opens it itself and submits", async () => {
    const sidecar = new FakeSidecar();
    const node = new LeanSealNode(cfg(), chainOf(), drand, sidecar);
    const env = await envelope({ roundsAhead: 3 });
    const id = await node.admit(env, "peerA");
    await node.tick();
    expect(node.status(id).status).toBe("sealed");
    while ((await latestRound(drand)) < env.label.round) await new Promise((r) => setTimeout(r, 1000));
    await node.tick();
    expect(node.status(id)).toMatchObject({ status: "deadline-submitted", openedBy: "deadline", txHash: keccak256(RAW) });
    expect(sidecar.submitted).toEqual([keccak256(RAW)]);
  }, 30_000);
});
