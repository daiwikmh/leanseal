# LeanSeal sealed mempool: an ERC-8421 non-standard alternative mempool

**Version:** 3 (adds reveal tickets for the sealed batch-auction pool; public release by default; gossiped between nodes)
**Status:** running on two peered sidecar nodes on our local EIP-8141 devnet, loaded as a custom mempool.
**Mempool id:** the IPFS CIDv0 of this file. A node opts in by listing it under `customMempools` (see Configuration).
**Gossip topic:** `/account_abstraction/<mempool id>/custom_mempool_v1/ssz_snappy`.

## Purpose

The standard alternative mempool shows every pending frame transaction in the clear, so a swap's `amountOutMinimum` can be read and sandwiched. This mempool carries **sealed envelopes** instead.

An envelope has two parts:

- **The box.** The signed frame transaction, encrypted with AES-256-GCM.
- **The label.** The facts a node needs to judge the envelope without opening it:
  - sender, nonce, max cost, chosen builders and deadline round;
  - `txHash`, which binds the label to the box.

The box key is always locked to a **drand time lock (Lock B)**. Anyone can open it once the deadline round is published, and nobody can open it before.

**Default: public release.** The envelope names no builder. It is gossiped to every node in this mempool, and at the deadline every node opens it and puts the transaction into the public standard mempool. No party ever receives the transaction privately.

**Optional, research only: a chosen builder.** An envelope may also carry **Lock A**, the box key wrapped with ML-KEM-768 for named builders, who may open it early and include it. This is private order flow and is not CROPS-aligned, so it is off by default.

Validation never touches the transaction, because nodes cannot read it. These rules bound abuse using only the label, chain state and the sender's ERC-8421 stake.

## Admission rules (network-wide)

A node runs these in order and rejects at the first failure.

| ID | Name | Rule |
|---|---|---|
| SEAL-010 | size | The envelope is at most `maxEnvelopeBytes` (24,000) bytes of JSON. |
| SEAL-020 | shape | `version` is 1, `chainId` is this chain, the hex and decimal fields are well-formed, and `nonceKey` is 0. |
| SEAL-030 | builders | Every named builder is known to the node and has exactly one Lock A. An empty list is valid and means public release at the deadline. |
| SEAL-040 | deadline | `round` is at least `minRoundsAhead` (2) and at most `maxRoundsAhead` (20) drand rounds ahead of the latest round. |
| SEAL-050 | sender-code | `sender` has deployed account code. |
| SEAL-051 | sender-stake | `sender` is a **staked entity** under ERC-8421 STAKING-010: stake of at least `minStakeWei`, and withdrawal not initiated. This is the sybil cost that makes the junk penalties below meaningful. |
| SEAL-052 | nonce | `nonceSeq` is not below the sender's on-chain nonce. |
| SEAL-053 | solvency | The sender's balance covers this envelope's `maxCost` plus the `maxCost` of its other pending sealed envelopes. This mirrors ERC-8421 SOLVENCY-010. |

## Local rules

These depend on the node's own pool and the peer that sent the envelope, so peers are not penalised for them.

| ID | Name | Rule |
|---|---|---|
| SEAL-060 | peer-ban | Reject envelopes from a peer that has collected `peerStrikesBeforeBan` (3) proven junk strikes. |
| SEAL-070 | duplicate | Reject an envelope whose id is already pooled. |
| SEAL-071 | slot | Allow at most `maxEnvelopesPerSlot` (3) pending envelopes per `(sender, nonceKey, nonceSeq)`. |
| SEAL-061 | rate | A peer may send at most `peerEnvelopesPerMinute` (30) envelopes per minute. |

## Lifecycle rules

| ID | Rule |
|---|---|
| SEAL-110 | **Builder submission.** Only a chosen builder may report a submission, and the submitted hash must equal `label.txHash`. |
| SEAL-120 | **Junk.** A builder that opens a box holding anything other than a valid transaction matching its label reveals its Lock A key. The node checks that the key opens the box and that the contents are junk, then strikes the sending peer. A false report is refused, and the real transaction is submitted instead. |
| SEAL-130 | **Deadline release.** When `round` is reached and no builder has submitted, **every** node opens Lock B, checks the opened transaction against the label, and submits it to the public standard alternative mempool. A node that finds it already there (a peer released it first) counts it as released. |

## Propagation

- A node that admits an envelope from RPC publishes it on this mempool's gossip topic.
- A node that receives one over gossip runs the same SEAL rules:
  - **accepted** envelopes are forwarded by gossipsub;
  - **rejected** ones are ignored (not forwarded), and the peer is not penalised, matching the standard mempool's handling of transactions that fail validation.
- Admission reports record the source (`rpc` or `gossip`) and the peer.

## Reveal tickets (sealed batch auction)

Version 3 adds a second kind of message: a **reveal ticket** for a Uniswap v4 pool whose hook (`SealedPoolHook`) only trades in batches.

**The pool.**
- Users deposit into the hook's vault, then commit only `keccak256(hook, user, round, zeroForOne, amountIn, minOut, salt)` for the current batch round (rounds are counted in blocks).
- After the round closes, the order is revealed with `reveal()`, which anyone holding the preimage may call. After the reveal window, `settle()` (callable by anyone) nets buys against sells at the pool price, swaps the remainder once, and gives every order on a side the same price. Orders whose `minOut` the batch price misses are refunded.
- The hook's `beforeSwap` rejects every other swap, so nothing can trade between a reveal and its settlement.

**The ticket.** The user locks the reveal parameters to a drand round that opens inside the reveal window, and gossips the ticket on this mempool. No user needs to come back online: at that round **every** node opens the ticket, checks it against the on-chain commitment, calls `reveal()`, and later `settle()`. Both calls are public transactions from the node's own keeper key, not a private submission.

| ID | Name | Rule |
|---|---|---|
| REV-010 | size | The ticket is at most `maxTicketBytes` (4,000) bytes of JSON. |
| REV-020 | shape | Version 1, kind `batch-reveal`, this chain and this node's configured pool hook, well-formed fields. |
| REV-030 | deadline | The drand round opens between 1 and `maxRoundsAhead` rounds from now. |
| REV-040 | committed | The commitment is on chain in that batch, by the ticket's user, and not yet revealed. |
| REV-050 | duplicate | No ticket for this commitment is already held. |
| REV-060 | rate | The sending peer is under `peerEnvelopesPerMinute`. |

**At the drand round:**
- a ticket whose opened order does not match its commitment is marked junk;
- one a peer already revealed counts as revealed;
- one whose window has closed is marked expired. Its order stays unrevealed, and the user's bond goes to whoever settles.

**Why this stops a sandwich.** Before the reveal, a bot sees only a hash. After it, the pool accepts no swap but the batch's own, and every order on a side gets the same price. There is no "before" and "after" to trade around.

**Limits.**
- A bot can commit blind orders into a batch and choose not to reveal them; it loses its bond.
- A bot sees deposits into the vault, but not which round or direction they are for.

## Relation to the standard mempool

The opened transaction is an ordinary EIP-8141 frame transaction. At release it enters the **public** standard alternative mempool, goes through its ERC-8421 admission, and is gossiped like any other transaction. This mempool adds a sealed waiting room in front of it; it does not relax any standard rule and uses no private submission.

**Limit.** After release, the transaction is public until it is included, roughly one block. A sandwich in that window is possible in principle. Closing it needs fair ordering at execution (for example a batch auction), which is out of scope for version 2.

## RPC

| Method | Purpose |
|---|---|
| `leanseal_sendEnvelope(envelope)` | Submit an envelope. Returns `{ id, mempoolId, gossipedTo }`, or an error naming the failed rule. |
| `leanseal_envelopeStatus(id)` | Returns `sealed`, `builder-submitted`, `deadline-submitted`, `junk` or `failed`, plus who opened it. |
| `leanseal_pendingFor(builderId)` | The sealed envelopes a builder may open. |
| `leanseal_builderSubmitted(id, builderId, txHash)` | Builder report (SEAL-110). |
| `leanseal_reportJunk(id, builderId, key)` | Junk proof (SEAL-120). |
| `leanseal_listAdmissions({ limit })` | The admission report: one entry per envelope, each with SEAL rule verdicts. |
| `leanseal_mempoolInfo()` | This mempool's id, rules, builders, pending count, reveal rules and pool hook. |
| `leanseal_sendRevealTicket(ticket)` | Submit a reveal ticket. Returns `{ id, mempoolId, gossipedTo }`, or an error naming the failed REV rule. |
| `leanseal_ticketStatus(id)` | Returns `locked`, `revealed`, `junk`, `expired` or `failed`, plus the reveal transaction. |

## Configuration (sidecar)

```json
"customMempools": [
  {
    "mempoolId": "<CIDv0 of this file>",
    "module": "../leanseal-node/src/mempool.ts",
    "options": { "configFile": "../leanseal-node/leanseal.config.json" }
  }
]
```
