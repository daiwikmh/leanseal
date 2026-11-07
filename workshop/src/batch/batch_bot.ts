import { readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, encodeFunctionData, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sendLegacy, waitMined } from "../lib/chain.js";
import { rpc } from "../lib/rpc.js";
import { ensureParticipantKey } from "../lib/state.js";
import { ETHREX_URL, stateFile } from "../net.js";
import { loadUni } from "../uni/setup_pool.js";
import { hookPoolKey, loadBatch } from "./setup_batch_pool.js";

const OUTSIDE_SWAP = "0ba73d90";
const TIMEOUT_MS = Number(process.env.BOT_TIMEOUT_MS ?? "150000");
const KEY_TUPLE = "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const SWAPPER = parseAbi([`function swapExactIn(${KEY_TUPLE} key, bool zeroForOne, uint256 amountIn)`]);
const EVENTS = parseAbi([
  "event Committed(uint256 indexed round, uint256 index, address indexed user, bytes32 commitment)",
  "event Revealed(uint256 indexed round, uint256 index, bool zeroForOne, uint128 amountIn, uint128 minOut)",
  "event Settled(uint256 indexed round, uint256 ethIn, uint256 tokenIn, uint256 ethOut, uint256 tokenOut)",
]);

const t0 = Date.now();
const log = (m: string) => console.log(`[bot +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function revertData(from: Address, to: Address, data: Hex): Promise<string> {
  const res = await fetch(ETHREX_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from, to, data }, "latest"] }) });
  const body = await res.json();
  return body.error ? `${body.error.data ?? ""} ${body.error.message ?? ""}` : "";
}

async function main() {
  const batch = loadBatch();
  const uni = loadUni();
  const swapper = JSON.parse(readFileSync(stateFile("mev-state.json"), "utf8")).swapper as Address;
  const key = hookPoolKey(uni.tusd!, batch.hook!);
  const owner = privateKeyToAccount(ensureParticipantKey()).address;
  let from = BigInt(await rpc(ETHREX_URL, "eth_blockNumber", []));
  log(`watching sealed batch pool ${batch.hook} (public alt mempool and chain); bot contract ${swapper}`);
  const watched = new Set<bigint>();
  const result = { commitsSeen: 0, revealsSeen: 0, frontRunAttempts: 0, frontRunsBlocked: 0, sandwiched: false, blockedReason: "" };
  while (Date.now() - t0 < TIMEOUT_MS) {
    const head = BigInt(await rpc(ETHREX_URL, "eth_blockNumber", []));
    if (head >= from) {
      const logs = await rpc(ETHREX_URL, "eth_getLogs", [{ address: batch.hook, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${head.toString(16)}` }]) as Array<{ data: Hex; topics: [Hex, ...Hex[]] }>;
      from = head + 1n;
      for (const l of logs) {
        const ev = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics });
        if (ev.eventName === "Committed") {
          result.commitsSeen++;
          watched.add(ev.args.round);
          log(`commit seen in batch ${ev.args.round}: only a hash (${ev.args.commitment.slice(0, 14)}…), cannot target`);
        } else if (ev.eventName === "Revealed") {
          result.revealsSeen++;
          log(`VICTIM revealed in batch ${ev.args.round}: ${ev.args.amountIn} wei ETH -> tUSD, min ${ev.args.minOut}; trying to front-run`);
          result.frontRunAttempts++;
          const data = encodeFunctionData({ abi: SWAPPER, functionName: "swapExactIn", args: [key, true, ev.args.amountIn * 50n] });
          const reason = await revertData(owner, swapper, data);
          const r = await waitMined(await sendLegacy(ensureParticipantKey(), { to: swapper, data, gas: 1_000_000n }));
          if (r.status === "0x1") {
            log("front-run went through: the pool is NOT protected");
          } else {
            result.frontRunsBlocked++;
            result.blockedReason = reason.includes(OUTSIDE_SWAP) ? "the hook's beforeSwap rejects it: the pool only trades in batches (OutsideSwap)" : `reverted: ${reason.slice(0, 120)}`;
            log(`front-run BLOCKED in block ${BigInt(r.blockNumber)}: ${result.blockedReason}`);
          }
        } else if (ev.eventName === "Settled" && watched.has(ev.args.round)) {
          log(`batch ${ev.args.round} settled at one price (ETH in ${ev.args.ethIn}, tUSD out ${ev.args.tokenOut}); nothing to sandwich`);
          writeFileSync(stateFile("batch-bot-result.json"), JSON.stringify(result, null, 2));
          log("bot profit 0 wei");
          return;
        }
      }
    }
    await sleep(1000);
  }
  writeFileSync(stateFile("batch-bot-result.json"), JSON.stringify(result, null, 2));
  log("timeout; bot profit 0 wei");
}

main().catch((e) => { console.error(e); process.exit(1); });
