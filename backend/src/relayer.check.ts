import assert from "node:assert/strict";
import { KeyPair, KeyPairSigner, actions, base64Encode, buildDelegateAction, decodeSignedDelegate, encodeSignedDelegate, teraToGas, type KeyPairString } from "near-api-js";
import { nearKeyFromPrf } from "shared";

process.env.PARENT_ACCOUNT = "opencash.near";
process.env.CONTRACT_ID = "registry.opencash.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const { refusal } = await import("./relayer.js");
const quoted = new Map([
  ["11111111-1111-1111-1111-111111111111", { kind: "intents", deposit_address: "dep1", recipient: "0xabc", amount_units: "5000000" }],
  ["22222222-2222-2222-2222-222222222222", { kind: "intents", deposit_address: "dep2", recipient: "0xdef", amount_units: "2500000" }],
  ["33333333-3333-3333-3333-333333333333", { kind: "direct", deposit_address: null, recipient: "alice.near", amount_units: "1000000" }],
]);
const lookup = async (company: string, id: string) => (company === "acme.opencash.near" && quoted.has(id) ? (quoted.get(id) as never) : null);
const P1 = "opencash payout 11111111-1111-1111-1111-111111111111";
const P2 = "opencash payout 22222222-2222-2222-2222-222222222222";
const P3 = "opencash payout 33333333-3333-3333-3333-333333333333";
const isSponsored = (d: Parameters<typeof refusal>[0]) => refusal(d, lookup);

const key = nearKeyFromPrf(new Uint8Array(32).fill(3));
const signer = new KeyPairSigner(KeyPair.fromString(key.secretKey as KeyPairString));

async function signed(receiverId: string, action: ReturnType<typeof actions.functionCall> | ReturnType<typeof actions.functionCall>[], senderId = "acme.opencash.near") {
  const delegate = buildDelegateAction({
    senderId,
    receiverId,
    actions: Array.isArray(action) ? action : [action],
    nonce: 1n,
    maxBlockHeight: 100n,
    publicKey: KeyPair.fromString(key.secretKey as KeyPairString).getPublicKey(),
  });
  const { signedDelegate } = await signer.signDelegateAction(delegate);
  return decodeSignedDelegate(Buffer.from(base64Encode(encodeSignedDelegate(signedDelegate)), "base64"));
}

const invoice = actions.functionCall("create_invoice", { client_name: "X", due_ms: 1, items: [] }, teraToGas(50), 0n);
const ok = await signed("registry.opencash.near", invoice);
assert.equal(ok.delegateAction.publicKey.toString(), key.publicKey, "passkey-derived key signs the delegate");
assert.equal(await isSponsored(ok.delegateAction), null, "create_invoice on our contract is sponsored");
assert.match((await isSponsored((await signed("usdc.near", invoice)).delegateAction))!, /registry/);
assert.match((await isSponsored((await signed("registry.opencash.near", invoice, "mallory.near")).delegateAction))!, /business accounts/);
assert.match((await isSponsored((await signed("registry.opencash.near", actions.functionCall("attest_invoice", {}, teraToGas(50), 0n))).delegateAction))!, /not sponsored/);
assert.match((await isSponsored((await signed("registry.opencash.near", actions.functionCall("create_invoice", {}, teraToGas(50), 1n))).delegateAction))!, /deposit/);
assert.match((await isSponsored((await signed("registry.opencash.near", actions.functionCall("create_invoice", {}, teraToGas(300), 0n))).delegateAction))!, /gas/);
assert.match((await isSponsored((await signed("registry.opencash.near", actions.functionCall("sign_agreement", { id: "acme-a1", doc_hash: "x" }, teraToGas(50), 0n))).delegateAction))!, /not sponsored/, "agreements are off-chain now");
const transfer = (receiver: string, amount: string, memo: string | undefined, deposit = 1n) => actions.functionCall("ft_transfer", { receiver_id: receiver, amount, memo }, teraToGas(15), deposit);
assert.equal(await isSponsored((await signed(USDC, [transfer("dep1", "5000000", P1), transfer("dep2", "2500000", P2)])).delegateAction), null, "a batch of quoted payouts is sponsored");
assert.equal(await isSponsored((await signed(USDC, transfer("alice.near", "1000000", P3))).delegateAction), null, "a direct payout to a NEAR name is sponsored");
assert.match((await isSponsored((await signed(USDC, transfer("attacker.near", "1000000", P3))).delegateAction))!, /different address/, "a direct payout can't be redirected");
assert.match((await isSponsored((await signed(USDC, transfer("attacker.near", "5000000", P1))).delegateAction))!, /different address/);
assert.match((await isSponsored((await signed(USDC, transfer("dep1", "5000000", undefined))).delegateAction))!, /memo/, "a transfer without a payout id is refused");
assert.match((await isSponsored((await signed(USDC, transfer("dep1", "5000000", "opencash payout 99999999-9999-9999-9999-999999999999"))).delegateAction))!, /not a live payout quote/);
assert.match((await isSponsored((await signed(USDC, transfer("dep1", "9000000", P1))).delegateAction))!, /amount does not match/);
assert.match((await isSponsored((await signed(USDC, transfer("dep1", "5000000", P1, 0n))).delegateAction))!, /1 yoctoNEAR/);
assert.match((await isSponsored((await signed(USDC, [transfer("dep1", "5000000", P1), transfer("dep1", "5000000", P1)])).delegateAction))!, /own payout id/);
assert.match((await isSponsored((await signed(USDC, transfer("dep1", "5000000", P1), "globex.opencash.near")).delegateAction))!, /not a live payout quote/, "another business cannot use acme's quotes");
console.log("relayer allowlist checks ok");
