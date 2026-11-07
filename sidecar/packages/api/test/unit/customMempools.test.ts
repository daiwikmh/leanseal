import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CustomMempoolGossip } from "@skandha/executor/lib/services/CustomMempoolGossip";
import { loadCustomMempools } from "../../src/customMempools";

function moduleFile(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "custom-mempool-"));
  const file = join(dir, "pool.mjs");
  writeFileSync(file, source);
  return file;
}

const POOL = `export async function createMempool({ mempoolId, options }) {
  return { mempoolId, methods: { demo_echo: (params, peer) => ({ mempoolId, options, params, peer }) } };
}`;

describe("loadCustomMempools", () => {
  it("returns an empty table when no custom mempool is configured", async () => {
    expect((await loadCustomMempools()).size).toBe(0);
  });

  it("loads a module and exposes its methods with the mempool id and options", async () => {
    const table = await loadCustomMempools([{ mempoolId: "QmRules", module: moduleFile(POOL), options: { k: 1 } }]);
    const echo = table.get("demo_echo")!;
    expect(await echo(["a"], "127.0.0.1")).toEqual({ mempoolId: "QmRules", options: { k: 1 }, params: ["a"], peer: "127.0.0.1" });
  });

  it("refuses two mempools that define the same method", async () => {
    const file = moduleFile(POOL);
    await expect(loadCustomMempools([
      { mempoolId: "QmA", module: file },
      { mempoolId: "QmB", module: file },
    ])).rejects.toThrow(/defined twice/);
  });

  it("gives each mempool a gossip handle on its own topic", async () => {
    const GOSSIP_POOL = `export async function createMempool({ mempoolId, gossip }) {
      const got = [];
      gossip.subscribe((data, peer) => { got.push(peer + ":" + data[0]); });
      return { mempoolId, methods: {
        demo_publish: async () => ({ sent: await gossip.publish(new Uint8Array([9])), networked: gossip.networked }),
        demo_got: () => got,
      } };
    }`;
    const bus = new CustomMempoolGossip();
    const sent: string[] = [];
    bus.attachNetwork(async (id, data) => { sent.push(id + ":" + data[0]); return 2; }, () => undefined);
    const table = await loadCustomMempools([{ mempoolId: "QmRules", module: moduleFile(GOSSIP_POOL) }], bus);
    expect(await table.get("demo_publish")!([], "x")).toEqual({ sent: 2, networked: true });
    expect(sent).toEqual(["QmRules:9"]);
    await bus.deliver("QmRules", new Uint8Array([4]), "p2p:peerB");
    expect(table.get("demo_got")!([], "x")).toEqual(["p2p:peerB:4"]);
  });
});
