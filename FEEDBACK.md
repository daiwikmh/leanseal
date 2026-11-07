# Uniswap v4: developer feedback from LeanSeal

**Project:** LeanSeal, a sealed batch auction on Uniswap v4 that stops sandwich attacks inside the EVM, with quantum-safe wallets.
**What we built on Uniswap:** [`SealedPoolHook.sol`](contracts/src/SealedPoolHook.sol), a v4 hook with commit → reveal → settle, one price per side, and a `beforeSwap` guard that rejects every swap outside the batch.
**Where it runs:** our local EIP-8141 chain and the public hackathon devnet (chain 1337), on the devnet's existing PoolManager `0x6bF9Aa9c04fd001385742d61f6818C3236429848`.
**Design doc:** [`uniswap-use-description.md`](uniswap-use-description.md) · **Live:** https://leanseal.vercel.app/

## What worked well

- **Hooks are the right extension point.** We enforced fairness in the pool's own code, with no fork of v4 and no changes to the PoolManager.
- **`unlock` and flash accounting** made batch settlement clean: inside `unlockCallback` we net buys against sells at the pool price, swap only the remainder once, then settle and take the balances.
- **`beforeSwap` reverting** was enough to block every outside swap, including real front-run attempts from our MEV bot (`OutsideSwap`).
- **Native ETH as currency0** removed the WETH wrapping step for users.

## Where we lost time

1. **Mining the hook address.** Permissions live in the hook's address bits, so before every deploy we mined a CREATE2 salt until the address carried exactly the `beforeSwap` flag (`0x0080`) and nothing else ([`setup_batch_pool.ts`](workshop/src/batch/setup_batch_pool.ts)). A standard factory or helper in the SDK, plus a short doc page with the flag mask, would save every hook team this step.

2. **Reading the pool price from inside a hook.** To net orders at the current price, the hook reads `slot0` through `extsload`, using the internal storage slot of the pools mapping (`keccak256(poolId, 6)`). That depends on PoolManager's storage layout. A documented, stable read path for hooks (outside the separate StateView contract) would remove that fragility.

3. **Decoding hook reverts.** A revert in `beforeSwap` reaches the caller wrapped in `WrappedError`, so our tooling showed garbled reasons until we decoded the raw data by hand to find the `OutsideSwap` selector. A decoding helper, or a doc example of unwrapping hook errors, would help.

4. **Settling native ETH versus ERC-20 in `unlockCallback`.** Getting the right `sync` / `settle` / `take` order (`settle{value}` for ETH; `sync`, transfer, `settle` for the token) took trial and error. A worked example for custom-accounting hooks that handle both directions would help.

5. **Failing one order without failing the batch.** We signal a per-order `minOut` miss by reverting with the order index, catching it outside `unlock`, excluding that order and retrying. It works, but a documented pattern for partial fills or exclusions in custom-accounting hooks would make this less hand-rolled.

6. **No reference hook for batch or commit-reveal flows.** MEV protection through batching (netting, one price per side, refunds, commit-reveal timing) is a common idea but we found no reference implementation. An official example would make on-chain MEV protection much easier to build.

7. **Quoting for custom-accounting hooks.** We re-implemented the exact-in quote math ourselves to show users an estimate before they commit. A small, documented quoting helper for hooked pools would help front-ends.

## Suggestions

- An SDK helper: `mineHookSalt(deployer, initCode, flags)`.
- A doc page: "reading pool state from a hook", covering `extsload`, StateView, and what is stable across versions.
- Example hooks: a batch auction and a commit-reveal swap, with tests.
- Error docs: how `WrappedError` wraps hook reverts, and how to decode them.

## Rating

Ease of use: **7/10**. Hooks, `unlock` and flash accounting were a pleasure to build on; the friction was in deployment (address mining), reading state from inside a hook, and error decoding.
