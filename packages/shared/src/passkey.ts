import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

export const rpName = "opencash";

export const prfSalt = sha256(new TextEncoder().encode("opencash/near/prf/v1"));

export type NearKey = { publicKey: string; secretKey: string };

export function nearKeyFromPrf(prfOutput: Uint8Array): NearKey {
  const seed = hkdf(sha256, prfOutput, prfSalt, new TextEncoder().encode("opencash/near/ed25519/v1"), 32);
  const publicKey = ed25519.getPublicKey(seed);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(publicKey, 32);
  seed.fill(0);
  return { publicKey: `ed25519:${base58.encode(publicKey)}`, secretKey: `ed25519:${base58.encode(secret)}` };
}

export function encodeUserHandle(accountId: string): Uint8Array {
  return new TextEncoder().encode(accountId);
}

export function decodeUserHandle(handle: ArrayBuffer | Uint8Array): string {
  return new TextDecoder().decode(handle instanceof Uint8Array ? handle : new Uint8Array(handle));
}

export function signWithNearKey(secretKey: string, message: string): string {
  const seed = base58.decode(secretKey.replace(/^ed25519:/, "")).slice(0, 32);
  return base58.encode(ed25519.sign(new TextEncoder().encode(message), seed));
}

export function verifyNearSignature(publicKey: string, message: string, signature: string): boolean {
  try {
    return ed25519.verify(base58.decode(signature), new TextEncoder().encode(message), base58.decode(publicKey.replace(/^ed25519:/, "")));
  } catch {
    return false;
  }
}
