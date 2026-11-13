# Agent Spending Sandboxes and Dropping the Registry Contract

Researched 2026-11-12 from live docs, nearcore source, npm and read-only HTTP calls. Nothing was signed, created or registered.
Builds on `docs/near-integration-brief.md`. **UNVERIFIED** = could not confirm; the URL tried is given.

## 0. Correction to the brief

The brief (section 2) says attached deposits in a meta-transaction "come from the user's account". The current protocol docs say the opposite:
"If an inner action needs an attached balance ... this balance is taken from the relayer", and failed-action balance refunds go to the user
(https://docs.near.org/protocol/transactions/meta-tx.md, "Balance refunds in meta transactions"). NEP-366 agrees that deposits are refunded to the
user on failure (https://github.com/near/NEPs/blob/master/neps/nep-0366.md). Consequences: the relayer pays the 1 yocto for `ft_transfer`, founder
accounts do not need NEAR for it, and the relayer allowlist **must cap every `deposit`/`Transfer` amount**, or a user can drain the relayer.

## Q1. AI agent spending sandboxes

### a) Sub-account per agent (`agent1.acme.opencash.near`)

| Fact | Source |
|---|---|
| Only `acme.opencash.near` can create `agent1.acme.opencash.near` ("Accounts cannot create sub-accounts of other accounts") | https://docs.near.org/protocol/accounts-contracts/account-id.md |
| Parent has **no** control after creation: "Accounts have no control over their sub-account, they are different entities" | same |
| Control = whoever holds its access keys. Owner keeps control only by adding its own full-access key to the agent account at creation | https://docs.near.org/protocol/accounts-contracts/access-keys.md |
| Storage: 1E19 yocto/byte (1 NEAR per 100 KB); first 770 bytes free, covered by a fixed 0.007 NEAR creation fee | https://docs.near.org/protocol/storage/storage-staking.md |
| USDC needs `storage_deposit` per agent account (0.00125 NEAR, from the brief) | `docs/near-integration-brief.md` section 3 |
| Sweeping back: send a normal `Transfer` first, then `DeleteAccount`; "If the beneficiary does not exist, the remaining balance is burned"; never use DeleteAccount as a transfer | https://docs.near.org/protocol/network/token-loss.md |
| NEP-141 balances live in the token contract, keyed by account id; the page above says nothing about FTs. Inference: `ft_transfer` all USDC out (and `storage_unregister`) **before** deleting, or the USDC is stranded under a name someone could re-create. **UNVERIFIED** in docs | https://docs.near.org/protocol/network/token-loss.md |

Creating the agent account is a `CreateAccount + Transfer + AddKey` batch signed by `acme`'s passkey-derived key. It can be relayed as a
meta-transaction (full-access key, so multiple actions are allowed), but then the relayer pays the `Transfer` (section 0), so cap it.

### b) Function-call access keys

| Question | Answer | Source |
|---|---|---|
| What the allowance covers | Gas only; "It doesn't cover deposits or transfers"; cannot be changed; exhausted key is dead | https://docs.near.org/protocol/accounts-contracts/access-keys.md |
| Restrictions | One `receiver_id`; optional `method_names` list (empty = any method) | same |
| Attach a deposit? | **No.** "do not allow to attach NEAR tokens to the call"; 1 yocto "cannot be attached with a function-call key" | same; https://docs.near.org/smart-contracts/security/one_yocto |
| Protocol error | `InvalidAccessKeyError::DepositWithFunctionCall` | https://docs.rs/near-primitives/0.33.0/src/near_primitives/errors.rs.html |
| Via a meta-tx instead? | **No.** nearcore `validate_delegate_action_key`: function-call key => exactly one `FunctionCall` and `deposit > 0` is rejected with `DelegateActionAccessKeyError(DepositWithFunctionCall)`; allowance is not checked | https://github.com/near/nearcore/blob/master/runtime/runtime/src/actions.rs (fn `validate_delegate_action_key`) |

So an agent holding only a function-call key **cannot call USDC `ft_transfer` / `ft_transfer_call`** directly or via relayer. Workarounds:

| Workaround | Works? | Source |
|---|---|---|
| **Policy contract on the agent account** (agent key = function-call key with `receiver_id = agent1.acme...`, `method_names = ["pay"]`; `pay` takes no deposit, checks caps, then the contract itself calls `ft_transfer` with 1 yocto from its own balance) | Yes. Standard pattern; contract-originated calls may attach deposits | access-keys page above; brief section 4 (outbound 1 yocto from contract) |
| Same contract shared across agents as a **global contract** (`UseGlobalContract`, < 0.001 NEAR per user; publishing burns 10 NEAR per 100 KB; worthwhile at >10 accounts) | Yes, optional | https://docs.near.org/smart-contracts/global-contracts.md (NEP-591) |
| **Deterministic `0s` accounts** (`DeterministicStateInit`: code + initial storage, **no access keys**, address derived from state) | Possible host for a keyless policy wallet, but docs give no NEP/version and only an FT example. Not needed for the demo | https://docs.near.org/protocol/tutorials/creating-deterministic-accounts.md |
| **Gas keys** (NEP-611, protocol 86): prepaid gas balance + up to 1,024 nonce lanes; can be FunctionCall; deposits still paid from main balance | Does **not** lift the deposit ban (it is a FunctionCall-permission check). From protocol 87 gas keys cannot sign delegate actions. Useful only for parallel agent txs | https://docs.near.org/protocol/accounts-contracts/gas-keys.md; meta-tx page |
| Full-access key on the agent sub-account | Works for everything (x402, NEP-413); the cap is then only the account balance | access-keys page |

### c) Caps without a custom contract?

| Mechanism | Per-tx / per-day / allowlist enforced by | Source |
|---|---|---|
| Native access keys | Nothing beyond receiver + method + gas allowance. No amount caps | access-keys page |
| `intents.near` verifier keys | None: "Each key has full control and can add or remove other keys"; intent types (`transfer` with memo, `ft_withdraw`, `token_diff`, `add_public_key` ...) have no scopes or allowances | https://docs.near-intents.org/integration/verifier-contract/account-abstraction.md; https://docs.near-intents.org/integration/verifier-contract/intent-types-and-execution.md |
| Our relayer policy | Only for txs that go through our relayer; agent with a full-access key can bypass by self-paying gas. Real enforcement needs us to **hold the key** | brief section 2 |
| Custodial signer (opencash backend holds agent key, enforces policy before signing) | Off-chain, by us. Hard on-chain ceiling = account balance | design choice |
| NEAR Intents **Agent API** (NEAR Technologies Ltd, "experimental, mainnet-only beta", runs in an attested TEE): owner-signed policy with `actions`, per-asset `limits.per_transaction/hourly/daily/monthly`, `budget.daily_usd`, `destinations.mode only/except/any`, `timelock_ms`, `frozen`; some fields written on-chain to the wallet's rules, others API-enforced | Third party, policy enforced partly API-side, partly by "wallet provider" | https://docs.agentsonintents.com/integration/agent-api/overview; https://docs.agentsonintents.com/integration/agent-api/policies-and-limits ; demo base URL `https://api.demo.agentsonintents.com` per https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/07-agents.md |
| OutLayer agent custody: TEE-derived keys, per-tx/hourly/daily/monthly caps, whitelists, rate limits, multisig, freeze; policy "stored encrypted on-chain"; cumulative limits "best-effort under concurrency" | Third party TEE | https://app.outlayer.ai/docs/agent-custody |
| Small policy contract on the agent account | On-chain, by NEAR consensus | section b |

Answer: **true on-chain caps need a contract** (or a third-party TEE wallet). Without either, caps are a promise made by whoever holds the key.

### d) x402 on NEAR

x402 v2 HTTP transport: server answers `402` with header `PAYMENT-REQUIRED` (base64 JSON `{x402Version:2, error, resource, accepts[]}`;
each `accepts` item has `scheme, network (CAIP-2), amount, asset, payTo, maxTimeoutSeconds, extra`); client retries with `PAYMENT-SIGNATURE`
(base64 `PaymentPayload`); server replies `200` + `PAYMENT-RESPONSE` (base64 `SettlementResponse`). Source:
https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md

**Path 1 - NEAR-native x402 (`@fastnear/x402` 2.5.0, npm checked).** https://js.fastnear.com/x402
- `exact` scheme, networks `near:mainnet` / `near:testnet`. Payer signs a NEP-366 `SignedDelegate` for one USDC `ft_transfer` (30 TGas, 1 yocto); the
  facilitator relays it and pays gas + 1 yocto. "Wallet and local-key payers need **full-access keys**." Recipient must be USDC-registered.
- Packages: `/node` (`createLocalNearSigner`, `createNearPaymentFetch`), `/server` (`createNearResourceServer`), `/facilitator` (`createNearFacilitator`).
- Public facilitators (zero fee): `https://x402.mikedotexe.com` (mainnet), `https://test.x402.mikedotexe.com` (testnet). Live `GET /supported` on the
  testnet one returned `{"x402Version":2,"scheme":"exact","network":"near:testnet"}`, signer `x402-relayer.mike.testnet`. `/verify` and `/settle`
  need a manually approved `X-API-Key` (seller side only; payers need none). Self-hosting supported.
- **Receive**: a business runs `createNearResourceServer` with `payTo = acme.opencash.near`. How `payTo` is set is in the package README, not the page
  (**UNVERIFIED**, https://js.fastnear.com/x402).
- Agent flow: `paidFetch(url)` -> 402 -> sign delegate `ft_transfer(payTo, amount)` -> retry with `PAYMENT-SIGNATURE` -> facilitator settles -> 200.
- Not merged upstream; it is FastNEAR's package. Rust equivalent `r402-near` on docs.rs (https://docs.rs/r402-near), not inspected.

**Path 2 - PingPay Agent Pay facilitator** (x402 v2, `exact` + `assetTransferMethod: near-intents`, `paymentFlow: upfront`, per open PR
https://github.com/x402-foundation/x402/pull/3370). https://pingpay.gitbook.io/docs/pingpay-api/agent-pay-facilitator/x402-integration.md
- Base `https://pay.pingpay.io/agentpay/x402`: `GET /supported` (public), `/offers`, `POST /verify`, `POST /settle` (all `X-Api-Key`).
  Live `/supported` lists `near:mainnet`, `eip155:1/10/56/100/137/143/...` as origins. Mainnet only.
- Flow: 402 with unquoted `accepts[]` (empty `payTo`/`amount`, `extra.destination`) -> client sends `payload.type="quote"` + required `refundTo` ->
  `/verify` returns `extra.depositAddress, amountIn, refundDeadline, operationToken` -> client deposits `amountIn` on origin chain ->
  `payload.type="deposit"` with `operationToken, depositAddress, txHash` -> `/settle` -> `200` receipt (`network: near:mainnet` when settled via intents).
  Pending = `200 success:false errorReason:settlement_pending`; short = `INCOMPLETE_DEPOSIT`; terminal = `402`.
- **Receive**: merchant org enables Agent Pay, picks asset + destination (`public` wallet or `intents` NEAR account), gets an API key from Settings
  or from the Ping team; `@pingpay/agentpay-middleware` 0.2.0 (`agentPayX402({apiKey, facilitatorUrl, routes})`). Minimum 0.2 USDC.
  https://pingpay.gitbook.io/docs/pingpay-api/agent-pay-facilitator/getting-started.md . Whether a named NEAR account is accepted as recipient: **UNVERIFIED**.
- **Pay** from NEAR: since `near:mainnet` is an origin, an agent can pay by a plain USDC `ft_transfer` to the quoted deposit address (fits the
  policy-contract `pay()` too). Ping's own example payer is "Agent Connect" (hosted MCP, NEAR Intents USDC balance -> Base deposit, per-agent policy
  `destinations.mode`, `timelock_ms`, 30-day key): https://pingpay.gitbook.io/docs/pingpay-api/agent-pay-facilitator/pay-with-agent-connect.md .
  Its field names match the Agent API above; that they are the same product is my inference, **UNVERIFIED**.

### e) Existing agent-wallet projects

| Project | Provides | Usable in 2 days? | Source |
|---|---|---|---|
| NEAR Intents Agent API | Per-agent wallet on Intents, owner-signed policy, TEE, swap/transfer/withdraw | API yes; mainnet-only beta, own wallet model (not our sub-accounts), "may lose assets" | links in c) |
| OutLayer agent custody | `POST https://api.outlayer.ai/register` -> api_key + implicit NEAR account; policy, `ft_transfer` via `/call`, NEP-413, intents; testnet API `https://testnet-api.outlayer.ai` (intents 503 there); free 1000 ops/24h | Yes as a dependency; listed hackathon partner | https://app.outlayer.ai/docs/agent-custody ; https://docs.near.org/primitives/off-chain-compute/outlayer.md |
| `@fastnear/x402` | NEAR-native x402 payer/seller/facilitator | Yes, testnet facilitator live | https://js.fastnear.com/x402 |
| Shade Agent Framework | - | **No**: "Do not use ... not been maintained since April 19, 2026" | https://docs.near.org/ai/shade-agents/getting-started/introduction.md |
| NEAR AI Cloud | API-key spend limits for inference only, not wallets | No (not a wallet) | https://docs.near.ai/api-reference/workspaces/update-api-key-spend-limit.md |
| `near-mcp` | MCP over local private keys, no limits | Not a sandbox | https://docs.near.org/getting-started/tools-for-ai.md |

The `security` track explicitly asks for "spending limits, policy engines, sandboxed wallets" with function-call keys
(https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/06-security.md); `agents` track names PingPay (07-agents.md above).

### Q1 recommendation

**Agent = `agentN.acme.opencash.near` sub-account + a ~100-line `agent-wallet` Rust contract + a function-call key for the agent.**
- At creation (one batch signed by acme's passkey key): `CreateAccount`, `Transfer` (~2 NEAR testnet for code storage), `DeployContract`
  (or `UseGlobalContract`), `FunctionCall new{owner: acme, usdc, policy}`, `AddKey(agent_pk, FunctionCall{receiver: self, methods:["pay"], allowance})`.
  No full-access key on the agent account, so the agent cannot escape the contract. Backend pays USDC `storage_deposit`.
- `pay(receiver, amount, memo)`: require predecessor == self (agent key) ; check per-tx cap, rolling 24 h total, allowlist; then
  `ft_transfer` 1 yocto with a callback that rolls back the spend counter on failure. Owner methods (`set_policy`, `freeze`, `sweep`) require
  predecessor == `acme.opencash.near`, so the owner signs them with the passkey (relayable: no deposit needed). Every `pay` emits an event = history.
- x402: **Ping (mainnet)** works through `pay()` (deposit to quoted address). **`@fastnear/x402` does not** with a function-call key (needs a
  full-access `SignedDelegate`). Honest fallback for the testnet demo: an opencash "x402 adapter" that reads `PAYMENT-REQUIRED`, calls `pay(payTo, amount)`,
  and retries; this only works against sellers that accept a tx hash proof (e.g. our own seller), not the fastnear facilitator.
- If 2 days is too tight for a second contract: **Plan B** = same sub-account, full-access key held by the opencash backend, caps enforced off-chain
  before signing, `@fastnear/x402` against the live testnet facilitator. Say plainly in the README: "caps are enforced by opencash; the chain only
  guarantees the agent cannot spend more than its account balance."

Storage rules: durable = agent account balance + contract state (policy, 24 h window, frozen flag) on NEAR; Postgres keeps an indexed copy of `pay`
events (rebuildable from chain). Plan B: policy + spend counters in Postgres only; lost counters on a DB loss mean caps reset, balance still bounds loss.
Nothing is memory-only.
Latency: agent waits for the `pay` tx (~2-3 s, 2 receipts + callback); x402 adds facilitator verify/settle (Ping: 1Click, up to minutes cross-chain).
Plan B is neither faster nor slower on-chain; it adds one backend hop. No change to existing flows.
New schema: new contract `contracts/agent-wallet` (state: `owner`, `usdc`, `per_tx`, `per_day`, `allowlist: IterableSet`, `window_start`,
`spent_in_window`, `frozen`). Postgres: `agents(account_id PK, business_id FK, public_key, created_at)`, `agent_payments(tx_hash PK, agent_id, receiver,
amount, memo, x402_resource, created_at)` with index `(agent_id, created_at)` for history/day totals. Env: `AGENT_WALLET_WASM` or `AGENT_WALLET_GLOBAL_HASH`,
`PING_API_KEY`, `X402_FACILITATOR_URL`.

| Option | On-chain caps | x402 fit | Build time | Verdict |
|---|---|---|---|---|
| Do nothing (agents use business account) | none, full funds exposed | any | 0 | rejected: the product's whole point |
| Sub-account + full-access key held by agent | balance only | fastnear + Ping | 0.5 day | rejected: agent can do anything with its balance and keys |
| Sub-account + custodial key + off-chain policy (Plan B) | balance only | fastnear + Ping | 1 day | fallback |
| Sub-account + policy contract + FC key | yes | Ping; fastnear no | 1.5-2 days | **recommended** |
| Intents `add_public_key` per agent | none (keys are full control) | Ping | - | rejected |
| Agent API / OutLayer | yes (third party TEE) | Ping (Agent Connect) | 1 day + accounts | rejected as core: mainnet beta, separate identity, external custody; fine as "also works with" |
| Gas keys / deterministic accounts | no / unclear | - | - | rejected: don't solve deposits |

## Q2. Can opencash drop the custom contract?

What the native stack gives: payments to `acme.opencash.near` emit NEP-141 `EVENT_JSON` `ft_transfer {old_owner_id, new_owner_id, amount, memo?}`
(https://github.com/near/NEPs/blob/master/neps/nep-0141.md); `ft_transfer(receiver_id, amount, memo)` needs 1 yocto (same). Whether Circle's NEAR USDC emits
the memo in its event: **UNVERIFIED** (not checked on-chain). NEP-413 signs `{message, nonce[32], recipient, callbackUrl?}` off-chain with a **full-access
key** and "no transactions being involved" (https://github.com/near/NEPs/blob/master/neps/nep-0413.md); the NEP defines no verification procedure, so a
verifier must check that `publicKey` is (or was) a full-access key of `accountId` via RPC `view_access_key` - keys can later be removed, and proving
validity at signing time needs archival RPC. 1Click deposit addresses are unique per quote, so they already correlate cross-chain payments to invoices
without any memo (brief section 1). A NEAR-USDC-origin 1Click quote (which would give NEAR wallets the same deposit-address + auto-refund flow) could
not be checked: every dry quote, including the brief's known-good Arbitrum route, returned `500 Internal server error` on 2026-11-12 10:34 UTC
(**UNVERIFIED**, `POST https://1click.chaindefuser.com/v0/quote`). Ping lists `near:mainnet` as an origin, which suggests the route exists.

| Contract function (lib.rs) | Native / SDK-only replacement | Trust or verifiability lost | Recommendation |
|---|---|---|---|
| Business registry `register_company`, `advance_company`, `record_application`, `get_company` | Postgres + the account itself: only `opencash.near` can create `*.opencash.near`, so the name proves we onboarded it | Public, timestamped status history and doc/application hashes. Operator-only writes, so the chain only adds immutability, not independent truth | **Replace** (optionally anchor hashes, see last row) |
| Invoices `create_invoice(_for)`, `get/list_invoices` | Postgres; invoice id in the 1Click quote record / `ft_transfer` memo | Tamper-evident invoice terms (amount, items) that payer can check on-chain. Mitigation: sign invoice JSON with the business key (NEP-413) and show the signature on the pay page | **Replace** |
| `attest_invoice`, `record_settlement`, pending set `list_pending` | Postgres status machine fed by 1Click `/v0/status` + USDC `ft_transfer` events to the business account | Nothing material: these are operator assertions about 1Click; the real proofs are the 1Click status and the NEAR settlement tx, which remain public. `pending` is a worker queue and belongs in Postgres | **Replace** |
| Agreements `create_agreement`, `sign_agreement`, `void_agreement`, list | NEP-413 signature per party over `{agreement_id, doc_hash}` with `recipient: "opencash.near"`; store sig + pubkey in Postgres; verify via RPC | On-chain timestamp/ordering, proof the key was valid when signing (key rotation), enforced "all parties signed => executed", public enumeration. Passkey keys are full-access, so NEP-413 works | **Replace** if time is short; **keep** if "agreements on NEAR" is a demo claim |
| NEAR-wallet invoice payment `ft_on_transfer` + `on_invoice_forwarded` (exact due forwarded, excess/wrong/paid-twice refunded, rollback on failure) | Payer `ft_transfer` directly to `acme.opencash.near` with memo `opencash:<invoice id>`; backend matches events. Or 1Click with NEAR USDC origin (unverified) | Atomic amount check, automatic refund of under/over/duplicate payments, and status flip in the same tx. Mis-payments become a manual refund by the business | **Keep** (only function where the contract enforces something) or use 1Click if a NEAR-origin quote verifies |
| Getters `get_usdc`, `get_operator`, `company_count` | config / SQL | none | **Replace** |
| (optional) doc/application hash anchoring | Keep a 10-line `anchor(hash)` method that only logs; or put the hash in the memo of a real USDC transfer | Same as registry row | Only if a judge-visible proof is wanted |

### Q2 recommendation

**Slim the contract, do not delete it.** Move registry, invoices, attestations, the pending set and settlement records to Postgres (the operator
was attesting its own data; on-chain copies add immutability but no independent trust, and they cost a tx + gas per state change). Replace agreement
signing with NEP-413 unless on-chain agreements are a headline claim. **Keep `ft_on_transfer` payment forwarding** - it is the only function where
NEAR enforces a rule (exact amount, refunds) that a memo transfer cannot - unless a NEAR-origin 1Click quote is verified to work, in which case
NEAR-wallet payers use the same deposit-address flow as everyone else and the contract can go entirely. The agent-wallet contract from Q1 is the
better place to show "NEAR enforces this" to judges.

Storage rules: durable record becomes Postgres for invoices/companies/agreements (plus NEP-413 signatures as rows); chain keeps payment txs, 1Click
records, USDC events. Lost on DB loss without backups: invoice terms and statuses (payments themselves remain on-chain and re-derivable). Nothing memory-only.
Latency: invoice create/status updates drop from a NEAR tx (~1-2 s + relayer) to a DB write (ms). Payment latency unchanged (1Click / USDC tx).
New schema: `invoices.status` + `pending` as a partial index `WHERE status='pending'` (serves the worker poll); `agreement_signatures(agreement_id,
account_id, public_key, signature, nonce, signed_at, PK(agreement_id, account_id))`; drop the `contract invoice id` dependency in app code. Env:
`REGISTRY_CONTRACT_ID` remains only if the payment-forwarding contract is kept.

| Option | Verdict |
|---|---|
| Keep contract as is | rejected: every invoice/status change is an operator tx with no added trust, more relayer cost and failure modes |
| Delete contract entirely now | rejected unless NEAR-origin 1Click verifies: loses enforced refunds for NEAR-wallet payers |
| Slim contract to payment forwarding (+ optional `anchor`) and move the rest to Postgres / NEP-413 | **recommended** |
