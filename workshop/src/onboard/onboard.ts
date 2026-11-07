import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { concat, decodeAbiParameters, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, parseAbiParameters } from "viem";
import type { Address, Hex } from "viem";
import * as lib from "@forshtat/hegota-support/tx";
import { toWire } from "@forshtat/hegota-support/rpc";
import { sendLegacy, waitMined } from "../lib/chain.js";
import { loadConfig } from "../lib/config.js";
import { rpc } from "../lib/rpc.js";
import { profile } from "../lib/frameTx/profile.js";
import { ensureParticipantKey } from "../lib/state.js";
import { ETHREX_URL, stateFile } from "../net.js";
import { loadBatch } from "../batch/setup_batch_pool.js";
import { loadOnboard } from "./setup_onboard.js";

const LSSK = process.env.PQ_SIGNER ?? "../signer-lss/lssk";
const USER = process.env.ONBOARD_USER ?? "user-1";
const SEED_FILE = `../.secrets/onboard-${USER}.seed`;
const KEY_FILE = process.env.ONBOARD_KEY_FILE ?? `../.secrets/onboard-${USER}.key`;
const SUBMIT_URL = process.env.PQ_SUBMIT_URL ?? "http://127.0.0.1:14347/rpc";
const PREFUND = BigInt(process.env.ONBOARD_PREFUND_WEI ?? "1000000000000000");
const DEPOSIT = BigInt(process.env.ONBOARD_DEPOSIT_WEI ?? "500000000000000");
const SIG_BYTES = 4164;

const FACTORY = parseAbi([
  "function createAccount(address implementation, bytes args, bytes32 salt) returns (address)",
  "function predict(address implementation, bytes args, bytes32 salt) view returns (address)",
]);
const ACCOUNT = parseAbi(["function verifyFrameAndApprove(uint256 sigIndex)"]);
const HOOK = parseAbi(["function deposit() payable", "function ethOf(address) view returns (uint256)"]);

const t0 = Date.now();
const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

function ensureKey(): { pkSeed: Hex; pkRoot: Hex } {
  if (!existsSync(KEY_FILE)) {
    if (!existsSync(SEED_FILE)) writeFileSync(SEED_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
    execFileSync(LSSK, ["keygen", "--seed-file", SEED_FILE, "--tier", "light", "-o", KEY_FILE], { stdio: ["ignore", "ignore", "ignore"] });
    log(`new quantum-safe key for ${USER} (leanSphincs-s, light tier), kept in .secrets/`);
  }
  const info = JSON.parse(execFileSync(LSSK, ["info", KEY_FILE], { encoding: "utf8" }));
  return { pkSeed: info.pkSeed, pkRoot: info.pkRoot };
}

function sign(digest: Hex): Hex {
  const out = execFileSync(LSSK, ["sign-key", KEY_FILE, digest.slice(2)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() as Hex;
  return decodeAbiParameters(parseAbiParameters("bytes32,bytes32,bytes"), out)[2];
}

async function call<T>(to: Address, abi: ReturnType<typeof parseAbi>, functionName: string, args: unknown[]): Promise<T> {
  const data = encodeFunctionData({ abi, functionName: functionName as never, args: args as never });
  const out = await rpc(ETHREX_URL, "eth_call", [{ to, data }, "latest"]);
  return decodeFunctionResult({ abi, functionName: functionName as never, data: out }) as T;
}

async function main() {
  const cfg = loadConfig();
  const o = loadOnboard();
  if (!o.factory || !o.implementation || !o.paymaster || !o.verifier || !o.module) throw new Error("run onboard/setup_onboard.ts first");
  const hook = loadBatch().hook;
  const { pkSeed, pkRoot } = ensureKey();
  const args = concat([pkSeed, pkRoot, o.verifier, o.module]);
  const salt = keccak256(concat([pkSeed, pkRoot]));
  const account = await call<Address>(o.factory, FACTORY, "predict", [o.implementation, args, salt]);
  log(`wallet address, known before it exists: ${account}`);

  const code = await rpc(ETHREX_URL, "eth_getCode", [account, "latest"]);
  if (process.env.ONBOARD_PREDICT_ONLY) {
    console.log(JSON.stringify({ account, created: code !== "0x" }));
    return;
  }
  if (code !== "0x") throw new Error(`${account} already exists: this user is already onboarded`);

  const deposit = hook && PREFUND > 0n;
  if (PREFUND > 0n) {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await waitMined(await sendLegacy(ensureParticipantKey(), { to: account, value: PREFUND, gas: 300_000n }));
        if (r.status !== "0x1") throw new Error(`prefund ${r.transactionHash} failed`);
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        log(`funding transfer was not included (${(e as Error).message.slice(0, 80)}); sending it again (${attempt}/3)`);
      }
    }
    log(`a friend sent ${PREFUND} wei to the not-yet-created address`);
  }

  const frames = [
    lib.frame(profile, "DEFAULT", {
      target: o.factory, execution: 25_000n, state: 450_000n,
      data: encodeFunctionData({ abi: FACTORY, functionName: "createAccount", args: [o.implementation, args, salt] }),
    }),
    lib.frame(profile, "VERIFY", { scope: "EXECUTION", target: null, execution: 55_000n, data: encodeFunctionData({ abi: ACCOUNT, functionName: "verifyFrameAndApprove", args: [0n] }) }),
    lib.frame(profile, "VERIFY", { scope: "PAYMENT", target: o.paymaster, execution: 12_000n }),
    deposit
      ? lib.frame(profile, "SENDER", { target: hook!, execution: BigInt(process.env.ONBOARD_SENDER_GAS ?? "300000"), state: BigInt(process.env.ONBOARD_SENDER_STATE ?? "600000"), value: DEPOSIT, data: encodeFunctionData({ abi: HOOK, functionName: "deposit" }) })
      : lib.frame(profile, "SENDER", { target: cfg.recipient as Address, execution: 50_000n, state: 200_000n, value: 0n }),
  ];
  const tx = lib.newTx({
    chainId: cfg.chainId, sender: account, nonceSeq: 0n, frames,
    signatures: [{ scheme: lib.sigScheme(profile, "ARBITRARY"), signer: "0x", msg: "0x", signature: `0x${"00".repeat(SIG_BYTES)}` }],
    fees: { maxFeePerGas: cfg.maxFeePerGasWei },
  });
  const t1 = Date.now();
  tx.signatures[0] = { ...tx.signatures[0], signature: sign(lib.sigHash(profile, tx)) };
  log(`signed with the new PQ key in ${Date.now() - t1} ms (frames: deploy, wallet VERIFY, paymaster VERIFY, ${deposit ? "deposit into the batch pool" : "a 0-value call"})`);

  const raw = lib.encodeTx(profile, tx);
  const sim = await rpc(ETHREX_URL, "ethrex_simulateFrameTransaction", [raw]).catch((e: Error) => ({ error: e.message }));
  log(`ethrex simulation: ${JSON.stringify(sim).slice(0, 400)}`);

  const hash = await rpc(SUBMIT_URL, "eth_sendFrameTransaction", [toWire(tx)]) as Hex;
  log(`ADMITTED by the alt mempool: ${hash}`);
  for (let i = 0; i < 180; i++) {
    const r = await rpc(ETHREX_URL, "eth_getTransactionReceipt", [hash]);
    if (r) {
      const gas = (r.frameReceipts ?? []).map((f: { gasUsed: string; status: string }) => `${BigInt(f.gasUsed)}${f.status === "0x1" ? "" : " (failed)"}`).join(", ");
      log(`mined in block ${BigInt(r.blockNumber)}, status ${r.status}, frame gas [${gas}], total ${BigInt(r.gasUsed)}`);
      const created = (await rpc(ETHREX_URL, "eth_getCode", [account, "latest"])) !== "0x";
      const vault = deposit ? await call<bigint>(hook!, HOOK, "ethOf", [account]) : 0n;
      log(`wallet created: ${created}${deposit ? `; vault balance ${vault} wei` : ""}; gas paid by the sponsor paymaster`);
      writeFileSync(stateFile(`onboard-${USER}.json`), JSON.stringify({ account, txHash: hash, block: BigInt(r.blockNumber).toString(), created }, null, 2));
      return;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`${hash} not mined within 180 s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
