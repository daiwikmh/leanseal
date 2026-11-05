import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { toWire } from "@forshtat/hegota-support/rpc";
import { decodeFrameTx } from "../lib/frameTx/codec.js";
import { rpc } from "../lib/rpc.js";

const [rawFile, url] = process.argv.slice(2);
const tx = decodeFrameTx(readFileSync(rawFile, "utf8").trim() as Hex);
rpc(url, "eth_sendFrameTransaction", [toWire(tx)])
  .then((h) => console.log(`ADMITTED by ${url}: ${h}`))
  .catch((e) => console.log(`REJECTED by ${url}: ${(e as Error).message.slice(0, 800)}`));
