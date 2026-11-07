import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address } from "viem";
import { rpc } from "../lib/rpc.js";
import { ETHREX_URL } from "../net.js";
import { PQ_STATE_FILE } from "../pq/pq_e2e.js";
import { loadBatch } from "./setup_batch_pool.js";
import { log, sendPq } from "./pq_send.js";

const HOOK_ABI = parseAbi([
  "function ethOf(address) view returns (uint256)",
  "function tokenOf(address) view returns (uint256)",
  "function withdraw(uint256 ethAmount, uint256 tokenAmount)",
]);

async function read(hook: Address, functionName: "ethOf" | "tokenOf", account: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: HOOK_ABI, functionName, args: [account] });
  return decodeFunctionResult({ abi: HOOK_ABI, functionName, data: await rpc(ETHREX_URL, "eth_call", [{ to: hook, data }, "latest"]) }) as bigint;
}

async function main() {
  const hook = loadBatch().hook;
  if (!hook) throw new Error("run batch/setup_batch_pool.ts first");
  const account = JSON.parse(readFileSync(PQ_STATE_FILE, "utf8")).account as Address;
  const [eth, token] = await Promise.all([read(hook, "ethOf", account), read(hook, "tokenOf", account)]);
  if (eth === 0n && token === 0n) throw new Error("the vault is empty: nothing to withdraw");
  await sendPq(account, hook, 0n, encodeFunctionData({ abi: HOOK_ABI, functionName: "withdraw", args: [eth, token] }), `withdraw ${eth} wei ETH and ${token} tUSD from the pool vault`);
  console.log(JSON.stringify({ withdrawnEthWei: eth.toString(), withdrawnTusdWei: token.toString() }));
}

main().catch((e) => { console.error(e); process.exit(1); });
