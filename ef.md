# LeanSeal: hackathon submission and references

**Track:** Ethereum Foundation, *Best use of the Frame Transaction Alternative Mempool* (EIP-8141 / ERC-8421)
**One line:** Sealed, quantum-safe swaps that bots can't touch.

| | |
|---|---|
| Live demo | https://leanseal.vercel.app/ (landing) · https://129-212-188-106.sslip.io/dashboard (console) |
| Our sealed-mempool node (public RPC) | `https://129-212-188-106.sslip.io/rpc` (add it as an instance on the explorer) |
| Repository | https://github.com/daiwikmh/leanseal |
| Project overview | [README.md](README.md) |
| Uniswap v4 design (PRD) | [uniswap-use-description.md](uniswap-use-description.md) |
| Sealed-mempool rules | [docs/leanseal-mempool.md](docs/leanseal-mempool.md) (mempool ID `QmSjNQxct8kRXMYKSsdefPsi3AFBHdSj3QjQtanS6bwgSc`) |

## Why it needs the alt mempool

1. **Frame transactions with more than 100k verification gas.** Our wallets verify a NIST post-quantum signature (SLH-DSA-SHA2) in an EIP-8141 VERIFY frame. That costs ~154k gas, which the public mempool's 100k cap rejects, so only the ERC-8421 staked budget admits it.
2. **A custom ERC-8421 mempool.** Our MEV protection is itself an alt mempool: a plug-in with published rules (its ID is the IPFS CID of the rules doc) and its own p2p topic. It carries drand-time-locked orders and reveals them on schedule, so nothing is sent privately.
3. **A sponsor paymaster in the validation prefix.** New users pay no gas, and wallet creation, PQ verification, sponsorship and a first deposit happen in one frame transaction.

## Admitted transactions on the devnet (chain 1337)

All mined with status 1, checked on 2026-11-07.

| What | Transaction | Block |
|---|---|---|
| **Sealed batch commit**, PQ wallet, gas paid by the sponsor (run #30, 0% loss, bot front-run rejected) | [0x923274a9…e1e5](https://explorer.altmempool.wtf/tx/0x923274a91d03128b447f7e56d5b35262520fc21eee00229e570c68e49d71e1e5?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 6395 |
| **Passkey wallet created in one transaction** (real Touch ID; deploy + PQ verify + sponsor + deposit) | [0xcb71bb91…cd97](https://explorer.altmempool.wtf/tx/0xcb71bb91ba0aa148e60fbd15cb77913091c9cde2a094d725686eb7956d3ccd97?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 6724 |
| **Passkey wallet's sealed commit** (batch 1607, 0% loss) | [0x8f8abafd…4647](https://explorer.altmempool.wtf/tx/0x8f8abafdef9580b160b7752353e1f7efefd8cbd30324bab8bc628aae75bd4647?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 6430 |
| Reveal of that order by our node's keeper | `0x1e8131ffdcfbf7f50b573839f5fdd3fe89b89d1853bb1d7bfd530d2b297fe421` | 6435 |
| **NIST SLH-DSA-SHA2 wallet** (staked), 200k verification budget | [0xeb569198…4d13](https://explorer.altmempool.wtf/tx/0xeb569198ae239d241ea5630d82f20230180f89ca972a7fa1753963f03bc13d4c?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 5463 |
| Staked leanSphincs-s wallet, 200k verification budget | [0x578872ee…c805](https://explorer.altmempool.wtf/tx/0x578872eea2f4325f9d06a791a2d7c81d319bb08f12e184f0404da3723706c805?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 2365 |
| Staked leanSphincs-s wallet, 1M verification budget | [0xdf844822…19db](https://explorer.altmempool.wtf/tx/0xdf844822708d212cea3836715241887899d1bb47e34e22cf2a37d2d7b37d19db?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) | 2370 |

Devnet contracts: SealedPoolHook `0x22fDb32179D29d1f90a0Ef1810d2AeEcd8f94080` · Uniswap v4 PoolManager `0x6bF9Aa9c04fd001385742d61f6818C3236429848` · tUSD `0x5ed7367cbb2e9bc743e14ffc3fbd230c25c6059b` · wallet factory `0x42def1c5b6e5679e64f243e7767f27f8132b695a` · sponsor `0xe72458f41ce1d6791908c38db0b4c0f750be3736`.

## Where the tech is used (code)

| What | Code |
|---|---|
| **Submitting a PQ frame transaction to the alt mempool** | [`workshop/src/batch/pq_send.ts#L25`](workshop/src/batch/pq_send.ts#L25) |
| One-transaction wallet creation (deploy, PQ verify, sponsor, deposit) | [`workshop/src/onboard/onboard.ts#L114`](workshop/src/onboard/onboard.ts#L114) |
| Staked verification budget (BUDGET-010) in the alt-mempool node | [`sidecar/…/validators/frameTx.ts#L465`](sidecar/packages/executor/src/services/UserOpValidation/validators/frameTx.ts#L465), patch: [`patches/sidecar-budget-010.patch`](patches/sidecar-budget-010.patch) |
| `customMempools` plug-in hook in the alt-mempool node | [`sidecar/packages/api/src/customMempools.ts#L43`](sidecar/packages/api/src/customMempools.ts#L43) |
| Custom-mempool p2p gossip | [`sidecar/…/CustomMempoolGossip.ts`](sidecar/packages/executor/src/services/CustomMempoolGossip.ts) |
| Our sealed mempool: ticket intake and rules | [`leanseal-node/src/mempool.ts#L143`](leanseal-node/src/mempool.ts#L143) |
| Reveal at the drand round, keepers | [`leanseal-node/src/reveal.ts`](leanseal-node/src/reveal.ts), [`leanseal-node/src/hookChain.ts`](leanseal-node/src/hookChain.ts) |
| drand timelock | [`sealing-kit/src/envelope.ts#L174`](sealing-kit/src/envelope.ts#L174) |
| Uniswap v4 hook: `commit` / `settle` / `beforeSwap` guard | [`SealedPoolHook.sol#L120`](contracts/src/SealedPoolHook.sol#L120) · [`#L148`](contracts/src/SealedPoolHook.sol#L148) · [`#L206`](contracts/src/SealedPoolHook.sol#L206) |
| PQ clone wallet and factory | [`LeanSealCloneAccount.sol`](contracts/src/LeanSealCloneAccount.sol), [`LeanSealFactory.sol`](contracts/src/LeanSealFactory.sol) |
| Passkey → PQ key in the browser (WebAuthn PRF + WASM) | [`web/src/scripts/passkey.ts`](web/src/scripts/passkey.ts), [`signer-lss-wasm/src/lib.rs`](signer-lss-wasm/src/lib.rs) |
| Hook tests (netting, one price, refunds, bonds) | [`contracts/test/SealedPoolHook.t.sol`](contracts/test/SealedPoolHook.t.sol) |

## Measured results

| Setting | Result |
|---|---|
| Public mempool swap, MEV bot on | **−3.0%** (sandwiched) |
| Sealed batch auction, local chain (runs #17, #19, #21) | **0%**, every front-run rejected (`OutsideSwap`) |
| Sealed batch auction, live devnet (run #30, passkey runs) | **0%**, front-run rejected |
| Institution order ticket on the live site (buy, sell, withdraw) | Buy batch 2526 and sell batch 2517 settled at one price, 0% from the quote |
| Signature verification gas | SLH-DSA-SHA2 ~154k (staked) · leanSphincs-s ~47k (fits 100k unstaked) |
| Passkey signing in the browser | key ~0.3 s, signature ~30 ms |

## Demo flow (about 5 minutes)

1. Open the console → **Create passkey** (Touch ID / Face ID).
2. **Create my wallet (free):** one frame transaction, gas paid by the sponsor.
3. **Swap with my wallet → Run.** The Log shows: signed in the browser → commit (a hash only) → the bot tries to front-run and is **blocked** → the batch settles at one price, **0% loss**.
4. **Transactions** tab → open the commit on the explorer.
5. **Checks** tab → the ERC-8421 rule-by-rule admission report, and the sealed mempool's own rules.
6. **View → Institution:** **Get test funds** → a buy or sell order → **Withdraw vault**.

## How LeanSeal fits this track

LeanSeal is exactly "something only an alt mempool makes possible": PQ-secure smart wallets whose EIP-8141 verification needs more than 100k gas (NIST SLH-DSA, ~154k), used for sandwich-proof Uniswap v4 swaps. The MEV protection is itself an ERC-8421 custom mempool that carries time-locked orders on public rails, keeping the flow CROPS with no private order flow.

- **(a) Verification budget above 100k:** our wallets verify a NIST post-quantum signature in the VERIFY frame (~154k gas), which the public mempool rejects. We apply ERC-8421's staked budget (BUDGET-010, up to 1M) and the precompile rule (CALLING-040) in the sidecar, and found and reported the live precompile bug. Admitted on the devnet at block 5463.
- **(b) More flexible state access in the paymaster:** a sponsor paymaster sits in the same validation prefix, so a new user's first frame transaction deploys the wallet, verifies the PQ signature, has gas sponsored and deposits, all in one. Admitted at block 6724, signed after a real Touch ID unlock.
- **Relation to the alt mempool, beyond using it:** we added a `customMempools` extension point to the alt-mempool node and built our own ERC-8421 custom mempool on it, with published rules (ID = IPFS CID of the rules doc), its own gossip topic and admission rules REV-010…060. It carries drand-time-locked orders and reveals them on schedule, so a Uniswap v4 batch auction fills everyone at one price and rejects every other swap.
- **How well it works:** a public-mempool swap was sandwiched for −3.0%; the sealed batch gave **0% loss with every bot front-run rejected**, locally and on the live devnet (commit `0x923274a9…e1e5`, block 6395).
- **Practicality:** live at https://leanseal.vercel.app/ (console: https://129-212-188-106.sslip.io/dashboard). Judges need no funds: passkey sign-in, a quantum-safe key made in the browser, sponsored gas, and a test-funds faucet.

## Feedback for the alt-mempool team

1. The verification budget is summed over the whole validation prefix and raised to 1M only if every entity is staked. That is stricter than ERC-8421's per-entity budget, so a staked PQ sender with an unstaked paymaster can't fit.
2. Precompile calls (0x02 SHA-256) were rejected as an "un-deployed contract address", which blocked NIST SLH-DSA wallets until it was fixed; CALLING-040 allows 0x01–0x11.
3. There was no extension point for non-standard mempools. We added a `customMempools` hook and a `custom_mempool_v1` gossip topic and are happy to upstream them.
4. Frame transactions are charged near `gasLimit × maxFeePerGas` while the base fee is 7 wei, so the 2 gwei default drains paymasters fast.
5. A devnet reset wiped our contracts, the public gateway had 0 peers, and some admitted transactions were relayed 4× and then dropped. An "admitted but dropped" status in the explorer would help.
6. `eth_estimateGas` with fee fields fails on ethrex (block gas × fee balance check).
7. A viem-style SDK for frame transactions would remove most of the boilerplate.
8. The rule-by-rule admission report made debugging fast. Thank you.
