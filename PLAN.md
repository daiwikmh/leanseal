# LeanSeal plan

LeanSeal is a quantum-safe wallet plus a "sealed lane" mempool. Bots can't read a transaction before it's included, and a timelock guarantees it never gets stuck.

Target bounty: "Best use of the Frame Transaction Alternative Mempool". We aim at track 1a (PQ verification over 100k gas) and track 3 (improve the rules: pre-inclusion privacy).

---

## 1. What EIP-8141 changes, in plain words

Before 8141, Ethereum hard-codes one rule: a transaction is valid if it carries an ECDSA signature from the sender's key. 8141 adds a new transaction type, `0x06`, where **the account's own code decides** whether the transaction is valid and who pays.

| # | Change | Plain meaning | What we use it for |
|---|---|---|---|
| 1 | New tx type `0x06`: `[chain_id, nonce, sender, frames, signatures, fees, blobs]` | A transaction is a list of up to 64 steps ("frames") | Our whole transaction |
| 2 | Frame modes: `DEFAULT 0` (runs as ENTRY_POINT `0xaa`), `VERIFY 1` (read-only check, must call APPROVE), `SENDER 2` (runs as the account) | Steps that check, then steps that act | A VERIFY frame checks the PQ signature; a SENDER frame does the swap |
| 3 | `APPROVE` opcode (`0xaa`) with scope 1 pay / 2 execute / 3 both | The contract says "yes, this is valid" or "yes, I'll pay" | Our wallet approves after the SLH-DSA check passes |
| 4 | `signatures` list, schemes `0 ARBITRARY`, `1 SECP256K1`, `2 P256` | ARBITRARY bytes are never checked by the protocol; the contract reads them with `SIGDATACOPY` and checks them itself | The ~3.8 KB SLH-DSA signature goes here |
| 5 | Introspection opcodes: `TXPARAM` (`0xb0`; `0x08` = sighash), `FRAMEDATALOAD/COPY`, `FRAMEPARAM` (`0xb3`; status, scope), `SIGPARAM` (`0xb4`), `SIGDATACOPY` (`0xb5`) | Contract code can read the whole transaction and the hash to sign | The verifier reads the sighash and the signature |
| 6 | Payer separate from sender (`pay` frame) | Native paymasters, no relayer | Optional: a sponsor pays gas |
| 7 | Atomic batch flag (`0x4`) | All-or-nothing groups of calls | Approve plus swap in one go |
| 8 | Two gas pools per frame (execution and state); receipts are per frame and include `payer`; no tx-level status | Different gas and receipt shape | Tooling must read frame receipts |
| 9 | ORIGIN returns the frame caller; EIP-3607 not applied; TSTORE cleared between frames; nonce bumps on payment approval | Edge-case behaviour changes | Don't rely on `tx.origin` |
| 10 | Public mempool rules: `MAX_VERIFY_GAS = 100,000`, most environment opcodes banned, only the sender's storage readable | Validation must be cheap and predictable, or nodes get DoS'd | **This is why we need an alt mempool**: our check costs 150,627 gas (measured on chain, block 407,933) |

Extras on the devnet: EIP-8250 keyed nonces (several transactions in flight per sender) and EIP-8272 recent-root references.

## 2. How the platform fits together today (devnet 1337)

```
wallet ──eth_sendFrameTransaction──▶ sidecar (Skandha fork, ERC-8421 rules)
                                       │ 1. ethrex_simulateFrameTransaction (trace)
                                       │ 2. check prefix shape, gas, opcodes, storage, stake
                                       │ 3. store + gossip on libp2p topic (one per mempool)
                                       │ 4. every ~10s: ethrex_submitPrivilegedFrameTransaction
                                       ▼
                          ethrex (execution) + Lighthouse (consensus) ── block (6s)
```

- **Alt mempool** = a rule document; its IPFS hash is the gossip topic. The standard one is `QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk`. There's no plugin system: custom rules mean forking the sidecar code (`packages/executor/src/services/UserOpValidation/...`).
- **Validators**: consensus validators don't change. The block producer (ethrex) gets alt-mempool transactions **only** through the sidecar's relayer (`BundlingService/relayers/privileged.ts`), which force-includes them. ethrex's own mempool applies the stricter canonical rules, so a 150k-gas check sent there directly would be rejected.
- **Stake**: `NaiveStakingRegistry` at `0xd51c…2d2f`. The contract must call `addStake` itself; the minimum is 0.01 ETH with a 1-day delay. Stake unlocks the bigger gas budget (BUDGET-010) and extra storage and opcode access.
- **Blocker found in code**: `validationPrefix.ts:288` rejects anything over 100k, **with no staked exemption**. BUDGET-010 (1M for staked) isn't implemented in the sidecar.

## 3. What LeanSeal adds

```
Alice's app ─ sign (SLH-DSA) ─ seal (AES + ML-KEM per builder + tlock to drand round R) ─▶ LeanSeal node
   LeanSeal node: check label signature, cost and stake  ▶ gossip ENVELOPE on topic "leanseal"
   ├─ chosen builder (within window): ML-KEM decrypt ▶ full 8421 validation ▶ privileged submit ▶ block
   └─ after round R (fallback): anyone tlock-decrypts ▶ standard alt-mempool topic ▶ any builder
```

| Actor | Runs | Integration point |
|---|---|---|
| Wallet / sealing kit | TS library: `@noble/post-quantum` 0.7.1, `tlock-js` 0.9.0, `drand-client` 1.4.2 | Produces envelopes |
| PQ account | `SphincsFrameAccount` + SLH-DSA verifier (from the `sphincs` repo) | VERIFY frame, ARBITRARY signature |
| LeanSeal node | Sidecar fork: new RPC `leanseal_sendEnvelope`, envelope pool, drand watcher, BUDGET-010 patch | New gossip topic, plus the existing validation pipeline after opening |
| Builder plug-in | Holds an ML-KEM key, decrypts, hands the opened tx to its sidecar relayer | `relayers/privileged.ts` on the builder's own ethrex |
| Builder registry | Contract: `builderId → ML-KEM pubkey, stake` | Wallets read it to pick builders |

## 4. Phases (each one has a check)

| Phase | Work | Verify by |
|---|---|---|
| 0 | Ask Pierre and Alex: (a) can the public devnet enable the staked 1M budget? (b) can our node or builder relay into devnet ethrex (privileged submit)? (c) how is a custom topic registered? | Written answers; this decides the live-demo path |
| 1 | Local stack: ethrex Docker devnet (`test/e2e/ethrex-devnet.sh`) plus sidecar standalone; submit the workshop `ExampleWallet` tx. Also submit one to the public gateway | Status `OnChain` locally, and the tx visible on explorer.altmempool.wtf (meets qualification) |
| 2 | PQ wallet: deploy `SphincsFrameAccount` + NIST SLH-DSA-SHA2-128-24 verifier on local and 1337; measure gas. Implement BUDGET-010 in `validationPrefix.ts` (1M if the entity is staked); stake the account | Measured verify gas (measured: 150,627 on chain); tx rejected when unstaked and admitted when staked, locally |
| 3 | Sealing kit: envelope format, AES-256-GCM, ML-KEM-768 locks, tlock lock, SLH-DSA label signature | Round-trip tests: builder key opens; wrong key fails; tlock opens only after round R; tampered label rejected |
| 4 | LeanSeal node: envelope RPC and pool, label check (reads `pkSeed/pkRoot` from the account), drand watcher, open → normal validation; penalise the sender if the opened tx doesn't match the label | Two local nodes: an envelope gossips sealed; it opens at R; a mismatched envelope lowers the sender's reputation |
| 5 | Builder registry contract + builder plug-in | Envelope included inside the window without ever appearing in a public pool; fallback path works with the builder offline |
| 6 | Demo: swap on the predeployed Uniswap v4 PoolManager (`0x6bF9…8429848`); a "bot" watching public pools sees nothing until inclusion | Recorded run plus explorer links |
| 7 | README, design explainer, submission | Each claim in the README is backed by a run |

Local run findings (2026-11-06):
- `ghcr.io/forshtat/eip8141-devnet` runs on this Mac (amd64 emulation): chain 9, `ethrex_*` RPC up.
- It stays at block 0. `--dev` crashes: "engine_forkchoiceUpdatedV4 cannot accept Hegotá payload attributes".
- A block-producing local chain needs `deploy/devnet/docker-compose.yml` (ethrex + Lighthouse), not yet tried.

Verified so far (2026-11-06):

| Check | Result |
|---|---|
| Public devnet RPC (ethrex and sidecar, chain 1337) | ✅ answers |
| Workshop installed, throwaway key created | ✅ |
| Devnet faucet | ❌ "The faucet is empty" |
| C SLH-DSA-SHA2-128-24 signer builds | ✅ |
| One signature | ✅ but 354 s single-threaded (one-shot, no cached tree) |
| Message format | the signer needs `0x0000 ‖ msg` (FIPS 205 external envelope) |
| `SphincsFrameAccount`, verifier and Yul module compile | ✅ |
| On-chain verify (anvil) | ✅ valid sig → true; wrong message → false |
| Verifier execution gas | **143,927** (> 100k public cap; confirms alt mempool needed) |
| Funding | ✅ 20 ETH from shared genesis account (user ran it) |
| Gateway → miner gossip | ❌ gateway has 0 peers, manual bundling; send to `altmempool.forshtat.com/rpc` instead |
| Baseline frame txs on 1337 | ✅ `0xc5f733ad…` (block 407611), wallet tx `0xccd618ef…` (block 407619) |
| PQ verifier / module / account on 1337 | ✅ `0x00a8dab9…`, `0x0aed81f7…`, account `0x3197da79…` |
| PQ tx simulated on ethrex 1337 | ✅ executes, VERIFY frame **154,887 gas**, total 268,330 |
| PQ tx to live sidecar | ❌ `400100 exceeds MAX_VERIFY_GAS 100000` (declared limit; no staked exemption) |
| Sidecar BUDGET-010 patch (1M if every prefix entity staked) | ✅ `patches/sidecar-budget-010.patch`, 82/82 tests incl. 3 new |
| Sealed lane as an ERC-8421 non-standard alt mempool (2026-11-06) | ✅ Rules in `docs/leanseal-mempool.md` (12 SEAL rules), mempool id = its IPFS CIDv0 `Qmc4RWzo…AQpnu`. The sidecar loads it through a new `customMempools` config hook (`sidecar/packages/api/src/customMempools.ts`, 3 tests); the plugin is `leanseal-node/src/mempool.ts` (6 tests, node suite 27/27). Sealed swap through the sidecar: 12/12 rules passed, builder-submitted, block 3027, 0% loss. The unstaked lss wallet is refused at SEAL-051. The standalone node on 14400 is retired. |
| Sealed batch auction, CROPS-clean (2026-11-06) | ✅ The uni session's `SealedPoolHook` is deployed locally (CREATE2 with a mined salt, flag `0x0080`, 4-block rounds, 2-round reveals). Alice: PQ deposit, then a PQ commit (hash only), then a drand-locked reveal ticket gossiped on the sealed mempool (rules v3, `QmSjNQxc…`, `REV-*`). Both peered nodes reveal and settle from keeper keys. Runs #17/#19/#21: 0% loss; the bot's front-run was rejected by `beforeSwap` (`OutsideSwap`) 3/3. The public-release sealed lane is still sandwiched (#13, −2.9999%). Tests: leanseal-node 40/40, sidecar api 59/59, executor services 298/298, sealing-kit 17/17, hook fork tests 6/6. |
| One-transaction onboarding, B (2026-11-06) | ✅ `LeanSealCloneAccount` (clone with the key in its code) + `LeanSealFactory` (bare CREATE2) + `SponsorPaymaster`; `workshop/src/onboard/setup_onboard.ts`, `onboard.ts`. The first tx [deploy, VERIFY, pay, SENDER deposit] was mined in block 5478, and the new wallet then batch-swapped (batch 1371, 0% loss). New users must use lss: unstaked means 100k for the whole prefix. Forge tests 6/6. |
| Self-staking `LeanSealAccount` on 1337 | ✅ `0x5ed7367c…`, registry stake 0.01 ETH / 86400 s |
| Our node: precompiles 0x01–0x11 in config | needed: default list is empty, SHA-256 (0x02) was rejected |
| PQ tx admitted by our patched node | ✅ `0x0ed6e07f…`, 17/17 checks pass, status `New` (manual bundling, not relayed) |
| PQ tx included in a block | ✅ block 407,933 on 1337, relayed by our node via `ethrex_submitPrivilegedFrameTransaction`; VERIFY frame 150,627 gas, total 268,330, both frames status 1 |
| Sealing kit (`sealing-kit/`) | ✅ 17/17 tests (ML-KEM-768 locks, AES-GCM box with label as AAD, live drand quicknet tlock open/refuse); typecheck clean |
| Real PQ tx sealed + opened | ✅ 3,997-byte tx → 11,375-byte envelope (1 builder), opens byte-identical, label checks pass |
| Fast signer (`signer/`): 16 threads + ARMv8 SHA-256 | ✅ 354 s → 26.8 s, byte-identical |
| XMSS cache (once per wallet, 9.6 s, 128 MiB) | ✅ signing 3.0 s, byte-identical, self-verifies |
| PQ Uniswap swap (ETH→tUSD) | 🟡 signed in 3.0 s, ethrex sim both frames OK (swap 107,983 gas), admitted by our node, relayed; not mined: devnet stalled at block 408,262 |
| Local chain (`localnet/`): ethrex + Lighthouse, Uniswap + registry replayed, PQ wallet `0xc773…` | ✅ PQ transfer block 77 (VERIFY 149,607 gas) |
| MEV experiment A (public alt mempool, 3% slippage) | ✅ bot sandwiched: front-run block 116, victim 119, back-run 120; Alice got exactly her min = **−3.000%**; bot +2.09e12 wei before gas (`localnet/runA-*`) |
| MEV experiment B (sealed, same bot, same settings) | ✅ bot saw only ciphertext ("cannot target"); builder opened in ~1 s, block 125 (VERIFY 146,322, swap 106,955 gas); Alice got quote −4 wei (rounding) = **0%** loss; ~11.6 s sign→block (`localnet/runB-*`) |
| LeanSeal envelope node + builder (`leanseal-node/`) | ✅ 21/21 tests (door checks, slot cap, rate limit, builder path, junk proven by revealing K, live-drand deadline fallback); mutation check bites; tsc clean. Not yet run against the devnet |

Fallbacks if Phase 0 says no:
- Run our patched node plus our own ethrex locally for the 150k path.
- On the public devnet, submit the sealed flow with a sub-100k PQ variant (SPHINCS- C7 at ~96K; it isn't NIST, and the margin is tight, so measure it first).

## 5. Risks and open questions

- **NIST parameter set mismatch.** noble implements the standard SLH-DSA sets, but the on-chain verifier (150,627 gas measured) is the "128-24" set. Signer and verifier must match, so we may need the sphincs repo's signer. Check this first in Phase 2.
- **tlock is not quantum-safe** (BLS). It only protects the ~24s window; afterwards the tx is public anyway.
- **The chosen builder sees the tx.** This is the same trust model as Flashbots Protect. Mitigation: stake, reputation, and several builders racing.
- **One tx in flight per sender** on the devnet. Use keyed nonces (8250) if needed.
- **Devnet resets** change addresses. Keep deploy scripts idempotent.

## 6. Design breakdown

### Storage
- **Durable on chain:** the PQ account (public key in immutables), stake in the registry, and the builder registry (ML-KEM public keys).
- **Durable off chain:** Alice's SLH-DSA private key (wallet) and each builder's ML-KEM private key. Losing either is unrecoverable for that party.
- **Memory only:**
  - The envelope pool in each LeanSeal node, the same as the sidecar mempool (the sidecar has rocksdb/local DB options; we'll keep envelopes in memory). If the node restarts before opening, its envelopes are lost; other peers still hold copies, and the wallet resends after the deadline.
  - The random key K, discarded after sealing.
- **Reputation counters:** per mempool, stored the way the sidecar already stores them.

### Latency
- **The wallet waits on:** SLH-DSA signing (not yet measured on a phone; it's the slowest step) plus ML-KEM and tlock (fast).
- **Inclusion:**
  - Builder path: next relay tick (sidecar auto-bundles about every 10s) plus a 6s block.
  - Fallback path: deadline R (~24s), then ≤3s for the drand beacon, then the normal path.
- **Clocks:** window length (config), drand 3s rounds, the bundling interval, and the 6s block time.
- **Net effect:** inclusion gets **slower** than a plain public tx in the fallback case, and roughly the same in the builder case. Privacy is the gain, not speed.

### New schema
- **Envelope:** `{label{sender, maxCost, round, builderIds[], boxHash}, labelSig, box, lockA[], lockB}`.
- **Builder registry contract:** `mapping(bytes32 builderId => {bytes mlkemPub, address operator})`, plus `register()` and `remove()`.
- **Sidecar config keys:**
  - `leanseal.topic`;
  - `leanseal.windowRounds`;
  - `leanseal.drandChainHash` (quicknet);
  - `leanseal.drandUrl`;
  - `leanseal.builderRegistry`;
  - `maxVerifyGasStaked` (BUDGET-010, default 1,000,000).
- **New RPC methods:** `leanseal_sendEnvelope`, `leanseal_envelopeStatus`.
- **Gossip topic:** `/account_abstraction/<leanseal-id>/envelope/ssz_snappy`.
- No database tables; no changes to the existing frame tx SSZ format.

### Better approach

| Option | Privacy | Liveness | PQ | Effort | Verdict |
|---|---|---|---|---|---|
| Do nothing: plain alt mempool with a PQ wallet | None (bots see everything) | ✅ | ✅ | Low | Rejected: only track 1a, no product story |
| Private RPC to one builder (Flashbots-style) | Trust one party | ❌ (builder can hold it) | Partial | Low | Rejected: not new, single point of failure |
| Threshold encryption committee (Shutter-style) | ✅ | Depends on committee | ❌ | High | Rejected: too much for a hackathon |
| **Sealed lane: ML-KEM to chosen builders + tlock fallback** | Trusted builders only during the window | ✅ (always opens at R) | ✅ (except the tlock layer) | Medium | **Chosen** |
| Keep envelopes only in memory vs a DB | n/a | n/a | n/a | — | In memory: envelopes live seconds, and peers hold copies |

**Recommendation:** build the sealed lane on a sidecar fork with the BUDGET-010 patch. It's the only option that covers both tracks, stays live without trusting anyone forever, and keeps every signature and lock quantum-safe except the short-lived timelock.
