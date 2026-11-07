import { concat, encodeFunctionData, pad, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import { sendLegacy, waitMined } from "../lib/chain.js";
import { ensureParticipantKey } from "../lib/state.js";
import { loadUni, readPool } from "../uni/setup_pool.js";
import { hookPoolKey, loadBatch } from "./setup_batch_pool.js";

const ETH_WEI = BigInt(process.env.ADD_ETH_WEI ?? "100000000000000000");
const Q96 = 2n ** 96n;
const KEY_TUPLE = "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";

async function send(to: Address, data: Hex, value = 0n) {
  const hash = await sendLegacy(ensureParticipantKey(), { to, data, value, gas: 3_000_000n });
  const r = await waitMined(hash);
  if (r.status !== "0x1") throw new Error(`tx ${hash} reverted`);
  return hash;
}

async function main() {
  const uni = loadUni();
  const batch = loadBatch();
  if (!uni.tusd || !uni.seeder || !batch.hook || !batch.poolId) throw new Error("run uni/setup_pool.ts and batch/setup_batch_pool.ts first");
  const before = await readPool(batch.poolId);
  const liquidity = (ETH_WEI * before.sqrtPriceX96) / Q96;
  const tusdWei = (liquidity * before.sqrtPriceX96) / Q96;
  const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);
  await send(uni.tusd, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [uni.seeder, (tusdWei * 105n) / 100n] }));
  const seederAbi = parseAbi([`function seed(${KEY_TUPLE} key, (int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt) params) payable`]);
  const hash = await send(uni.seeder, encodeFunctionData({
    abi: seederAbi, functionName: "seed",
    args: [hookPoolKey(uni.tusd, batch.hook), { tickLower: -887220, tickUpper: 887220, liquidityDelta: liquidity, salt: concat([pad("0x00", { size: 32 })]) }],
  }), (ETH_WEI * 105n) / 100n);
  const after = await readPool(batch.poolId);
  console.log(JSON.stringify({ tx: hash, addedEthWei: ETH_WEI.toString(), addedTusdWei: tusdWei.toString(), liquidityBefore: before.liquidity.toString(), liquidityAfter: after.liquidity.toString() }));
}

main().catch((e) => { console.error(e); process.exit(1); });
