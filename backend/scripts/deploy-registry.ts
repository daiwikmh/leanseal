import { readFile } from "node:fs/promises";
import { Account, KeyPair, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { config } from "../src/config.js";
import { accountExists, operator, provider } from "../src/near.js";

const wasm = new URL("../../contracts/registry/target/near/opencash_registry.wasm", import.meta.url);
const prefix = config.contract.replace(`.${config.parent}`, "");
if (prefix === config.contract) throw new Error(`CONTRACT_ID must be a direct sub-account of ${config.parent}`);

const code = await readFile(wasm);
const parent = operator();
const key = KeyPair.fromString(config.operatorKey() as KeyPairString);

if (!(await accountExists(config.contract))) {
  console.log(`Creating ${config.contract} with 3.5 NEAR for contract storage…`);
  await parent.createSubAccount({ accountOrPrefix: prefix, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto("3.5") });
}

const registry = new Account(config.contract, provider, config.operatorKey() as KeyPairString);
console.log(`Deploying ${code.length} bytes to ${config.contract}…`);
await registry.deployContract(code);

try {
  await registry.callFunction({ contractId: config.contract, methodName: "new", args: { operator: config.parent, usdc: config.usdc }, gas: teraToGas(30) });
  console.log(`Initialised with operator ${config.parent}`);
} catch (error) {
  if (!String(error).includes("already been initialized")) throw error;
  console.log("Already initialised; code updated.");
}
const registered = await provider.callFunction({ contractId: config.usdc, method: "storage_balance_of", args: { account_id: config.contract } });
if (!registered) {
  await parent.callFunction({ contractId: config.usdc, methodName: "storage_deposit", args: { account_id: config.contract, registration_only: true }, deposit: nearToYocto("0.00125"), gas: teraToGas(30) });
  console.log(`Registered ${config.contract} with USDC so it can receive wallet payments`);
}
console.log("Operator on chain:", await provider.callFunction({ contractId: config.contract, method: "get_operator", args: {} }));
