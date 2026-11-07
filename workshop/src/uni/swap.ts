import { readFileSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, decodeFunctionResult } from "viem";
import type { Address, Hex } from "viem";
import * as lib from "@forshtat/hegota-support/tx";
import { toWire } from "@forshtat/hegota-support/rpc";
import { loadConfig } from "../lib/config.js";
import { rpc } from "../lib/rpc.js";
import { profile } from "../lib/frameTx/profile.js";
import { accountNonce } from "../lib/frameTx/send.js";
import { buildTx, pqSign, PQ_STATE_FILE } from "../pq/pq_e2e.js";
import { ETH, UNI, loadUni, poolKey, readPool } from "./setup_pool.js";
import { ETHREX_URL } from "../net.js";

const ETHREX = ETHREX_URL;
const V4_SWAP = "0x10";
const ACTIONS = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f };
const AMOUNT_IN = 10n ** 14n;
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS ?? "50");
const FEE_PIPS = 3000n;
const Q96 = 2n ** 96n;

export function quoteExactIn(sqrtPriceX96: bigint, liquidity: bigint, amountIn: bigint): bigint {
  const dx = (amountIn * (1_000_000n - FEE_PIPS)) / 1_000_000n;
  const x = (liquidity * Q96) / sqrtPriceX96;
  const y = (liquidity * sqrtPriceX96) / Q96;
  return (y * dx) / (x + dx);
}

export function swapCalldata(tusd: Address, amountIn: bigint, minOut: bigint, deadline: bigint): Hex {
  const key = poolKey(tusd);
  const swapParams = encodeAbiParameters(
    parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)"),
    [{ poolKey: key, zeroForOne: true, amountIn, amountOutMinimum: minOut, hookData: "0x" }],
  );
  const settle = encodeAbiParameters(parseAbiParameters("address,uint256"), [ETH, amountIn]);
  const take = encodeAbiParameters(parseAbiParameters("address,uint256"), [tusd, minOut]);
  const actions = `0x${[ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL].map((a) => a.toString(16).padStart(2, "0")).join("")}` as Hex;
  const input = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [actions, [swapParams, settle, take]]);
  return encodeFunctionData({
    abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
    functionName: "execute",
    args: [V4_SWAP, [input], deadline],
  });
}

async function tusdBalance(tusd: Address, who: Address): Promise<bigint> {
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const data = await rpc(ETHREX, "eth_call", [{ to: tusd, data: encodeFunctionData({ abi, functionName: "balanceOf", args: [who] }) }, "latest"]);
  return decodeFunctionResult({ abi, functionName: "balanceOf", data }) as bigint;
}

async function main() {
  const mode = process.argv[2] ?? "dry";
  const cfg = loadConfig();
  const uni = loadUni();
  const account = JSON.parse(readFileSync(PQ_STATE_FILE, "utf8")).account as Address;
  const pool = await readPool(uni.poolId!);
  const quote = quoteExactIn(pool.sqrtPriceX96, pool.liquidity, AMOUNT_IN);
  const minOut = (quote * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const data = swapCalldata(uni.tusd!, AMOUNT_IN, minOut, deadline);
  console.log(JSON.stringify({ account, amountInWei: AMOUNT_IN.toString(), localQuote: quote.toString(), minOut: minOut.toString() }));

  const dryGas = await rpc(ETHREX, "eth_estimateGas", [{ from: account, to: UNI.universalRouter, value: `0x${AMOUNT_IN.toString(16)}`, data }]).catch((e: Error) => `REVERT: ${e.message.slice(0, 400)}`);
  console.log(`dry-run (eth_estimateGas from the account): ${typeof dryGas === "string" && dryGas.startsWith("0x") ? BigInt(dryGas) : dryGas}`);
  if (mode === "dry") return;

  const before = await tusdBalance(uni.tusd!, account);
  const nonce = await accountNonce(account);
  const tx = buildTx(account, nonce, cfg.chainId, cfg.maxFeePerGasWei,
    { to: UNI.universalRouter, value: AMOUNT_IN, data, exec: BigInt(process.env.SWAP_GAS ?? "400000"), state: BigInt(process.env.SWAP_STATE_GAS ?? "200000") },
    BigInt(process.env.VERIFY_GAS ?? "200000"));
  const digest = lib.sigHash(profile, tx);
  tx.signatures[0] = { ...tx.signatures[0], signature: pqSign(digest) };
  const raw = lib.encodeTx(profile, tx);
  writeFileSync("pq-last-swap.raw", raw);
  const sim = await rpc(ETHREX, "ethrex_simulateFrameTransaction", [raw]).catch((e: Error) => ({ error: e.message.slice(0, 400) }));
  console.log("ethrex simulation:", JSON.stringify(sim).slice(0, 500));
  const url = process.env.PQ_SUBMIT_URL!;
  const hash = await rpc(url, "eth_sendFrameTransaction", [toWire(tx)]);
  console.log(`ADMITTED by ${url}: ${hash}`);
  console.log(JSON.stringify({ tusdBefore: before.toString() }));
}

if (/(^|\/)swap\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1); });
