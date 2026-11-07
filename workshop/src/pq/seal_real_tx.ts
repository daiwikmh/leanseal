import { readFileSync } from "node:fs";
import { hexToBytes, bytesToHex } from "viem";
import type { Hex } from "viem";
import { decodeFrameTx } from "../lib/frameTx/codec.js";
import { checkOpenedTx, generateBuilderKeys, openWithBuilderKey, seal } from "../../../sealing-kit/src/envelope.js";
import { quicknet, roundAfter } from "../../../sealing-kit/src/drand.js";

const raw = readFileSync(process.argv[2], "utf8").trim() as Hex;
const rawBytes = hexToBytes(raw);
const tx = decodeFrameTx(raw);
const maxCost = 0x53164d3980800n;
const builder = generateBuilderKeys();
const drand = quicknet();
const env = await seal({
  rawTx: rawBytes, chainId: Number(tx.chainId), sender: tx.sender, nonceKey: tx.nonceKeys[0], nonceSeq: tx.nonceSeq,
  maxCost, round: await roundAfter(drand, 24), builders: [{ builderId: "leanseal-builder-1", publicKey: builder.publicKey }], drand,
});
const size = JSON.stringify(env).length;
const opened = openWithBuilderKey(env, "leanseal-builder-1", builder.secretKey);
const back = decodeFrameTx(bytesToHex(opened));
checkOpenedTx(env, { chainId: Number(back.chainId), sender: back.sender, nonceKey: back.nonceKeys[0], nonceSeq: back.nonceSeq, maxCost });
console.log(JSON.stringify({ rawTxBytes: rawBytes.length, envelopeJsonBytes: size, round: env.label.round, opened: bytesToHex(opened) === raw, sender: back.sender, frames: back.frames.length, sigBytes: (back.signatures[0].signature.length - 2) / 2 }));
