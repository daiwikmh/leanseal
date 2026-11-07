# Live alt mempool rejects precompile calls in validation frames (CALLING-040)

> **Update:** fixed on the live devnet. On a re-test, the same staked SHA2 wallet transfer was admitted and mined: `0xeb569198ae239d241ea5630d82f20230180f89ca972a7fa1753963f03bc13d4c`, block 5463. Unstaked senders remain capped at 100k.

**Where:** live devnet 1337. Both the miner (`https://altmempool.forshtat.com/rpc`) and the gateway (`https://altmempoolgateway.forshtat.com/rpc`) do this. Tested 2026-11-06, block ~2,370.

## Summary
A staked sender's VERIFY frame that `STATICCALL`s the SHA-256 precompile (`0x02`) is rejected with:

```
payer accesses un-deployed contract address 0x0000000000000000000000000000000000000002 with opcode STATICCALL
```

ERC-8421 **CALLING-040** says: "Precompiles that access nothing in the blockchain state or environment are allowed. These include the core precompiles `0x01` to `0x11` and the `P256VERIFY` precompile." So the transaction should pass this rule.

Every verifier that uses a precompile is affected. That includes the NIST post-quantum signature SLH-DSA-SHA2 (FIPS 205), which hashes with `0x02`. It also affects anything using `ecrecover` (`0x01`), `modexp` (`0x05`), BN254 pairing (`0x08`, i.e. Groth16 / privacy-pool proofs) or BLS12-381 (`0x0b`–`0x11`).

## Root cause
`packages/executor/src/services/UserOpValidation/validators/frameTx.ts`, in the `CODE_ACCESS` check: an accessed address with code size ≤ 2 is allowed only if it appears in `networkConfig.precompiles`.

`packages/executor/src/config.ts:671` sets the default to `precompiles: []`, and the devnet config doesn't override it. So every precompile counts as "un-deployed".

## Reproduction
1. Deploy any account whose VERIFY frame calls `sha256` (precompile `0x02`) and then `APPROVE`s, and stake it in the registry (`0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f`).
   Ours is `0x5856f49462d10eda6211c773622b25d558119f0a`: a SLH-DSA-SHA2-128-24 SPHINCS+ frame account, staked 0.012 ETH with an 86,400 s delay.
2. Send a self-pay frame tx: `[VERIFY(self_verify), SENDER(transfer 1 gwei)]`, with the verify limit at 200k.
3. `eth_sendFrameTransaction` to the miner or the gateway rejects it with the error above.
   `ethrex_simulateFrameTransaction` on the same tx returns `executionStatus: success`, so the transaction itself is valid.

**Control:** the same account code with a keccak-only verifier, which calls no precompile, is admitted and mined on the live devnet. Same stake, verify limits 200k, 1M and 1.2M:
- `0x578872eea2f4325f9d06a791a2d7c81d319bb08f12e184f0404da3723706c805` (block 2365)
- `0xdf844822708d212cea3836715241887899d1bb47e34e22cf2a37d2d7b37d19db` (block 2370)
- `0x38280e7431ac58bde55624399f569ddaae04748037dd7412661f9e2e17228af0` (block 2372)

## Suggested fix
Default `precompiles` to the CALLING-040 set: `0x01`–`0x11` plus `P256VERIFY` (`0x100`). Alternatively, add that list to the devnet config.

We confirmed the config route on a local ethrex devnet: adding `0x01`–`0x11` to `precompiles` in `config.json` gets the same SHA2 transaction admitted and mined.

## Side observation
The staked verify budget accepted **1.2M**, which is above ERC-8421's `MAX_VERIFY_GAS_STAKED_ENTITY = 1_000_000`. Either the live node uses a higher cap or it doesn't cap staked entities. Unless that's intended, it may be worth aligning with the spec.
