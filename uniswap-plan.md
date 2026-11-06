LeanSeal × Uniswap v4: Architecture review and implementation design
My recommendation is to build LeanSeal as a private transaction execution layer for Uniswap, rather than building a new AMM or trying to put the encryption mechanism inside a Uniswap hook.

The two systems solve different problems:
- LeanSeal: Who can see a transaction before inclusion, who can authorize it, and how it reaches a block.
- Uniswap: How the transaction interacts with liquidity, pools, routing, token settlement, and swaps.
They fit together at the transaction execution boundary.

I reviewed your LeanSeal implementation notes alongside the official Uniswap documentation, particularly v4 Architecture, PoolManager, Flash Accounting, Universal Router, Permit2, Hooks, and Smart Wallet.
1. Review of the two existing architectures
A. LeanSeal today
Your architecture has four main layers:
1. Account and authorization

SphincsFrameAccount + SLH-DSA + EIP-8141 VERIFY frame.


2. Transaction sealing

AES-256-GCM + ML-KEM-768 builder encryption + drand timelock.


3. Alternative mempool

Skandha sidecar fork, envelope pool, custom gossip, validation and privileged relay.


4. Execution

ethrex + Lighthouse + block inclusion.


The important part is that LeanSeal does not need to understand every application that a transaction interacts with. It needs to validate the transaction, protect it while pending, and deliver it to execution.

That is a good separation of responsibilities.

Your actual progress is meaningful: the SLH-DSA verifier has been deployed and tested on devnet 1337, and the 154,887-gas VERIFY execution confirms why the alternative mempool is needed. However, the live sidecar still rejects it at 100,000 gas, and envelope delivery and builder execution remain unfinished. Pasted text(20261105-221632).txt

B. Uniswap v4 today
Uniswap v4 has a different architecture.
Universal Router

Command-based entry point for swaps and position actions


PoolManager

Singleton managing all v4 pool state and operations


Pool execution

Swaps · Liquidity · Settlement · Flash Accounting

Hooks

Optional external contracts called around pool operations. They customize pool behavior but do not control public mempool visibility.


The key points from Uniswap's documentation:
- PoolManager is a singleton. All v4 pools are maintained through it.
- Universal Router supports v2, v3 and v4 operations, including chained operations and Permit2.
- Hooks can intercept pool actions, but are attached when a pool is initialized.
- Flash Accounting uses transient storage and net balance deltas to settle operations efficiently. 
  Uniswap Developers+4
Architectural conclusion: We should integrate before the Universal Router, not inside PoolManager.

That means existing Uniswap v4 pools can be used without modifying their contracts or deploying a new hook.

2. Proposed integrated architecture
I'd add one new concept to the existing LeanSeal design:

An application execution adapter.

This is the boundary between the generic LeanSeal transaction infrastructure and DeFi protocols.

For the first implementation, the adapter will support Uniswap v4.
LeanSeal execution architecture
USER / DAPP

Select pool, token pair, amount, slippage and recipient

Build swap intent and obtain a quote


LEANSEAL WALLET

EIP-8141 transaction · SLH-DSA signature


SEALING KIT

AES-GCM · ML-KEM builder locks · drand fallback


LEANSEAL NETWORK

Envelope RPC · Gossip · Admission · Builder registry


Builder path

ML-KEM decrypt → validate → relay


Fallback path

Timelock decrypt → alternate relay




ETHREX EXECUTION

EIP-8141 account validates and executes its SENDER frame


UNISWAP EXECUTION ADAPTER

Calls Universal Router with authenticated swap calldata


UNISWAP v4 POOLMANAGER

Swap · Hook callbacks · Flash Accounting · Settlement


Notice something important: the builder does not need custom Uniswap logic to decrypt and submit a swap. It needs the normal transaction execution infrastructure. The application-specific logic is already encoded in the signed frame transaction.

The execution adapter is primarily a reusable integration boundary, not necessarily a contract that has to custody funds.
3. What actually happens when a user makes a private swap?
Let's walk through a concrete example.

Alice has 10 ETH in her LeanSeal smart account and wants to swap it for USDC through an existing Uniswap v4 ETH/USDC pool.
Step 1 — Construct the swap
The frontend builds a swap intent:
interface PrivateSwapIntent {
  chainId: number;
  account: `0x${string}`;

  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;

  amountIn: bigint;
  minAmountOut: bigint;

  recipient: `0x${string}`;
  deadline: number;

  router: `0x${string}`;
  routerCalldata: `0x${string}`;
}


The frontend obtains the current pool state and calculates an acceptable minimum output.

An important privacy decision: don't send Alice's order size and route to a third-party quote service without considering the information it reveals. For a privacy-oriented product, I'd initially quote using local RPC reads and Uniswap's onchain quoting infrastructure.
Step 2 — Construct the Universal Router call
The transaction targets Universal Router, not the individual pool.

Conceptually:
UniversalRouter.execute(
    commands,
    inputs,
    deadline
);


The router's command 0x10 is V4_SWAP. Its command stream also supports payment and position-management operations. This gives us a standardized way to build the execution payload. 
Uniswap Developers+1


For the initial implementation, support only:
- One v4 pool.
- Exact-input swap.
- ERC-20 input.
- Fixed recipient.
- Minimum output.
- Deadline.
Don't start with multi-hop, partial fills or liquidity positions.
Step 3 — PQ authorization
The wallet creates the EIP-8141 frame transaction.

Conceptually:
Frame 1: VERIFY
  - Read transaction sighash
  - Read SLH-DSA signature
  - Verify signature
  - APPROVE execution

Frame 2: SENDER
  - Call UniversalRouter.execute()
  - Execute the prepared v4 swap


This is the most important design decision:

The builder must not construct or modify the swap. It only decrypts and relays the already-authorized transaction.

The user's signature must bind all economically relevant parameters, including token addresses, input amount, minimum output, recipient, router, calldata, chain and nonce.
Step 4 — Seal the transaction
The wallet seals the complete signed frame transaction.
Signed frame transaction
          |
          v
     Random AES key
          |
          v
   AES-256-GCM encryption
          |
          +---- ML-KEM-768 lock for builder(s)
          |
          +---- drand timelock fallback
          |
          v
       Envelope


One improvement I'd make to your envelope schema: explicitly include chainId, nonce, expiry and a signed transaction commitment. The current label has sender, maxCost, round, builderIds and boxHash. That is a good starting point, but replay protection and binding of the envelope metadata to the exact authorized transaction need to be explicit. Pasted text(20261105-221632).txt

Step 5 — Builder execution
The selected builder:
1. Receives the envelope.
2. Decrypts using its ML-KEM private key.
3. Checks the envelope and transaction commitments.
4. Submits the original EIP-8141 transaction through the existing privileged relay.
5. Tracks the transaction's inclusion and execution result.
The builder does not need to sign a replacement swap transaction.
Step 6 — Uniswap executes
The execution chain becomes:
ethrex
  |
  v
EIP-8141 Account
  |
  | VERIFY: SLH-DSA approved
  |
  | SENDER: external CALL
  |
  v
Universal Router
  |
  | V4_SWAP
  |
  v
PoolManager
  |
  | swap()
  | beforeSwap / afterSwap (if configured)
  | update transient deltas
  |
  v
Settlement
  |
  v
USDC received by Alice


The PoolManager's locking and settlement mechanics are handled by the router. This is why I'd prefer Universal Router over writing our own direct PoolManager integration for the first version. 
Uniswap Developers+2

Step 7 — Produce a receipt
I'd introduce a LeanSeal execution receipt:
interface LeanSealExecutionReceipt {
  envelopeId: string;
  transactionHash: string;

  account: string;
  builderId: string;

  protocol: "UNISWAP_V4";
  router: string;
  poolId: string;

  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;

  sealedAt: number;
  openedAt: number;
  includedAt: number;

  blockNumber: bigint;
  executionStatus: "SUCCESS" | "REVERTED";
}


This makes the product more than an encrypted mempool. It gives the user an auditable record of how their private transaction was handled.

For EIP-8141, your implementation must also account for the per-frame receipts and payer information rather than assuming a conventional transaction-level status. Pasted text(20261105-221632).txt


4. Where should the smart contracts live?
I would avoid modifying the existing LeanSeal contracts unnecessarily.

Here's the proposed contract architecture:
Component	Responsibility
SphincsFrameAccount	PQ authorization and frame execution
LeanSealBuilderRegistry	Builder identity, public key, stake and status
LeanSealSwapExecutor	Optional application adapter and execution safeguards
Uniswap Universal Router	Routing and executing the swap
Uniswap PoolManager	Actual pool execution

Do we need LeanSealSwapExecutor?
Not necessarily.

There are two implementation approaches.

Option A — Account directly calls Universal Router
SphincsFrameAccount
        |
        | CALL
        v
UniversalRouter
        |
        v
PoolManager


This is my preferred approach for the initial MVP.

Option B — Introduce an executor
SphincsFrameAccount
        |
        v
LeanSealSwapExecutor
        |
        v
UniversalRouter
        |
        v
PoolManager


The executor can enforce additional restrictions, such as approved routers, supported chains, maximum swap size, recipient restrictions and minimum output.

However, it adds another contract and another trust boundary. I'd only introduce it when those controls are actually required.
Token approvals: an important integration detail
Universal Router integrates with Permit2.

A practical first implementation can use Permit2's allowance-based flow:
1. The account approves Permit2 through the ERC-20 token.
2. The account grants Universal Router a bounded Permit2 allowance.
3. The private swap executes through Universal Router.
4. The router uses its Permit2 permissions to transfer the input token.
Permit2 documents both time-bound allowances and signature-based transfers. 
Uniswap Developers+1


I'd initially use allowance-based authorization rather than depending on Permit2 signature compatibility with SLH-DSA. The LeanSeal account should handle the PQ authorization itself.

This setup transaction can happen beforehand. It doesn't need to reveal the actual pending swap amount.

5. Do we need to build a Uniswap hook?
My recommendation is not initially.

There are three possible integration levels:
Integration	What it achieves	Priority
Private swaps through existing v4 pools	Pre-inclusion transaction privacy	1
LeanSeal execution adapter	Application-level execution safeguards	2
Custom v4 hook	Pool-specific fees, authorization or execution policies	3

The distinction matters because a hook runs during pool execution. It cannot hide the pending transaction from the public mempool.

Also, hooks are specified when a v4 pool is initialized. You cannot simply attach a new LeanSeal hook to an already initialized pool. 
Uniswap Developers+1


Later, we could deploy a dedicated LeanSeal-enabled pool with a hook.

For example:
- Different fee treatment for transactions meeting certain execution policies.
- Restrict swaps to approved smart accounts.
- Custom limit-order or execution policies.
- Additional pool-specific validation.
But those would be additional features, not the mechanism providing privacy.
6. Important problems I would address in the current architecture
There are a few things I would change before integrating Uniswap.
1. Don't confuse transaction privacy with pool privacy
LeanSeal protects the pending transaction, not the Uniswap pool.

Once a transaction is included:
- Its calldata becomes public.
- Its swap parameters can be inspected.
- The swap is observable through chain data and events.
- Anyone can analyze the resulting pool state.
Therefore, the product promise should be:

Protect transaction intent before execution, not conceal transactions permanently.
2. Builder trust remains a security assumption
Your ML-KEM architecture gives selected builders the ability to decrypt.

They can see the swap before inclusion. A malicious builder could potentially:
- Copy the transaction's strategy.
- Execute a competing transaction.
- Delay submission.
- Leak the plaintext to other searchers.
Multiple builders, stake and reputation can reduce reliance on one party, but they do not cryptographically prevent a builder from leaking information.

This should be an explicit part of LeanSeal's threat model.
3. Timelock fallback doesn't guarantee inclusion
Your documentation says the fallback opens at round R, after which anyone can decrypt and submit.

That provides a recovery path for the transaction, but not guaranteed block inclusion.

There is still a race after decryption: competing searchers may see the transaction and attempt to get ahead of it.

I would describe this feature as time-delayed recovery and liveness fallback, not guaranteed execution.

Your own notes also identify that the drand timelock uses BLS and therefore isn't quantum-safe. Pasted text(20261105-221632).txt

4. The EIP-8141 compatibility boundary
This is probably the biggest deployment consideration.

Your current architecture is built around the experimental EIP-8141 devnet, chain 1337.

You cannot assume that any Ethereum network with Uniswap v4 deployed will accept LeanSeal's frame transactions.

We need to verify:
- EIP-8141 transaction support on the target network.
- Sidecar and builder relay access.
- Universal Router deployment and compatible version.
- Permit2 deployment and compatibility.
- EIP-1153 transient storage support.
- PoolManager address, pool liquidity and hook configuration.
For the initial demonstration, I'd use the existing devnet infrastructure if the required Uniswap contracts are available there. Otherwise, deploy a compatible local Uniswap v4 environment.
5. Gas and execution budgets
Your current verifier already uses 154,887 gas on devnet.

The planned 1M staked verification budget is not implemented in the current validation prefix. Pasted text(20261105-221632).txt


We need to budget separately for:
Execution component	What to measure
VERIFY	SLH-DSA verification
SENDER	Router call and swap execution
Total transaction	Combined gas and fees
State gas	Storage access and updates
Router	V4 swap and settlement overhead

Don't assume that implementing the staked VERIFY budget automatically solves the entire transaction's gas limits.

7. The implementation roadmap I'd follow
I'd break this into five milestones.
1. Milestone 1 — PQ account to Uniswap
   First priority
   No encryption yet.
   
   Deploy or identify Universal Router, Permit2, PoolManager and an existing liquid pool on the target devnet.
   
   Execute a plain EIP-8141 transaction:
   - VERIFY using SLH-DSA.
   - SENDER calling Universal Router.
   - Execute one exact-input v4 swap.
   - Confirm output and events.
   Success condition: A PQ-authorized LeanSeal account successfully swaps through Uniswap v4.
2. Milestone 2 — Sealed Uniswap transaction
   
   Integrate the existing sealing kit.
   PQ transaction
      → Encrypt
      → ML-KEM builder lock
      → Submit envelope
      → Builder decrypts
      → Sidecar validates
      → ethrex includes
      → Uniswap executes
   
   
   Success condition: The swap calldata is not exposed in the public mempool before inclusion.
3. Milestone 3 — Fallback and liveness
   
   Integrate:
   - drand watcher.
   - tlock decryption.
   - Fallback gossip.
   - Builder availability tracking.
   - Transaction expiration and replay protection.
   Test what happens when the selected builder goes offline.
   
   Success condition: The fallback can recover and submit the sealed swap after the designated round.
4. Milestone 4 — Private Swap frontend
   
   Build a simple interface:
   
   
   
   
   
   
   
   datawallet.com
   
   
   Show:
   - Token pair and input amount.
   - Expected output.
   - Minimum output.
   - Public vs private execution.
   - Envelope status.
   - Builder status.
   - Inclusion status.
   - Execution receipt.
   Success condition: A user can execute a private swap without interacting with the terminal.
5. Milestone 5 — Advanced DeFi execution
   
   Expand support to:
   - Multi-hop swaps.
   - v3 and v4 routes.
   - Liquidity modifications.
   - Private automated trading agents.
   - Optional LeanSeal-specific v4 hooks.
   Success condition: LeanSeal becomes a reusable private execution infrastructure for DeFi.

8. What I would actually build first
I'd keep the first implementation surprisingly small.
LeanSeal Private Swap
Recommended MVP







twitter.com


One PQ wallet. One builder. One Uniswap v4 pool. One private swap.

The demo should prove four things:
1. A transaction is authorized with SLH-DSA.
2. Its contents are hidden from public mempool observers.
3. The builder decrypts and relays the original transaction.
4. The transaction successfully executes on Uniswap v4.
Nothing else is necessary for the first proof.

Proposed initial repository structure
I'd keep Uniswap-specific logic out of the existing sidecar implementation.
leanseal/
│
├── packages/
│   ├── wallet/
│   │   ├── frame-builder/
│   │   ├── sphincs-signer/
│   │   └── swap-intent/
│   │
│   ├── sealing-kit/
│   │   ├── envelope/
│   │   ├── ml-kem/
│   │   └── timelock/
│   │
│   ├── client/
│   │   ├── rpc/
│   │   └── envelope-status/
│   │
│   └── integrations/
│       └── uniswap-v4/
│           ├── quote/
│           ├── router/
│           ├── calldata/
│           ├── pool-reader/
│           └── receipt/
│
├── contracts/
│   ├── SphincsFrameAccount.sol
│   ├── BuilderRegistry.sol
│   └── LeanSealSwapExecutor.sol
│
├── sidecar/
│   ├── envelope-pool/
│   ├── validation/
│   ├── gossip/
│   └── relayer/
│
└── apps/
    └── private-swap/


LeanSealSwapExecutor should be optional; don't deploy it just to add another layer between the account and Universal Router.

9. The larger opportunity
I see three possible products emerging from this.
Product	Value proposition
LeanSeal Wallet	Quantum-resistant transaction authorization
LeanSeal Private Swap	Private pre-inclusion Uniswap execution
LeanSeal DeFi Execution Network	Private execution infrastructure for protocols and agents

The third is the interesting long-term direction.

A trading agent should be able to prepare a transaction against Uniswap, Aave, an onchain lending protocol or another DeFi application, and submit it through LeanSeal without exposing its strategy to the public mempool.

Uniswap is simply our first integration.

My final architectural decision:
- Keep the PQ account.
- Keep the sealing kit.
- Keep the alternative mempool and builder network.
- Add an application integration SDK.
- Use Universal Router for the first Uniswap v4 integration.
- Don't build a custom hook yet.
- Don't modify the sidecar to understand Uniswap swaps.
- Keep transaction execution generic.
This preserves LeanSeal's original architecture while giving it a concrete DeFi use case.
