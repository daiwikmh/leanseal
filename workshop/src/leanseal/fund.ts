import type { Address } from "viem";
import { sendLegacy, waitMined } from "../lib/chain.js";
import { ensureParticipantKey } from "../lib/state.js";

async function main() {
  const [to, wei] = process.argv.slice(2);
  const r = await waitMined(await sendLegacy(ensureParticipantKey(), { to: to as Address, value: BigInt(wei), gas: 250_000n }));
  console.log(`sent ${wei} wei to ${to}: status ${r.status}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
