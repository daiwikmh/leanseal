import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEther } from "viem";
import type { Address, Hex } from "viem";
import { sendLegacy, waitMined } from "../lib/chain.js";
import { deployContract } from "../lib/contracts.js";
import { ensureParticipantKey } from "../lib/state.js";
import { stateFile } from "../net.js";

export const ONBOARD_STATE = stateFile("onboard-state.json");
const OUT = "../contracts/out";
const PAYMASTER_FUNDING = parseEther(process.env.ONBOARD_PAYMASTER_ETH ?? "0.02");

export type OnboardState = { implementation?: Address; factory?: Address; paymaster?: Address; verifier?: Address; module?: Address };
export const loadOnboard = (): OnboardState => (existsSync(ONBOARD_STATE) ? JSON.parse(readFileSync(ONBOARD_STATE, "utf8")) : {});
const save = (s: OnboardState) => writeFileSync(ONBOARD_STATE, JSON.stringify(s, null, 2));

async function deployArtifact(file: string, name: string): Promise<Address> {
  const bytecode = JSON.parse(readFileSync(`${OUT}/${file}/${name}.json`, "utf8")).bytecode.object as Hex;
  const r = await waitMined(await sendLegacy(ensureParticipantKey(), { to: null, data: bytecode, gas: 6_000_000n }));
  if (r.status !== "0x1" || !r.contractAddress) throw new Error(`${name} deploy failed`);
  return r.contractAddress as Address;
}

async function main() {
  const lss = JSON.parse(readFileSync(stateFile("pq-lss-state.json"), "utf8")) as { verifier: Address; module: Address };
  const s = loadOnboard();
  s.verifier = lss.verifier;
  s.module = lss.module;
  if (!s.implementation) {
    s.implementation = await deployArtifact("LeanSealCloneAccount.sol", "LeanSealCloneAccount");
    save(s);
    console.log(`LeanSealCloneAccount (shared account code) ${s.implementation}`);
  }
  if (!s.factory) {
    s.factory = await deployArtifact("LeanSealFactory.sol", "LeanSealFactory");
    save(s);
    console.log(`LeanSealFactory ${s.factory}`);
  }
  if (!s.paymaster) {
    s.paymaster = await deployContract("SponsorPaymaster", [], PAYMASTER_FUNDING);
    save(s);
    console.log(`SponsorPaymaster ${s.paymaster}, funded ${PAYMASTER_FUNDING} wei`);
  }
  console.log(JSON.stringify(s));
}

if (/(^|\/)setup_onboard\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1); });
