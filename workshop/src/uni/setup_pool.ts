import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { encodeAbiParameters, encodeDeployData, encodeFunctionData, keccak256, parseAbi, decodeFunctionResult } from "viem";
import type { Abi, Address, Hex } from "viem";
import { sendLegacy, waitMined } from "../lib/chain.js";
import { loadConfig } from "../lib/config.js";
import { rpc } from "../lib/rpc.js";
import { ensureParticipantKey } from "../lib/state.js";
import { stateFile, uniAddresses } from "../net.js";

export const UNI = uniAddresses();
export const ETH = "0x0000000000000000000000000000000000000000" as Address;
export const FEE = 3000;
export const TICK_SPACING = 60;
export const STATE_FILE = stateFile("uni-state.json");

const OUT = "../contracts/out";
const SQRT_PRICE_1000 = 2505414483750479311864138015696n;
const FULL_RANGE = { lower: -887220, upper: 887220 };
const LIQUIDITY = 316227766016837933n;
const SEED_ETH = 11n * 10n ** 15n;
const TUSD_SUPPLY = 1_000_000n * 10n ** 18n;
const TUSD_TO_SEEDER = 20n * 10n ** 18n;

export type UniState = { tusd?: Address; seeder?: Address; poolId?: Hex; seeded?: boolean };
export const loadUni = (): UniState => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {});
const saveUni = (s: UniState) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

const artifact = (file: string, name: string): { abi: Abi; bytecode: Hex } => {
  const j = JSON.parse(readFileSync(`${OUT}/${file}/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
};

export const poolKey = (tusd: Address) => ({ currency0: ETH, currency1: tusd, fee: FEE, tickSpacing: TICK_SPACING, hooks: ETH });

export const poolIdOf = (tusd: Address): Hex =>
  keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [ETH, tusd, FEE, TICK_SPACING, ETH],
  ));

async function send(to: Address | null, data: Hex, value = 0n, gas = 3_000_000n): Promise<any> {
  const hash = await sendLegacy(ensureParticipantKey(), { to, data, value, gas });
  const r = await waitMined(hash);
  if (r.status !== "0x1") throw new Error(`tx ${hash} reverted`);
  return r;
}

const KEY_TUPLE = "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";

export async function readPool(poolId: Hex) {
  const cfg = loadConfig();
  const sv = parseAbi([
    "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getLiquidity(bytes32) view returns (uint128)",
  ]);
  const call = async (fn: "getSlot0" | "getLiquidity") =>
    decodeFunctionResult({ abi: sv, functionName: fn, data: await rpc(cfg.gatewayUrl, "eth_call", [{ to: UNI.stateView, data: encodeFunctionData({ abi: sv, functionName: fn, args: [poolId] }) }, "latest"]) });
  const slot0 = (await call("getSlot0")) as readonly [bigint, number, number, number];
  const liquidity = (await call("getLiquidity")) as bigint;
  return { sqrtPriceX96: slot0[0], tick: slot0[1], lpFee: slot0[3], liquidity };
}

async function main() {
  const s = loadUni();
  if (!s.tusd) {
    const a = artifact("TestUSD.sol", "TestUSD");
    s.tusd = (await send(null, encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: [TUSD_SUPPLY] }))).contractAddress;
    saveUni(s);
    console.log(`tUSD ${s.tusd}`);
  }
  if (!s.seeder) {
    const a = artifact("LiquiditySeeder.sol", "LiquiditySeeder");
    s.seeder = (await send(null, encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: [UNI.poolManager] }), 0n, 12_000_000n)).contractAddress;
    saveUni(s);
    console.log(`seeder ${s.seeder}`);
  }
  s.poolId = poolIdOf(s.tusd!);
  saveUni(s);
  const before = await readPool(s.poolId);
  if (before.sqrtPriceX96 === 0n) {
    const pm = parseAbi([`function initialize(${KEY_TUPLE} key, uint160 sqrtPriceX96) returns (int24)`]);
    await send(UNI.poolManager, encodeFunctionData({ abi: pm, functionName: "initialize", args: [poolKey(s.tusd!), SQRT_PRICE_1000] }));
    console.log(`initialized pool ${s.poolId} at 1 ETH = 1000 tUSD`);
  }
  if (!s.seeded) {
    const erc20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);
    await send(s.tusd!, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [s.seeder!, TUSD_TO_SEEDER] }));
    const seederAbi = parseAbi([`function seed(${KEY_TUPLE} key, (int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt) params) payable`]);
    const r = await send(s.seeder!, encodeFunctionData({
      abi: seederAbi, functionName: "seed",
      args: [poolKey(s.tusd!), { tickLower: FULL_RANGE.lower, tickUpper: FULL_RANGE.upper, liquidityDelta: LIQUIDITY, salt: `0x${"00".repeat(32)}` }],
    }), SEED_ETH);
    s.seeded = true;
    saveUni(s);
    console.log(`seeded liquidity, gasUsed ${BigInt(r.gasUsed)}`);
  }
  const p = await readPool(s.poolId);
  console.log(JSON.stringify({ poolId: s.poolId, tusd: s.tusd, sqrtPriceX96: p.sqrtPriceX96.toString(), tick: p.tick, lpFee: p.lpFee, liquidity: p.liquidity.toString() }));
}

if (/(^|\/)setup_pool\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1); });
