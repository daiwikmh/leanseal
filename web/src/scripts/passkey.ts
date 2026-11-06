type LssExports = { memory: WebAssembly.Memory; io_ptr(): number; lss_keygen(): number; lss_sign(): number; lss_forget(): void };

const CRED_KEY = 'leanseal.passkey.credential';
const enc = new TextEncoder();
let wasm: LssExports | null = null;

export type PublicKey = { pkSeed: string; pkRoot: string };

const hex = (b: Uint8Array) => `0x${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
const unhex = (h: string) => Uint8Array.from(h.replace(/^0x/, '').match(/../g)!.map((x) => parseInt(x, 16)));
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function prfSalt(): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('leanseal/lss-seed/v1')));
}

async function loadWasm(): Promise<LssExports> {
  if (!wasm) wasm = (await WebAssembly.instantiateStreaming(fetch('/lss.wasm'), {})).instance.exports as unknown as LssExports;
  return wasm;
}

const io = (w: LssExports) => new Uint8Array(w.memory.buffer, w.io_ptr(), 8192);

async function seedFrom(prf: ArrayBuffer): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('LeanSeal'), info: enc.encode('lss-light-seed-v1') }, ikm, 256);
  return new Uint8Array(bits);
}

function prfOutput(cred: PublicKeyCredential): ArrayBuffer | null {
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
  return ext.prf?.results?.first ?? null;
}

async function assertPrf(credentialId?: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      userVerification: 'required',
      allowCredentials: credentialId ? [{ type: 'public-key', id: credentialId }] : [],
      extensions: { prf: { eval: { first: await prfSalt() } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was chosen.');
  const out = prfOutput(cred);
  if (!out) throw new Error('This passkey cannot derive keys (no PRF support). Try Chrome or Safari with iCloud Keychain or Google Password Manager.');
  localStorage.setItem(CRED_KEY, b64(cred.rawId));
  return out;
}

export function supported(): string | null {
  if (!window.PublicKeyCredential) return 'This browser has no passkey support.';
  if (location.hostname === '127.0.0.1') return 'Passkeys need a domain name. Open http://localhost:4321/dashboard instead.';
  return null;
}

export function hasCredential(): boolean {
  try {
    return !!localStorage.getItem(CRED_KEY);
  } catch {
    return false;
  }
}

export async function createPasskey(): Promise<ArrayBuffer> {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'LeanSeal', id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'LeanSeal wallet', displayName: 'LeanSeal wallet' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: await prfSalt() } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error('Passkey creation was cancelled.');
  localStorage.setItem(CRED_KEY, b64(cred.rawId));
  return prfOutput(cred) ?? assertPrf(new Uint8Array(cred.rawId));
}

export async function unlockPasskey(): Promise<ArrayBuffer> {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(CRED_KEY);
  } catch {
    saved = null;
  }
  try {
    return await assertPrf(saved ? unb64(saved) : undefined);
  } catch (e) {
    if (saved && (e as Error).name === 'NotAllowedError') {
      try {
        localStorage.removeItem(CRED_KEY);
      } catch {
        throw e;
      }
      throw new Error('That passkey was not found or the prompt was closed. If you deleted it, press Create passkey.');
    }
    throw e;
  }
}

export async function loadKey(prf: ArrayBuffer): Promise<PublicKey> {
  const w = await loadWasm();
  const seed = await seedFrom(prf);
  new Uint8Array(prf).fill(0);
  io(w).set(seed);
  seed.fill(0);
  w.lss_keygen();
  const out = io(w).slice(0, 64);
  return { pkSeed: hex(out.slice(0, 32)), pkRoot: hex(out.slice(32, 64)) };
}

export async function sign(digest: string): Promise<string> {
  const w = await loadWasm();
  io(w).set(unhex(digest));
  const n = w.lss_sign();
  if (!n) throw new Error('The passkey key is locked.');
  return hex(io(w).slice(0, n));
}

export function forget() {
  wasm?.lss_forget();
}
