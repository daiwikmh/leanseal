import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { HookChain, HookOrder, OrderPlaintext } from "./reveal.js";

export const SEALED_POOL_ABI = parseAbi([
  "function currentRound() view returns (uint256)",
  "function revealRounds() view returns (uint256)",
  "function roundBlocks() view returns (uint256)",
  "function ordersOf(uint256 round) view returns ((address user, bytes32 commitment, bool revealed, bool excluded, bool zeroForOne, uint128 amountIn, uint128 minOut)[])",
  "function reveal(uint256 round, uint256 index, bool zeroForOne, uint128 amountIn, uint128 minOut, bytes32 salt)",
  "function settle()",
]);

/** Reads the sealed pool and sends reveal/settle from a node-owned keeper key. */
export async function viemHookChain(rpcUrl: string, chainId: number, hook: Address, keeperKeyFile: string): Promise<HookChain> {
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const account = privateKeyToAccount(readFileSync(keeperKeyFile, "utf8").trim() as Hex);
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ chain, account, transport: http(rpcUrl) });
  const revealRounds = await pub.readContract({ address: hook, abi: SEALED_POOL_ABI, functionName: "revealRounds" });
  const send = async (request: Parameters<typeof wallet.writeContract>[0]): Promise<Hex> => {
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
    return hash;
  };
  let settling = false;
  const settleDue = () =>
    pub.simulateContract({ account, address: hook, abi: SEALED_POOL_ABI, functionName: "settle" }).then(() => true, () => false);
  return {
    revealRounds,
    currentRound: () => pub.readContract({ address: hook, abi: SEALED_POOL_ABI, functionName: "currentRound" }),
    orders: async (batchRound): Promise<HookOrder[]> =>
      (await pub.readContract({ address: hook, abi: SEALED_POOL_ABI, functionName: "ordersOf", args: [batchRound] }))
        .map((o) => ({ user: o.user, commitment: o.commitment, revealed: o.revealed })),
    reveal: async (batchRound: bigint, index: number, o: OrderPlaintext) => {
      const { request } = await pub.simulateContract({
        account, address: hook, abi: SEALED_POOL_ABI, functionName: "reveal",
        args: [batchRound, BigInt(index), o.zeroForOne, BigInt(o.amountIn), BigInt(o.minOut), o.salt],
      });
      return send({ ...request, gas: 300_000n } as Parameters<typeof wallet.writeContract>[0]);
    },
    settleIfDue: async () => {
      if (settling) return null;
      if (!(await settleDue())) return null;
      settling = true;
      try {
        const data = encodeFunctionData({ abi: SEALED_POOL_ABI, functionName: "settle" });
        const estimate = BigInt(await pub.request({ method: "eth_estimateGas", params: [{ from: account.address, to: hook, data }] }));
        return await send({ account, chain, address: hook, abi: SEALED_POOL_ABI, functionName: "settle", gas: (estimate * 13n) / 10n } as Parameters<typeof wallet.writeContract>[0]);
      } catch (e) {
        if (!(await settleDue())) return null;
        throw e;
      } finally {
        settling = false;
      }
    },
  };
}
