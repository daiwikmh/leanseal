import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "@noble/hashes/utils.js";
import type { ChainClient } from "tlock-js";
import {
  checkOpenedTx, envelopeId, EnvelopeError, generateBuilderKeys, openWithBeacon, openWithBuilderKey, seal,
} from "../src/envelope.js";
import type { Envelope, Hex, SealInput } from "../src/envelope.js";
import { latestRound, quicknet, roundAfter } from "../src/drand.js";

const SENDER: Hex = "0x5ed7367cbb2e9bc743e14ffc3fbd230c25c6059b";
const rawTx = randomBytes(4000);
const alice = generateBuilderKeys();
const bob = generateBuilderKeys();
const mallory = generateBuilderKeys();

let drand: ChainClient;
let futureEnv: Envelope;
let pastEnv: Envelope;

const input = (round: number, over: Partial<SealInput> = {}): SealInput => ({
  rawTx, chainId: 1337, sender: SENDER, nonceKey: 0n, nonceSeq: 2n, maxCost: 1_500_000_000_000_000n, round,
  builders: [{ builderId: "alice", publicKey: alice.publicKey }, { builderId: "bob", publicKey: bob.publicKey }],
  drand, ...over,
});

const clone = (e: Envelope): Envelope => JSON.parse(JSON.stringify(e));

beforeAll(async () => {
  drand = quicknet();
  futureEnv = await seal(input(await roundAfter(drand, 3600)));
  pastEnv = await seal(input((await latestRound(drand)) - 1));
}, 30_000);

describe("builder lock (ML-KEM-768)", () => {
  it("a chosen builder opens the exact signed tx", () => {
    expect(openWithBuilderKey(futureEnv, "alice", alice.secretKey)).toEqual(rawTx);
  });

  it("every chosen builder can open it independently", () => {
    expect(openWithBuilderKey(futureEnv, "bob", bob.secretKey)).toEqual(rawTx);
  });

  it("a builder that was not chosen cannot open it", () => {
    expect(() => openWithBuilderKey(futureEnv, "mallory", mallory.secretKey)).toThrow(EnvelopeError);
  });

  it("a wrong secret key under a chosen id fails", () => {
    expect(() => openWithBuilderKey(futureEnv, "alice", mallory.secretKey)).toThrow(/did not open/);
  });

  it("the envelope reveals nothing of the tx in clear", () => {
    const needle = Buffer.from(rawTx.slice(100, 132)).toString("hex");
    expect(JSON.stringify(futureEnv).includes(needle)).toBe(false);
  });
});

describe("label binding", () => {
  it("a tampered label field breaks every lock", () => {
    const e = clone(futureEnv);
    e.label.maxCost = "999999999999999999999";
    expect(() => openWithBuilderKey(e, "alice", alice.secretKey)).toThrow(EnvelopeError);
  });

  it("a swapped sender breaks every lock", () => {
    const e = clone(futureEnv);
    e.label.sender = "0x29fe1cd4e3f1d1aebedb6fa2c6c41b590df1bf28";
    expect(() => openWithBuilderKey(e, "bob", bob.secretKey)).toThrow(EnvelopeError);
  });

  it("a tampered box is rejected", () => {
    const e = clone(futureEnv);
    e.box = (e.box.slice(0, -2) + (e.box.endsWith("00") ? "01" : "00")) as Hex;
    expect(() => openWithBuilderKey(e, "alice", alice.secretKey)).toThrow(/tampered/);
  });

  it("envelope id changes when the label changes", () => {
    const e = clone(futureEnv);
    e.label.round += 1;
    expect(envelopeId(e)).not.toBe(envelopeId(futureEnv));
  });
});

describe("opened tx vs label", () => {
  const facts = { chainId: 1337, sender: SENDER, nonceKey: 0n, nonceSeq: 2n, maxCost: 1_000_000_000_000_000n };

  it("accepts a tx matching the label", () => {
    expect(() => checkOpenedTx(futureEnv, facts)).not.toThrow();
  });

  it("rejects a different sender", () => {
    expect(() => checkOpenedTx(futureEnv, { ...facts, sender: "0x0000000000000000000000000000000000000001" })).toThrow(/sender/);
  });

  it("rejects a tx costing more than the label promised", () => {
    expect(() => checkOpenedTx(futureEnv, { ...facts, maxCost: 2_000_000_000_000_000n })).toThrow(/maxCost/);
  });

  it("rejects a different nonce", () => {
    expect(() => checkOpenedTx(futureEnv, { ...facts, nonceSeq: 3n })).toThrow(/nonceSeq/);
  });
});

describe("time lock (drand quicknet tlock)", () => {
  it("opens for anyone once the round has passed", async () => {
    expect(await openWithBeacon(pastEnv, drand)).toEqual(rawTx);
  }, 30_000);

  it("refuses to open before the round", async () => {
    await expect(openWithBeacon(futureEnv, drand)).rejects.toThrow(EnvelopeError);
  }, 30_000);
});

describe("seal input checks", () => {
  it("with no builder, only the time lock can open it (public deadline release)", async () => {
    const env = await seal(input(1, { builders: [] }));
    expect(env.lockA).toEqual([]);
    expect(env.label.builderIds).toEqual([]);
    expect(typeof env.lockB).toBe("string");
  });

  it("rejects duplicate builder ids", async () => {
    const b = { builderId: "alice", publicKey: alice.publicKey };
    await expect(seal(input(1, { builders: [b, b] }))).rejects.toThrow(/duplicate/);
  });
});
