import { readFileSync } from "node:fs";
import type { Address } from "viem";

export const NET = process.env.LEANSEAL_NET ?? "devnet";
export const ETHREX_URL = process.env.ETHREX_URL ?? "https://altmempool.forshtat.com";
export const stateFile = (base: string): string => (NET === "devnet" ? base : `${NET}.${base}`);

const DEVNET_UNI = {
  poolManager: "0x6bF9Aa9c04fd001385742d61f6818C3236429848",
  stateView: "0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB",
  universalRouter: "0x5e2250a42608a5cc9f62e23ab24824ee25b5e2be",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const;

export function uniAddresses(): { poolManager: Address; stateView: Address; universalRouter: Address; permit2: Address } {
  const file = process.env.UNI_ADDRESSES;
  if (!file) return DEVNET_UNI;
  const m = JSON.parse(readFileSync(file, "utf8"));
  return { poolManager: m.POOL_MANAGER, stateView: m.STATE_VIEW, universalRouter: m.UNIVERSAL_ROUTER, permit2: m.PERMIT2 };
}
