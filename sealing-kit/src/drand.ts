import { mainnetClient, roundAt } from "tlock-js";
import type { ChainClient } from "tlock-js";

export const QUICKNET_CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

export const quicknet = (): ChainClient => mainnetClient();

export async function roundAfter(client: ChainClient, seconds: number, now = Date.now()): Promise<number> {
  const info = await client.chain().info();
  return roundAt(now + seconds * 1000, info);
}

export async function latestRound(client: ChainClient, attempts = 3): Promise<number> {
  for (let i = 1; ; i++) {
    try {
      return (await client.latest()).round;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}
export type { ChainClient } from "tlock-js";
