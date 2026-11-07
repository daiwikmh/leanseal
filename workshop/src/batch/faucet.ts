import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import type { Address } from "viem";
import { sendLegacy, waitMined } from "../lib/chain.js";
import { rpc } from "../lib/rpc.js";
import { ensureParticipantKey } from "../lib/state.js";
import { ETHREX_URL } from "../net.js";
import { loadUni } from "../uni/setup_pool.js";

const ETH_WEI = BigInt(process.env.FAUCET_ETH_WEI ?? "5000000000000000");
const TUSD_WEI = BigInt(process.env.FAUCET_TUSD_WEI ?? "5000000000000000000");
const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

async function send(tx: { to: Address; value?: bigint; data?: `0x${string}` }) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await waitMined(await sendLegacy(ensureParticipantKey(), { ...tx, gas: 300_000n }));
      if (r.status !== "0x1") throw new Error(`faucet tx ${r.transactionHash} failed`);
      return r.transactionHash as string;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`faucet transfer was not included, sending it again (${attempt}/3)`);
    }
  }
}

async function main() {
  const to = process.argv[2] as Address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? "")) throw new Error("usage: faucet.ts <address>");
  const tusd = loadUni().tusd;
  if (!tusd) throw new Error("run uni/setup_pool.ts first");
  const ethTx = await send({ to, value: ETH_WEI });
  console.log(`sent ${ETH_WEI} wei ETH: ${ethTx}`);
  const tusdTx = await send({ to: tusd, data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, TUSD_WEI] }) });
  console.log(`sent ${TUSD_WEI} tUSD: ${tusdTx}`);
  const bal = decodeFunctionResult({ abi: erc20, functionName: "balanceOf", data: await rpc(ETHREX_URL, "eth_call", [{ to: tusd, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [to] }) }, "latest"]) });
  console.log(JSON.stringify({ to, ethWei: ETH_WEI.toString(), tusdWei: TUSD_WEI.toString(), ethTx, tusdTx, tusdBalance: String(bal) }));
}

main().catch((e) => { console.error(e); process.exit(1); });
