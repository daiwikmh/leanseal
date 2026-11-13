import type { Company, Invoice, InvoiceStatus, Jurisdiction } from "./company.js";
import type { Intake } from "./intake.js";
import type { Agreement, AgreementKind, StoredDocument } from "./agreements.js";
import type { Payee, Payout, PayoutRequest } from "./payouts.js";

export type Advice = { jurisdiction: Jurisdiction; reason: string; filings: string[]; model: string };
export type PayToken = { assetId: string; symbol: string; blockchain: string; decimals: number };
export type PayQuote = {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  symbol: string;
  blockchain: string;
  deadline: string;
};
export type PayStatus = { invoice: Invoice; intents: string | null; originTx: string | null; settleTx: string | null };
export type PaymentLink = { id: string; company: string; title: string; description: string; amount: string | null; active: boolean; created_at: string; url: string };
export type ApiKey = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null };
export type Webhook = { id: string; url: string; created_at: string; recent: { event_type: string; status: string; attempts: number; last_status_code: number | null; created_at: string }[] | null };
export type AgentView = {
  id: string;
  name: string;
  account_id: string;
  status: "creating" | "active" | "frozen";
  per_tx_cap: string;
  daily_cap: string;
  spent_24h: string;
  allowlist: string[];
  api_key_prefix: string | null;
  balance: string | null;
  created_at: string;
};
export type AgentPayment = { id: string; kind: string; recipient: string; amount: string; resource: string | null; status: string; tx_hash: string | null; error: string | null; created_at: string };
export type X402Settlement = { payer: string; amount: string; transaction: string; resource: string | null; created_at: string };
export type SignedRequest = { account_id: string; public_key: string; signed_at: number; signature: string };
export type StoredApplication = { intake: Intake; application_hash: string; updated_at: string };
export type PublicInvoice = Invoice & { legal_name: string; jurisdiction: Jurisdiction | null };

export function createApi(base: string) {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${base}/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
    return body as T;
  }

  const post = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

  return {
    advise: (input: { country: string; plan: string; company: string }) => post<Advice>("/advisor", input),
    createCompany: (input: { handle: string; legalName: string; country: string; publicKey: string }) =>
      post<{ company: Company; txHash: string }>("/companies", input),
    company: (account: string) => call<Company>(`/companies/${account}`),
    balance: (account: string) => call<{ usdc: string }>(`/companies/${account}/balance`),
    invoices: (account: string) => call<Invoice[]>(`/companies/${account}/invoices`),
    relay: (signedDelegate: string) => post<{ txHash: string; result: unknown }>("/relay", { signedDelegate }),
    invoice: (id: string) => call<PublicInvoice>(`/invoices/${encodeURIComponent(id)}`),
    tokens: () => call<PayToken[]>("/tokens"),
    quote: (id: string, input: { originAsset: string; refundTo: string }) =>
      post<PayQuote>(`/invoices/${encodeURIComponent(id)}/quote`, input),
    settled: (id: string, body: { tx_hash: string; payer: string }) => post<Invoice>(`/invoices/${encodeURIComponent(id)}/settled`, body),
    status: (id: string) => call<PayStatus>(`/invoices/${encodeURIComponent(id)}/status`),
    quotePayouts: (auth: string, body: { items: PayoutRequest[]; label?: string }) =>
      call<{ batch_id: string | null; payouts: Payout[] }>("/payouts/quote", { method: "POST", body: JSON.stringify(body), headers: { "X-Near-Auth": auth } }),
    payouts: (auth: string) => call<Payout[]>("/payouts", { headers: { "X-Near-Auth": auth } }),
    payees: (auth: string) => call<Payee[]>("/payees", { headers: { "X-Near-Auth": auth } }),
    savePayee: (auth: string, payee: Omit<Payee, "id">) => call<Payee>("/payees", { method: "POST", body: JSON.stringify(payee), headers: { "X-Near-Auth": auth } }),
    deletePayee: (auth: string, id: string) => call<{ ok: boolean }>(`/payees/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-Near-Auth": auth } }),
    links: (auth: string) => call<PaymentLink[]>("/links", { headers: { "X-Near-Auth": auth } }),
    createLink: (auth: string, body: { title: string; description?: string; amount?: string | null }) =>
      call<PaymentLink>("/links", { method: "POST", body: JSON.stringify(body), headers: { "X-Near-Auth": auth } }),
    setLinkActive: (auth: string, id: string, active: boolean) =>
      call<PaymentLink>(`/links/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ active }), headers: { "X-Near-Auth": auth } }),
    publicLink: (id: string) => call<PaymentLink & { legal_name: string }>(`/public/links/${encodeURIComponent(id)}`),
    payLink: (id: string, body: { payer_name?: string; amount?: string }) => post<{ invoice_id: string; pay_url: string }>(`/public/links/${encodeURIComponent(id)}/pay`, body),
    apiKeys: (auth: string) => call<ApiKey[]>("/developer/keys", { headers: { "X-Near-Auth": auth } }),
    createApiKey: (auth: string, name: string) => call<ApiKey & { key: string }>("/developer/keys", { method: "POST", body: JSON.stringify({ name }), headers: { "X-Near-Auth": auth } }),
    revokeApiKey: (auth: string, id: string) => call<{ ok: boolean }>(`/developer/keys/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-Near-Auth": auth } }),
    webhooks: (auth: string) => call<Webhook[]>("/developer/webhooks", { headers: { "X-Near-Auth": auth } }),
    createWebhook: (auth: string, url: string) => call<Webhook & { secret: string }>("/developer/webhooks", { method: "POST", body: JSON.stringify({ url }), headers: { "X-Near-Auth": auth } }),
    deleteWebhook: (auth: string, id: string) => call<{ ok: boolean }>(`/developer/webhooks/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-Near-Auth": auth } }),
    testWebhook: (auth: string) => call<{ ok: boolean }>("/developer/webhooks/test", { method: "POST", body: "{}", headers: { "X-Near-Auth": auth } }),
    chatInfo: () => call<{ telegram: string | null; xmtp: string | null }>("/chat/info"),
    chatCode: (code: string) => call<{ platform: string; label: string }>(`/chat/code/${encodeURIComponent(code)}`),
    chatLinks: (auth: string) => call<{ platform: string; chat_user_id: string; label: string; linked_at: string }[]>("/chat/links", { headers: { "X-Near-Auth": auth } }),
    unlinkChat: (auth: string, platform: string, id: string) =>
      call<{ ok: boolean }>(`/chat/links/${platform}/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-Near-Auth": auth } }),
    linkChat: (auth: string, code: string) =>
      call<{ account: string; platform: string }>("/chat/link", { method: "POST", body: JSON.stringify({ code }), headers: { "X-Near-Auth": auth } }),
    agents: (auth: string) => call<AgentView[]>("/agents", { headers: { "X-Near-Auth": auth } }),
    createAgent: (auth: string, body: { name: string; per_tx_cap: string; daily_cap: string; allowlist: string[] }) =>
      call<{ agent: AgentView; public_key: string }>("/agents", { method: "POST", body: JSON.stringify(body), headers: { "X-Near-Auth": auth } }),
    updateAgent: (auth: string, id: string, body: { per_tx_cap?: string; daily_cap?: string; allowlist?: string[]; frozen?: boolean }) =>
      call<AgentView>(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "X-Near-Auth": auth } }),
    agentKey: (auth: string, id: string) => call<{ key: string }>(`/agents/${id}/key`, { method: "POST", body: "{}", headers: { "X-Near-Auth": auth } }),
    sweepAgent: (auth: string, id: string) => call<{ amount: string; tx_hash: string }>(`/agents/${id}/sweep`, { method: "POST", body: "{}", headers: { "X-Near-Auth": auth } }),
    x402Settlements: (auth: string) => call<X402Settlement[]>("/x402/settlements", { headers: { "X-Near-Auth": auth } }),
    agentPayments: (auth: string, id: string) => call<AgentPayment[]>(`/agents/${id}/payments`, { headers: { "X-Near-Auth": auth } }),
    agreements: (auth: string, account: string, asParty = false) =>
      call<Agreement[]>(`/agreements?account=${encodeURIComponent(account)}${asParty ? "&as_party=1" : ""}`, { headers: { "X-Near-Auth": auth } }),
    createAgreement: (auth: string, body: { kind: AgreementKind; title: string; doc_hash: string; parties: string[]; invoice_id?: string | null }) =>
      call<Agreement>("/agreements", { method: "POST", body: JSON.stringify(body), headers: { "X-Near-Auth": auth } }),
    signAgreement: (auth: string, id: string) => call<Agreement>(`/agreements/${encodeURIComponent(id)}/sign`, { method: "POST", body: "{}", headers: { "X-Near-Auth": auth } }),
    voidAgreement: (auth: string, id: string) => call<Agreement>(`/agreements/${encodeURIComponent(id)}/void`, { method: "POST", body: "{}", headers: { "X-Near-Auth": auth } }),
    agreement: (id: string) => call<Agreement>(`/agreements/${encodeURIComponent(id)}`),
    uploadDocument: (auth: string, body: { title: string; mime: string; content_base64: string }) =>
      call<{ doc_hash: string; title: string }>("/documents", { method: "POST", body: JSON.stringify(body), headers: { "X-Near-Auth": auth } }),
    generateDocument: (auth: string, body: { kind: AgreementKind; parties: string[]; invoice_id?: string; terms?: string }) =>
      call<{ doc_hash: string; title: string }>("/documents/generate", { method: "POST", body: JSON.stringify(body), headers: { "X-Near-Auth": auth } }),
    document: (auth: string, docHash: string, agreementId: string) =>
      call<StoredDocument>(`/documents/${encodeURIComponent(docHash)}?agreement=${encodeURIComponent(agreementId)}`, { headers: { "X-Near-Auth": auth } }),
    submitApplication: (body: SignedRequest & { intake: Intake }) => post<{ application_hash: string; company: Company }>("/applications", body),
    readApplication: (r: SignedRequest) =>
      call<StoredApplication>(
        `/applications/${encodeURIComponent(r.account_id)}?${new URLSearchParams({ public_key: r.public_key, signed_at: String(r.signed_at), signature: r.signature })}`,
      ),
  };
}

export type Api = ReturnType<typeof createApi>;

export const statusLabel: Record<InvoiceStatus, string> = {
  open: "Waiting",
  pending: "Payment in flight",
  paid: "Paid",
  refunded: "Refunded",
};
