import { rpc } from "../lib/rpc.js";
import { swapCalldata, quoteExactIn } from "./swap.js";
import { UNI, loadUni, readPool } from "./setup_pool.js";

async function main() {
  const uni = loadUni();
  const acct = "0x5ed7367cbb2e9bc743e14ffc3fbd230c25c6059b";
  const pool = await readPool(uni.poolId!);
  const q = quoteExactIn(pool.sqrtPriceX96, pool.liquidity, 10n ** 14n);
  const data = swapCalldata(uni.tusd!, 10n ** 14n, (q * 9950n) / 10000n, BigInt(Math.floor(Date.now() / 1000) + 600));
  const call = { from: acct, to: UNI.universalRouter, value: "0x5af3107a4000", data, gas: "0x7a1200" };
  for (const [name, args] of [["eth_call+override", [call, "latest", { [acct]: { code: "0x" } }]], ["eth_estimateGas+override", [call, "latest", { [acct]: { code: "0x" } }]]] as const) {
    try { console.log(name, await rpc(process.env.DRY_RPC ?? "https://altmempool.forshtat.com", name.split("+")[0], args as any)); }
    catch (e) { console.log(name, "ERR", (e as Error).message.slice(0, 300)); }
  }

}

main();
