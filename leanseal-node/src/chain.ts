import { createPublicClient, http, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import { toWire } from "@forshtat/hegota-support/rpc";
import type * as lib from "@forshtat/hegota-support/tx";

export interface ChainReader {
  codeSize(addr: Address): Promise<number>;
  nonce(addr: Address): Promise<bigint>;
  balance(addr: Address): Promise<bigint>;
  stake(addr: Address): Promise<{ stake: bigint; unstakeDelaySec: number; withdrawTime: bigint }>;
}

export interface Sidecar {
  submit(tx: lib.FrameTx): Promise<Hex>;
  relayNow(): Promise<void>;
  status(hash: Hex): Promise<string>;
}

const REGISTRY_ABI = parseAbi(["function getDepositInfo(address) view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)"]);

export function viemChain(rpcUrl: string, registry: Address): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    codeSize: async (addr) => ((await client.getCode({ address: addr })) ?? "0x").length / 2 - 1,
    nonce: async (addr) => BigInt(await client.getTransactionCount({ address: addr, blockTag: "latest" })),
    balance: (addr) => client.getBalance({ address: addr }),
    stake: async (addr) => {
      const [stake, unstakeDelaySec, withdrawTime] = await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "getDepositInfo", args: [addr] });
      return { stake, unstakeDelaySec: Number(unstakeDelaySec), withdrawTime };
    },
  };
}

async function jsonRpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
  return body.result;
}

export function httpSidecar(url: string, relay: boolean): Sidecar {
  return {
    submit: (tx) => jsonRpc(url, "eth_sendFrameTransaction", [toWire(tx)]),
    relayNow: async () => {
      if (relay) await jsonRpc(url, "debug_bundler_sendBundleNow", []);
    },
    status: async (hash) => (await jsonRpc(url, "skandha_frameTransactionStatus", [hash]))?.status ?? "Unknown",
  };
}

export function directRelay(ethrexUrl: string): Sidecar {
  return {
    submit: async (tx) => {
      const { encodeTx, txHash } = await import("@forshtat/hegota-support/tx");
      const { profile } = await import("./facts.js");
      const raw = encodeTx(profile, tx);
      const sim = await jsonRpc(ethrexUrl, "ethrex_simulateFrameTransaction", [raw]);
      if (sim?.executionStatus !== "success" || !sim.payer) throw new Error(`simulation failed: ${JSON.stringify(sim).slice(0, 200)}`);
      await jsonRpc(ethrexUrl, "ethrex_submitPrivilegedFrameTransaction", [raw]);
      return txHash(profile, tx) as Hex;
    },
    relayNow: async () => {},
    status: async () => "Submitted",
  };
}
