import { spawn } from "node:child_process";
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
const MAX_RUNS = 50;

type Net = "local" | "devnet";
type Scheme = "sha2" | "lss";
type Flags = {
  network: Net;
  action: "swap" | "transfer";
  lane: "public" | "sealed" | "batch";
  scheme: Scheme;
  mevBot: boolean;
  slippageBps: number;
  verifyGas: number;
};

type NetInfo = { rpc: string; sidecar: string; node: string | null; config: string; prefix: string; uni: string | null };

const NETS: Record<Net, NetInfo> = {
  local: { rpc: "http://127.0.0.1:8545", sidecar: "http://127.0.0.1:14347/rpc", node: "http://127.0.0.1:14347/rpc", config: `${WORKSHOP}/workshop.config.local.json5`, prefix: "local.", uni: `${ROOT}localnet/uni.local.json` },
  devnet: { rpc: "https://altmempool.forshtat.com", sidecar: "https://altmempool.forshtat.com/rpc", node: null, config: `${WORKSHOP}/workshop.config.json5`, prefix: "", uni: null },
};

const DEFAULT_FLAGS: Flags = { network: "local", action: "swap", lane: "batch", scheme: "sha2", mevBot: true, slippageBps: 300, verifyGas: 0 };

const FLAG_SCHEMA = [
  { key: "network", label: "Network", options: ["local", "devnet"], help: "Our local EIP-8141 chain, or the public hackathon devnet (transfers only: no Uniswap pool there)." },
  { key: "action", label: "Action", options: ["swap", "transfer"], help: "A Uniswap v4 swap of 0.0001 ETH to tUSD, or a 1 gwei transfer." },
  { key: "lane", label: "Lane", options: ["public", "sealed", "batch"], help: "Public: the signed tx waits in the alt mempool where bots read it. Sealed: an encrypted envelope gossiped between nodes and released publicly at a drand deadline (hidden until then, but bots can still react after). Batch: only a hash is committed; nodes reveal it at a drand round and the pool fills the whole batch at one price, rejecting every other swap." },
  { key: "scheme", label: "Signature scheme", options: ["sha2", "lss"], help: "SLH-DSA-SHA2-128-24 (NIST, ~157k verify gas, needs stake) or leanSphincs-s (research, ~47k, fits the 100k limit unstaked)." },
  { key: "mevBot", label: "MEV bot", options: [true, false], help: "Runs a sandwich bot that watches the public alt mempool and the LeanSeal node. Swaps only." },
  { key: "slippageBps", label: "Max slippage", options: [50, 100, 300], help: "The swap's minimum output. The bot steals up to exactly this much." },
  { key: "verifyGas", label: "Verify gas limit", options: [0, 60000, 100000, 200000, 1000000], help: "VERIFY frame gas limit. 0 picks the scheme default (sha2 200k, lss 60k). Unstaked senders are capped at 100k." },
] as const;

const PRESETS = [
  { id: "attack", title: "MEV attack", text: "A normal swap on the public alt mempool. The bot reads it and sandwiches it.", flags: { network: "local", action: "swap", lane: "public", scheme: "sha2", mevBot: true, slippageBps: 300, verifyGas: 0 } },
  { id: "batch", title: "Sealed batch auction", text: "Commit a hash, nodes reveal it at a drand round, one price for the batch. The bot cannot trade around it.", flags: { network: "local", action: "swap", lane: "batch", scheme: "sha2", mevBot: true, slippageBps: 300, verifyGas: 0 } },
  { id: "sealed", title: "Sealed, public release", text: "An envelope hidden until a drand deadline, then public. Shows why hiding alone is not enough.", flags: { network: "local", action: "swap", lane: "sealed", scheme: "sha2", mevBot: true, slippageBps: 300, verifyGas: 0 } },
  { id: "devnet", title: "Live devnet tx", text: "A PQ transfer on the public hackathon network with a 200k verify budget.", flags: { network: "devnet", action: "transfer", lane: "public", scheme: "lss", mevBot: false, slippageBps: 300, verifyGas: 200000 } },
  { id: "nostake", title: "No-stake wallet", text: "leanSphincs-s swap from an unstaked wallet: fits the 100k limit.", flags: { network: "local", action: "swap", lane: "public", scheme: "lss", mevBot: false, slippageBps: 300, verifyGas: 0 } },
] as const;

function optionReport(f: Flags) {
  return Object.fromEntries(FLAG_SCHEMA.map((def) => [def.key, def.options.map((value) => {
    const problems = flagProblems({ ...f, [def.key]: value } as Flags);
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

function tusdAddress(): string | null {
  const file = `${WORKSHOP}/local.uni-state.json`;
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).tusd : null;
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

function flagProblems(f: Flags): string[] {
  const problems: string[] = [];
  if (f.network === "devnet" && f.action === "swap") problems.push("devnet has no Uniswap pool yet: use action = transfer");
  if (f.network === "devnet" && f.lane === "sealed") problems.push("the sealed lane (LeanSeal node + builder) runs only on the local chain");
  if (f.action === "transfer" && f.lane === "sealed") problems.push("the sealed lane carries swaps: use action = swap");
  if (f.lane === "batch" && (f.network !== "local" || f.action !== "swap")) problems.push("the batch auction pool exists only on the local chain and takes swaps");
  if (f.lane === "batch" && !existsSync(`${WORKSHOP}/local.batch-state.json`)) problems.push("no sealed batch pool deployed yet (run workshop/src/batch/setup_batch_pool.ts)");
  if (!stateOf(f.network, f.scheme)) problems.push(`no ${f.scheme} wallet deployed on ${f.network} yet`);
  return problems;
}

function envFor(f: Flags): NodeJS.ProcessEnv {
  const n = NETS[f.network];
  const scheme = f.scheme === "lss"
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
    SLIPPAGE_BPS: String(f.slippageBps),
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

async function tusdBalance(account: string): Promise<bigint> {
  const tusd = tusdAddress();
  if (!tusd) return 0n;
  return BigInt(await rpc(NETS.local.rpc, "eth_call", [{ to: tusd, data: `0x70a08231${word(account)}` }, "latest"]));
}

async function walletInfo(net: Net, scheme: Scheme) {
  const st = stateOf(net, scheme);
  if (!st) return { network: net, scheme, deployed: false };
  const n = NETS[net];
  const registry = configRegistry(n.config);
  const [balance, deposit, tusd] = await Promise.allSettled([
    rpc(n.rpc, "eth_getBalance", [st.account, "latest"]),
    registry ? rpc(n.rpc, "eth_call", [{ to: registry, data: `0x5287ce12${word(st.account)}` }, "latest"]) : Promise.resolve(null),
    net === "local" ? tusdBalance(st.account) : Promise.resolve(null),
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
  const [localBlock, devnetBlock, sidecar, devnetSidecar, node, reputation, wallets] = await Promise.all([
    probe(async () => Number(BigInt(await rpc(NETS.local.rpc, "eth_blockNumber")))),
    probe(async () => Number(BigInt(await rpc(NETS.devnet.rpc, "eth_blockNumber")))),
    probe(() => rpc(NETS.local.sidecar, "skandha_explorer_info")),
    probe(() => rpc(NETS.devnet.sidecar, "skandha_explorer_info")),
    probe(() => rpc(NETS.local.node!, "leanseal_mempoolInfo")),
    probe(() => rpc(NETS.local.sidecar, "skandha_explorer_listReputation")),
    Promise.all((["local", "devnet"] as Net[]).flatMap((n) => (["sha2", "lss"] as Scheme[]).map((s) => walletInfo(n, s).catch(() => ({ network: n, scheme: s, deployed: false }))))),
  ]);
  return { localBlock, devnetBlock, sidecar, devnetSidecar, node, reputation, wallets, running: current?.flags ?? null };
}

type Run = {
  id: number;
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
  batch?: { round?: string; ticket?: string; ticketStatus?: string; note?: string; revealTx?: string; frontRunsBlocked?: number; blockedReason?: string };
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
let current: { flags: Flags } | null = null;
const clients = new Set<ServerResponse>();

function emit(event: object) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(data);
}

function runScript(name: "alice" | "bot", args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", ...args], { cwd: WORKSHOP, env });
    let buf = "";
    const feed = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim() || /npm warn/i.test(line)) continue;
        emit({ type: "line", stream: name, line: line.slice(0, 600) });
        onLine(line);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReceipt(net: Net, hash: string, canNudge: () => boolean, timeoutMs = 90_000): Promise<any> {
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

async function experiment(f: Flags): Promise<Run> {
  const run: Run = { id: (runs[0]?.id ?? 0) + 1, at: Date.now(), flags: f, verifyGasLimit: verifyGasOf(f), ok: false, botTargeted: false };
  const env = envFor(f);
  const account = stateOf(f.network, f.scheme)!.account;
  const useBot = f.mevBot && f.action === "swap" && f.network === "local";
  emit({ type: "start", mode: f.lane, flags: f, runId: run.id });
  const before = f.action === "swap" ? await tusdBalance(account) : 0n;
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
    const botTimeout = f.lane === "public" ? "90000" : f.lane === "batch" ? "200000" : "30000";
    botDone = runScript("bot", [botScript], { ...env, BOT_TIMEOUT_MS: botTimeout }, (line) => {
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
    botDone = botDone.finally(() => { botActed = true; });
    await Promise.race([isReady, sleep(30_000)]);
  }
  const code = await runScript("alice", aliceArgs(f), env, (line) => {
    const q = line.match(/"localQuote":"(\d+)"/) ?? line.match(/-> (\d+) tUSD/);
    if (q) quote = BigInt(q[1]);
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
      run.error = "not mined within 90 s";
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
    const received = batchReceived ?? (await tusdBalance(account)) - before;
    run.quote = quote.toString();
    run.received = received.toString();
    run.lossPct = quote > 0n && received > 0n ? Number(((quote - received) * 1_000_000n) / quote) / 10_000 : undefined;
  }
  runs = [run, ...runs].slice(0, MAX_RUNS);
  writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
  emit({ type: "result", mode: f.lane, run, quote: run.quote ?? "0", received: run.received ?? "0", lossPct: run.lossPct ?? 0, botTargeted: run.botTargeted, botProfit: run.botProfit ?? "0" });
  return run;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

const WEB_DIST = `${ROOT}web/dist`;
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", woff2: "font/woff2", svg: "image/svg+xml", png: "image/png", txt: "text/plain; charset=utf-8" };

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

function start(f: Flags, res: ServerResponse) {
  if (current) return json(res, 409, { error: "another run is in progress" });
  const problems = flagProblems(f);
  if (problems.length) return json(res, 400, { error: problems.join("; "), problems });
  current = { flags: f };
  experiment(f)
    .catch((e) => emit({ type: "error", message: (e as Error).message }))
    .finally(() => { current = null; });
  json(res, 202, { started: true, flags: f });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    const asset = req.method === "GET" ? staticFile(path) : null;
    if (asset) {
      res.writeHead(200, { "content-type": asset[1] });
      res.end(readFileSync(asset[0]));
      return;
    }
    if (path === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (path === "/api/flags") return json(res, 200, { defaults: DEFAULT_FLAGS, schema: FLAG_SCHEMA, presets: PRESETS });
    if (path === "/api/flags/check" && req.method === "POST") {
      const f = parseFlags(await readBody(req));
      return json(res, 200, { flags: f, problems: flagProblems(f), options: optionReport(f) });
    }
    if (path === "/api/status") return json(res, 200, await status());
    if (path === "/api/runs") return json(res, 200, runs);
    if (path === "/api/mempool") return json(res, 200, await rpc(NETS.local.node!, "leanseal_mempoolInfo"));
    if (path === "/api/admissions" && url.searchParams.get("mempool") === "sealed") {
      return json(res, 200, await rpc(NETS.local.node!, "leanseal_listAdmissions", [{ limit: 30 }]));
    }
    if (path === "/api/admissions") {
      const net = url.searchParams.get("network") === "devnet" ? "devnet" : "local";
      const r = await rpc(NETS[net].sidecar, "skandha_explorer_listAdmissions", [{ limit: 30 }]);
      return json(res, 200, r.items.map(({ frames, ...rest }: any) => rest));
    }
    const tx = path.match(/^\/api\/tx\/(0x[0-9a-fA-F]{64})$/);
    if (tx) {
      const net = url.searchParams.get("network") === "devnet" ? "devnet" : "local";
      const r = await rpc(NETS[net].sidecar, "skandha_explorer_getTransaction", [tx[1]]);
      return json(res, 200, { admission: r?.admission ?? null, events: r?.events ?? [], status: r?.entry?.status ?? null });
    }
    const env = path.match(/^\/api\/envelope\/(0x[0-9a-fA-F]+)$/);
    if (env) return json(res, 200, await rpc(NETS.local.node!, "leanseal_envelopeStatus", [env[1]]));
    if (path === "/api/run" && req.method === "POST") return start(parseFlags(await readBody(req)), res);
    const legacy = path.match(/^\/run\/(public|sealed)$/);
    if (legacy && req.method === "POST") return start({ ...DEFAULT_FLAGS, lane: legacy[1] as Flags["lane"] }, res);
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: (e as Error).message.slice(0, 300) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`LeanSeal API on http://127.0.0.1:${PORT}${existsSync(WEB_DIST) ? " (serving web/dist)" : " (run the Astro UI with: cd web && npm run dev)"}`));
