import { verifyMessage } from "near-api-js/nep413";
import { authMessage, fromBase64, nearAuthRecipient, nonceTime, type NearAuth } from "shared";
import { provider } from "./near.js";

const freshMs = 5 * 60_000;

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

export async function verifyNearAuth(header: string | undefined, action: string, subject: string): Promise<string> {
  if (!header) fail(401, "Sign in with your passkey or NEAR wallet first.");
  let auth: NearAuth;
  try {
    auth = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as NearAuth;
  } catch {
    fail(401, "Malformed X-Near-Auth header.");
  }
  if (auth.message !== authMessage(action, subject)) fail(401, "Signed message is for a different action.");
  const nonce = fromBase64(auth.nonce);
  if (nonce.length !== 32 || Math.abs(Date.now() - nonceTime(nonce)) > freshMs) fail(401, "Signature expired. Sign again.");
  try {
    await verifyMessage({
      signerAccountId: auth.accountId,
      signerPublicKey: auth.publicKey,
      payload: { message: auth.message, recipient: nearAuthRecipient, nonce },
      signature: fromBase64(auth.signature),
      provider,
    });
  } catch (error) {
    fail(401, `NEAR signature rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  return auth.accountId;
}
