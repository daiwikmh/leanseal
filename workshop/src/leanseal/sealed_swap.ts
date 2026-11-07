import { readFileSync, writeFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, hexToBytes, parseAbi } from "viem";
import type { Address, Hex } from "viem";
import * as lib from "@forshtat/hegota-support/tx";
import { loadConfig } from "../lib/config.js";
import { rpc } from "../lib/rpc.js";
import { profile } from "../lib/frameTx/profile.js";
import { accountNonce } from "../lib/frameTx/send.js";
import { ETHREX_URL, stateFile } from "../net.js";
import { buildTx, pqSign, PQ_STATE_FILE } from "../pq/pq_e2e.js";
import { UNI, loadUni, readPool } from "../uni/setup_pool.js";
import { quoteExactIn, swapCalldata } from "../uni/swap.js";
import { seal } from "../../../sealing-kit/src/envelope.js";
import { latestRound, quicknet } from "../../../sealing-kit/src/drand.js";
import { maxCostBound } from "../../../leanseal-node/src/facts.js";

const AMOUNT_IN = 10n ** 14n;
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS ?? "50");
const NODE_URL = process.env.LEANSEAL_NODE_URL ?? "http://127.0.0.1:14347/rpc";
const SIDECAR_URL = process.env.PQ_SUBMIT_URL ?? "http://127.0.0.1:14347/rpc";
const BUILDERS_FILE = process.env.LEANSEAL_BUILDERS ?? "../leanseal-node/builders.json";
const ROUNDS_AHEAD = Number(process.env.ROUNDS_AHEAD ?? "5");
const CHOSEN = (process.env.LEANSEAL_CHOSEN ?? "").split(",").filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (msg: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

async function tusdBalance(tusd: Address, who: Address): Promise<bigint> {
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const data = await rpc(ETHREX_URL, "eth_call", [{ to: tusd, data: encodeFunctionData({ abi, functionName: "balanceOf", args: [who] }) }, "latest"]);
  return decodeFunctionResult({ abi, functionName: "balanceOf", data }) as bigint;
}

async function main() {
  const cfg = loadConfig();
  const uni = loadUni();
  const account = JSON.parse(readFileSync(PQ_STATE_FILE, "utf8")).account as Address;
  const before = await tusdBalance(uni.tusd!, account);

  const pool = await readPool(uni.poolId!);
  const quote = quoteExactIn(pool.sqrtPriceX96, pool.liquidity, AMOUNT_IN);
  const minOut = (quote * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  const data = swapCalldata(uni.tusd!, AMOUNT_IN, minOut, BigInt(Math.floor(Date.now() / 1000) + 600));
  log(`quote ${AMOUNT_IN} wei ETH -> ${quote} tUSD (min ${minOut}), read locally from StateView`);

  const nonce = await accountNonce(account);
  const tx = buildTx(account, nonce, cfg.chainId, cfg.maxFeePerGasWei,
    { to: UNI.universalRouter, value: AMOUNT_IN, data, exec: 400_000n, state: 200_000n }, BigInt(process.env.VERIFY_GAS ?? "200000"));
  tx.signatures[0] = { ...tx.signatures[0], signature: pqSign(lib.sigHash(profile, tx)) };
  const raw = lib.encodeTx(profile, tx);
  const rawBytes = hexToBytes(raw);
  const txHash = lib.txHash(profile, tx);
  log(`signed PQ tx ${txHash}`);

  const builders = JSON.parse(readFileSync(BUILDERS_FILE, "utf8")) as Record<string, { publicKey: Hex }>;
  const drand = quicknet();
  const round = (await latestRound(drand)) + ROUNDS_AHEAD;
  const env = await seal({
    rawTx: rawBytes, chainId: cfg.chainId, sender: account, nonceKey: 0n, nonceSeq: nonce,
    maxCost: maxCostBound(tx, rawBytes.length), round,
    builders: CHOSEN.map((id) => ({ builderId: id, publicKey: hexToBytes(builders[id].publicKey) })),
    drand,
  });
  writeFileSync(stateFile("last-envelope.json"), JSON.stringify(env));
  const { id, gossipedTo } = await rpc(NODE_URL, "leanseal_sendEnvelope", [env]);
  log(`sealed envelope ${id} sent (${CHOSEN.length ? `builders ${CHOSEN.join(",")}` : "public release, no builder"}, gossiped to ${gossipedTo} peer(s), deadline drand round ${round})`);

  let status = "sealed";
  while (status === "sealed") {
    await sleep(500);
    status = (await rpc(NODE_URL, "leanseal_envelopeStatus", [id])).status;
  }
  const st = await rpc(NODE_URL, "leanseal_envelopeStatus", [id]);
  log(`envelope ${status} (opened by ${st.openedBy})${st.note ? `: ${st.note}` : ""}`);
  if (!st.txHash) process.exit(1);

  let receipt: any = null;
  while (!receipt) {
    await sleep(1000);
    receipt = await rpc(ETHREX_URL, "eth_getTransactionReceipt", [txHash]);
  }
  const after = await tusdBalance(uni.tusd!, account);
  const frames = receipt.frameReceipts.map((f: any, i: number) => `frame ${i}: ${BigInt(f.gasUsed)} gas, status ${f.status}`);
  log(`included in block ${BigInt(receipt.blockNumber)}; ${frames.join("; ")}`);
  log(`tUSD received: ${after - before} (min was ${minOut})`);
  writeFileSync(stateFile("last-sealed-swap.json"), JSON.stringify({ envelopeId: id, txHash, block: BigInt(receipt.blockNumber).toString(), openedBy: st.openedBy, round, received: (after - before).toString() }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
