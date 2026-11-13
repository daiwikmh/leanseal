import { Passkey } from "react-native-passkey";
import { base64url } from "@scure/base";
import { decodeUserHandle, encodeUserHandle, nearKeyFromPrf, prfSalt, rpName, type NearKey } from "shared";
import { rpId } from "./config";

export type PasskeySession = { accountId: string; key: NearKey };

function b64(bytes: Uint8Array): string {
  return base64url.encode(bytes).replace(/=+$/, "");
}

function bytes(value: unknown, name: string): Uint8Array {
  if (typeof value === "string") {
    const normal = value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return base64url.decode(normal + "=".repeat((4 - (normal.length % 4)) % 4));
  }
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object") return Uint8Array.from(Object.values(value as Record<string, number>));
  throw new Error(`${name} missing from the passkey response.`);
}

function challenge(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

const extensions = { prf: { eval: { first: prfSalt } } };

async function assert(credentialId?: string): Promise<{ accountId: string; prf: Uint8Array }> {
  const result = await Passkey.getPlatformKey({
    rpId,
    challenge: challenge(),
    userVerification: "required",
    ...(credentialId ? { allowCredentials: [{ type: "public-key", id: credentialId }] } : {}),
    extensions,
  } as never);
  const prf = result.clientExtensionResults?.prf?.results?.first;
  if (!prf) throw new Error("This passkey can't derive keys (no PRF support on this device).");
  const handle = result.response.userHandle;
  if (!handle) throw new Error("This passkey has no opencash account attached.");
  return { accountId: decodeUserHandle(bytes(handle, "User handle")), prf: bytes(prf, "PRF output") };
}

export async function createPasskey(accountId: string, displayName: string): Promise<PasskeySession> {
  const created = await Passkey.createPlatformKey({
    rp: { id: rpId, name: rpName },
    user: { id: b64(encodeUserHandle(accountId)), name: accountId, displayName },
    challenge: challenge(),
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    extensions,
  } as never);
  const first = created.clientExtensionResults?.prf?.results?.first;
  const prf = first ? bytes(first, "PRF output") : (await assert(created.rawId)).prf;
  return { accountId, key: nearKeyFromPrf(prf) };
}

export async function signInWithPasskey(): Promise<PasskeySession> {
  const { accountId, prf } = await assert();
  return { accountId, key: nearKeyFromPrf(prf) };
}

export function passkeysSupported(): boolean {
  return Passkey.isSupported();
}
