import { describe, expect, it } from "vitest";
import { CustomMempoolGossip } from "../../src/services/CustomMempoolGossip";

describe("CustomMempoolGossip", () => {
  it("without a network, publish reaches nobody", async () => {
    const g = new CustomMempoolGossip();
    expect(g.networked).toBe(false);
    expect(await g.publish("QmA", new Uint8Array([1]))).toBe(0);
  });

  it("subscribes registered mempools when the network attaches, and later ones at once", async () => {
    const g = new CustomMempoolGossip();
    const subscribed: string[] = [];
    g.register("QmA", () => undefined);
    g.attachNetwork(async (_id, data) => data.length, (id) => subscribed.push(id));
    g.register("QmB", () => undefined);
    expect(subscribed).toEqual(["QmA", "QmB"]);
    expect(await g.publish("QmA", new Uint8Array([1, 2, 3]))).toBe(3);
  });

  it("delivers to the mempool's handler, and a handler error means do not forward", async () => {
    const g = new CustomMempoolGossip();
    const seen: string[] = [];
    g.register("QmA", (data, peer) => { seen.push(`${peer}:${data[0]}`); });
    g.register("QmB", () => { throw new Error("invalid envelope"); });
    await g.deliver("QmA", new Uint8Array([7]), "p2p:peer1");
    expect(seen).toEqual(["p2p:peer1:7"]);
    await expect(g.deliver("QmB", new Uint8Array([1]), "p2p:peer1")).rejects.toThrow(/invalid/);
    await expect(g.deliver("QmC", new Uint8Array([1]), "p2p:peer1")).rejects.toThrow(/no custom mempool/);
  });

  it("refuses two registrations for one mempool id", () => {
    const g = new CustomMempoolGossip();
    g.register("QmA", () => undefined);
    expect(() => g.register("QmA", () => undefined)).toThrow(/already registered/);
  });
});
