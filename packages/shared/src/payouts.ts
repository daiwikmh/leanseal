export type PayoutStatus = "quoted" | "sent" | "completed" | "refunded" | "failed" | "expired";

export type Payout = {
  id: string;
  company: string;
  batch_id: string | null;
  kind: "intents" | "direct";
  payee_name: string;
  asset_id: string;
  symbol: string;
  chain: string;
  recipient: string;
  amount_units: string;
  amount_out: string;
  deposit_address: string | null;
  deadline: string;
  status: PayoutStatus;
  transfer_tx: string | null;
  delivery_tx_url: string | null;
  refund_reason: string | null;
  created_at: string;
};

export type PayoutRequest = { payee_name: string; asset_id: string; recipient: string; amount: string };

export type Payee = { id: string; name: string; asset_id: string; recipient: string };

export const payoutStatusLabel: Record<PayoutStatus, string> = {
  quoted: "Ready to send",
  sent: "In flight",
  completed: "Delivered",
  refunded: "Refunded",
  failed: "Failed",
  expired: "Quote expired",
};

export const maxBatch = 20;
