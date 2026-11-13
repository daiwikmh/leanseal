import { Account, JsonRpcProvider, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import type { Company, Invoice, InvoiceStatus, Payment } from "shared";
import { withFormation } from "./business.js";
import { config } from "./config.js";

export const provider = new JsonRpcProvider({ url: config.rpcUrl });

let operatorAccount: Account | null = null;

export function operator(): Account {
  operatorAccount ??= new Account(config.parent, provider, config.operatorKey() as KeyPairString);
  return operatorAccount;
}

export async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  return (await provider.callFunction({ contractId: config.contract, method, args })) as T;
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

export async function usdcBalance(accountId: string): Promise<string> {
  const result = await provider.callFunction({ contractId: config.usdc, method: "ft_balance_of", args: { account_id: accountId } });
  return String(result ?? "0");
}

export async function openCompany(input: {
  handle: string;
  publicKey: string;
  legalName: string;
  country: string;
}): Promise<{ company: Company; txHash: string }> {
  const parent = operator();
  const accountId = `${input.handle}.${config.parent}`;
  const created = await parent.createSubAccount({
    accountOrPrefix: input.handle,
    publicKey: input.publicKey,
    nearToTransfer: nearToYocto(config.newAccountNear as `${number}`),
  });
  await parent.callFunction({
    contractId: config.usdc,
    methodName: "storage_deposit",
    args: { account_id: accountId, registration_only: true },
    deposit: nearToYocto("0.00125"),
    gas: teraToGas(30),
  });
  const company = await parent.callFunction<Company>({
    contractId: config.contract,
    methodName: "register_company",
    args: { account_id: accountId, legal_name: input.legalName, country: input.country },
    gas: teraToGas(30),
  });
  return { company: await withFormation(company), txHash: created.transaction.hash };
}

export async function attestInvoice(
  id: string,
  status: InvoiceStatus,
  extra: { deposit_address?: string; settle_tx?: string; payment?: Payment } = {},
): Promise<Invoice> {
  return operator().callFunction<Invoice>({
    contractId: config.contract,
    methodName: "attest_invoice",
    args: {
      id,
      status,
      deposit_address: extra.deposit_address ?? null,
      settle_tx: extra.settle_tx ?? null,
      payment: extra.payment ?? null,
    },
    gas: teraToGas(30),
  });
}
