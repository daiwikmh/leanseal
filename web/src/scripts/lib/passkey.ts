import { decodeUserHandle, encodeUserHandle, nearKeyFromPrf, prfSalt, rpName, type NearKey } from "shared";

export type PasskeySession = { accountId: string; key: NearKey };

const rememberKey = "opencash.account";

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

const prfInputs = { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs;

function randomChallenge(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

function prfOf(credential: PublicKeyCredential): Uint8Array | null {
  const first = (credential.getClientExtensionResults() as PrfResults).prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

async function assert(credentialId?: ArrayBuffer): Promise<{ accountId: string; prf: Uint8Array }> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge(),
      rpId: location.hostname,
      userVerification: "required",
      allowCredentials: credentialId ? [{ type: "public-key", id: credentialId }] : [],
      extensions: prfInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("The passkey prompt was closed.");
  const prf = prfOf(credential);
  if (!prf) throw new Error("This passkey can't derive keys (no PRF support). Use Chrome, Safari 18+, or a phone passkey.");
  const handle = (credential.response as AuthenticatorAssertionResponse).userHandle;
  if (!handle) throw new Error("This passkey has no opencash account attached.");
  return { accountId: decodeUserHandle(handle), prf };
}

export async function createPasskey(accountId: string, displayName: string): Promise<PasskeySession> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: randomChallenge(),
      rp: { id: location.hostname, name: rpName },
      user: { id: new Uint8Array(encodeUserHandle(accountId)), name: accountId, displayName },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: prfInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("The passkey prompt was closed.");
  const prf = prfOf(credential) ?? (await assert(credential.rawId)).prf;
  return remember({ accountId, key: nearKeyFromPrf(prf) });
}

export async function signInWithPasskey(): Promise<PasskeySession> {
  const { accountId, prf } = await assert();
  return remember({ accountId, key: nearKeyFromPrf(prf) });
}

function remember(session: PasskeySession): PasskeySession {
  try {
    localStorage.setItem(rememberKey, session.accountId);
  } catch {}
  return session;
}

export function lastAccount(): string | null {
  try {
    return localStorage.getItem(rememberKey);
  } catch {
    return null;
  }
}

export function forget() {
  try {
    localStorage.removeItem(rememberKey);
  } catch {}
}

export function passkeysSupported(): boolean {
  return typeof window.PublicKeyCredential === "function";
}
