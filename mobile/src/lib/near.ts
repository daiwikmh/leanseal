import { Account, JsonRpcProvider, actions, base64Encode, encodeSignedDelegate, teraToGas, type KeyPairString } from "near-api-js";
import { signMessage } from "near-api-js/nep413";
import { authMessage, authNonce, encodeAuth, nearAuthRecipient, network, toBase64 } from "shared";
import { api } from "./api";
import type { PasskeySession } from "./passkey";

const provider = new JsonRpcProvider({ url: network.rpc });

export async function relayActions(session: PasskeySession, receiverId: string, list: ReturnType<typeof actions.functionCall>[]): Promise<string> {
  const account = new Account(session.accountId, provider, session.key.secretKey as KeyPairString);
  const { signedDelegate } = await account.createSignedMetaTransaction({ receiverId, actions: list, blockHeightTtl: 120 });
  const { txHash } = await api.relay(base64Encode(encodeSignedDelegate(signedDelegate)));
  return txHash;
}

export function relayCall(session: PasskeySession, method: string, args: Record<string, unknown>): Promise<string> {
  return relayActions(session, network.contract, [actions.functionCall(method, args, teraToGas(50), 0n)]);
}

export function sendUsdc(session: PasskeySession, payouts: { id: string; deposit_address: string | null; recipient: string; kind: string; amount_units: string }[]): Promise<string> {
  const transfers = payouts.map((p) => ({ receiver_id: p.kind === "direct" ? p.recipient : p.deposit_address!, amount: p.amount_units, memo: `opencash payout ${p.id}` }));
  return relayActions(session, network.usdc, transfers.map((t) => actions.functionCall("ft_transfer", t, teraToGas(15), 1n)));
}

export function businessAuth(session: PasskeySession, action: string): Promise<string> {
  return passkeyAuth(session, action, "business");
}

export async function passkeyAuth(session: PasskeySession, action: string, subject: string): Promise<string> {
  const account = new Account(session.accountId, provider, session.key.secretKey as KeyPairString);
  const message = authMessage(action, subject);
  const nonce = authNonce();
  const signed = await signMessage({ signerAccount: account, payload: { message, recipient: nearAuthRecipient, nonce } });
  return encodeAuth({ accountId: session.accountId, publicKey: session.key.publicKey, signature: toBase64(signed.signature), nonce: toBase64(nonce), message });
}
