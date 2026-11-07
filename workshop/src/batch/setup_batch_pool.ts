import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { concat, encodeAbiParameters, encodeDeployData, encodeFunctionData, getContractAddress, keccak256, pad, parseAbi, toHex } from "viem";
import type { Abi, Address, Hex } from "viem";
import { sendLegacy, waitMined } from "../lib/chain.js";
import { ensureParticipantKey } from "../lib/state.js";
import { stateFile } from "../net.js";
import { FEE, TICK_SPACING, UNI, loadUni, readPool } from "../uni/setup_pool.js";

export const BATCH_STATE = stateFile("batch-state.json");
const OUT = "../contracts/out";
const ROUND_BLOCKS = BigInt(process.env.BATCH_ROUND_BLOCKS ?? "4");
const REVEAL_ROUNDS = BigInt(process.env.BATCH_REVEAL_ROUNDS ?? "2");
const BOND = BigInt(process.env.BATCH_BOND_WEI ?? "1000000000");
const SQRT_PRICE_1000 = 2505414483750479311864138015696n;
const LIQUIDITY = 31622776601683793n;
const SEED_ETH = 11n * 10n ** 14n;
const TUSD_TO_SEEDER = 2n * 10n ** 18n;
const HOOK_FLAGS = 0x0080n;
const FLAG_MASK = 0x3fffn;
const KEY_TUPLE = "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";

export type BatchState = {
  deployer?: Address;
  hook?: Address;
  salt?: Hex;
  poolId?: Hex;
  seeded?: boolean;
  roundBlocks?: string;
  revealRounds?: string;
  bond?: string;
};

export const loadBatch = (): BatchState => (existsSync(BATCH_STATE) ? JSON.parse(readFileSync(BATCH_STATE, "utf8")) : {});
const saveBatch = (s: BatchState) => writeFileSync(BATCH_STATE, JSON.stringify(s, null, 2));

const artifact = (file: string, name: string): { abi: Abi; bytecode: Hex } => {
  const j = JSON.parse(readFileSync(`${OUT}/${file}/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
};

export const hookPoolKey = (tusd: Address, hook: Address) => ({
  currency0: "0x0000000000000000000000000000000000000000" as Address, currency1: tusd, fee: FEE, tickSpacing: TICK_SPACING, hooks: hook,
});

export const poolIdOfKey = (k: ReturnType<typeof hookPoolKey>): Hex =>
  keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
  ));

/** Finds a CREATE2 salt whose address carries exactly the beforeSwap flag. */
export function mineSalt(deployer: Address, initCode: Hex): { salt: Hex; address: Address } {
  const codeHash = keccak256(initCode);
  for (let i = 0n; i < 1_000_000n; i++) {
    const salt = pad(toHex(i), { size: 32 });
    const address = getContractAddress({ opcode: "CREATE2", from: deployer, salt, bytecodeHash: codeHash });
    if ((BigInt(address) & FLAG_MASK) === HOOK_FLAGS) return { salt, address };
  }
  throw new Error("no salt found");
}

async function send(to: Address | null, data: Hex, value = 0n, gas = 3_000_000n) {
  const hash = await sendLegacy(ensureParticipantKey(), { to, data, value, gas });
  const r = await waitMined(hash);
  if (r.status !== "0x1") throw new Error(`tx ${hash} reverted`);
  return r;
}

async function main() {
  const uni = loadUni();
  if (!uni.tusd || !uni.seeder) throw new Error("run uni/setup_pool.ts first (needs tUSD and the seeder)");
  const s = loadBatch();
  if (!s.deployer) {
    const a = artifact("Create2Deployer.sol", "Create2Deployer");
    s.deployer = (await send(null, a.bytecode, 0n, 2_000_000n)).contractAddress;
    saveBatch(s);
    console.log(`Create2Deployer ${s.deployer}`);
  }
  if (!s.hook) {
    const a = artifact("SealedPoolHook.sol", "SealedPoolHook");
    const initCode = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: [UNI.poolManager, uni.tusd, FEE, TICK_SPACING, ROUND_BLOCKS, REVEAL_ROUNDS, BOND] });
    const { salt, address } = mineSalt(s.deployer!, initCode);
    const dep = parseAbi(["function deploy(bytes32 salt, bytes initCode) returns (address)"]);
    await send(s.deployer!, encodeFunctionData({ abi: dep, functionName: "deploy", args: [salt, initCode] }), 0n, 25_000_000n);
    Object.assign(s, { hook: address, salt, roundBlocks: ROUND_BLOCKS.toString(), revealRounds: REVEAL_ROUNDS.toString(), bond: BOND.toString() });
    saveBatch(s);
    console.log(`SealedPoolHook ${address} (salt ${salt}, roundBlocks ${ROUND_BLOCKS}, revealRounds ${REVEAL_ROUNDS}, bond ${BOND} wei)`);
  }
  const key = hookPoolKey(uni.tusd, s.hook!);
  s.poolId = poolIdOfKey(key);
  saveBatch(s);
  if ((await readPool(s.poolId)).sqrtPriceX96 === 0n) {
    const pm = parseAbi([`function initialize(${KEY_TUPLE} key, uint160 sqrtPriceX96) returns (int24)`]);
    await send(UNI.poolManager, encodeFunctionData({ abi: pm, functionName: "initialize", args: [key, SQRT_PRICE_1000] }));
    console.log(`initialized sealed pool ${s.poolId} at 1 ETH = 1000 tUSD`);
  }
  if (!s.seeded) {
    const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);
    await send(uni.tusd, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [uni.seeder, TUSD_TO_SEEDER] }));
    const seederAbi = parseAbi([`function seed(${KEY_TUPLE} key, (int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt) params) payable`]);
    await send(uni.seeder, encodeFunctionData({
      abi: seederAbi, functionName: "seed",
      args: [key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: LIQUIDITY, salt: concat([pad("0x00", { size: 32 })]) }],
    }), SEED_ETH, 3_000_000n);
    s.seeded = true;
    saveBatch(s);
    console.log("seeded the sealed pool");
  }
  const p = await readPool(s.poolId);
  console.log(JSON.stringify({ hook: s.hook, poolId: s.poolId, sqrtPriceX96: p.sqrtPriceX96.toString(), liquidity: p.liquidity.toString() }));
}

if (/(^|\/)setup_batch_pool\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1); });
