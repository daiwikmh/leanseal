import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { timelockDecrypt, timelockEncrypt, Buffer } from "tlock-js";
import type { ChainClient } from "tlock-js";

export const ENVELOPE_VERSION = 1;
const LABEL_DOMAIN = utf8ToBytes("LEANSEAL_LABEL_V1");
const LOCK_A_INFO = "leanseal/lock-a/v1/";

export type Hex = `0x${string}`;

export interface Label {
  version: number;
  chainId: number;
  sender: Hex;
  nonceKey: string;
  nonceSeq: string;
  maxCost: string;
  round: number;
  builderIds: string[];
  txHash: Hex;
}

export interface BuilderLock {
  builderId: string;
  kemCipherText: Hex;
  nonce: Hex;
  wrappedKey: Hex;
}

export interface Envelope {
  label: Label;
  boxNonce: Hex;
  box: Hex;
  lockA: BuilderLock[];
  lockB: string;
}

export interface BuilderPublicKey {
  builderId: string;
  publicKey: Uint8Array;
}

export interface SealInput {
  rawTx: Uint8Array;
  chainId: number;
  sender: Hex;
  nonceKey: bigint;
  nonceSeq: bigint;
  maxCost: bigint;
  round: number;
  builders: BuilderPublicKey[];
  drand: ChainClient;
}

export interface TxFacts {
  chainId: number;
  sender: Hex;
  nonceKey: bigint;
  nonceSeq: bigint;
  maxCost: bigint;
}

export class EnvelopeError extends Error {}

const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
const unhex = (h: string): Uint8Array => hexToBytes(h.startsWith("0x") ? h.slice(2) : h);

export const txHashOf = (rawTx: Uint8Array): Hex => hex(keccak_256(rawTx));

export function labelHash(label: Label): Uint8Array {
  const canonical = JSON.stringify([
    label.version, label.chainId, label.sender.toLowerCase(), label.nonceKey, label.nonceSeq,
    label.maxCost, label.round, label.builderIds, label.txHash.toLowerCase(),
  ]);
  return keccak_256(concatBytes(LABEL_DOMAIN, utf8ToBytes(canonical)));
}

export const envelopeId = (env: Envelope): Hex => hex(keccak_256(concatBytes(labelHash(env.label), unhex(env.box))));

function wrapKeyFor(sharedSecret: Uint8Array, lh: Uint8Array, builderId: string): Uint8Array {
  return hkdf(sha256, sharedSecret, lh, utf8ToBytes(LOCK_A_INFO + builderId), 32);
}

export function generateBuilderKeys(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return ml_kem768.keygen(seed);
}

export async function seal(input: SealInput): Promise<Envelope> {
  const ids = input.builders.map((b) => b.builderId);
  if (new Set(ids).size !== ids.length) throw new EnvelopeError("duplicate builder id");

  const label: Label = {
    version: ENVELOPE_VERSION,
    chainId: input.chainId,
    sender: input.sender,
    nonceKey: input.nonceKey.toString(),
    nonceSeq: input.nonceSeq.toString(),
    maxCost: input.maxCost.toString(),
    round: input.round,
    builderIds: ids,
    txHash: txHashOf(input.rawTx),
  };
  const lh = labelHash(label);
  const key = randomBytes(32);
  const boxNonce = randomBytes(12);
  const box = gcm(key, boxNonce, lh).encrypt(input.rawTx);

  const lockA = input.builders.map(({ builderId, publicKey }) => {
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey);
    const nonce = randomBytes(12);
    const wrappedKey = gcm(wrapKeyFor(sharedSecret, lh, builderId), nonce, lh).encrypt(key);
    return { builderId, kemCipherText: hex(cipherText), nonce: hex(nonce), wrappedKey: hex(wrappedKey) };
  });

  const lockB = await timelockEncrypt(input.round, Buffer.from(key), input.drand);
  key.fill(0);
  return { label, boxNonce: hex(boxNonce), box: hex(box), lockA, lockB };
}

export function openWithKey(env: Envelope, key: Uint8Array): Uint8Array {
  try {
    const rawTx = gcm(key, unhex(env.boxNonce), labelHash(env.label)).decrypt(unhex(env.box));
    if (txHashOf(rawTx) !== env.label.txHash.toLowerCase()) throw new EnvelopeError("opened tx does not match label.txHash");
    return rawTx;
  } catch (e) {
    if (e instanceof EnvelopeError) throw e;
    throw new EnvelopeError("box authentication failed: wrong key, or label or box was tampered with");
  }
}

export function unwrapBuilderKey(env: Envelope, builderId: string, secretKey: Uint8Array): Uint8Array {
  const lock = env.lockA.find((l) => l.builderId === builderId);
  if (!lock || !env.label.builderIds.includes(builderId)) throw new EnvelopeError(`builder ${builderId} is not chosen for this envelope`);
  const lh = labelHash(env.label);
  try {
    const sharedSecret = ml_kem768.decapsulate(unhex(lock.kemCipherText), secretKey);
    return gcm(wrapKeyFor(sharedSecret, lh, builderId), unhex(lock.nonce), lh).decrypt(unhex(lock.wrappedKey));
  } catch {
    throw new EnvelopeError("builder lock did not open: wrong key or tampered label");
  }
}

export function openWithBuilderKey(env: Envelope, builderId: string, secretKey: Uint8Array): Uint8Array {
  return openWithKey(env, unwrapBuilderKey(env, builderId, secretKey));
}

export async function openWithBeacon(env: Envelope, drand: ChainClient): Promise<Uint8Array> {
  let key: Buffer;
  try {
    key = await timelockDecrypt(env.lockB, drand);
  } catch (e) {
    throw new EnvelopeError(`time lock did not open: ${(e as Error).message}`);
  }
  return openWithKey(env, new Uint8Array(key));
}

export function checkOpenedTx(env: Envelope, facts: TxFacts): void {
  const l = env.label;
  const problems: string[] = [];
  if (facts.chainId !== l.chainId) problems.push(`chainId ${facts.chainId} != ${l.chainId}`);
  if (facts.sender.toLowerCase() !== l.sender.toLowerCase()) problems.push(`sender ${facts.sender} != ${l.sender}`);
  if (facts.nonceKey.toString() !== l.nonceKey) problems.push(`nonceKey ${facts.nonceKey} != ${l.nonceKey}`);
  if (facts.nonceSeq.toString() !== l.nonceSeq) problems.push(`nonceSeq ${facts.nonceSeq} != ${l.nonceSeq}`);
  if (facts.maxCost > BigInt(l.maxCost)) problems.push(`maxCost ${facts.maxCost} > label ${l.maxCost}`);
  if (problems.length > 0) throw new EnvelopeError(`opened tx contradicts label: ${problems.join("; ")}`);
}

/** Locks bytes to a drand round: anyone can open them once that round is published. */
export async function timelockSeal(round: number, data: Uint8Array, drand: ChainClient): Promise<string> {
  return timelockEncrypt(round, Buffer.from(data), drand);
}

export async function timelockOpen(lock: string, drand: ChainClient): Promise<Uint8Array> {
  return new Uint8Array(await timelockDecrypt(lock, drand));
}
