import { appendFileSync } from "node:fs";
import { rpc } from "../lib/rpc.js";
import { ETHREX_URL, uniAddresses } from "../net.js";

const SENDER = (process.argv[2] ?? "").toLowerCase();
const OUT = process.argv[3] ?? "bot-sightings.log";
const ROUTER = uniAddresses().universalRouter.toLowerCase();
const EXECUTE_SELECTOR = "3593564c";
const seen = new Set<string>();

function record(source: string, hash: string, detail: string) {
  const key = `${source}:${hash}`;
  if (seen.has(key)) return;
  seen.add(key);
  const line = `${new Date().toISOString()} ${source} ${hash} ${detail}`;
  console.log(line);
  appendFileSync(OUT, `${line}\n`);
}

const mentionsSwap = (blob: string) => blob.includes(ROUTER.slice(2)) || blob.includes(EXECUTE_SELECTOR) || (SENDER !== "" && blob.includes(SENDER.slice(2)));

async function scanTxpool() {
  const pool = await rpc(ETHREX_URL, "txpool_content", []);
  for (const kind of ["pending", "queued"]) {
    for (const txs of Object.values(pool?.[kind] ?? {}) as Record<string, any>[]) {
      for (const tx of Object.values(txs)) {
        const blob = JSON.stringify(tx).toLowerCase();
        if (mentionsSwap(blob)) record("ethrex-txpool", tx.hash, `from ${tx.from ?? tx.sender}`);
      }
    }
  }
}

async function scanBlocks(last: { n: bigint }) {
  const head = BigInt(await rpc(ETHREX_URL, "eth_blockNumber", []));
  for (let n = last.n + 1n; n <= head; n++) {
    const b = await rpc(ETHREX_URL, "eth_getBlockByNumber", [`0x${n.toString(16)}`, true]);
    for (const tx of b.transactions) {
      if (mentionsSwap(JSON.stringify(tx).toLowerCase())) record("block", tx.hash, `included in block ${n}`);
    }
  }
  last.n = head;
}

async function main() {
  const last = { n: BigInt(await rpc(ETHREX_URL, "eth_blockNumber", [])) };
  console.log(`bot watching ethrex txpool and new blocks for router ${ROUTER} / sender ${SENDER || "(any)"}`);
  for (;;) {
    await scanTxpool().catch((e) => console.error("txpool:", (e as Error).message));
    await scanBlocks(last).catch((e) => console.error("blocks:", (e as Error).message));
    await new Promise((r) => setTimeout(r, 300));
  }
}

main();
