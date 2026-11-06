import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "viem";
import type { Hex } from "viem";
import { generateBuilderKeys } from "../../sealing-kit/src/envelope.js";
import { Builder } from "./builder.js";
import { directRelay, httpSidecar } from "./chain.js";
import { httpNodeApi } from "./server.js";

const [builderId, keyFile, nodeUrl, sidecarUrl] = process.argv.slice(2);
if (!builderId || !keyFile || !nodeUrl || !sidecarUrl) {
  console.error("usage: builderMain <builderId> <keyFile> <leansealNodeUrl> <sidecarUrl>");
  process.exit(2);
}
if (!existsSync(keyFile)) {
  const k = generateBuilderKeys();
  writeFileSync(keyFile, JSON.stringify({ secretKey: bytesToHex(k.secretKey), publicKey: bytesToHex(k.publicKey) }), { mode: 0o600 });
  console.log(`new ML-KEM-768 key written to ${keyFile}`);
}
const key = JSON.parse(readFileSync(keyFile, "utf8")) as { secretKey: Hex; publicKey: Hex };
const relay = sidecarUrl.startsWith("direct:") ? directRelay(sidecarUrl.slice("direct:".length)) : httpSidecar(sidecarUrl, true);
const builder = new Builder(builderId, hexToBytes(key.secretKey), httpNodeApi(nodeUrl), relay);
console.log(`builder ${builderId} polling ${nodeUrl}`);
setInterval(async () => {
  try {
    for (const r of await builder.poll()) console.log(JSON.stringify(r));
  } catch (e) {
    console.error("poll:", (e as Error).message);
  }
}, 1000);
