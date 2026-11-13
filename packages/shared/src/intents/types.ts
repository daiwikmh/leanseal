export type IntentsToken = {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price: number;
  contractAddress: string | null;
};

export type DepositStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export type QuoteParams = {
  swapType?: "EXACT_INPUT" | "EXACT_OUTPUT";
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
  slippageBps?: number;
  deadlineMs?: number;
  dry?: boolean;
  appFees?: { recipient: string; fee: number }[];
};

export type Quote = {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  timeEstimate: number;
  depositAddress?: string;
  depositMemo?: string;
  deadline?: string;
};

export type QuoteResponse = {
  quote: Quote;
  timestamp: string;
  correlationId: string;
};

export type StatusResponse = {
  status: DepositStatus;
  updatedAt: string;
  quoteResponse?: { quoteRequest?: { originAsset?: string } };
  swapDetails?: {
    amountInFormatted?: string;
    amountInUsd?: string;
    amountOutFormatted?: string;
    refundReason?: string;
    destinationChainTxHashes?: { hash: string; explorerUrl?: string }[];
    originChainTxHashes?: { hash: string; explorerUrl?: string }[];
    refundedAmountFormatted?: string;
  };
};
