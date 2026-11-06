import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { bytesToHex } from "viem";
import { generateBuilderKeys } from "../../sealing-kit/src/envelope.js";

const [builderId, keyFile, buildersFile] = process.argv.slice(2);
if (!existsSync(keyFile)) {
  const k = generateBuilderKeys();
  writeFileSync(keyFile, JSON.stringify({ secretKey: bytesToHex(k.secretKey), publicKey: bytesToHex(k.publicKey) }), { mode: 0o600 });
}
const { publicKey } = JSON.parse(readFileSync(keyFile, "utf8"));
const builders = existsSync(buildersFile) ? JSON.parse(readFileSync(buildersFile, "utf8")) : {};
builders[builderId] = { publicKey };
writeFileSync(buildersFile, JSON.stringify(builders, null, 2));
console.log(`${builderId}: public key ${publicKey.length / 2 - 1} bytes registered in ${buildersFile}`);
