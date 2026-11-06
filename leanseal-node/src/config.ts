import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Address, Hex } from "viem";

export interface NodeConfig {
  port: number;
  chainId: number;
  ethrexUrl: string;
  sidecarUrl: string;
  relayAfterSubmit: boolean;
  stakingRegistry: Address;
  minStakeWei: bigint;
  minRoundsAhead: number;
  maxRoundsAhead: number;
  maxEnvelopeBytes: number;
  peerEnvelopesPerMinute: number;
  peerStrikesBeforeBan: number;
  maxEnvelopesPerSlot: number;
  tickMs: number;
  builders: Record<string, { publicKey: Hex }>;
  batchHook?: Address;
  keeperKeyFile?: string;
  maxTicketBytes: number;
}

export const DEFAULTS: Omit<NodeConfig, "ethrexUrl" | "sidecarUrl" | "stakingRegistry" | "builders"> = {
  port: 14400,
  chainId: 1337,
  relayAfterSubmit: false,
  minStakeWei: 10n ** 16n,
  minRoundsAhead: 2,
  maxRoundsAhead: 20,
  maxEnvelopeBytes: 24_000,
  peerEnvelopesPerMinute: 30,
  peerStrikesBeforeBan: 3,
  maxEnvelopesPerSlot: 3,
  tickMs: 1_000,
  maxTicketBytes: 4_000,
};

export function loadConfig(path: string): NodeConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const builders = raw.buildersFile ? JSON.parse(readFileSync(resolve(dirname(path), raw.buildersFile), "utf8")) : raw.builders ?? {};
  const keeperKeyFile = raw.keeperKeyFile ? resolve(dirname(path), raw.keeperKeyFile) : undefined;
  return { ...DEFAULTS, ...raw, minStakeWei: BigInt(raw.minStakeWei ?? DEFAULTS.minStakeWei), builders, keeperKeyFile };
}
