import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSHOP = `${ROOT}workshop`;
const DEMO = `${ROOT}demo/`;
const PORT = Number(process.env.DEMO_PORT ?? "4321");
const RUNS_FILE = `${DEMO}runs.json`;
const MAX_RUNS = 200;
const PUBLIC = process.env.PUBLIC === "1";
const MAX_ACTIVE = PUBLIC ? Number(process.env.MAX_ACTIVE ?? "3") : 1;
const RUNS_PER_HOUR = Number(process.env.RUNS_PER_HOUR ?? "6");

type Net = "local" | "devnet";
type Scheme = "sha2" | "lss";
type Flags = {
  network: Net;
  action: "swap" | "transfer" | "onboard" | "withdraw" | "faucet";
  lane: "public" | "sealed" | "batch";
  scheme: Scheme;
  mevBot: boolean;
  slippageBps: number;
  verifyGas: number;
  gas: "self" | "sponsor";
  wallet: "demo" | "passkey";
};

type NetInfo = { rpc: string; sidecar: string; node: string | null; config: string; prefix: string; uni: string | null };

const NETS: Record<Net, NetInfo> = {
  local: { rpc: "http://127.0.0.1:8545", sidecar: "http://127.0.0.1:14347/rpc", node: "http://127.0.0.1:14347/rpc", config: `${WORKSHOP}/workshop.config.local.json5`, prefix: "local.", uni: `${ROOT}localnet/uni.local.json` },
  devnet: { rpc: "https://altmempool.forshtat.com", sidecar: "https://altmempool.forshtat.com/rpc", node: process.env.DEVNET_NODE_URL ?? (process.env.PUBLIC === "1" ? "http://127.0.0.1:14367/rpc" : "https://129-212-188-106.sslip.io/rpc"), config: `${WORKSHOP}/workshop.config.json5`, prefix: "", uni: null },
};

const DEFAULT_FLAGS: Flags = { network: "local", action: "swap", lane: "batch", scheme: "lss", mevBot: true, slippageBps: 300, verifyGas: 0, gas: "sponsor", wallet: "demo" };

const FLAG_SCHEMA = [
  { key: "network", label: "Network", options: ["local", "devnet"], help: "Our local chain or the public hackathon devnet." },
  { key: "action", label: "Action", options: ["swap", "transfer"], help: "Swap 0.0001 ETH for tUSD, or send 1 wei." },
  { key: "lane", label: "Lane", options: ["public", "sealed", "batch"], help: "Public: anyone can read the swap. Sealed: encrypted until a deadline. Batch: sealed orders filled together at one price." },
  { key: "scheme", label: "Signature scheme", options: ["sha2", "lss"], help: "SHA2: the NIST standard, bigger, needs stake. lss: smaller and faster, no stake." },
  { key: "mevBot", label: "MEV bot", options: [true, false], help: "Run a bot that tries to trade around the swap." },
  { key: "slippageBps", label: "Max slippage", options: [50, 100, 300], help: "The most the swap may lose. A bot takes up to this much." },
  { key: "gas", label: "Gas", options: ["self", "sponsor"], help: "Who pays the gas: the wallet, or a sponsor." },
  { key: "wallet", label: "Wallet", options: ["demo", "passkey"], help: "Demo: the console's wallets. Passkey: yours, with its key made in your browser." },
  { key: "verifyGas", label: "Verify gas limit", options: [0, 60000, 100000, 200000, 1000000], help: "Gas for the signature check. Auto picks a good value." },
] as const;

const PRESETS = [
  { id: "protected", group: "core", title: "Protected swap", text: "Your swap goes into our sealed mempool as a hidden order. Orders open together at one price, so bots cannot jump ahead.", flags: { network: "local", action: "swap", lane: "batch", scheme: "lss", mevBot: true, slippageBps: 300, verifyGas: 0, gas: "sponsor", wallet: "demo" } },
  { id: "passkey", group: "core", title: "Protected swap, my passkey wallet", text: "The same, from your own wallet. Face ID unlocks its quantum-safe key in this browser.", flags: { network: "local", action: "swap", lane: "batch", scheme: "lss", mevBot: true, slippageBps: 300, verifyGas: 0, gas: "sponsor", wallet: "passkey" } },
  { id: "attack", group: "extra", title: "Unprotected swap (bot attack)", text: "A normal public swap. A bot trades around it and takes up to 3%.", flags: { network: "local", action: "swap", lane: "public", scheme: "sha2", mevBot: true, slippageBps: 300, verifyGas: 0, gas: "self", wallet: "demo" } },
  { id: "sealed", group: "extra", title: "Encrypted until a deadline", text: "Hidden until a deadline, then public. The bot can still react.", flags: { network: "local", action: "swap", lane: "sealed", scheme: "sha2", mevBot: true, slippageBps: 300, verifyGas: 0, gas: "self", wallet: "demo" } },
  { id: "batch", group: "extra", title: "Protected swap, NIST signature", text: "The protected swap signed with SLH-DSA SHA2. Needs a staked wallet.", flags: { network: "local", action: "swap", lane: "batch", scheme: "sha2", mevBot: true, slippageBps: 300, verifyGas: 0, gas: "self", wallet: "demo" } },
  { id: "devnet", group: "extra", title: "Quantum-safe transfer", text: "Send 1 wei from a quantum-safe wallet to any address. The wallet verifies a post-quantum signature on chain.", flags: { network: "devnet", action: "transfer", lane: "public", scheme: "lss", mevBot: false, slippageBps: 300, verifyGas: 0, gas: "self", wallet: "demo" } },
] as const;

const PUBLIC_PRESET_IDS = ["passkey", "protected", "devnet"];
const VISIBLE_PRESETS = PUBLIC ? PRESETS.filter((p) => PUBLIC_PRESET_IDS.includes(p.id)).map((p) => ({ ...p, flags: { ...p.flags, network: "devnet" } })) : PRESETS;
const PUBLIC_DEFAULTS = VISIBLE_PRESETS.find((p) => p.id === "passkey")?.flags ?? DEFAULT_FLAGS;

function optionReport(f: Flags, s: Session) {
  return Object.fromEntries(FLAG_SCHEMA.map((def) => [def.key, def.options.map((value) => {
    const problems = flagProblems({ ...f, [def.key]: value } as Flags, s);
    return { value, ok: problems.length === 0, reason: problems.join("; ") };
  })]));
}

function configRegistry(path: string): string {
  const m = readFileSync(path, "utf8").match(/stakingRegistry:\s*"(0x[0-9a-fA-F]{40})"/);
  return m ? m[1] : "";
}

function stateOf(net: Net, scheme: Scheme): { account: string } | null {
  const file = `${WORKSHOP}/${NETS[net].prefix}${scheme === "lss" ? "pq-lss-state.json" : "pq-state.json"}`;
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

const netState = (net: Net, name: string): string => `${WORKSHOP}/${NETS[net].prefix}${name}`;

function readJson<T>(file: string): T | null {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : null;
}

type Passkey = { id: string; pkSeed: string; pkRoot: string; keyFile: string };
type Session = { id: string; passkey: Passkey | null; predicted: Partial<Record<Net, string>>; clients: Set<ServerResponse>; running: boolean; starts: number[]; faucetAt: number };
const sessions = new Map<string, Session>();

function sessionFor(id: string | null): Session {
  const key = PUBLIC && id && /^[a-z0-9-]{8,64}$/.test(id) ? id : "local";
  let s = sessions.get(key);
  if (!s) {
    s = { id: key, passkey: null, predicted: {}, clients: new Set(), running: false, starts: [], faucetAt: 0 };
    sessions.set(key, s);
  }
  return s;
}

const passkeyStateFile = (net: Net, s: Session) => (s.passkey ? netState(net, `onboard-pk-${s.passkey.id}.json`) : "");

function walletOf(f: Flags, s: Session): { account: string; created?: boolean } | null {
  if (f.wallet !== "passkey") return stateOf(f.network, f.scheme);
  const st = s.passkey ? readJson<{ account: string; created?: boolean }>(passkeyStateFile(f.network, s)) : null;
  return st?.created ? st : null;
}

function tusdAddress(net: Net): string | null {
  return readJson<{ tusd?: string }>(netState(net, "uni-state.json"))?.tusd ?? null;
}

const verifyGasOf = (f: Flags): number => f.verifyGas || (f.scheme === "lss" ? 60_000 : 200_000);

function parseFlags(input: unknown): Flags {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_FLAGS } as Record<string, unknown>;
  for (const def of FLAG_SCHEMA) {
    if ((def.options as readonly unknown[]).includes(raw[def.key])) out[def.key] = raw[def.key];
  }
  return out as Flags;
}

function flagProblems(f: Flags, s: Session): string[] {
  const problems: string[] = [];
  if (PUBLIC && f.network !== "devnet") problems.push("this public console runs on the live devnet only");
  if (PUBLIC && f.wallet === "demo") {
    const demoSwap = f.scheme === "lss" && f.lane === "batch" && f.action === "swap" && f.gas === "sponsor";
    const demoTransfer = f.scheme === "lss" && f.action === "transfer";
    if (!demoSwap && !demoTransfer) problems.push("on the live site the shared demo wallet runs the protected swap or the quantum-safe transfer; use your passkey wallet for anything else");
  }
  if (f.network === "devnet" && f.action === "swap" && f.lane !== "batch") problems.push("on the devnet, swaps go through the batch auction: use lane = batch");
  if (f.network === "devnet" && f.lane === "sealed") problems.push("the sealed lane (LeanSeal node + builder) runs only on the local chain");
  if (f.action === "transfer" && f.lane === "sealed") problems.push("the sealed lane carries swaps: use action = swap");
  if (f.lane === "batch" && f.action !== "swap") problems.push("the batch auction takes swaps: use action = swap");
  if (f.lane === "batch" && !existsSync(netState(f.network, "batch-state.json"))) problems.push(`no sealed batch pool deployed on ${f.network} yet (run workshop/src/batch/setup_batch_pool.ts)`);
  if (f.gas === "sponsor" && f.lane !== "batch") problems.push("sponsored gas is wired into the batch lane only");
  if (f.gas === "sponsor" && f.scheme !== "lss") problems.push("a sponsored SHA2 tx needs ~154k + paymaster in one unstaked 100k budget: use scheme = lss");
  if (f.gas === "sponsor" && !existsSync(netState(f.network, "onboard-state.json"))) problems.push(`no sponsor paymaster deployed on ${f.network} yet (run workshop/src/onboard/setup_onboard.ts)`);
  if (f.wallet === "passkey") {
    if (f.scheme !== "lss") problems.push("passkey wallets sign with leanSphincs-s: use scheme = lss");
    if (f.lane !== "batch" || f.gas !== "sponsor") problems.push("a passkey wallet starts with no gas money: use lane = batch and gas = sponsor");
    if (!s.passkey) problems.push("unlock your passkey first (sidebar)");
    else if (!walletOf(f, s)) problems.push(`create your passkey wallet on ${f.network} first (sidebar)`);
  } else if (!stateOf(f.network, f.scheme)) problems.push(`no ${f.scheme} wallet deployed on ${f.network} yet`);
  return problems;
}

function envFor(f: Flags, s: Session): NodeJS.ProcessEnv {
  const n = NETS[f.network];
  const pk = s.passkey;
  const scheme = f.wallet === "passkey" && pk
    ? { PQ_SCHEME: "lss", PQ_SIGNER: `${DEMO}remote-signer.mjs`, PQ_LSS_KEY: pk.keyFile, ONBOARD_KEY_FILE: pk.keyFile, ONBOARD_USER: `pk-${pk.id}`, PQ_STATE: passkeyStateFile(f.network, s), REMOTE_SIGN_URL: `http://127.0.0.1:${PORT}` }
    : f.scheme === "lss"
    ? { PQ_SCHEME: "lss", PQ_SIGNER: `${ROOT}signer-lss/lssk`, PQ_LSS_KEY: `${ROOT}.secrets/lss.key` }
    : { PQ_SIGNER: `${ROOT}signer/leanseal-signer`, LEANSEAL_XMSS_CACHE: `${ROOT}.secrets/xmss.cache`, PQ_SEED_FILE: `${ROOT}.secrets/pq.seed`, PQ_PK_FILE: `${ROOT}.secrets/pq.pk` };
  const base = { ...process.env };
  delete base.PQ_SCHEME;
  delete base.LEANSEAL_NET;
  return {
    ...base,
    ...(f.network === "local" ? { LEANSEAL_NET: "local", UNI_ADDRESSES: n.uni! } : {}),
    WORKSHOP_CONFIG: n.config,
    ETHREX_URL: n.rpc,
    SPHINCS_OUT: `${ROOT}contracts/out`,
    PQ_SUBMIT_URL: n.sidecar,
    LEANSEAL_NODE_URL: n.node ?? "",
    SLIPPAGE_BPS: String(f.slippageBps),
    BATCH_PAYMASTER: f.gas === "sponsor" ? readJson<{ paymaster?: string }>(netState(f.network, "onboard-state.json"))?.paymaster ?? "" : "",
    VERIFY_GAS: String(verifyGasOf(f)),
    ...scheme,
  };
}

async function rpc(url: string, method: string, params: unknown[] = [], timeoutMs = 4000): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
}

const word = (addr: string) => addr.slice(2).toLowerCase().padStart(64, "0");

async function tusdBalance(net: Net, account: string): Promise<bigint> {
  const tusd = tusdAddress(net);
  if (!tusd) return 0n;
  return BigInt(await rpc(NETS[net].rpc, "eth_call", [{ to: tusd, data: `0x70a08231${word(account)}` }, "latest"]));
}

async function walletInfo(net: Net, scheme: Scheme) {
  const st = stateOf(net, scheme);
  if (!st) return { network: net, scheme, deployed: false };
  const n = NETS[net];
  const registry = configRegistry(n.config);
  const [balance, deposit, tusd] = await Promise.allSettled([
    rpc(n.rpc, "eth_getBalance", [st.account, "latest"]),
    registry ? rpc(n.rpc, "eth_call", [{ to: registry, data: `0x5287ce12${word(st.account)}` }, "latest"]) : Promise.resolve(null),
    tusdBalance(net, st.account),
  ]);
  const dep = deposit.status === "fulfilled" && deposit.value ? deposit.value.slice(2) : "";
  const stake = dep.length >= 192 ? BigInt(`0x${dep.slice(0, 64)}`) : 0n;
  const withdrawTime = dep.length >= 192 ? BigInt(`0x${dep.slice(128, 192)}`) : 0n;
  return {
    network: net,
    scheme,
    deployed: true,
    account: st.account,
    ethWei: balance.status === "fulfilled" ? BigInt(balance.value).toString() : null,
    tusdWei: tusd.status === "fulfilled" && tusd.value !== null ? tusd.value.toString() : null,
    stakeWei: stake.toString(),
    staked: stake > 0n && withdrawTime === 0n,
  };
}

async function status() {
  const probe = async (fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    try {
      const value = await fn();
      return { up: true, ms: Date.now() - t0, value };
    } catch (e) {
      return { up: false, ms: Date.now() - t0, error: (e as Error).message.slice(0, 160) };
    }
  };
  if (PUBLIC) {
    const [devnetBlock, devnetSidecar, devnetNode] = await Promise.all([
      probe(async () => Number(BigInt(await rpc(NETS.devnet.rpc, "eth_blockNumber")))),
      probe(() => rpc(NETS.devnet.sidecar, "skandha_explorer_info")),
      probe(() => rpc(NETS.devnet.node!, "leanseal_mempoolInfo")),
    ]);
    return { public: true, devnetBlock, devnetSidecar, devnetNode, wallets: [], active: activeJobs };
  }
  const [localBlock, devnetBlock, sidecar, devnetSidecar, node, devnetNode, reputation, wallets] = await Promise.all([
    probe(async () => Number(BigInt(await rpc(NETS.local.rpc, "eth_blockNumber")))),
    probe(async () => Number(BigInt(await rpc(NETS.devnet.rpc, "eth_blockNumber")))),
    probe(() => rpc(NETS.local.sidecar, "skandha_explorer_info")),
    probe(() => rpc(NETS.devnet.sidecar, "skandha_explorer_info")),
    probe(() => rpc(NETS.local.node!, "leanseal_mempoolInfo")),
    probe(() => rpc(NETS.devnet.node!, "leanseal_mempoolInfo")),
    probe(() => rpc(NETS.local.sidecar, "skandha_explorer_listReputation")),
    Promise.all((["local", "devnet"] as Net[]).flatMap((n) => (["sha2", "lss"] as Scheme[]).map((s) => walletInfo(n, s).catch(() => ({ network: n, scheme: s, deployed: false }))))),
  ]);
  return { localBlock, devnetBlock, sidecar, devnetSidecar, node, devnetNode, reputation, wallets, active: activeJobs };
}

type Order = { side: "buy" | "sell"; amountWei: string };

type Run = {
  id: number;
  transferTo?: string;
  session?: string;
  order?: Order;
  at: number;
  flags: Flags;
  verifyGasLimit: number;
  ok: boolean;
  error?: string;
  txHash?: string;
  block?: number;
  gasUsed?: number;
  frameGas?: number[];
  signMs?: number;
  quote?: string;
  received?: string;
  lossPct?: number;
  botTargeted: boolean;
  botProfit?: string;
  envelope?: { id: string; status?: string; openedBy?: string; round?: number; note?: string };
  batch?: { round?: string; ticket?: string; ticketStatus?: string; note?: string; revealTx?: string; frontRunsBlocked?: number; blockedReason?: string; refunded?: boolean };
  sealedChecks?: Array<{ rule: string; name: string; verdict: string; detail?: string }>;
  admissionOutcome?: string;
};

function loadRuns(): Run[] {
  try {
    return existsSync(RUNS_FILE) ? JSON.parse(readFileSync(RUNS_FILE, "utf8")) : [];
  } catch {
    return [];
  }
}

let runs: Run[] = loadRuns();
let activeJobs = 0;
let nextRunId = (runs[0]?.id ?? 0) + 1;
let deployerQueue: Promise<unknown> = Promise.resolve();
let deployerBusy = false;

function withDeployer<T>(fn: () => Promise<T>): Promise<T> {
  const next = deployerQueue.then(async () => {
    deployerBusy = true;
    try {
      return await fn();
    } finally {
      deployerBusy = false;
    }
  });
  deployerQueue = next.catch(() => undefined);
  return next;
}

function emitTo(s: Session, event: object) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of s.clients) c.write(data);
}

function saveRun(run: Run) {
  runs = [run, ...runs].slice(0, MAX_RUNS);
  writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
}

const visibleRuns = (s: Session) => (PUBLIC ? runs.filter((r) => r.session === s.id) : runs).map(({ session, ...r }) => r);

function runScript(s: Session, name: "alice" | "bot", args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", ...args], { cwd: WORKSHOP, env });
    let buf = "";
    const feed = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim() || /npm warn/i.test(line)) continue;
        emitTo(s, { type: "line", stream: name, line: line.slice(0, 600) });
        onLine(line);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReceipt(net: Net, hash: string, canNudge: () => boolean, timeoutMs = 240_000): Promise<any> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await rpc(NETS[net].rpc, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) return r;
    if (net === "local" && canNudge()) await rpc(NETS.local.sidecar, "debug_bundler_sendBundleNow").catch(() => null);
    await sleep(2000);
  }
  return null;
}

function aliceArgs(f: Flags): string[] {
  if (f.action === "transfer") return ["src/pq/pq_e2e.ts", "transfer"];
  if (f.lane === "batch") return ["src/batch/batch_swap.ts"];
  return f.lane === "sealed" ? ["src/leanseal/sealed_swap.ts"] : ["src/uni/swap.ts", "send"];
}

async function experiment(f: Flags, s: Session, order?: Order, transferTo?: string): Promise<Run> {
  const run: Run = { id: nextRunId++, session: s.id, at: Date.now(), flags: order ? { ...f, mevBot: false } : f, order, transferTo: f.action === "transfer" ? transferTo : undefined, verifyGasLimit: verifyGasOf(f), ok: false, botTargeted: false };
  f = run.flags;
  const session = s;
  const base = order ? { ...envFor(f, s), BATCH_SIDE: order.side, BATCH_AMOUNT_IN: order.amountWei } : envFor(f, s);
  const env = run.transferTo ? { ...base, TRANSFER_TO: run.transferTo } : base;
  const account = walletOf(f, s)!.account;
  const wantBot = f.mevBot && f.action === "swap" && (f.network === "local" || f.lane === "batch");
  const useBot = wantBot && !(PUBLIC && deployerBusy);
  emitTo(s, { type: "start", mode: f.lane, flags: f, runId: run.id });
  if (wantBot && !useBot) emitTo(s, { type: "line", stream: "bot", line: "the bot is busy with another visitor's swap; this run goes without it" });
  const before = f.action === "swap" ? await tusdBalance(f.network, account) : 0n;
  let quote = 0n;
  let rejected = "";
  let failure = "";
  let botDone: Promise<number> = Promise.resolve(0);
  let botActed = !(useBot && f.lane === "public");
  let batchReceived: bigint | null = null;
  if (f.lane === "batch") run.batch = {};
  if (useBot) {
    let ready: () => void = () => {};
    const isReady = new Promise<void>((r) => { ready = r; });
    const botScript = f.lane === "batch" ? "src/batch/batch_bot.ts" : "src/leanseal/mev_bot.ts";
    const botTimeout = f.lane === "public" ? "90000" : f.lane === "batch" ? "420000" : "30000";
    let releaseBot: () => void = () => {};
    const botFinished = new Promise<void>((r) => { releaseBot = r; });
    if (PUBLIC) void withDeployer(() => botFinished);
    botDone = runScript(s, "bot", [botScript], { ...env, BOT_TIMEOUT_MS: botTimeout }, (line) => {
      if (/watching (public alt mempool|sealed batch pool)/.test(line)) ready();
      if (line.includes("VICTIM")) run.botTargeted = true;
      const blocked = line.match(/front-run BLOCKED in block \d+: (.*)$/);
      if (blocked && run.batch) {
        run.batch.frontRunsBlocked = (run.batch.frontRunsBlocked ?? 0) + 1;
        run.batch.blockedReason = blocked[1];
      }
      if (/front-run mined|nothing to sandwich/.test(line)) botActed = true;
      const m = line.match(/bot profit (-?\d+) wei/);
      if (m) run.botProfit = m[1];
    });
    botDone = botDone.finally(() => { botActed = true; releaseBot(); });
    await Promise.race([isReady, sleep(30_000)]);
  }
  const code = await runScript(s, "alice", aliceArgs(f), env, (line) => {
    const q = line.match(/"localQuote":"(\d+)"/) ?? line.match(/-> (\d+) tUSD/);
    if (q) {
      quote = BigInt(q[1]);
      emitTo(session, { type: "progress", quote: quote.toString() });
    }
    const mined = line.match(/commit .*mined in block (\d+)/) ?? line.match(/^.*mined in block (\d+), status/);
    if (mined && run.txHash) {
      void rpc(NETS[f.network].rpc, "eth_getTransactionReceipt", [run.txHash]).then((rc) => {
        if (rc) emitTo(session, { type: "progress", block: Number(BigInt(rc.blockNumber)), gasUsed: Number(BigInt(rc.gasUsed)) });
      }).catch(() => undefined);
    }
    const h = line.match(/ADMITTED by \S+: (0x[0-9a-f]{64})/) ?? line.match(/signed PQ tx (0x[0-9a-f]{64})/);
    if (h) run.txHash = h[1];
    const r = line.match(/REJECTED by \S+: (.*)$/);
    if (r) rejected = r[1];
    const s = line.match(/signed in ([\d.]+)(ms|s)/);
    if (s) run.signMs = Math.round(Number(s[1]) * (s[2] === "s" ? 1000 : 1));
    const e = line.match(/sealed envelope (0x[0-9a-f]+) sent/);
    if (e) run.envelope = { id: e[1] };
    const c = line.match(/commit .*PQ frame tx (0x[0-9a-f]{64}) admitted/);
    if (c) run.txHash = c[1];
    const tk = line.match(/reveal ticket (0x[0-9a-f]+) sent/);
    if (tk && run.batch) run.batch.ticket = tk[1];
    const br = line.match(/"batchRound":"(\d+)".*"received":"(\d+)"/);
    if (br && run.batch) {
      run.batch.round = br[1];
      batchReceived = BigInt(br[2]);
      if (/"excluded":true/.test(line)) run.batch.refunded = true;
    }
    if (/^\s*(Error|RpcError|AdmissionError)|error:/i.test(line) && !failure) failure = line.trim().slice(0, 300);
  });
  if (rejected) run.error = `alt mempool rejected: ${rejected}`;
  const refused = f.lane === "sealed" && !run.envelope;
  if (refused) run.error = `sealed mempool refused the envelope: ${failure || `script exited with code ${code}`}`;
  if (run.txHash && !rejected && !refused) {
    const receipt = await waitReceipt(f.network, run.txHash, () => botActed);
    if (receipt) {
      run.block = Number(BigInt(receipt.blockNumber));
      run.gasUsed = Number(BigInt(receipt.gasUsed));
      run.frameGas = (receipt.frameReceipts ?? []).map((fr: { gasUsed: string }) => Number(BigInt(fr.gasUsed)));
      run.ok = receipt.status === "0x1";
    } else {
      run.error = "not mined within 240 s";
    }
  }
  if (!run.ok && !run.error) run.error = failure || `script exited with code ${code}`;
  if (run.envelope && NETS[f.network].node) {
    const st = await rpc(NETS[f.network].node!, "leanseal_envelopeStatus", [run.envelope.id]).catch(() => null);
    if (st) run.envelope = { id: run.envelope.id, status: st.status, openedBy: st.openedBy, round: st.round, note: st.note };
  }
  if (run.batch?.ticket && NETS[f.network].node) {
    const st = await rpc(NETS[f.network].node!, "leanseal_ticketStatus", [run.batch.ticket]).catch(() => null);
    if (st) Object.assign(run.batch, { ticketStatus: st.status, note: st.note, revealTx: st.revealTx });
  }
  if (f.lane === "batch" && batchReceived === null && !run.error) {
    run.ok = false;
    run.error = failure || "batch did not settle";
  }
  if (f.lane === "sealed" && NETS[f.network].node) {
    const items = await rpc(NETS[f.network].node!, "leanseal_listAdmissions", [{ limit: 20 }]).catch(() => []);
    const mine = items.find((a: any) => (run.envelope ? a.envelopeId === run.envelope.id : a.sender?.toLowerCase() === account.toLowerCase() && a.at >= run.at));
    if (mine) {
      run.sealedChecks = mine.checks;
      run.admissionOutcome = mine.outcome;
    }
  }
  if (f.lane === "public") {
    const items = await rpc(NETS[f.network].sidecar, "skandha_explorer_listAdmissions", [{ limit: 20 }]).then((r) => r.items).catch(() => []);
    const mine = items.find((a: any) => (run.txHash ? a.txHash === run.txHash : a.sender?.toLowerCase() === account.toLowerCase() && a.at >= run.at));
    if (mine) {
      run.admissionOutcome = mine.outcome;
      if (!run.txHash) run.txHash = mine.txHash;
    }
  }
  await botDone;
  if (f.action === "swap") {
    const received = batchReceived ?? (await tusdBalance(f.network, account)) - before;
    run.quote = quote.toString();
    run.received = received.toString();
    run.lossPct = quote > 0n && received > 0n ? Number(((quote - received) * 1_000_000n) / quote) / 10_000 : undefined;
  }
  saveRun(run);
  emitTo(s, { type: "result", mode: f.lane, run: { ...run, session: undefined }, quote: run.quote ?? "0", received: run.received ?? "0", lossPct: run.lossPct ?? 0, botTargeted: run.botTargeted, botProfit: run.botProfit ?? "0" });
  return run;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

const WEB_DIST = `${ROOT}web/dist`;
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", woff2: "font/woff2", svg: "image/svg+xml", png: "image/png", wasm: "application/wasm", txt: "text/plain; charset=utf-8" };

function staticFile(path: string): [string, string] | null {
  if (path === "/classic") return [`${DEMO}index.html`, TYPES.html];
  const rel = normalize(path);
  if (rel.includes("..")) return null;
  const base = join(WEB_DIST, rel);
  if (!base.startsWith(WEB_DIST) || !existsSync(base)) return null;
  const file = statSync(base).isDirectory() ? join(base, "index.html") : base;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return [file, TYPES[extname(file).slice(1)] ?? "application/octet-stream"];
}

const LSSK = `${ROOT}signer-lss/lssk`;
const WORD = /^0x[0-9a-f]{64}$/;
const pendingSigns = new Map<string, { digest: string; session: string; resolve: (sig: string) => void }>();

async function requestSignature(id: string, digest: string): Promise<string> {
  const s = [...sessions.values()].find((x) => x.passkey?.id === id);
  const passkey = s?.passkey;
  if (!s || !passkey) throw new Error("passkey is locked: unlock it in the dashboard");
  const reqId = randomBytes(8).toString("hex");
  const signature = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { pendingSigns.delete(reqId); reject(new Error("no browser answered: keep the dashboard open with the passkey unlocked")); }, 120_000);
    pendingSigns.set(reqId, { digest, session: s.id, resolve: (sig) => { clearTimeout(timer); resolve(sig); } });
    emitTo(s, { type: "sign", reqId, id, digest });
  });
  const ok = execFileSync(LSSK, ["verify", passkey.pkSeed, passkey.pkRoot, digest, signature], { encoding: "utf8" }).trim();
  if (ok !== "true") throw new Error("the browser's signature does not verify under the passkey's public key");
  return signature;
}

async function predictAccount(net: Net, s: Session): Promise<string | null> {
  if (!s.passkey || !existsSync(netState(net, "onboard-state.json"))) return null;
  if (s.predicted[net]) return s.predicted[net]!;
  const env = envFor({ ...DEFAULT_FLAGS, network: net, scheme: "lss", wallet: "passkey" }, s);
  let out = "";
  await runQuiet(["src/onboard/onboard.ts"], { ...env, ONBOARD_PREDICT_ONLY: "1" }, (line) => { if (line.startsWith("{")) out = line; });
  const account = out ? (JSON.parse(out).account as string) : null;
  if (account) s.predicted[net] = account;
  return account;
}

function runQuiet(args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", ...args], { cwd: WORKSHOP, env });
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function passkeyStatus(s: Session) {
  const passkey = s.passkey;
  if (!passkey) return { unlocked: false };
  const nets: Net[] = PUBLIC ? ["devnet"] : ["local", "devnet"];
  const wallets = await Promise.all(nets.map(async (net) => {
    const account = await predictAccount(net, s).catch(() => null);
    if (!account) return { network: net, available: false };
    const code = await rpc(NETS[net].rpc, "eth_getCode", [account, "latest"]).catch(() => "0x");
    const balance = await rpc(NETS[net].rpc, "eth_getBalance", [account, "latest"]).then((b) => BigInt(b).toString()).catch(() => null);
    const created = code !== "0x";
    const stateFile = passkeyStateFile(net, s);
    if (created && stateFile && !readJson<{ created?: boolean }>(stateFile)?.created) {
      writeFileSync(stateFile, JSON.stringify({ account, created: true, adoptedFromChain: true }, null, 2));
    }
    return { network: net, available: true, account, created, ethWei: balance };
  }));
  return { unlocked: true, id: passkey.id, pkSeed: passkey.pkSeed, wallets };
}

function registerPasskey(body: unknown, s: Session) {
  const { pkSeed, pkRoot } = (body ?? {}) as { pkSeed?: string; pkRoot?: string };
  if (!pkSeed || !pkRoot || !WORD.test(pkSeed) || !WORD.test(pkRoot)) throw new Error("pkSeed and pkRoot must be 32-byte hex words");
  const id = createHash("sha256").update(pkSeed + pkRoot).digest("hex").slice(0, 16);
  const keyFile = `${ROOT}.secrets/passkey-${id}.json`;
  writeFileSync(keyFile, JSON.stringify({ id, pkSeed, pkRoot }, null, 2));
  if (s.passkey?.id !== id) s.predicted = {};
  s.passkey = { id, pkSeed, pkRoot, keyFile };
}

async function onboardRun(net: Net, s: Session): Promise<Run> {
  const f: Flags = { ...DEFAULT_FLAGS, network: net, action: "onboard", lane: "batch", scheme: "lss", mevBot: false, gas: "sponsor", wallet: "passkey" };
  const run: Run = { id: nextRunId++, session: s.id, at: Date.now(), flags: f, verifyGasLimit: 55_000, ok: false, botTargeted: false };
  emitTo(s, { type: "start", mode: "onboard", flags: f, runId: run.id });
  if (deployerBusy) emitTo(s, { type: "line", stream: "alice", line: "waiting for the funding key (another visitor is using it)…" });
  let failure = "";
  const code = await withDeployer(() => runScript(s, "alice", ["src/onboard/onboard.ts"], envFor(f, s), (line) => {
    const h = line.match(/ADMITTED by the alt mempool: (0x[0-9a-f]{64})/);
    if (h) run.txHash = h[1];
    const s = line.match(/signed with the new PQ key in (\d+) ms/);
    if (s) run.signMs = Number(s[1]);
    if (/^\s*(Error|RpcError|AdmissionError)|error:/i.test(line) && !failure) failure = line.trim().slice(0, 300);
  }));
  if (run.txHash) {
    const receipt = await waitReceipt(net, run.txHash, () => true);
    if (receipt) {
      run.block = Number(BigInt(receipt.blockNumber));
      run.gasUsed = Number(BigInt(receipt.gasUsed));
      run.frameGas = (receipt.frameReceipts ?? []).map((fr: { gasUsed: string }) => Number(BigInt(fr.gasUsed)));
      run.ok = receipt.status === "0x1";
    } else run.error = "not mined within 90 s";
  }
  if (!run.ok && !run.error) run.error = failure || `script exited with code ${code}`;
  saveRun(run);
  emitTo(s, { type: "result", mode: "onboard", run: { ...run, session: undefined }, quote: "0", received: "0", lossPct: 0, botTargeted: false, botProfit: "0" });
  return run;
}

function startJob(job: () => Promise<Run>, flags: Flags, res: ServerResponse, s: Session) {
  if (s.running) return json(res, 409, { error: "your previous run is still going" });
  if (activeJobs >= MAX_ACTIVE) return json(res, 429, { error: PUBLIC ? `busy: ${activeJobs} swaps are running for other visitors. Try again in a minute.` : "another run is in progress" });
  const hourAgo = Date.now() - 3_600_000;
  s.starts = s.starts.filter((t) => t > hourAgo);
  if (PUBLIC && s.starts.length >= RUNS_PER_HOUR) return json(res, 429, { error: `limit reached: ${RUNS_PER_HOUR} runs per hour per visitor` });
  s.starts.push(Date.now());
  s.running = true;
  activeJobs++;
  job()
    .catch((e) => emitTo(s, { type: "error", message: (e as Error).message }))
    .finally(() => { s.running = false; activeJobs--; });
  json(res, 202, { started: true, flags });
}

let demoBusy = false;

function parseOrder(input: unknown): Order | undefined | string {
  if (input === undefined || input === null) return undefined;
  const o = input as { side?: unknown; amountWei?: unknown };
  if (o.side !== "buy" && o.side !== "sell") return "order side must be buy or sell";
  if (typeof o.amountWei !== "string" || !/^[0-9]{1,30}$/.test(o.amountWei)) return "order amount must be a whole number of wei";
  const amount = BigInt(o.amountWei);
  const [min, max] = o.side === "buy" ? [10n ** 12n, 5n * 10n ** 16n] : [10n ** 15n, 10n ** 21n];
  if (amount < min || amount > max) return `order amount out of range for a ${o.side}`;
  return { side: o.side, amountWei: o.amountWei };
}

function start(f: Flags, res: ServerResponse, s: Session, orderInput?: unknown, toInput?: unknown) {
  const order = parseOrder(orderInput);
  if (typeof order === "string") return json(res, 400, { error: order });
  if (toInput !== undefined && toInput !== "" && (typeof toInput !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(toInput))) return json(res, 400, { error: "the recipient must be a 0x… address with 40 hex characters" });
  const transferTo = typeof toInput === "string" && toInput ? toInput : undefined;
  const problems = flagProblems(f, s);
  if (order && (f.lane !== "batch" || f.action !== "swap")) problems.push("orders go through the batch auction: use lane = batch");
  if (problems.length) return json(res, 400, { error: problems.join("; "), problems });
  if (PUBLIC && f.wallet === "demo") {
    if (demoBusy) return json(res, 429, { error: "the shared demo wallet is busy with another visitor; try again in a minute, or use your passkey wallet" });
    return startJob(async () => {
      demoBusy = true;
      try {
        return await experiment(f, s, order, transferTo);
      } finally {
        demoBusy = false;
      }
    }, f, res, s);
  }
  startJob(() => experiment(f, s, order, transferTo), f, res, s);
}

const SEL = { ethOf: "0x8fb08e2c", tokenOf: "0x42ec38e2", balanceOf: "0x70a08231", getSlot0: "0xc815641c", getLiquidity: "0xfa6793d5" };
const STATE_VIEW: Record<Net, () => string | null> = {
  devnet: () => "0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB",
  local: () => readJson<{ STATE_VIEW?: string }>(NETS.local.uni!)?.STATE_VIEW ?? null,
};
const FAUCET_COOLDOWN_MS = 3_600_000;
const FAUCET_PER_DAY = Number(process.env.FAUCET_PER_DAY ?? "100");
let faucetDay = { day: "", count: 0 };

async function callUint(net: Net, to: string, data: string): Promise<string> {
  return BigInt(await rpc(NETS[net].rpc, "eth_call", [{ to, data }, "latest"])).toString();
}

async function vaultInfo(net: Net, s: Session) {
  const w = walletOf({ ...DEFAULT_FLAGS, network: net, wallet: "passkey" }, s);
  const batch = readJson<{ hook?: string; poolId?: string }>(netState(net, "batch-state.json"));
  const tusd = tusdAddress(net);
  const sv = STATE_VIEW[net]();
  if (!w || !batch?.hook || !batch.poolId || !tusd || !sv) return { ready: false };
  const a = word(w.account);
  const pid = batch.poolId.slice(2);
  const [walletEth, walletTusd, vaultEth, vaultTusd, slot0, liquidity] = await Promise.all([
    rpc(NETS[net].rpc, "eth_getBalance", [w.account, "latest"]).then((b) => BigInt(b).toString()),
    callUint(net, tusd, `${SEL.balanceOf}${a}`),
    callUint(net, batch.hook, `${SEL.ethOf}${a}`),
    callUint(net, batch.hook, `${SEL.tokenOf}${a}`),
    rpc(NETS[net].rpc, "eth_call", [{ to: sv, data: `${SEL.getSlot0}${pid}` }, "latest"]),
    callUint(net, sv, `${SEL.getLiquidity}${pid}`),
  ]);
  return {
    ready: true, account: w.account, walletEth, walletTusd, vaultEth, vaultTusd,
    sqrtPriceX96: BigInt(`0x${(slot0 as string).slice(2, 66)}`).toString(), liquidity,
    faucetReadyAt: s.faucetAt ? s.faucetAt + FAUCET_COOLDOWN_MS : 0,
  };
}

async function scriptRun(s: Session, net: Net, action: "withdraw" | "faucet", args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  const f: Flags = { ...DEFAULT_FLAGS, network: net, action, lane: "batch", scheme: "lss", mevBot: false, gas: "sponsor", wallet: "passkey" };
  const run: Run = { id: nextRunId++, session: s.id, at: Date.now(), flags: f, verifyGasLimit: verifyGasOf(f), ok: false, botTargeted: false };
  emitTo(s, { type: "start", mode: action, flags: f, runId: run.id });
  let failure = "";
  const go = () => runScript(s, "alice", args, { ...envFor(f, s), ...extraEnv }, (line) => {
    const h = line.match(/PQ frame tx (0x[0-9a-f]{64}) admitted/) ?? line.match(/sent \d+ wei ETH: (0x[0-9a-f]{64})/);
    if (h && !run.txHash) run.txHash = h[1];
    if (/^\s*(Error|RpcError|StepError)|error:/i.test(line) && !failure) failure = line.trim().slice(0, 300);
  });
  const code = action === "faucet" ? await withDeployer(go) : await go();
  run.ok = code === 0;
  if (!run.ok) run.error = failure || `script exited with code ${code}`;
  saveRun(run);
  emitTo(s, { type: "result", mode: action, run: { ...run, session: undefined }, quote: "0", received: "0", lossPct: 0, botTargeted: false, botProfit: "0" });
  return run;
}

const RPC_ALLOWED = /^(leanseal_[A-Za-z]+|skandha_explorer_(?!faucet)[A-Za-z]+|eth_chainId|eth_blockNumber|eth_supportedEntryPoints|web3_clientVersion|net_version)$/;

async function publicRpc(req: IncomingMessage, res: ServerResponse) {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  const reply = (code: number, body: unknown) => {
    res.writeHead(code, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return reply(405, { error: "POST JSON-RPC here" });
  const body = await readBody(req);
  const calls = (Array.isArray(body) ? body : [body]) as Array<{ id?: unknown; method?: unknown }>;
  const blocked = calls.find((c) => typeof c?.method !== "string" || !RPC_ALLOWED.test(c.method));
  if (blocked) return reply(200, { jsonrpc: "2.0", id: blocked?.id ?? null, error: { code: -32601, message: `method not available on this public endpoint: ${String(blocked?.method)}` } });
  const upstream = await fetch(NETS[PUBLIC ? "devnet" : "local"].node!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  reply(upstream.status, await upstream.json());
}

const fromInternet = (req: IncomingMessage) => !!req.headers["x-forwarded-for"] || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const s = sessionFor((req.headers["x-leanseal-session"] as string | undefined) ?? url.searchParams.get("session"));
  try {
    const asset = req.method === "GET" ? staticFile(path) : null;
    if (asset) {
      res.writeHead(200, { "content-type": asset[1], "cache-control": "no-cache" });
      res.end(readFileSync(asset[0]));
      return;
    }
    if (path === "/rpc") return await publicRpc(req, res);
    if (path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      s.clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => { clearInterval(ping); s.clients.delete(res); });
      return;
    }
    if (path === "/api/flags") return json(res, 200, { public: PUBLIC, defaults: PUBLIC ? PUBLIC_DEFAULTS : DEFAULT_FLAGS, schema: FLAG_SCHEMA, presets: VISIBLE_PRESETS });
    if (path === "/api/flags/check" && req.method === "POST") {
      const f = parseFlags(await readBody(req));
      return json(res, 200, { flags: f, problems: flagProblems(f, s), options: optionReport(f, s) });
    }
    if (path === "/api/status") return json(res, 200, await status());
    if (path === "/api/runs") return json(res, 200, visibleRuns(s));
    const netParam: Net = PUBLIC || url.searchParams.get("network") === "devnet" ? "devnet" : "local";
    if (path === "/api/mempool") return json(res, 200, await rpc(NETS[netParam].node!, "leanseal_mempoolInfo"));
    if (path === "/api/admissions" && url.searchParams.get("mempool") === "sealed") {
      return json(res, 200, await rpc(NETS[netParam].node!, "leanseal_listAdmissions", [{ limit: 30 }]));
    }
    if (path === "/api/admissions") {
      const net = netParam;
      const r = await rpc(NETS[net].sidecar, "skandha_explorer_listAdmissions", [{ limit: 30 }]);
      return json(res, 200, r.items.map(({ frames, ...rest }: any) => rest));
    }
    const tx = path.match(/^\/api\/tx\/(0x[0-9a-fA-F]{64})$/);
    if (tx) {
      const net = netParam;
      const r = await rpc(NETS[net].sidecar, "skandha_explorer_getTransaction", [tx[1]]);
      return json(res, 200, { admission: r?.admission ?? null, events: r?.events ?? [], status: r?.entry?.status ?? null });
    }
    const ticket = path.match(/^\/api\/ticket\/(0x[0-9a-fA-F]{1,128})$/);
    if (ticket) return json(res, 200, await rpc(NETS[netParam].node!, "leanseal_ticketStatus", [ticket[1]]).catch((e: Error) => ({ error: e.message.replace(/^unknown: /, "") })));
    const env = path.match(/^\/api\/envelope\/(0x[0-9a-fA-F]+)$/);
    if (env) return json(res, 200, await rpc(NETS[netParam].node!, "leanseal_envelopeStatus", [env[1]]));
    if (path === "/api/run" && req.method === "POST") {
      const body = await readBody(req) as Record<string, unknown>;
      return start(parseFlags(body), res, s, body.order, body.transferTo);
    }
    if (path === "/api/vault" && req.method === "GET") return json(res, 200, await vaultInfo(netParam, s));
    if (path === "/api/withdraw" && req.method === "POST") {
      if (!walletOf({ ...DEFAULT_FLAGS, network: netParam, wallet: "passkey" }, s)) return json(res, 400, { error: "unlock your passkey and create your wallet first" });
      return startJob(() => scriptRun(s, netParam, "withdraw", ["src/batch/vault_withdraw.ts"]), { ...DEFAULT_FLAGS, network: netParam, action: "withdraw" }, res, s);
    }
    if (path === "/api/faucet" && req.method === "POST") {
      const w = walletOf({ ...DEFAULT_FLAGS, network: netParam, wallet: "passkey" }, s);
      if (!w) return json(res, 400, { error: "unlock your passkey and create your wallet first" });
      if (s.faucetAt && Date.now() - s.faucetAt < FAUCET_COOLDOWN_MS) return json(res, 429, { error: `the faucet is once an hour; try again in ${Math.ceil((s.faucetAt + FAUCET_COOLDOWN_MS - Date.now()) / 60000)} min` });
      const day = new Date().toISOString().slice(0, 10);
      if (faucetDay.day !== day) faucetDay = { day, count: 0 };
      if (faucetDay.count >= FAUCET_PER_DAY) return json(res, 429, { error: "the faucet's daily limit is reached; try again tomorrow" });
      faucetDay.count++;
      s.faucetAt = Date.now();
      return startJob(() => scriptRun(s, netParam, "faucet", ["src/batch/faucet.ts", w.account]), { ...DEFAULT_FLAGS, network: netParam, action: "faucet" }, res, s);
    }
    if (path === "/api/passkey" && req.method === "GET") return json(res, 200, await passkeyStatus(s));
    if (path === "/api/passkey" && req.method === "POST") {
      registerPasskey(await readBody(req), s);
      return json(res, 200, await passkeyStatus(s));
    }
    if (path === "/api/passkey" && req.method === "DELETE") {
      s.passkey = null;
      return json(res, 200, { unlocked: false });
    }
    if (path === "/api/passkey/onboard" && req.method === "POST") {
      const net: Net = PUBLIC || (await readBody(req) as { network?: string }).network === "devnet" ? "devnet" : "local";
      const st = await passkeyStatus(s);
      const w = st.unlocked ? st.wallets!.find((x) => x.network === net) : null;
      if (!w?.available) return json(res, 400, { error: st.unlocked ? `no onboarding contracts on ${net} yet` : "unlock your passkey first" });
      if (w.created) return json(res, 400, { error: `your wallet already exists on ${net}` });
      return startJob(() => onboardRun(net, s), { ...DEFAULT_FLAGS, network: net, action: "onboard", wallet: "passkey" }, res, s);
    }
    if (path === "/api/sign/request" && req.method === "POST") {
      if (fromInternet(req)) return json(res, 403, { error: "signing requests come only from this server's own scripts" });
      const { id, digest } = await readBody(req) as { id?: string; digest?: string };
      if (!id || !digest || !WORD.test(digest)) return json(res, 400, { error: "id and a 32-byte digest are required" });
      return json(res, 200, { signature: await requestSignature(id, digest) });
    }
    if (path === "/api/sign/respond" && req.method === "POST") {
      const { reqId, signature } = await readBody(req) as { reqId?: string; signature?: string };
      const p = reqId ? pendingSigns.get(reqId) : undefined;
      if (!p || p.session !== s.id || !signature || !/^0x[0-9a-f]+$/.test(signature)) return json(res, 400, { error: "unknown request or bad signature" });
      pendingSigns.delete(reqId!);
      p.resolve(signature);
      return json(res, 200, { ok: true });
    }
    const legacy = path.match(/^\/run\/(public|sealed)$/);
    if (legacy && req.method === "POST" && !PUBLIC) return start({ ...DEFAULT_FLAGS, lane: legacy[1] as Flags["lane"] }, res, s);
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: (e as Error).message.slice(0, 300) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`LeanSeal API on http://127.0.0.1:${PORT}${existsSync(WEB_DIST) ? " (serving web/dist)" : " (run the Astro UI with: cd web && npm run dev)"}`));
