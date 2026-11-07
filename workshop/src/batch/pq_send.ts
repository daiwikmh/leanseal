import type { Address, Hex } from "viem";
import * as lib from "@forshtat/hegota-support/tx";
import { toWire } from "@forshtat/hegota-support/rpc";
import { loadConfig } from "../lib/config.js";
import { rpc } from "../lib/rpc.js";
import { profile } from "../lib/frameTx/profile.js";
import { accountNonce } from "../lib/frameTx/send.js";
import { ETHREX_URL } from "../net.js";
import { buildTx, pqSign } from "../pq/pq_e2e.js";

const SUBMIT_URL = process.env.PQ_SUBMIT_URL ?? "http://127.0.0.1:14347/rpc";
const VERIFY_GAS = BigInt(process.env.VERIFY_GAS ?? "200000");
const PAYMASTER = (process.env.BATCH_PAYMASTER || undefined) as Address | undefined;

const t0 = Date.now();
export const log = (msg: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Signs a one-call frame tx with the PQ key, submits it to the alt mempool and waits for it. */
export async function sendPq(account: Address, to: Address, value: bigint, data: Hex, what: string): Promise<Hex> {
  const cfg = loadConfig();
  const nonce = await accountNonce(account);
  const tx = buildTx(account, nonce, cfg.chainId, cfg.maxFeePerGasWei, { to, value, data, exec: BigInt(process.env.BATCH_EXEC_GAS ?? "300000"), state: BigInt(process.env.BATCH_STATE_GAS ?? "600000") }, VERIFY_GAS, PAYMASTER);
  tx.signatures[0] = { ...tx.signatures[0], signature: pqSign(lib.sigHash(profile, tx)) };
  const hash = await rpc(SUBMIT_URL, "eth_sendFrameTransaction", [toWire(tx)]) as Hex;
  log(`${what}: PQ frame tx ${hash} admitted by the alt mempool${PAYMASTER ? ", gas paid by the sponsor paymaster" : ""}`);
  for (let i = 0; i < 60; i++) {
    const r = await rpc(ETHREX_URL, "eth_getTransactionReceipt", [hash]);
    if (r) {
      if (r.status !== "0x1") throw new Error(`${what} tx ${hash} failed`);
      log(`${what} mined in block ${BigInt(r.blockNumber)}`);
      return hash;
    }
    await sleep(1000);
  }
  throw new Error(`${what} tx ${hash} not mined within 60 s`);
}
