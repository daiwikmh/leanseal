import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, parseAbi, toHex } from "viem";
import type { Address, Hex } from "viem";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../lib/config.js";
import { rpc } from "../lib/rpc.js";
import { ETHREX_URL } from "../net.js";
import { PQ_STATE_FILE } from "../pq/pq_e2e.js";
import { log, sendPq, sleep } from "./pq_send.js";
import { loadUni, readPool } from "../uni/setup_pool.js";
import { quoteExactIn } from "../uni/swap.js";
import { loadBatch } from "./setup_batch_pool.js";
import { latestRound, quicknet } from "../../../sealing-kit/src/drand.js";
import { commitmentOf, lockTicket } from "../../../leanseal-node/src/reveal.js";

const AMOUNT_IN = BigInt(process.env.BATCH_AMOUNT_IN ?? "100000000000000");
const DEPOSIT = BigInt(process.env.BATCH_DEPOSIT ?? "500000000000000");
const SLIPPAGE_BPS = BigInt(process.env.SLIPPAGE_BPS ?? "300");
const NODE_URL = process.env.LEANSEAL_NODE_URL ?? "http://127.0.0.1:14347/rpc";
const SELL = process.env.BATCH_SIDE === "sell";
const FEE_PIPS = 3000n;
const Q96 = 2n ** 96n;
const BLOCK_SECONDS = 6;
const DRAND_SECONDS = 3;

const HOOK_ABI = parseAbi([
  "function deposit() payable",
  "function depositToken(uint256 amount)",
  "function commit(bytes32 commitment) returns (uint256 round, uint256 index)",
  "function ethOf(address) view returns (uint256)",
  "function tokenOf(address) view returns (uint256)",
  "function currentRound() view returns (uint256)",
  "function ordersOf(uint256 round) view returns ((address user, bytes32 commitment, bool revealed, bool excluded, bool zeroForOne, uint128 amountIn, uint128 minOut)[])",
]);

async function read<T>(hook: Address, functionName: string, args: unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi: HOOK_ABI, functionName: functionName as never, args: args as never });
  const out = await rpc(ETHREX_URL, "eth_call", [{ to: hook, data }, "latest"]);
  return decodeFunctionResult({ abi: HOOK_ABI, functionName: functionName as never, data: out }) as T;
}

const blockNumber = async () => BigInt(await rpc(ETHREX_URL, "eth_blockNumber", []));

function quoteSell(sqrtPriceX96: bigint, liquidity: bigint, tokenIn: bigint): bigint {
  const dy = (tokenIn * (1_000_000n - FEE_PIPS)) / 1_000_000n;
  const x = (liquidity * Q96) / sqrtPriceX96;
  const y = (liquidity * sqrtPriceX96) / Q96;
  return (x * dy) / (y + dy);
}

async function main() {
  const batch = loadBatch();
  const uni = loadUni();
  if (!batch.hook || !batch.poolId || !uni.tusd) throw new Error("run batch/setup_batch_pool.ts first");
  const hook = batch.hook;
  const roundBlocks = BigInt(batch.roundBlocks!);
  const bond = BigInt(batch.bond!);
  const account = JSON.parse(readFileSync(PQ_STATE_FILE, "utf8")).account as Address;

  const needEth = SELL ? bond : AMOUNT_IN + bond;
  const haveEth = await read<bigint>(hook, "ethOf", [account]);
  if (haveEth < needEth) {
    const shortfall = needEth - haveEth;
    const wallet = BigInt(await rpc(ETHREX_URL, "eth_getBalance", [account, "latest"]));
    const amount = shortfall < DEPOSIT && wallet >= DEPOSIT ? DEPOSIT : shortfall;
    if (wallet < amount) throw new Error(`not enough ETH: the order needs ${shortfall} wei more in the vault, the wallet holds ${wallet} wei`);
    await sendPq(account, hook, amount, encodeFunctionData({ abi: HOOK_ABI, functionName: "deposit" }), `deposit ${amount} wei into the pool vault`);
  }
  if (SELL) {
    const haveToken = await read<bigint>(hook, "tokenOf", [account]);
    if (haveToken < AMOUNT_IN) {
      const shortfall = AMOUNT_IN - haveToken;
      const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
      const walletToken = decodeFunctionResult({ abi: erc20, functionName: "balanceOf", data: await rpc(ETHREX_URL, "eth_call", [{ to: uni.tusd, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [account] }) }, "latest"]) }) as bigint;
      if (walletToken < shortfall) throw new Error(`not enough tUSD: the order sells ${AMOUNT_IN}, the vault holds ${haveToken} and the wallet ${walletToken}. Use the faucet or buy tUSD first.`);
      await sendPq(account, uni.tusd, 0n, encodeFunctionData({ abi: erc20, functionName: "approve", args: [hook, shortfall] }), `approve ${shortfall} tUSD for the pool vault`);
      await sendPq(account, hook, 0n, encodeFunctionData({ abi: HOOK_ABI, functionName: "depositToken", args: [shortfall] }), `deposit ${shortfall} tUSD into the pool vault`);
    }
  }
  const tokenBefore = await read<bigint>(hook, "tokenOf", [account]);
  const ethBefore = await read<bigint>(hook, "ethOf", [account]);

  const pool = await readPool(batch.poolId);
  const quote = SELL ? quoteSell(pool.sqrtPriceX96, pool.liquidity, AMOUNT_IN) : quoteExactIn(pool.sqrtPriceX96, pool.liquidity, AMOUNT_IN);
  const minOut = (quote * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  console.log(JSON.stringify({ account, side: SELL ? "sell" : "buy", amountInWei: AMOUNT_IN.toString(), localQuote: quote.toString(), minOut: minOut.toString() }));

  const drand = quicknet();
  const order = { zeroForOne: !SELL, amountIn: AMOUNT_IN.toString(), minOut: minOut.toString(), salt: toHex(randomBytes(32)) };
  const commitment = commitmentOf(hook, account, order);
  log(`order sealed: commitment ${commitment} (valid in whichever batch the commit lands)`);
  const commitHash = await sendPq(account, hook, 0n, encodeFunctionData({ abi: HOOK_ABI, functionName: "commit", args: [commitment] }), "commit (only the hash goes on chain)");
  const minedBlock = BigInt((await rpc(ETHREX_URL, "eth_getTransactionReceipt", [commitHash])).blockNumber);
  const batchRound = minedBlock / roundBlocks;
  const index = (await read<Array<{ commitment: Hex }>>(hook, "ordersOf", [batchRound])).findIndex((o) => o.commitment.toLowerCase() === commitment.toLowerCase());
  if (index < 0) throw new Error(`commit ${commitHash} mined in block ${minedBlock} but not found in batch ${batchRound}`);
  const revealStartBlock = (batchRound + 1n) * roundBlocks;
  const etaSeconds = Number(revealStartBlock - (await blockNumber())) * BLOCK_SECONDS + BLOCK_SECONDS;
  const round = (await latestRound(drand)) + Math.ceil(Math.max(etaSeconds, BLOCK_SECONDS) / DRAND_SECONDS) + 1;
  const ticket = await lockTicket({ chainId: loadConfig().chainId, hook, user: account, batchRound: batchRound.toString(), round }, order, drand);
  log(`commit is order #${index} of batch ${batchRound}; reveal ticket locked to drand round ${round}`);

  const { id, gossipedTo } = await rpc(NODE_URL, "leanseal_sendRevealTicket", [ticket]);
  log(`reveal ticket ${id} sent to the sealed mempool, gossiped to ${gossipedTo} peer(s); nodes reveal it at drand round ${round}`);

  let status = "locked";
  while (status === "locked") {
    await sleep(1000);
    status = (await rpc(NODE_URL, "leanseal_ticketStatus", [id])).status;
  }
  const st = await rpc(NODE_URL, "leanseal_ticketStatus", [id]);
  log(`ticket ${status}${st.revealTx ? ` by tx ${st.revealTx}` : ""}${st.note ? ` (${st.note})` : ""}`);
  if (status !== "revealed") process.exit(1);

  for (let i = 0; i < 360; i++) {
    const now = await read<bigint>(hook, SELL ? "ethOf" : "tokenOf", [account]);
    const before = SELL ? ethBefore : tokenBefore;
    const o = (await read<Array<{ excluded: boolean }>>(hook, "ordersOf", [batchRound]))[index];
    if (now > before || o.excluded) {
      const received = o.excluded ? 0n : now - before;
      log(o.excluded ? `batch ${batchRound} settled: order refunded (batch price below minOut)` : `batch ${batchRound} settled at one price: ${SELL ? "ETH" : "tUSD"} received ${received} (min was ${minOut})`);
      console.log(JSON.stringify({ batchRound: batchRound.toString(), index, received: received.toString(), quote: quote.toString(), excluded: o.excluded, ticket: id }));
      return;
    }
    await sleep(1000);
  }
  throw new Error(`batch ${batchRound} not settled within 360 s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
