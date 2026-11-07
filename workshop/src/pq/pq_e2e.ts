import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeAbiParameters, encodeDeployData, encodeFunctionData, parseAbi, parseAbiParameters } from "viem";
import type { Abi, Address, Hex } from "viem";
import * as lib from "@forshtat/hegota-support/tx";
import { toWire } from "@forshtat/hegota-support/rpc";
import { loadConfig } from "../lib/config.js";
import { sendLegacy, waitMined } from "../lib/chain.js";
import { rpc } from "../lib/rpc.js";
import { ensureParticipantKey } from "../lib/state.js";
import { profile } from "../lib/frameTx/profile.js";
import { accountNonce } from "../lib/frameTx/send.js";
import { ETHREX_URL, stateFile } from "../net.js";

const SPHINCS_OUT = process.env.SPHINCS_OUT!;
const SIGNER_BIN = process.env.PQ_SIGNER!;
const SEED_FILE = process.env.PQ_SEED_FILE!;
const PK_FILE = process.env.PQ_PK_FILE!;
export const PQ_SCHEME = process.env.PQ_SCHEME === "lss" ? "lss" : "sha2";
const LSS_KEY = process.env.PQ_LSS_KEY!;
const STATE_FILE = process.env.PQ_STATE ?? stateFile(PQ_SCHEME === "lss" ? "pq-lss-state.json" : "pq-state.json");
export const PQ_STATE_FILE = STATE_FILE;
const SIG_BYTES = PQ_SCHEME === "lss" ? 4164 : 3856;
const PAYMASTER_GAS = 12_000n;
const STAKE_WEI = BigInt(process.env.PQ_STAKE_WEI ?? (PQ_SCHEME === "lss" ? "0" : "10000000000000000"));

type PqState = { verifier?: Address; module?: Address; account?: Address };

const loadState = (): PqState => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {});
const saveState = (s: PqState) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

function artifact(path: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(`${SPHINCS_OUT}/${path}`, "utf8"));
  const obj: string = j.bytecode.object;
  return { abi: j.abi ?? [], bytecode: (obj.startsWith("0x") ? obj : `0x${obj}`) as Hex };
}

async function deploy(data: Hex, value = 0n): Promise<Address> {
  const hash = await sendLegacy(ensureParticipantKey(), { to: null, data, value, gas: 25_000_000n });
  const r = await waitMined(hash);
  if (r.status !== "0x1" || !r.contractAddress) throw new Error(`deploy ${hash} failed`);
  console.log(`  deployed ${r.contractAddress} (gasUsed ${BigInt(r.gasUsed)}) tx ${hash}`);
  return r.contractAddress as Address;
}

function publicKey(): { seed: Hex; root: Hex } {
  if (PQ_SCHEME === "lss") {
    const info = JSON.parse(execFileSync(SIGNER_BIN, ["info", LSS_KEY], { encoding: "utf8" }));
    return { seed: info.pkSeed, root: info.pkRoot };
  }
  const h = readFileSync(PK_FILE, "utf8").trim();
  return { seed: `0x${h.slice(0, 32)}${"0".repeat(32)}`, root: `0x${h.slice(32, 64)}${"0".repeat(32)}` };
}

export function pqSign(digest: Hex): Hex {
  const t0 = Date.now();
  if (PQ_SCHEME === "lss") {
    const enc = execFileSync(SIGNER_BIN, ["sign-key", LSS_KEY, digest.slice(2)], { encoding: "utf8", maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"] }).trim() as Hex;
    const [, , sig] = decodeAbiParameters(parseAbiParameters("bytes32,bytes32,bytes"), enc);
    console.log(`  signed in ${Date.now() - t0}ms`);
    return sig;
  }
  const out = execFileSync(SIGNER_BIN, [readFileSync(SEED_FILE, "utf8").trim(), `0000${digest.slice(2)}`], {
    encoding: "utf8", maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  console.log(`  signed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return `0x${out.slice(64)}`;
}

async function ensureContracts(s: PqState): Promise<Required<PqState>> {
  const pk = publicKey();
  if (!s.verifier) {
    console.log(`deploying ${PQ_SCHEME === "lss" ? "leanSphincs-s" : "SLH-DSA-SHA2-128-24"} verifier…`);
    s.verifier = await deploy(artifact(PQ_SCHEME === "lss" ? "LeanSphincs-SAsm.sol/LeanSphincsSAsm.json" : "SLH-DSA-SHA2-128-24verifier.sol/SLH_DSA_SHA2_128_24_Verifier.json").bytecode);
    saveState(s);
  }
  if (!s.module) {
    console.log("deploying SphincsFrameVerify (Yul frame module)…");
    s.module = await deploy(artifact("SphincsFrameVerify.yul/SphincsFrameVerify.json").bytecode);
    saveState(s);
  }
  if (!s.account) {
    console.log("deploying LeanSealAccount (stakes itself in its constructor)…");
    const { abi, bytecode } = artifact("LeanSealAccount.sol/LeanSealAccount.json");
    const owner = (await import("viem/accounts")).privateKeyToAccount(ensureParticipantKey()).address;
    const cfg = loadConfig();
    const stake = STAKE_WEI;
    const gasFunding = 3n * 10n ** 15n;
    s.account = await deploy(
      encodeDeployData({ abi, bytecode, args: [pk.seed, pk.root, s.verifier, owner, s.module, cfg.stakingRegistry, stake, stake > 0n ? 86400 : 0] }),
      stake + gasFunding,
    );
    console.log(`  staked ${stake} wei, funded ${gasFunding} wei for gas`);
    saveState(s);
  }
  return s as Required<PqState>;
}

export function buildTx(account: Address, nonce: bigint, chainId: number, maxFeePerGas: bigint, body: { to: Address; value: bigint; data: Hex; exec: bigint; state: bigint }, verifyGas: bigint, paymaster?: Address): lib.FrameTx {
  const verifyData = encodeFunctionData({ abi: parseAbi(["function verifyFrameAndApprove(uint256)"]), functionName: "verifyFrameAndApprove", args: [0n] });
  const verify = paymaster
    ? [
      lib.frame(profile, "VERIFY", { scope: "EXECUTION", target: null, execution: verifyGas, data: verifyData }),
      lib.frame(profile, "VERIFY", { scope: "PAYMENT", target: paymaster, execution: PAYMASTER_GAS }),
    ]
    : [lib.frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", target: null, execution: verifyGas, data: verifyData })];
  return lib.newTx({
    chainId, sender: account, nonceSeq: nonce,
    frames: [
      ...verify,
      lib.frame(profile, "SENDER", { target: body.to, execution: body.exec, state: body.state, value: body.value, data: body.data }),
    ],
    signatures: [{ scheme: lib.sigScheme(profile, "ARBITRARY"), signer: "0x", msg: "0x", signature: `0x${"00".repeat(SIG_BYTES)}` }],
    fees: { maxFeePerGas },
  });
}

async function main() {
  const mode = process.argv[2] ?? "transfer";
  const cfg = loadConfig();
  const s = await ensureContracts(loadState());
  console.log(`account ${s.account}  verifier ${s.verifier}  module ${s.module}`);

  const body = mode === "stake"
    ? { to: cfg.stakingRegistry as Address, value: BigInt(cfg.stakeWei), data: encodeFunctionData({ abi: parseAbi(["function addStake(uint32)"]), functionName: "addStake", args: [86400] }), exec: 150_000n, state: 300_000n }
    : { to: (process.env.TRANSFER_TO || cfg.recipient) as Address, value: 1n, data: "0x" as Hex, exec: 50_000n, state: 200_000n };

  const nonce = await accountNonce(s.account);
  const tx = buildTx(s.account, nonce, cfg.chainId, cfg.maxFeePerGasWei, body, BigInt(process.env.VERIFY_GAS ?? "400000"));
  const digest = lib.sigHash(profile, tx);
  console.log(`mode ${mode}, nonce ${nonce}, sighash ${digest}`);
  tx.signatures[0] = { ...tx.signatures[0], signature: pqSign(digest) };
  if (lib.sigHash(profile, tx) !== digest) throw new Error("sighash changed after inserting signature");
  const raw = lib.encodeTx(profile, tx);
  writeFileSync(`pq-last-${mode}.raw`, raw);

  try {
    const sim = await rpc(ETHREX_URL, "ethrex_simulateFrameTransaction", [raw]);
    writeFileSync(`pq-last-${mode}.sim.json`, JSON.stringify(sim, null, 2));
    console.log("ethrex simulation:", JSON.stringify(sim).slice(0, 600));
  } catch (e) {
    console.log("ethrex simulation error:", (e as Error).message.slice(0, 600));
  }

  for (const url of [process.env.PQ_SUBMIT_URL ?? cfg.gatewayUrl]) {
    try {
      const hash = await rpc(url, "eth_sendFrameTransaction", [toWire(tx)]);
      console.log(`ADMITTED by ${url}: ${hash}`);
    } catch (e) {
      console.log(`REJECTED by ${url}: ${(e as Error).message.slice(0, 800)}`);
    }
  }
}

if (/(^|\/)pq_e2e\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1); });
