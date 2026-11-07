#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [cmd, file, digest] = process.argv.slice(2);
const key = JSON.parse(readFileSync(file, "utf8"));
const word = (hex) => hex.replace(/^0x/, "").padEnd(64, "0");
const uint = (n) => n.toString(16).padStart(64, "0");

if (cmd === "info") {
  console.log(JSON.stringify({ scheme: "leanSphincs-S-keccak", tier: "light", pkSeed: key.pkSeed, pkRoot: key.pkRoot }));
  process.exit(0);
}
if (cmd !== "sign-key" || !/^(0x)?[0-9a-fA-F]{64}$/.test(digest ?? "")) {
  console.error("usage: remote-signer.mjs info <keyfile> | sign-key <keyfile> <digest_hex64>");
  process.exit(2);
}
const res = await fetch(`${process.env.REMOTE_SIGN_URL ?? "http://127.0.0.1:4321"}/api/sign/request`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: key.id, digest: `0x${digest.replace(/^0x/, "")}` }),
  signal: AbortSignal.timeout(150_000),
});
const body = await res.json();
if (!res.ok) {
  console.error(`remote signer: ${body.error}`);
  process.exit(1);
}
const sig = body.signature.replace(/^0x/, "");
const len = sig.length / 2;
console.log(`0x${word(key.pkSeed)}${word(key.pkRoot)}${uint(0x60)}${uint(len)}${sig.padEnd(Math.ceil(len / 32) * 64, "0")}`);
