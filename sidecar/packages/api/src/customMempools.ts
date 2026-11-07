import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { CustomMempoolConfig } from "@skandha/executor/lib/interfaces";
import type {
  CustomGossipHandler,
  CustomMempoolGossip,
} from "@skandha/executor/lib/services/CustomMempoolGossip";

export type CustomMethod = (params: unknown[], peer: string) => unknown;

/** What a custom mempool module's `createMempool` returns. */
export interface CustomMempool {
  mempoolId: string;
  methods: Record<string, CustomMethod>;
}

/** The gossip handle a custom mempool gets for its own p2p topic. */
export interface CustomMempoolTopic {
  networked: boolean;
  publish(data: Uint8Array): Promise<number>;
  subscribe(handler: CustomGossipHandler): void;
}

/**
 * Loads ERC-8421 non-standard alternative mempools: each is a module whose
 * `createMempool({ mempoolId, options, gossip })` returns its own RPC methods.
 */
export async function loadCustomMempools(
  entries: CustomMempoolConfig[] = [],
  gossip?: CustomMempoolGossip
): Promise<Map<string, CustomMethod>> {
  const table = new Map<string, CustomMethod>();
  for (const entry of entries) {
    const path = isAbsolute(entry.module) ? entry.module : resolve(entry.module);
    const mod = await import(pathToFileURL(path).href);
    const topic: CustomMempoolTopic = {
      get networked() {
        return gossip?.networked ?? false;
      },
      publish: (data) => gossip?.publish(entry.mempoolId, data) ?? Promise.resolve(0),
      subscribe: (handler) => gossip?.register(entry.mempoolId, handler),
    };
    const pool = (await mod.createMempool({
      mempoolId: entry.mempoolId,
      options: entry.options,
      gossip: topic,
    })) as CustomMempool;
    for (const [name, fn] of Object.entries(pool.methods)) {
      if (table.has(name)) throw new Error(`custom mempool method ${name} is defined twice`);
      table.set(name, fn);
    }
  }
  return table;
}
