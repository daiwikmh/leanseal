import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeAbiParameters, decodeFunctionData, encodeDeployData, encodeFunctionData, parseAbi, parseAbiParameters } from "viem";
import type { Abi, Address, Hex } from "viem";
import { sendLegacy, waitMined } from "../lib/chain.js";
import { rpc } from "../lib/rpc.js";
import { ensureParticipantKey } from "../lib/state.js";
import { ETHREX_URL, stateFile } from "../net.js";
import { UNI, loadUni, poolKey, readPool } from "../uni/setup_pool.js";

const PUBLIC_MEMPOOL = process.env.PUBLIC_MEMPOOL_URL ?? "http://127.0.0.1:14347/rpc";
const LEANSEAL_NODE = process.env.LEANSEAL_NODE_URL ?? "http://127.0.0.1:14347/rpc";
const WATCH_BUILDERS = (process.env.WATCH_BUILDERS ?? "builder-1").split(",");
const TIMEOUT_MS = Number(process.env.BOT_TIMEOUT_MS ?? "120000");
const BOT_FUNDING = 5n * 10n ** 16n;
const MAX_FRONTRUN = 2n * 10n ** 16n;
const FEE_PIPS = 3000n;
const Q96 = 2n ** 96n;
const EXECUTE = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const KEY_TUPLE = "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const SWAPPER = parseAbi([`function swapExactIn(${KEY_TUPLE} key, bool zeroForOne, uint256 amountIn)`, "function withdraw()"]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const t0 = Date.now();
const log = (m: string) => console.log(`[bot +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ethIn(sqrtP: bigint, L: bigint, dx: bigint): { out: bigint; sqrtP: bigint } {
  const eff = (dx * (1_000_000n - FEE_PIPS)) / 1_000_000n;
  const x = (L * Q96) / sqrtP;
  const x2 = x + eff;
  const sqrtP2 = (L * Q96) / x2;
  return { out: (L * (sqrtP - sqrtP2)) / Q96, sqrtP: sqrtP2 };
}

function tokenIn(sqrtP: bigint, L: bigint, dy: bigint): { out: bigint; sqrtP: bigint } {
  const eff = (dy * (1_000_000n - FEE_PIPS)) / 1_000_000n;
  const sqrtP2 = sqrtP + (eff * Q96) / L;
  return { out: (L * Q96) / sqrtP - (L * Q96) / sqrtP2, sqrtP: sqrtP2 };
}

function bestFrontRun(sqrtP: bigint, L: bigint, victimIn: bigint, victimMin: bigint) {
  let lo = 0n;
  let hi = MAX_FRONTRUN;
  while (hi - lo > 10n ** 9n) {
    const mid = (lo + hi) / 2n;
    const after = ethIn(sqrtP, L, mid);
    if (ethIn(after.sqrtP, L, victimIn).out >= victimMin) lo = mid;
    else hi = mid;
  }
  const front = ethIn(sqrtP, L, lo);
  const victim = ethIn(front.sqrtP, L, victimIn);
  const back = tokenIn(victim.sqrtP, L, front.out);
  return { amount: lo, tokens: front.out, victimOut: victim.out, expectedEthBack: back.out };
}

type Victim = { sender: Address; nonce: bigint; amountIn: bigint; minOut: bigint };

function parseVictim(tx: any, tusd: Address): Victim | null {
  for (const f of tx.frames ?? []) {
    if (Number(f.mode) !== 2 || (f.target ?? "").toLowerCase() !== UNI.universalRouter.toLowerCase()) continue;
    try {
      const { args } = decodeFunctionData({ abi: EXECUTE, data: f.data as Hex });
      const [commands, inputs] = args as [Hex, Hex[], bigint];
      if (commands.slice(0, 4) !== "0x10") continue;
      const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), inputs[0]);
      if (actions.slice(0, 4) !== "0x06") continue;
      const [p] = decodeAbiParameters(
        parseAbiParameters(`(${KEY_TUPLE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`), params[0]);
      if (p.poolKey.currency1.toLowerCase() !== tusd.toLowerCase() || !p.zeroForOne) continue;
      return { sender: tx.sender, nonce: BigInt(tx.nonceSeq), amountIn: p.amountIn, minOut: p.amountOutMinimum };
    } catch {
      continue;
    }
  }
  return null;
}

async function swapper(): Promise<Address> {
  const file = stateFile("mev-state.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).swapper;
  const j = JSON.parse(readFileSync("../contracts/out/SandwichSwapper.sol/SandwichSwapper.json", "utf8"));
  const hash = await sendLegacy(ensureParticipantKey(), {
    to: null, value: BOT_FUNDING, gas: 12_000_000n,
    data: encodeDeployData({ abi: j.abi as Abi, bytecode: j.bytecode.object as Hex, args: [UNI.poolManager] }),
  });
  const addr = (await waitMined(hash)).contractAddress as Address;
  writeFileSync(file, JSON.stringify({ swapper: addr }));
  log(`deployed bot contract ${addr} with ${BOT_FUNDING} wei`);
  return addr;
}

async function botCall(bot: Address, data: Hex): Promise<bigint> {
  const r = await waitMined(await sendLegacy(ensureParticipantKey(), { to: bot, data, gas: 1_000_000n }));
  if (r.status !== "0x1") throw new Error(`bot tx ${r.transactionHash} reverted`);
  return BigInt(r.blockNumber);
}

async function main() {
  const uni = loadUni();
  const bot = await swapper();
  const key = poolKey(uni.tusd!);
  const ethStart = BigInt(await rpc(ETHREX_URL, "eth_getBalance", [bot, "latest"]));
  log(`watching public alt mempool ${PUBLIC_MEMPOOL} and LeanSeal envelopes; bot ETH ${ethStart}`);
  const sealedSeen = new Set<string>();
  let victim: Victim | null = null;
  while (!victim && Date.now() - t0 < TIMEOUT_MS) {
    const pool = (await rpc(PUBLIC_MEMPOOL, "debug_bundler_dumpMempool", []).catch(() => [])) as any[];
    for (const tx of pool) victim ??= parseVictim(tx, uni.tusd!);
    for (const b of WATCH_BUILDERS) {
      const envs = (await rpc(LEANSEAL_NODE, "leanseal_pendingFor", [b]).catch(() => [])) as { id: string; env: any }[];
      for (const e of envs) {
        if (sealedSeen.has(e.id)) continue;
        sealedSeen.add(e.id);
        log(`sealed envelope ${e.id.slice(0, 12)}… from ${e.env.label.sender}: contents unreadable (${e.env.box.length / 2 - 1} encrypted bytes), cannot target`);
      }
    }
    if (!victim) await sleep(200);
  }
  const result: Record<string, unknown> = { sealedEnvelopesSeen: sealedSeen.size };
  if (!victim) {
    log("no readable swap seen before timeout: nothing to sandwich");
    writeFileSync(stateFile("mev-result.json"), JSON.stringify({ ...result, sandwiched: false }, null, 2));
    return;
  }
  log(`VICTIM: ${victim.sender} swaps ${victim.amountIn} wei ETH -> tUSD, min ${victim.minOut}`);
  const p = await readPool(uni.poolId!);
  const plan = bestFrontRun(p.sqrtPriceX96, p.liquidity, victim.amountIn, victim.minOut);
  log(`front-run ${plan.amount} wei so victim gets ${plan.victimOut} (just above min); expect ${plan.expectedEthBack} wei back`);
  const frontBlock = await botCall(bot, encodeFunctionData({ abi: SWAPPER, functionName: "swapExactIn", args: [key, true, plan.amount] }));
  log(`front-run mined in block ${frontBlock}`);
  while (BigInt(await rpc(ETHREX_URL, "eth_getTransactionCount", [victim.sender, "latest"])) <= victim.nonce) await sleep(500);
  const victimBlock = BigInt(await rpc(ETHREX_URL, "eth_blockNumber", []));
  log(`victim tx included (by block ${victimBlock})`);
  const tokens = (await rpc(ETHREX_URL, "eth_call", [{ to: uni.tusd, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [bot] }) }, "latest"])) as Hex;
  const backBlock = await botCall(bot, encodeFunctionData({ abi: SWAPPER, functionName: "swapExactIn", args: [key, false, BigInt(tokens)] }));
  const ethEnd = BigInt(await rpc(ETHREX_URL, "eth_getBalance", [bot, "latest"]));
  log(`back-run mined in block ${backBlock}; bot profit ${ethEnd - ethStart} wei (before gas)`);
  writeFileSync(stateFile("mev-result.json"), JSON.stringify({
    ...result, sandwiched: true, victim: { ...victim, amountIn: victim.amountIn.toString(), minOut: victim.minOut.toString(), nonce: victim.nonce.toString() },
    frontRunWei: plan.amount.toString(), frontBlock: frontBlock.toString(), victimByBlock: victimBlock.toString(), backBlock: backBlock.toString(),
    botProfitWeiBeforeGas: (ethEnd - ethStart).toString(),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
