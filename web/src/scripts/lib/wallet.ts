import { NearConnector, type NearWalletBase } from "@hot-labs/near-connect";
import { agreementSigningSubject, authMessage, authNonce, encodeAuth, nearAuthRecipient, network, toBase64 } from "shared";

let connector: NearConnector | null = null;
let current: { wallet: NearWalletBase; accountId: string } | null = null;

function instance(): NearConnector {
  connector ??= new NearConnector({ network: "mainnet" });
  return connector;
}

export async function connectWallet(): Promise<string> {
  const near = instance();
  const wallet = await near.connect();
  const accounts = await wallet.getAccounts({ network: "mainnet" });
  const accountId = accounts[0]?.accountId;
  if (!accountId) throw new Error("The wallet returned no NEAR account.");
  current = { wallet, accountId };
  return accountId;
}

export function connectedAccount(): string | null {
  return current?.accountId ?? null;
}

export async function walletAuth(action: string, subject: string): Promise<string> {
  if (!current) throw new Error("Connect a NEAR wallet first.");
  const message = authMessage(action, subject);
  const nonce = authNonce();
  const signed = await current.wallet.signMessage({ message, recipient: nearAuthRecipient, nonce, network: "mainnet", signerId: current.accountId });
  const signature = /^[A-Za-z0-9+/]+=*$/.test(signed.signature) ? signed.signature : toBase64(Uint8Array.from(atob(signed.signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
  return encodeAuth({ accountId: signed.accountId, publicKey: signed.publicKey, signature, nonce: toBase64(nonce), message });
}

export async function walletSignAgreement(id: string, docHash: string): Promise<string> {
  return walletAuth("sign-agreement", agreementSigningSubject(id, docHash));
}

export async function walletPayInvoice(id: string, amountUnits: string): Promise<string> {
  if (!current) throw new Error("Connect a NEAR wallet first.");
  const outcome = await current.wallet.signAndSendTransaction({
    network: "mainnet",
    signerId: current.accountId,
    receiverId: network.usdc,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName: "ft_transfer_call", args: { receiver_id: network.contract, amount: amountUnits, msg: id }, gas: "100000000000000", deposit: "1" },
      },
    ],
  });
  return outcome.transaction.hash;
}
