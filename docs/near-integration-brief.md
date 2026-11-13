# NEAR Integration Brief

Verified 2026-11-12 against live docs, npm, crates.io, the 1Click OpenAPI spec and read-only RPC/API calls.
No transactions were created or signed. Anything not confirmed is marked **UNVERIFIED**.

Sources: `https://docs.near-intents.org/llms.txt`, `https://docs.near.org/llms.txt`, `https://docs.near.ai/llms.txt`,
`https://1click.chaindefuser.com/docs/v0/openapi.yaml`, `https://nearhackathon.com/HACKATHON.md`.

## 0. Versions and decisions

| Thing | Pick | Version (checked 2026-11-12) | Why |
| --- | --- | --- | --- |
| Contract SDK | `near-sdk` (Rust) | 5.30.1 | docs.near.org calls near-sdk-rs "NEAR's only official smart-contract SDK"; `near/near-sdk-js` repo is **archived** (npm 2.0.0, last publish 2024-06) |
| Build tool | `cargo-near` | 0.23.0 | `cargo near new`, `cargo near build non-reproducible-wasm` |
| Standards crate | `near-contract-standards` | 5.30.1 | NEP-141 traits/resolver |
| Scaffold | `create-near-app` | 10.0.0 | `--contract --template auction-adv` = FT (NEP-141) escrow-like starter |
| CLI | `near-cli-rs` (`near` binary) | 0.31.1 | used in all docs examples |
| JS client / relayer | `near-api-js` | 7.5.3 | docs require >= 7.4 for meta-tx; `@near-js/*` 2.5.1 last published 2025-11, docs no longer use them |
| Borsh | `borsh` | 2.x | required by the relayer example |
| Alt JS client | `near-kit` | 0.20.2 | also documented; optional |
| Wallet login | `@hot-labs/near-connect` | - | `@near-wallet-selector/*` is deprecated per docs |
| 1Click SDK | `@defuse-protocol/one-click-sdk-typescript` | 0.1.26 | official; plain `fetch` works too |
| LLM client | `openai` | 7.55.0 | NEAR AI Cloud is OpenAI-compatible |
| Node | >= 22.22.2 | - | docs.near.org requirement |

Local machine: `cargo`, `rustc`, `wasm32-unknown-unknown` installed; `near` and `cargo-near` NOT installed.

## 1. NEAR Intents 1Click API (mainnet only)

**No testnet exists or is planned** (Intents docs + HACKATHON.md Q-007). Use mainnet, separate dev accounts, tiny amounts, and `dry: true` quotes.

Base URL: `https://1click.chaindefuser.com`

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v0/tokens` | none | list assets (`assetId`, `decimals`, `blockchain`, `symbol`, `price`, `contractAddress`) |
| POST | `/v0/quote` | optional JWT | quote; returns `depositAddress` unless `dry: true` |
| POST | `/v0/deposit/submit` | optional | `{ depositAddress, txHash }` to speed up detection (optional) |
| GET | `/v0/status?depositAddress=...&depositMemo=...` | optional | poll status (`depositMemo` only if quote returned one) |

### Auth and fees
- JWT from `https://partners.near-intents.org`. Send as `X-API-Key: <jwt>` or `Authorization: Bearer <jwt>`.
- Docs (fees page): without key, **extra 0.25% (25 bps)** on every non-`ANY_INPUT` quote. With key: 20 bps normally, **1 bp for stablecoin pairs (USDC/USDT/DAI) and same-asset multichain routes**. Protocol fee 0.0001% always.
- HACKATHON.md Q-006 says "Without it, 0.2% fee" - conflicts with the docs' 0.25%.
- Observed (unauthenticated dry quote Arbitrum USDC -> NEAR USDC, 5 USDC): server injected `appFees: [{fee: 1}]`, `amountOut` 4.99899. So for USDC->USDC the effective unauthenticated fee looked ~1 bp, not 25. **UNVERIFIED as policy**; get a JWT anyway.
- Optional own fee: `appFees: [{ recipient: "ourapp.near", fee: 50 }]` (bps).

### USDC asset IDs (from live `/v0/tokens`, 229 tokens)

| Chain | assetId | decimals |
| --- | --- | --- |
| NEAR (native Circle USDC) | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | 6 |
| Ethereum | `nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near` | 6 |
| Arbitrum | `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` | 6 |
| Base | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | 6 |
| Solana | `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near` | 6 |

Always resolve at runtime from `/v0/tokens`; do not hardcode beyond the NEAR USDC id.

### Quote request (`QuoteRequest`)
Required: `dry, swapType, slippageTolerance, originAsset, depositType, destinationAsset, amount, refundTo, refundType, recipient, recipientType, deadline`.

| Field | Values / notes |
| --- | --- |
| `dry` | `true` = validate + price only; response omits `depositAddress`, `deadline`, `timeWhenInactive` |
| `swapType` | `EXACT_INPUT`, `EXACT_OUTPUT`, `FLEX_INPUT`, `ANY_INPUT` (partners only) |
| `slippageTolerance` | basis points (100 = 1%) |
| `depositType` | `ORIGIN_CHAIN`, `INTENTS`, `CONFIDENTIAL_INTENTS` |
| `amount` | string, smallest unit (USDC = 6 decimals) |
| `recipient` / `recipientType` | address; `DESTINATION_CHAIN`, `INTENTS`, `CONFIDENTIAL_INTENTS` |
| `refundTo` / `refundType` | address on origin chain; `ORIGIN_CHAIN`, `INTENTS`, `CONFIDENTIAL_INTENTS` |
| `deadline` | ISO date-time; when refund begins if not completed. Must exceed deposit mining time (BTC ~1h) |
| optional | `appFees`, `referral`, `quoteWaitingTimeMs` (default 0), `confidentiality` (`public` default), `depositMode` (`SIMPLE`/`MEMO`), `customRecipientMsg` (see below) |

**Invoice fit: use `EXACT_OUTPUT`** - `amount` is the USDC the founder must receive; response gives `amountIn` (send this, slippage buffer included) and `minAmountIn`. Deposit below `minAmountIn` is refunded by `deadline`; excess above `amountIn` is refunded to `refundTo`.

`refundTo` must be a valid address on the payer's origin chain (`0x000...dEaD` was rejected: `"refundTo is not valid"`), so the pay page must ask the payer for their refund address.

`customRecipientMsg` (**HIGHLY EXPERIMENTAL** per spec): 1Click withdraws to NEAR via `ft_transfer_call(msg)` instead of `ft_transfer`. Funds are lost if recipient lacks `storage_deposit` or does not implement `ft_on_transfer`. Could route invoice payments straight into our contract; not recommended for the demo.

### Quote response (`QuoteResponse`)
Top level: `correlationId, timestamp, signature, quoteRequest, quote`.
`quote`: `depositAddress`, `depositMemo?`, `amountIn`, `amountInFormatted`, `amountInUsd`, `minAmountIn`, `amountOut`, `amountOutFormatted`, `amountOutUsd`, `minAmountOut`, `deadline`, `timeWhenInactive`, `timeEstimate` (s), `refundFee`, `withdrawFee`.
Signatures can be checked with `verifyQuoteSignature` exported by the TS SDK.

### Status (`GetExecutionStatusResponse`)
Fields: `correlationId, quoteResponse, status, updatedAt, swapDetails`.

| status | meaning |
| --- | --- |
| `PENDING_DEPOSIT` | waiting for deposit |
| `KNOWN_DEPOSIT_TX` | deposit tx detected |
| `PROCESSING` | executing |
| `SUCCESS` | delivered to recipient |
| `INCOMPLETE_DEPOSIT` | below required amount |
| `REFUNDED` | failed, returned to `refundTo` |
| `FAILED` | error |

404 = unknown deposit address. Docs say allow up to 15 min cross-chain. Explorer: `https://explorer.near-intents.org`.

### Invoice quote (verified shape with `dry: true`)
```ts
const ONECLICK = "https://1click.chaindefuser.com";
const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export async function invoiceQuote(p: {
  originAsset: string; usdcAmount: bigint; founderAccount: string; payerRefund: string; dry: boolean;
}) {
  const res = await fetch(`${ONECLICK}/v0/quote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.ONECLICK_JWT ? { "X-API-Key": process.env.ONECLICK_JWT } : {}),
    },
    body: JSON.stringify({
      dry: p.dry,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: p.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: NEAR_USDC,
      amount: p.usdcAmount.toString(),
      recipient: p.founderAccount,
      recipientType: "DESTINATION_CHAIN",
      refundTo: p.payerRefund,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  });
  if (!res.ok) throw new Error(JSON.stringify(await res.json()));
  return res.json();
}
```
Observed: dry quote Arbitrum USDC -> NEAR USDC (both swap types) returned 200 in this shape. The same request with Base USDC origin returned `500 Internal server error` once - **UNVERIFIED** whether transient.

Swap limits: only BNB Chain ($1,000) and Tron-origin ($100) have minimums; NEAR, Base, Arbitrum, Ethereum, Solana have none. A bridge can still reject with `Amount is too low for bridge, try at least ...`.

SDK equivalent: `OpenAPI.BASE`, `OpenAPI.TOKEN`, `OneClickService.getTokens/getQuote/getExecutionStatus/submitDepositTx` (exports verified in 0.1.26).

**UNVERIFIED:** whether 1Click performs USDC `storage_deposit` for a never-registered NEAR recipient. Pre-register each founder account on the USDC contract (section 3) to be safe.

## 2. Meta transactions / gasless relayer (NEP-366)

Docs: `https://docs.near.org/web3-apps/tutorials/meta-transactions`. Requires `near-api-js` >= 7.4 and `borsh` 2.
Flow: client signs a `SignedDelegate` (sender, receiver, actions, nonce, maxBlockHeight) -> base64(borsh) -> POST `/relay` -> relayer wraps it in its own tx and pays gas.

Key protocol facts (docs.near.org/protocol/transactions/meta-tx):
- Inner actions run with the **user as `predecessor_account_id`**; `signer_account_id` is the relayer. Our contract must use `env::predecessor_account_id()`.
- **CORRECTED 2026-11-12:** attached deposits of inner actions are taken from the **relayer**, not the user ("If an inner action requires an attached balance ... then this balance is taken from the relayer", https://docs.near.org/protocol/transactions/meta-tx). Refunds of a failed inner action go to the user. So the relayer must cap every deposit it sponsors; opencash allows only exactly 1 yoctoNEAR per USDC `ft_transfer`, at most 20 per delegate.
- User account must already exist (nonce lives on its access key) and cover its storage. Sign with a regular access key (`DelegateV2`/gas-key delegates removed in protocol 87).
- A delegate has a single `receiverId`. Paying the escrow is `ft_transfer_call` on the **USDC contract**, not on our contract. A relayer that only allows `receiverId == CONTRACT_ID` will **not** sponsor the fee deposit; allow USDC `ft_transfer_call` only when `args.receiver_id == CONTRACT_ID`.

### Client (verified exports in near-api-js 7.5.3)
```ts
import { Account, JsonRpcProvider, actions, encodeSignedDelegate, teraToGas, type KeyPairString } from "near-api-js";

const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const founder = new Account(founderId, provider, founderKey as KeyPairString);
const { signedDelegate } = await founder.createSignedMetaTransaction({
  receiverId: CONTRACT_ID,
  actions: [actions.functionCall("register_entity", { business: founderId, deadline_ns: "..." }, teraToGas(30), 0n)],
  blockHeightTtl: 120,
});
await fetch(`${RELAYER_URL}/relay`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") }),
});
```
In a browser wallet flow the wallet must support delegate-action signing (NEP-413 message signing is not a substitute). Simplest for the demo: generate the founder key in the browser, keep it there, sign delegates locally.

### Relayer with allowlist (docs example + docs "Gating the relayer" pattern)
```ts
import express from "express";
import { deserialize } from "borsh";
import { Account, JsonRpcProvider, MultiKeySigner, SCHEMA, type KeyPairString, type SignedDelegate } from "near-api-js";

const provider = new JsonRpcProvider({ url: process.env.RPC_URL ?? "https://test.rpc.fastnear.com" });
const signer = MultiKeySigner.fromSecretKeys(JSON.parse(process.env.RELAYER_PRIVATE_KEYS!) as KeyPairString[]);
const relayer = new Account(process.env.RELAYER_ID!, provider, signer);
const CONTRACT_ID = process.env.CONTRACT_ID!;
const USDC_ID = process.env.USDC_ID!;
const PARENT = process.env.PARENT_ACCOUNT!;
const CONTRACT_METHODS = new Set(["register_entity", "refund"]);
const MAX_GAS = 100_000_000_000_000n;

function sponsored(d: SignedDelegate["delegateAction"]): boolean {
  if (!d.senderId.endsWith(`.${PARENT}`)) return false;
  return d.actions.every((a) => {
    const fc = a.functionCall;
    if (!fc || fc.gas > MAX_GAS) return false;
    if (d.receiverId === CONTRACT_ID) return CONTRACT_METHODS.has(fc.methodName) && fc.deposit === 0n;
    if (d.receiverId === USDC_ID && fc.methodName === "ft_transfer_call" && fc.deposit === 1n) {
      return JSON.parse(Buffer.from(fc.args).toString("utf8")).receiver_id === CONTRACT_ID;
    }
    return false;
  });
}

const app = express();
app.use(express.json());
app.post("/relay", async (req, res) => {
  try {
    const sd = deserialize(SCHEMA.SignedDelegate, Buffer.from(req.body.signedDelegate, "base64")) as unknown as SignedDelegate;
    if (!sponsored(sd.delegateAction)) return res.status(403).json({ error: "This call is not sponsored" });
    res.json(await relayer.relayMetaTransaction(sd));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
app.listen(Number(process.env.PORT ?? 3000), "127.0.0.1");
```
`FunctionCall` fields (`methodName`, `args: Uint8Array`, `gas: bigint`, `deposit: bigint`) and `DelegateAction` fields (`senderId`, `receiverId`, `actions`, `nonce`, `maxBlockHeight`, `publicKey`) checked in the 7.5.3 type definitions. The allowlist code itself has not been run.
Relayer keys must be **full-access** keys on the relayer account; multiple keys reduce nonce collisions. Add rate limiting per `senderId`.
Reference Rust relayer: `https://github.com/near/pagoda-relayer-rs` (not archived, last push 2025-02; allowlists/allowances built in). Overkill for the hackathon - use the TS one above.

## 3. Creating accounts

Rules (account-id docs): accounts create only **direct** sub-accounts of themselves; parent has **no control** after creation; `testnet`/`near` top-level contracts expose `create_account`.

**From our parent account (recommended: backend holds `ourapp.testnet` key):**
```ts
import { Account, JsonRpcProvider, nearToYocto, type KeyPairString } from "near-api-js";
const parent = new Account("ourapp.testnet", provider, process.env.PARENT_PRIVATE_KEY as KeyPairString);
await parent.createSubAccount({
  accountOrPrefix: "acme",
  publicKey: founderPublicKey,
  nearToTransfer: nearToYocto("0.01"),
});
```
Then pre-register for USDC (paid by our backend, a normal tx, not a meta-tx): `storage_deposit { account_id: "acme.ourapp.testnet" }` with 0.00125 NEAR on the USDC contract.
Docs examples use `nearToTransfer: nearToYocto("0")`; we fund 0.01 so the founder can attach the 1 yocto that `ft_transfer_call` needs.

**From a contract (Rust):** `Promise::new(format!("{prefix}.{}", env::current_account_id()).parse().unwrap()).create_account().transfer(NearToken::from_millinear(1))` plus `.add_full_access_key(pk)` - without a key or contract the new account is **locked**. Account creation costs a fixed 0.007 NEAR in gas. If the registry contract itself lives at `ourapp.testnet`, it can create `acme.ourapp.testnet` atomically in `register_entity`; then the founder's very first call cannot be a meta-tx from that account (it does not exist yet) - have the backend call it.

**Top-level named account:** `parent.createAccount({ newAccountId: "x.testnet", publicKey, nearToTransfer })` or `callFunction({ contractId: "testnet", methodName: "create_account", args: { new_account_id, new_public_key } })`.

**Testnet faucet (CLI, for our own dev accounts):**
```bash
near account create-account sponsor-by-faucet-service ourapp.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
# or: near create-account ourapp.testnet --useFaucet --networkId testnet
```
Faucets: docs.near.org built-in (NEAR only), `https://near-faucet.io` (NEAR + FTs). **Testnet USDC: Circle faucet `https://faucet.circle.com`, 20 USDC on NEAR testnet every 2 hours.**

Implicit accounts: 64-hex id from an ed25519 key; created by any transfer (0 NEAR works).

## 4. Contract: write, build, deploy

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
npx create-near-app@latest contract --contract --template auction-adv
cargo test
cargo near build non-reproducible-wasm
near contract deploy ourapp.testnet use-file ./target/near/<name>.wasm \
  with-init-call new json-args '{"usdc":"3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af","operator":"ops.ourapp.testnet"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```
`--contract ts` is no longer supported by create-near-app; contracts are Rust only.

### USDC contract IDs (Circle docs, both confirmed by `ft_metadata` RPC view returning `symbol: "USDC"`)
| Network | Account |
| --- | --- |
| mainnet | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| testnet | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` |
Avoid other testnet "USDC" tokens (`usdc.fakes.testnet`, orderly ones) - not Circle's.

### NEP-141 receive pattern
Founder calls on the **USDC contract**: `ft_transfer_call { receiver_id: CONTRACT_ID, amount, msg }` with **exactly 1 yoctoNEAR** attached. USDC calls our `ft_on_transfer(sender_id, amount, msg) -> U128` where return value = **unused** amount (refunded by the token). Security rules from docs: check `predecessor_account_id == USDC`, return full `amount` for anything unexpected, never panic for business rejections. Our contract must itself be `storage_deposit`-registered on USDC to hold tokens. Payouts use `ft_transfer` with 1 yocto and the recipient must be registered.

Escrow skeleton - compiles with `cargo check --target wasm32-unknown-unknown` on near-sdk 5.30.1 (not deployed or tested):
```rust
use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq)]
pub enum Status { Draft, Filed, Ein, Active, Refunded }

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Entity { pub founder: AccountId, pub status: Status, pub escrowed: U128, pub released: U128, pub deadline_ns: u64 }

#[ext_contract(ext_ft)]
pub trait Ft { fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>); }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract { usdc: AccountId, operator: AccountId, entities: IterableMap<AccountId, Entity> }

#[near]
impl Contract {
    #[init]
    pub fn new(usdc: AccountId, operator: AccountId) -> Self {
        Self { usdc, operator, entities: IterableMap::new(b"e") }
    }

    pub fn register_entity(&mut self, business: AccountId, deadline_ns: u64) {
        let founder = env::predecessor_account_id();
        require!(self.entities.get(&business).is_none(), "exists");
        self.entities.insert(business, Entity { founder, status: Status::Draft, escrowed: U128(0), released: U128(0), deadline_ns });
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.usdc { return PromiseOrValue::Value(amount); }
        let business: AccountId = match msg.parse() { Ok(a) => a, Err(_) => return PromiseOrValue::Value(amount) };
        match self.entities.get_mut(&business) {
            Some(e) if e.founder == sender_id && e.status == Status::Draft => {
                e.escrowed = U128(e.escrowed.0 + amount.0);
                PromiseOrValue::Value(U128(0))
            }
            _ => PromiseOrValue::Value(amount),
        }
    }

    pub fn release_milestone(&mut self, business: AccountId, next: Status, amount: U128, to: AccountId) -> Promise {
        require!(env::predecessor_account_id() == self.operator, "operator only");
        let e = self.entities.get_mut(&business).expect("unknown entity");
        require!(e.escrowed.0 - e.released.0 >= amount.0, "insufficient escrow");
        e.released = U128(e.released.0 + amount.0);
        e.status = next;
        ext_ft::ext(self.usdc.clone()).with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(15)).ft_transfer(to, amount, None)
    }

    pub fn refund(&mut self, business: AccountId) -> Promise {
        let e = self.entities.get_mut(&business).expect("unknown entity");
        require!(env::predecessor_account_id() == e.founder, "founder only");
        require!(env::block_timestamp() > e.deadline_ns && e.status != Status::Active, "not refundable");
        let left = e.escrowed.0 - e.released.0;
        e.released = e.escrowed;
        e.status = Status::Refunded;
        ext_ft::ext(self.usdc.clone()).with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(15)).ft_transfer(e.founder.clone(), U128(left), None)
    }

    pub fn get_entity(&self, business: AccountId) -> Option<Entity> { self.entities.get(&business).cloned() }
}
```
Before shipping: add a `#[private]` callback on `ft_transfer` that restores `released`/`status` on failure (docs: "Callbacks can fail", "Balance Deduction"), enforce forward-only status transitions, and require storage payment in `register_entity` (storage-cost attack). `refund` and `release_milestone` use 1 yocto only on the outbound call - they need no user deposit, so they are relayable.
Methods that require 1 yocto from the caller (`#[payable]` + `assert_one_yocto`) can still be relayed; per the corrected note in section 2, the relayer pays that yocto.

## 5. NEAR AI Cloud

- Base URL: **`https://cloud-api.near.ai/v1`** (OpenAI-compatible). Auth: `Authorization: Bearer <NEAR_AI_API_KEY>`.
- Key: sign up at `https://cloud.near.ai`, buy credits, create key. Or $10 hackathon credits via `https://nearbuilders.org/join` -> dashboard; that is a **separate key** whose balance does not show in cloud.near.ai.
- Endpoints: `POST /v1/chat/completions`, `POST /v1/completions`, `GET /v1/models` (public; returns pricing, `context_length`, `supported_features` like `tools`/`structured_outputs`/`reasoning`). Also Responses API, embeddings, rerank, images, audio.
- Privacy tiers: **Confidential TEE** (NEAR's own GPUs, attestable), **3P Confidential TEE**, **Incognito** (OpenAI/Anthropic/Google via a TEE gateway; model runs outside TEE).
- Live `/v1/models` lists 63 models. Models carrying a `datacenters` field (inferred NEAR-hosted, **UNVERIFIED** tier mapping - check `https://near.ai/models`): `Qwen/Qwen3.6-35B-A3B-FP8`, `Qwen/Qwen3.8-27B`, `Qwen/Qwen3-VL-30B-A3B-Instruct`, `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated`, plus embedding/reranker/whisper/FLUX. Others include `deepseek/deepseek-v4.1-flash`, `z-ai/glm-5.3`, `moonshotai/kimi-k3`, `openai/gpt-5.5`, `anthropic/claude-sonnet-5-5`, `google/gemini-3.5-flash`.
- The quickstart example model `zai-org/GLM-5.1-FP8` is **not** in the live `/v1/models` list - always pick from `/v1/models`.
- Attestation: `GET /v1/attestation/report?model=<id>&provider=near&signing_algo=ecdsa&nonce=<64 hex>&include_tls_fingerprint=false` with header `x-no-aliasing: true` (API key optional). Response has gateway evidence + `model_attestations[]`. Per-reply signature: `GET /v1/signature/{chat_id}?signing_algo=ecdsa`. Intel Trust Authority token endpoint also exists (see API reference). Official verifying SDKs for JS/Python/Rust/Go at `https://docs.near.ai/cloud/inference-sdk/javascript`.

```ts
import OpenAI from "openai";
const ai = new OpenAI({ baseURL: "https://cloud-api.near.ai/v1", apiKey: process.env.NEAR_AI_API_KEY });
const r = await ai.chat.completions.create({
  model: "Qwen/Qwen3.8-27B",
  messages: [{ role: "system", content: "Recommend Wyoming LLC or Delaware C-corp for a non-US founder. Return JSON." },
             { role: "user", content: founderAnswers }],
});
```
The model id and that it supports JSON/`structured_outputs` are **UNVERIFIED** - check `supported_features` in `/v1/models`. No completion was run (no key available).

## 6. Hackathon rules (HACKATHON.md) and agent skills

- Deadline **2026-11-14T23:59:00Z**; repo must be public by then. Track id: `realworld` (hints: STABLECOINS, NEAR INTENTS, META TRANSACTIONS). Could also fit `business`.
- One submission per project via `POST https://nearhackathon.com/api/applications` (fields: `requestId` UUID, `projectName`, `leadName`, `email`, `size`, `tracks`, `nearAddress` (mainnet), `projectUrl`, `demoUrl` (X post), `idea`, `consent`). Never add `website` (spam trap). Payload must be confirmed by the human first; 409 = already submitted, fix via `/request-changes`.
- Human must confirm: submission, X post, making repo public/pushing, **signing transactions / spending tokens / deploying to mainnet**, never commit secrets.
- Testnet-only projects are eligible; mainnet only where integration is mainnet-only (Intents). Local demo OK with video; hosted demo is a plus (keep up through 2026-11-18, ideally 11-25). Add a LICENSE file. README written for AI screening (Claude Code/Codex) with "do X, see Y" steps; disclose pre-hackathon code/libs.
- Agent skills (from 00-setup.md): `npx skills add near/agent-skills` (single: `--skill near-intents`). Repo `near/agent-skills` currently has: `near-ai-cloud`, `near-api-js`, `near-cli-rs`, `near-contract-audit`, `near-dapp`, `near-intents`, `near-kit`, `near-smart-contracts` (00-setup.md lists six; repo now also has `near-cli-rs`, `near-contract-audit`).
- Intents examples repo: `https://github.com/near-examples/near-intents-examples` (active).

## 7. Blockers and open design points

1. **Network split.** Registry/escrow/relayer on testnet, but 1Click settles only to **mainnet** accounts (USDC `17208628...`). `acme.ourapp.testnet` cannot receive invoice payments. Options: (a) mirror founder accounts on mainnet (`acme.ourapp.near`) for invoices; (b) demo invoices with `dry: true` + one tiny live swap to a mainnet dev account. Any mainnet deploy/spend needs the human's explicit OK.
2. **Relayer scope.** "Only calls to our contract" does not cover the USDC `ft_transfer_call` fee deposit; allowlist it as shown in section 2.
3. **Deposits in relayed calls (corrected):** the relayer pays them, so the allowlist caps them at 1 yoctoNEAR per USDC transfer.
4. **Storage registration.** Contract and every founder account need USDC `storage_deposit` (0.00125 NEAR). Whether 1Click auto-registers recipients is **UNVERIFIED**.
5. **1Click fee without JWT** - docs (0.25%) vs HACKATHON.md (0.2%) vs observed (~1 bp on USDC->USDC). Register at partners.near-intents.org.
6. **Tooling.** Install `near-cli-rs` and `cargo-near` (not present locally). Mainnet USDC testing requires real funds.
