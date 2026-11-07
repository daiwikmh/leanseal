# LeanSeal on Uniswap v4: product requirements

*Status: implemented and running on our local chain and on the public hackathon devnet (chain 1337). Last updated 2026-11-07.*

## 1. Summary

LeanSeal adds a **sealed batch auction** to Uniswap v4. A user commits only a hash of their swap. The order travels time-locked through our ERC-8421 sealed mempool and is revealed at a drand round. Every order in the batch is then filled at **one price per side**. A Uniswap v4 hook ([`SealedPoolHook`](contracts/src/SealedPoolHook.sol)) rejects every swap that is not part of a batch settlement, so there is no "before" or "after" for a bot to trade into.

We do not modify Uniswap. We use v4's standard extension point (a hook) and the existing `PoolManager`.

**Try it live:** [leanseal.vercel.app](https://leanseal.vercel.app/) · [console](https://129-212-188-106.sslip.io/dashboard) · **Project overview:** [README.md](README.md)

### Where to find the code

| What | Code |
|---|---|
| The hook: commit, reveal, one-price settlement, `beforeSwap` guard | [`contracts/src/SealedPoolHook.sol`](contracts/src/SealedPoolHook.sol) |
| Hook tests: netting, one price per side, refunds, bonds | [`contracts/test/SealedPoolHook.t.sol`](contracts/test/SealedPoolHook.t.sol) |
| Deploy: salt mining for the hook address, pool creation, seeding | [`workshop/src/batch/setup_batch_pool.ts`](workshop/src/batch/setup_batch_pool.ts), [`contracts/src/Create2Deployer.sol`](contracts/src/Create2Deployer.sol), [`contracts/src/LiquiditySeeder.sol`](contracts/src/LiquiditySeeder.sol) |
| Adding liquidity | [`workshop/src/batch/add_liquidity.ts`](workshop/src/batch/add_liquidity.ts) |
| The user's side of a swap: deposit, commit, seal, wait for settle | [`workshop/src/batch/batch_swap.ts`](workshop/src/batch/batch_swap.ts) |
| Sealed mempool plugin and its rules | [`leanseal-node/src/mempool.ts`](leanseal-node/src/mempool.ts), [`docs/leanseal-mempool.md`](docs/leanseal-mempool.md) |
| Reveal tickets, drand timelock, reveal and settle by nodes | [`leanseal-node/src/reveal.ts`](leanseal-node/src/reveal.ts), [`leanseal-node/src/hookChain.ts`](leanseal-node/src/hookChain.ts), [`sealing-kit/src/envelope.ts`](sealing-kit/src/envelope.ts), [`sealing-kit/src/drand.ts`](sealing-kit/src/drand.ts) |
| Plug-in mempools and their p2p gossip in the alt-mempool node | [`sidecar/packages/api/src/customMempools.ts`](sidecar/packages/api/src/customMempools.ts), [`sidecar/packages/executor/src/services/CustomMempoolGossip.ts`](sidecar/packages/executor/src/services/CustomMempoolGossip.ts), [`patches/`](patches) |
| Quantum-safe wallets and one-transaction signup | [`contracts/src/LeanSealCloneAccount.sol`](contracts/src/LeanSealCloneAccount.sol), [`contracts/src/LeanSealFactory.sol`](contracts/src/LeanSealFactory.sol), [`workshop/src/onboard/onboard.ts`](workshop/src/onboard/onboard.ts) |
| Passkey → quantum-safe key in the browser | [`web/src/scripts/passkey.ts`](web/src/scripts/passkey.ts), [`signer-lss-wasm/src/lib.rs`](signer-lss-wasm/src/lib.rs), [`demo/remote-signer.mjs`](demo/remote-signer.mjs) |
| Console and public mode | [`demo/server.ts`](demo/server.ts), [`web/src/scripts/dashboard.ts`](web/src/scripts/dashboard.ts) |
| The MEV bot whose front-runs get rejected | [`workshop/src/batch/batch_bot.ts`](workshop/src/batch/batch_bot.ts), [`contracts/src/SandwichSwapper.sol`](contracts/src/SandwichSwapper.sol) |

## 2. Problem

On a normal Uniswap pool, a signed swap waits in a public mempool. A bot reads it, buys just before it and sells just after it (a "sandwich"), and takes up to the user's whole slippage. We measured this on our chain: **the user lost 3.0%** of the swap (runs #4 and #13).

The usual fix is private order flow: sending the trade to a chosen builder or relay. Hackathon feedback ruled that out, because private submission goes against the open, public rails the alt mempool is meant for. We needed protection that works on **public rails**.

## 3. Users

| User | What they want | What they get |
|---|---|---|
| **Individual** | Swap without being sandwiched, no seed phrase, no gas money | Passkey sign-in, a quantum-safe wallet made in the browser, sponsored gas, 0% loss in our runs |
| **Institution** (desk, treasury, fund) | Large orders without information leakage, one fair price, keys that survive quantum computers | The same engine, worded for desks: "sealed block trades". Keys stay with the operator. |

## 4. Goals

**Goals**
- No sandwiching of orders in the sealed pool.
- One price per side for every order in a batch.
- Public submission only: no private relays and no trusted builder.
- No changes to Uniswap v4 core, validators or Ethereum.
- Works with post-quantum wallets (EIP-8141 frame transactions).

## 5. How we use Uniswap v4

| Uniswap v4 feature | How LeanSeal uses it |
|---|---|
| **PoolManager** (singleton) | Holds the pool and does the swap math. Devnet: the existing `0x6bF9Aa9c04fd001385742d61f6818C3236429848`. |
| **Hooks** | `SealedPoolHook` is the pool's hook. A v4 hook's address encodes its permissions, so we mined a CREATE2 salt giving exactly the **beforeSwap** flag (`0x0080`) and deployed through `Create2Deployer` ([`mineSalt`](workshop/src/batch/setup_batch_pool.ts)). |
| **`beforeSwap`** | Always reverts with `OutsideSwap()`. Only the hook's own settlement can swap in this pool. |
| **`unlock` / flash accounting** | `settle()` calls `manager.unlock(round)`. Inside `unlockCallback` the hook nets the batch, swaps only the remainder through the pool, then settles and takes the balances. |
| **`extsload`** | The hook reads the pool's current price from PoolManager storage, to net buys against sells at that price. |
| **Pool key** | Native ETH / tUSD, fee 3000 (0.3%), tick spacing 60, hook = `SealedPoolHook`. |

Liquidity is added with our [`LiquiditySeeder`](contracts/src/LiquiditySeeder.sol) (full range), via [`add_liquidity.ts`](workshop/src/batch/add_liquidity.ts).

## 6. User flow

```
browser (quantum-safe key)              chain (devnet)                    our sealed mempool nodes
──────────────────────────              ──────────────                    ────────────────────────
1. deposit() ETH into the vault  ─────► SealedPoolHook.ethOf[user]
2. commit(hash) ─────────────────────► orders[round] (only the hash)
3. order locked to a drand round ───────────────────────────────────────► ticket held, gossiped A ⇄ B
                                                                           at the drand round:
4.                                       reveal(...) ◄──────────────────── open, check against hash
5.                                       settle()   ◄──────────────────── any node (or anyone)
                                         → PoolManager.unlock → one swap → one price
6. tUSD credited to tokenOf[user]
```

1. **Deposit.** The user puts ETH (or tUSD) into the hook's vault, separately from the trade, so the deposit doesn't reveal the trade.
2. **Commit.** The user's wallet sends `commit(keccak256(hook, user, round, zeroForOne, amountIn, minOut, salt))`. Only the hash goes on chain. Rounds are `block.number / 4`. The commit costs a bond (1 gwei here), which is returned on reveal.
3. **Seal.** The browser encrypts the order to a future **drand** round (timelock encryption) and sends this "reveal ticket" to our sealed mempool. Nodes check it (rules `REV-010…060`) and share it over their own p2p topic.
4. **Reveal.** When the round arrives, any node downloads that round's key, opens the ticket, checks it against the on-chain hash, and calls `reveal()`. Anyone holding the order may reveal it, the user included.
5. **Settle.** After the 2-round reveal window, anyone calls `settle()`, which handles batches in strict queue order:
   - buys are netted against sells at the pool price, and only the remainder is swapped through Uniswap;
   - every order on a side gets the same price;
   - an order whose `minOut` the batch misses is **excluded and refunded**;
   - unrevealed orders forfeit their bond to the settler.
The client side of steps 1–3 and the wait for settlement is [`batch_swap.ts`](workshop/src/batch/batch_swap.ts); steps 3–5 on the node side are [`reveal.ts`](leanseal-node/src/reveal.ts) and [`hookChain.ts`](leanseal-node/src/hookChain.ts).

6. **Withdraw.** Proceeds sit in the vault (`tokenOf`, `ethOf`) and can be withdrawn at any time with `withdraw()`.

## 7. Contract specification: [`contracts/src/SealedPoolHook.sol`](contracts/src/SealedPoolHook.sol)

**Constructor:** `(manager, token, fee, tickSpacing, roundBlocks, revealRounds, bond)`. Deployed values: 4-block rounds, a 2-round reveal window, a 1 gwei bond.

| Function | Who calls it | What it does |
|---|---|---|
| `deposit()` payable / `depositToken(amount)` | User | Adds to `ethOf` / `tokenOf` |
| `withdraw(eth, token)` | User | Takes vault balances out |
| `commit(bytes32)` | User | Records the hash in `orders[currentRound]` and takes the bond |
| `reveal(round, index, zeroForOne, amountIn, minOut, salt)` | Anyone | Only in the window `round < now ≤ round + revealRounds`; checks the hash; moves the amount from the vault into the order |
| `settle()` | Anyone | The next batch in the queue, after its window: nets, swaps the remainder, one price, refunds on `minOut` failure |
| `beforeSwap(...)` | PoolManager | Always reverts `OutsideSwap()` |
| `commitmentOf`, `ordersOf`, `currentRound`, `poolKey` | Views | For clients and nodes |

**Events:** `Committed`, `Revealed`, `Excluded`, `Settled`.
**Errors:** `OutsideSwap`, `NotManager`, `WrongPhase`, `BadReveal`, `NothingToSettle`, `MinOutFailed(index)`.
**Tests:** [`contracts/test/SealedPoolHook.t.sol`](contracts/test/SealedPoolHook.t.sol), 6/6 (netting, one price per side, `minOut` refunds, bonds).

## 8. Off-chain parts

| Part | Role | Where |
|---|---|---|
| **Sealed mempool** (ERC-8421 custom mempool plugin) | Admits, holds and gossips reveal tickets; rules are published (mempool ID `QmSjNQxct8kRXMYKSsdefPsi3AFBHdSj3QjQtanS6bwgSc`) | [`mempool.ts`](leanseal-node/src/mempool.ts), [`reveal.ts`](leanseal-node/src/reveal.ts), [rules](docs/leanseal-mempool.md) |
| **Keepers** | Each node calls `reveal()` and `settle()` from its own key; a lost race counts as success | [`hookChain.ts`](leanseal-node/src/hookChain.ts) |
| **Patched alt-mempool node** | Admits the post-quantum commit (staked 1M budget, precompiles), hosts the plugin | [`customMempools.ts`](sidecar/packages/api/src/customMempools.ts), [`CustomMempoolGossip.ts`](sidecar/packages/executor/src/services/CustomMempoolGossip.ts), [`patches/`](patches) |
| **Wallets** | Quantum-safe EIP-8141 accounts (SLH-DSA SHA2 or leanSphincs-s); passkey users get an lss key made in the browser; one-transaction signup; optional gas sponsor | [`LeanSealCloneAccount.sol`](contracts/src/LeanSealCloneAccount.sol), [`LeanSealFactory.sol`](contracts/src/LeanSealFactory.sol), [`onboard.ts`](workshop/src/onboard/onboard.ts), [`passkey.ts`](web/src/scripts/passkey.ts), [`lib.rs`](signer-lss-wasm/src/lib.rs) |
| **Console** | Runs swaps, shows logs, results and transactions; Individual / Institution wording | [`server.ts`](demo/server.ts), [`dashboard.ts`](web/src/scripts/dashboard.ts) |
| **MEV bot** | Watches commits and reveals, attempts real front-runs (rejected) | [`batch_bot.ts`](workshop/src/batch/batch_bot.ts) |

## 9. Deployments

| | Local chain | Public devnet |
|---|---|---|
| PoolManager | `localnet/uni.local.json` | `0x6bF9Aa9c04fd001385742d61f6818C3236429848` (existing) |
| SealedPoolHook | `0x3aBf5468CA1b8d2E1bfd0AA90B97Cd016eB6C080` | `0x22fDb32179D29d1f90a0Ef1810d2AeEcd8f94080` |
| tUSD (test token) | `workshop/local.uni-state.json` | `0x5ed7367cbb2e9bc743e14ffc3fbd230c25c6059b` |
| Liquidity | ~0.001 ETH | ~0.1 ETH + ~34.7 tUSD (topped up 2026-11-07) |
| Live site | `localhost:4321` | [leanseal.vercel.app](https://leanseal.vercel.app/) (landing) · [console](https://129-212-188-106.sslip.io/dashboard) |

## 10. Measured results

| Run | Setting | Result |
|---|---|---|
| #4, #13 | Public mempool, bot on | **−3.0%** (sandwiched) |
| #17, #19, #21 | Sealed batch, local | **0%**, every front-run rejected |
| #30 | Sealed batch, live devnet, sponsored | **0%**, front-run rejected; commit [`0x923274a9…e1e5`](https://explorer.altmempool.wtf/tx/0x923274a91d03128b447f7e56d5b35262520fc21eee00229e570c68e49d71e1e5?node=https%3A%2F%2Faltmempool.forshtat.com%2Frpc) (block 6395) |
| Passkey runs | Passkey wallet, local and devnet | 0% (batches 1550, 1607) |
| Public-site test | Two visitors at once | Alice 0%; Bob **refunded**: the price moved past his 3% limit before his batch settled (the price protection working) |

## 11. Design breakdown

### Storage
- **On chain (durable):** vault balances, commitments, revealed orders, the batch queue, and settlement results, all in `SealedPoolHook`. Pool state lives in Uniswap's `PoolManager`.
- **In node memory:** the sealed tickets waiting for their drand round, shared between nodes.
- **On our server's disk:** run history and wallet addresses.
- **In the user's browser:** the quantum-safe key, in memory only, re-made from the passkey.

### Latency
- **What the user waits on:** commit inclusion, the end of the 4-block round, the drand round, then the 2-round reveal window and settlement. That is **about 1–2 minutes** on the devnet.
- **Clocks involved:** rounds of 4 blocks; a reveal window of 2 rounds; drand rounds every 3 s; a ticket deadline about 30 s ahead; client retries (commit 3×, funding transfer 3×); a 180 s settle wait in the client.
- **Off the critical path:** the gossip between nodes, and the bot.

### New schema
- **Contracts:** `SealedPoolHook` (storage: `ethOf`, `tokenOf`, `orders[round]`, `queue`, `head`), `Create2Deployer`, `LiquiditySeeder`, and the test token. No changes to any Uniswap contract.
- **Mempool:** the rules doc [`docs/leanseal-mempool.md`](docs/leanseal-mempool.md) (its IPFS hash is the mempool ID); the reveal-ticket format; RPC methods `leanseal_sendRevealTicket`, `leanseal_ticketStatus`, `leanseal_mempoolInfo`; p2p topic `custom_mempool_v1`.
- **Config:** `batchHook` and `keeperKeyFile` in each plugin config; `BATCH_PAYMASTER`, `LEANSEAL_NODE_URL`, `ADD_ETH_WEI`; the console's `PUBLIC`, `MAX_ACTIVE`, `RUNS_PER_HOUR`.
- **No database.**

### The better approach

| Option | Verdict |
|---|---|
| Do nothing (normal public swap) | Rejected: measured −3% to a sandwich |
| Private order flow (encrypt to a chosen builder) | Rejected: private submission, which the judges flagged; you trust the builder not to trade against you |
| Hide until a deadline, then release publicly | Rejected: measured −3% (run #13); the bot just reacts after the release |
| Encryption inside the hook itself | Rejected: a contract cannot keep secrets; everything on chain is public |
| A new AMM instead of Uniswap | Rejected: gives up Uniswap's liquidity, tooling and trust |
| **Commit-reveal batch auction as a Uniswap v4 hook, with reveals carried by an ERC-8421 custom mempool** | **Chosen.** Public rails only, fairness enforced by the contract, no changes to Uniswap or validators, and any operator can run a revealing node |

## 12. Next steps

1. **Browser backup reveal and settle**, so swaps complete even with no node up.
2. **Larger bond**, and keeper fees paid from the batch.
3. **More operators** running the sealed-mempool plugin.
4. **Institutions:** multisig and policy validators (ERC-8286), HSM-held keys, larger pools, many orders per batch.
5. **Routing** beyond a single sealed pool.

## 13. Status

| Claim | Status |
|---|---|
| Hook logic (netting, one price, refunds, bonds) | ✅ [fork tests](contracts/test/SealedPoolHook.t.sol) 6/6 |
| Front-runs rejected by `beforeSwap` | ✅ local and live devnet |
| Sealed batch at 0% loss | ✅ local (#17, #19, #21) and devnet (#30, passkey runs) |
| Public site with several visitors at once | ✅ tested with simulated visitors |
