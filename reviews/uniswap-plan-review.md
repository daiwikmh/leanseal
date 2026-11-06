# Review: uniswap-plan.md ("LeanSeal × Uniswap v4")

Read-only review, 2026-11-05/06 UTC. Devnet: `https://altmempool.forshtat.com`, chain 1337 (confirmed with `cast chain-id`), head about 408,086. Only `eth_call`, `eth_getCode`, `eth_getLogs`, `eth_getBalance`, `eth_gasPrice` and `eth_getTransactionReceipt` were used. No transactions were sent and no `debug_*` calls were made.

## 1. Findings

| # | Doc claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Universal Router command `0x10` = `V4_SWAP` | CONFIRMED | Uniswap/universal-router `contracts/libraries/Commands.sol`: `V4_SWAP = 0x10`, `PERMIT2_PERMIT = 0x0a`, `WRAP_ETH = 0x0b` |
| 2 | `UniversalRouter.execute(commands, inputs, deadline)` | CONFIRMED | `UniversalRouter.sol`: `execute(bytes,bytes[],uint256) external payable checkDeadline` reverts `TransactionDeadlinePassed` when `block.timestamp > deadline`. Selector `0x3593564c` is present in the devnet router bytecode (`cast code 0x5e22…e2be`) |
| 3 | Permit2 allowance flow: ERC-20 approves Permit2, then Permit2 approves the router | CONFIRMED | developers.uniswap.org v4 "swapping" guide: approve Permit2 with `type(uint256).max`, then `permit2.approve(token, router, amount, expiration)` |
| 4 | "This setup transaction can happen beforehand. It doesn't need to reveal the actual pending swap amount" | WRONG / overclaimed | A bounded `permit2.approve(token, router, amount, expiration)` sent as a separate public tx reveals tokenIn, an upper bound on size and the intent to trade soon. Fixes: put both approvals inside the sealed frame tx (see #11), or use a standing max allowance (this still reveals the token) |
| 5 | Hooks are fixed at pool initialization | CONFIRMED | `hooks` is part of `PoolKey`. I recomputed `keccak(abi.encode(c0,c1,fee,ts,hooks))` and it equals the documented pool ID `0x784b…0648`. Several devnet pairs exist twice, once with and once without a hook, under different IDs |
| 6 | The walk-through uses "Alice has 10 ETH … ETH/USDC pool", but the MVP scope says "ERC-20 input" plus Permit2 | Inconsistent | With native ETH input (currency0 = `address(0)`) the SENDER frame carries `value` (EIP-8141: only SENDER frames may have non-zero value) and no Permit2 step is needed. That makes it the simplest Milestone 1 |
| 7 | "Verifier already uses 154,887 gas" | OUTDATED | The on-chain receipt for `0x0ed6e07f…` shows `frameReceipts[0].gasUsed = 0x24c63` = 150,627 and total `0x4182a` = 268,330 |
| 8 | "Live sidecar still rejects it at 100,000" | OUTDATED (partly) | Our patched sidecar admitted the tx and relayed it into block 407,933 (PLAN.md status table). Upstream public sidecars without the patch still reject it. Say so explicitly |
| 9 | "Staked 1M budget not implemented in the validation prefix" | OUTDATED | `patches/sidecar-budget-010.patch` implements it (82/82 tests). It exists in our fork, not upstream |
| 10 | "Envelope delivery and builder execution remain unfinished" | CONFIRMED | PLAN.md: "LeanSeal envelope node, builder plug-in ⬜ not built" |
| 11 | Approvals need prior txs (implied) | WRONG (they don't) | EIP-8141 (ethereum/EIPs `eip-8141.md`): the atomic-batch flag `0x4` is valid on SENDER and DEFAULT frames. A batch is a maximal contiguous run of frames, all succeed or all roll back, and approval flags are not allowed inside a batch. So `[VERIFY self_verify 0x3] [SENDER USDC.approve(Permit2) +0x4] [SENDER Permit2.approve(USDC,router,amt,exp) +0x4] [SENDER router.execute]` is one atomic, sealed tx. In SENDER frames `msg.sender` = account, so both approvals bind to the account. PLAN.md row 7 already says this |
| 12 | "The user's signature must bind token, amounts, minOut, recipient, router, calldata, chain, nonce" | CONFIRMED (already satisfied) | The canonical sighash is `keccak(type ‖ rlp(tx))` and covers every frame's mode, flags, target, limits, value and data, plus chainId and nonce (EIP-8141). The VERIFY frame reads `TXPARAM(0x08)` (PLAN.md row 5). The alt-mempool docs (`rules/signatures.md`) warn that approval covers *all* following SENDER frames, so the wallet must sign the sighash and never an app-level digest |
| 13 | Option A: "SphincsFrameAccount —CALL→ UniversalRouter" | CONFIRMED, with a clarification | The account does not CALL. The SENDER frame's *target* is the router, and the protocol supplies `msg.sender = tx.sender`. `execute()` (self-only) is not needed. A null target plus `execute(router,…)` also works, but adds gas for nothing |
| 14 | Recommends adding chainId/nonce/expiry/tx commitment to the envelope | CONFIRMED (partly redundant) | chainId and nonce are already committed by the sighash inside the box. The real gap is the binding between the label and the plaintext: the label should carry `keccak(signed tx)` or the sighash plus the expiry, and the builder must check it after opening |
| 15 | Deadline / minAmountOut | Incomplete | Universal Router `deadline` only makes the *SENDER frame* revert. VERIFY has already passed by then, so the user still pays gas, and a stale fallback-opened tx still lands as a paid revert. Add an `expiry_verify` frame (canonical `EXPIRY_VERIFIER`, allowed first in every prefix shape, `rules/prefix.md`) so expired txs are *invalid* and get dropped. Order: `expiry ≤ router deadline`. The drand round R must open *before* the expiry, otherwise the fallback is dead on arrival. Set minAmountOut in both `SWAP_EXACT_IN_SINGLE.amountOutMinimum` and `TAKE_ALL.minAmount` |
| 16 | Builder trust, leaks and front-running | CONFIRMED, missing items | Missing items: the builder can sandwich *within the slippage bound* and can choose *when* inside the deadline to include. minAmountOut is the only protection, so recommend tight slippage. On this devnet the "builder" is our own node relaying into the single shared ethrex sequencer through `ethrex_submitPrivilegedFrameTransaction`, so the devnet operator sees the plaintext before inclusion. The demo proves privacy from the public pool only, not from the sequencer |
| 17 | Fallback is liveness, not guaranteed inclusion; tlock BLS is not PQ | CONFIRMED | Matches PLAN.md. Also: once round R opens, the plaintext is public to every searcher (same exposure as the public mempool) |
| 18 | Quote privacy: "local RPC reads and on-chain quoting" | Partly WRONG for this devnet | `V4Quoter` through `eth_call` on the shared RPC sends amount and route to the RPC operator. Read `StateView.getSlot0`/`getLiquidity` (amount-independent) and compute the quote locally, or run your own node |
| 19 | EIP-8141 per-frame receipts and payer | CONFIRMED | The receipt has `frameReceipts[]` with `gasUsed`, `stateGasUsed`, `status` and a top-level `payer`. `LeanSealExecutionReceipt.executionStatus` must come from the SENDER/router frame's status, not from the tx `status` |
| 20 | EIP-1153 transient storage needed | CONFIRMED (indirect) | 51 v4 pools are initialized and 49 have liquidity minted through PositionManager on this chain, and that path needs transient storage |
| 21 | "Swap gas" budget | UNVERIFIED | I did not simulate: building a frame tx needs a signature, and `debug_*` was out of scope. The mainnet ballpark is about 120–180k execution gas for a single-hop UR v4 swap, plus about 46k each for the two approvals. Also needs state gas for new storage slots (Permit2 allowance, first-time USDC balance). The ~183,600 new-account figure only applies if a *new account* is created, and the recipient account already exists. Measure with `eth_estimateGas` or a local ethrex run. The block gas limit is 60M and the price 2 gwei, so the size of the budget is not a problem |
| 22 | Doc repo layout lists `contracts/SphincsFrameAccount.sol` | Minor mismatch | The deployed sender is `LeanSealAccount` (self-staking), which extends SphincsFrameAccount |
| 23 | PLAN.md row 10 says "our check costs ~142k" | Internal inconsistency (PLAN.md) | The measured figure is 150,627 |

## 2. Devnet inventory (chain 1337, checked via `cast codesize` / `cast call`)

| Item | Address / ID | Status |
|---|---|---|
| PoolManager | `0x6bF9Aa9c04fd001385742d61f6818C3236429848` | Present (24,009 B). Router, PositionManager, StateView and Quoter all return it from `poolManager()` |
| Universal Router | `0x5e2250a42608a5cc9f62e23ab24824ee25b5e2be` | Present (24,380 B). `execute` selectors present. v2/v3 paths revert (no factories), per devnet.md |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Present (9,152 B) |
| PositionManager | `0x5bF24B2CD6f4cc0057F4BeD53264d591620Af57B` | Present. `nextTokenId` = 101 |
| StateView | `0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB` | Present |
| V4Quoter | `0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D` | Present |
| WETH9 / USDC (predeploy) | `0x1b7d…87b6` / `0xEFe0…6AF5` | Present |
| **WETH9/USDC pool** `0x784b…0648` (devnet.md) | — | **Checked: ABSENT.** `getSlot0` = 0 and `getLiquidity` = 0. It was wiped in the 2026-10-08 reset, as devnet.md itself says |
| Any pool using the canonical USDC, USDT or LINK | — | **Checked: ABSENT.** None of the 51 `Initialize` events name them |
| Other liquid pools | e.g. WETH9/kUSD `0xe873…5fe8` (no hook, L≈1.6e14), ETH/pqUSD (no hook, L≈4.5e18), ETH/fgUSD ×5 | Present, but the tokens were deployed by unknown third parties and liquidity is tiny. Not a dependable demo pool |
| LeanSealAccount `0x5ed7…059b` | — | 0.00246 ETH, 0 USDC, 0 WETH, Permit2 allowance for (USDC, router) = 0. **Needs funding** |
| EXPIRY_VERIFIER address | — | **Couldn't check.** The docs name it but give no address |

## 3. Recommended Milestone-1 build list

1. **Seed our own pool**, using a funded EOA we control, not the published deployer key: `PositionManager` `initializePool` + `modifyLiquidities` for native **ETH/USDC** (`currency0 = address(0)`, fee 3000, tickSpacing 60, no hooks), with enough depth for the demo size. A deployer-owned USDC mint, or a USDC transfer from someone who holds it, is needed. Record the pool ID in devnet.md.
2. **Fund LeanSealAccount** with ETH for the swap and gas. Check its stake is still active.
3. **Frame-tx builder (M1a, ETH→USDC):** `[VERIFY self_verify 0x3, SLH-DSA over sighash] [SENDER → router.execute(0x10, [V4 actions SWAP_EXACT_IN_SINGLE(minOut), SETTLE_ALL, TAKE_ALL(minOut)], deadline), value = amountIn]`. No Permit2.
4. **M1b, USDC→ETH:** add the two atomic-batched approval SENDER frames (`0x4`) before the router frame, in the same tx.
5. **Optional `expiry_verify` frame**, once the EXPIRY_VERIFIER address is confirmed. Set expiry ≤ deadline.
6. **Local quote** from `StateView` reads. No Quoter `eth_call` on the shared RPC.
7. **Gas:** measure VERIFY, SENDER execution and state gas separately via `eth_estimateGas` or local ethrex. Set per-frame `limits.state` explicitly.
8. **Receipt parser** for `frameReceipts[]` and `payer`, plus decoding of the PoolManager `Swap` event and the USDC `Transfer` event.
9. **Submit** through the patched sidecar (BUDGET-010), as for tx `0x0ed6e07f…`.
10. **Update uniswap-plan.md:** the outdated gas and sidecar statements, the Permit2 privacy claim, and the ETH-vs-ERC-20 inconsistency.
