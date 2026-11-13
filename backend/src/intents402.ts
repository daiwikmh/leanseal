export type Entry = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { assetTransferMethod?: string; paymentFlow?: string; operationToken?: string; refundDeadline?: string; depositMemo?: string; [key: string]: unknown };
};
export type PaymentRequired = { x402Version: number; resource?: { url: string }; accepts: Entry[]; error?: string };
export type Receipt = { success: boolean; errorReason?: string; transaction?: string; network?: string; payer?: string; extra?: { status?: string } };

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

function decode<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function paymentRequired(response: Response): Promise<PaymentRequired | null> {
  const fromHeader = decode<PaymentRequired>(response.headers.get("payment-required"));
  if (fromHeader?.accepts) return fromHeader;
  try {
    const body = (await response.clone().json()) as PaymentRequired;
    return Array.isArray(body?.accepts) ? body : null;
  } catch {
    return null;
  }
}

export function receiptOf(response: Response): Receipt | null {
  return decode<Receipt>(response.headers.get("payment-response"));
}

export function isUsdc(asset: string, usdc: string): boolean {
  return asset === usdc || asset === `nep141:${usdc}`;
}

export function intentsEntry(required: PaymentRequired, usdc: string): Entry | null {
  return (
    required.accepts.find(
      (e) => e.scheme === "exact" && e.network === "near:mainnet" && e.extra?.assetTransferMethod === "near-intents" && e.extra?.paymentFlow === "upfront" && isUsdc(e.asset, usdc) && !e.extra?.operationToken,
    ) ?? null
  );
}

export function quotedEntry(required: PaymentRequired, unquoted: Entry): Entry | null {
  const quoted = required.accepts.find((e) => e.extra?.operationToken && e.network === unquoted.network && e.asset === unquoted.asset);
  if (!quoted || !quoted.payTo || !/^\d+$/.test(quoted.amount) || BigInt(quoted.amount) <= 0n) return null;
  return quoted;
}

export function quoteHeader(required: PaymentRequired, unquoted: Entry, refundTo: string): string {
  return encode({ x402Version: 2, resource: required.resource, accepted: unquoted, payload: { type: "quote", refundTo } });
}

export function depositHeader(resource: PaymentRequired["resource"], unquoted: Entry, quoted: Entry, txHash: string): string {
  return encode({
    x402Version: 2,
    resource,
    accepted: unquoted,
    payload: {
      type: "deposit",
      operationToken: quoted.extra!.operationToken,
      depositAddress: quoted.payTo,
      ...(quoted.extra?.depositMemo ? { depositMemo: quoted.extra.depositMemo } : {}),
      txHash,
    },
  });
}

export function hasExactNear(required: PaymentRequired): boolean {
  return required.accepts.some((e) => e.scheme === "exact" && e.network.startsWith("near:") && e.extra?.assetTransferMethod !== "near-intents");
}
