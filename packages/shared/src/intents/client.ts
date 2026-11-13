import type { IntentsToken, QuoteParams, QuoteResponse, StatusResponse } from "./types.js";

export const oneClickUrl = "https://1click.chaindefuser.com";

export type IntentsClientConfig = {
  baseUrl?: string;
  apiKey?: string;
  fetcher?: typeof fetch;
};

export function createIntentsClient(config: IntentsClientConfig = {}) {
  const base = config.baseUrl ?? oneClickUrl;
  const fetcher = config.fetcher ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["X-API-Key"] = config.apiKey;

  async function read<T>(response: Response, label: string): Promise<T> {
    const text = await response.text();
    if (!response.ok) throw new Error(`${label} ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  return {
    async getTokens(): Promise<IntentsToken[]> {
      return read(await fetcher(`${base}/v0/tokens`, { headers }), "Intents tokens");
    },

    async requestQuote(params: QuoteParams): Promise<QuoteResponse> {
      const deadline = new Date(Date.now() + (params.deadlineMs ?? 10 * 60_000)).toISOString();
      const body = {
        dry: params.dry ?? true,
        swapType: params.swapType ?? "EXACT_INPUT",
        slippageTolerance: params.slippageBps ?? 100,
        originAsset: params.originAsset,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: params.destinationAsset,
        amount: params.amount,
        recipient: params.recipient,
        recipientType: "DESTINATION_CHAIN",
        refundTo: params.refundTo,
        refundType: "ORIGIN_CHAIN",
        deadline,
        ...(params.appFees && params.appFees.length > 0 ? { appFees: params.appFees } : {}),
      };
      return read(await fetcher(`${base}/v0/quote`, { method: "POST", headers, body: JSON.stringify(body) }), "Intents quote");
    },

    async getStatus(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
      const query = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
      return read(await fetcher(`${base}/v0/status?${query}`, { headers }), "Intents status");
    },

    async submitDeposit(depositAddress: string, txHash: string): Promise<void> {
      await read(
        await fetcher(`${base}/v0/deposit/submit`, { method: "POST", headers, body: JSON.stringify({ depositAddress, txHash }) }),
        "Intents deposit",
      );
    },
  };
}

export type IntentsClient = ReturnType<typeof createIntentsClient>;
