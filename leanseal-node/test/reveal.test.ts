import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { ChainClient } from "../../sealing-kit/src/drand.js";
import { commitmentOf, RevealDesk } from "../src/reveal.js";
import type { HookChain, HookOrder, OrderPlaintext, RevealTicket } from "../src/reveal.js";

const HOOK = "0x3abf5468ca1b8d2e1bfd0aa90b97cd016eb6c080" as Address;
const ALICE = "0x42def1c5b6e5679e64f243e7767f27f8132b695a" as Address;
const ORDER: OrderPlaintext = { zeroForOne: true, amountIn: "100000000000000", minOut: "1", salt: `0x${"11".repeat(32)}` };
const BATCH = 980n;
const COMMITMENT = commitmentOf(HOOK, ALICE, BATCH, ORDER);

class Clock {
  constructor(public round: number) {}
  client(): ChainClient {
    return { latest: async () => ({ round: this.round }) } as unknown as ChainClient;
  }
}

class FakeHook implements HookChain {
  revealRounds = 2n;
  round = BATCH;
  book: HookOrder[] = [{ user: ALICE, commitment: COMMITMENT, revealed: false }];
  reveals: Array<{ index: number; order: OrderPlaintext }> = [];
  settles = 0;
  async currentRound() { return this.round; }
  async orders(r: bigint) { return r === BATCH ? this.book : []; }
  async reveal(_r: bigint, index: number, order: OrderPlaintext): Promise<Hex> {
    this.reveals.push({ index, order });
    this.book[index].revealed = true;
    return "0xabc";
  }
  async settleIfDue() {
    this.settles++;
    return null;
  }
}

const ticket = (over: Partial<RevealTicket> = {}): RevealTicket => ({
  version: 1, kind: "batch-reveal", chainId: 1337, hook: HOOK, user: ALICE, batchRound: BATCH.toString(), commitment: COMMITMENT, round: 105, lock: "armored", ...over,
});

function desk(opts: { opened?: OrderPlaintext; hook?: FakeHook; clock?: Clock } = {}) {
  const hook = opts.hook ?? new FakeHook();
  const clock = opts.clock ?? new Clock(100);
  const d = new RevealDesk(
    { chainId: 1337, hook: HOOK, maxTicketBytes: 4000, maxRoundsAhead: 20, peerTicketsPerMinute: 30 },
    hook, clock.client(), Date.now, async () => opts.opened ?? ORDER,
  );
  return { d, hook, clock };
}

describe("reveal desk admission (REV rules)", () => {
  it("admits a ticket whose commitment is on chain and unrevealed", async () => {
    const { d } = desk();
    const id = await d.admit(ticket(), "alice");
    expect(d.status(id)).toMatchObject({ status: "locked", batchRound: "980", round: 105 });
  });

  it("rejects a ticket for another pool, an unknown commitment, a far deadline and a duplicate", async () => {
    const { d } = desk();
    await expect(d.admit(ticket({ hook: ALICE }), "p")).rejects.toThrow(/^shape: .*another pool/);
    await expect(d.admit(ticket({ commitment: `0x${"22".repeat(32)}` }), "p")).rejects.toThrow(/^commit: /);
    await expect(d.admit(ticket({ round: 500 }), "p")).rejects.toThrow(/^round: /);
    await expect(d.admit(ticket({ round: 100 }), "p")).rejects.toThrow(/^round: /);
    await d.admit(ticket(), "p");
    await expect(d.admit(ticket(), "q")).rejects.toThrow(/^pool: duplicate/);
  });

  it("rejects a ticket for an order that is already revealed", async () => {
    const hook = new FakeHook();
    hook.book[0].revealed = true;
    const { d } = desk({ hook });
    await expect(d.admit(ticket(), "p")).rejects.toThrow(/already revealed/);
  });
});

describe("reveal desk release", () => {
  it("a reveal that loses the race to a peer counts as revealed, not failed", async () => {
    const hook = new FakeHook();
    hook.reveal = async () => {
      hook.book[0].revealed = true;
      throw new Error("tx reverted");
    };
    const { d, clock } = desk({ hook });
    const id = await d.admit(ticket(), "alice");
    clock.round = 105;
    hook.round = BATCH + 1n;
    await d.tick();
    expect(d.status(id)).toMatchObject({ status: "revealed", note: "a peer revealed it first" });
  });

  it("holds the ticket until its drand round, then reveals the order inside the reveal window and settles", async () => {
    const { d, hook, clock } = desk();
    const id = await d.admit(ticket(), "alice");
    await d.tick();
    expect(d.status(id).status).toBe("locked");
    clock.round = 105;
    hook.round = BATCH + 1n;
    await d.tick();
    expect(d.status(id)).toMatchObject({ status: "revealed", revealTx: "0xabc" });
    expect(hook.reveals).toEqual([{ index: 0, order: ORDER }]);
    expect(hook.settles).toBe(2);
  });

  it("waits while the batch is still collecting commits", async () => {
    const { d, clock } = desk();
    const id = await d.admit(ticket(), "alice");
    clock.round = 105;
    await d.tick();
    expect(d.status(id).status).toBe("locked");
  });

  it("records a failing settle instead of hiding it", async () => {
    const hook = new FakeHook();
    hook.settleIfDue = async () => { throw new Error("insufficient funds for gas"); };
    const { d } = desk({ hook });
    await d.tick();
    expect(d.lastKeeperError?.message).toMatch(/settle: insufficient funds/);
  });

  it("keeps a ticket locked when drand is unreachable while opening it", async () => {
    const hook = new FakeHook();
    const clock = new Clock(100);
    const d = new RevealDesk(
      { chainId: 1337, hook: HOOK, maxTicketBytes: 4000, maxRoundsAhead: 20, peerTicketsPerMinute: 30 },
      hook, clock.client(), Date.now, async () => { throw new Error("Unable to connect. Is the computer able to access the url?"); },
    );
    const id = await d.admit(ticket(), "alice");
    clock.round = 105;
    hook.round = BATCH + 1n;
    await d.tick();
    expect(d.status(id)).toMatchObject({ status: "locked", note: expect.stringMatching(/drand unreachable/) });
  });

  it("marks a ticket whose opened order does not match its commitment as junk", async () => {
    const { d, hook, clock } = desk({ opened: { ...ORDER, amountIn: "1" } });
    const id = await d.admit(ticket(), "alice");
    clock.round = 105;
    hook.round = BATCH + 1n;
    await d.tick();
    expect(d.status(id)).toMatchObject({ status: "junk" });
    expect(hook.reveals).toEqual([]);
  });

  it("counts an order a peer already revealed as revealed, and expires after the window", async () => {
    const a = desk();
    const idA = await a.d.admit(ticket(), "alice");
    a.clock.round = 105;
    a.hook.round = BATCH + 1n;
    a.hook.book[0].revealed = true;
    await a.d.tick();
    expect(a.d.status(idA)).toMatchObject({ status: "revealed", note: expect.stringMatching(/already revealed/) });

    const b = desk();
    const idB = await b.d.admit(ticket(), "alice");
    b.clock.round = 105;
    b.hook.round = BATCH + 3n;
    await b.d.tick();
    expect(b.d.status(idB).status).toBe("expired");
  });
});
