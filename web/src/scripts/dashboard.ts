import * as pk from './passkey';

type FlagValue = string | number | boolean;
type Flags = Record<string, FlagValue>;
type FlagDef = { key: string; label: string; options: FlagValue[]; help: string };
type Preset = { id: string; group: 'core' | 'extra'; title: string; text: string; flags: Flags };
type OptionState = Record<string, Array<{ value: FlagValue; ok: boolean; reason: string }>>;

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
  sealedChecks?: Check[];
  batch?: { round?: string; ticket?: string; ticketStatus?: string; note?: string; revealTx?: string; frontRunsBlocked?: number; blockedReason?: string };
  admissionOutcome?: string;
};

type Probe = { up: boolean; ms: number; value?: unknown; error?: string };
type Wallet = { network: string; scheme: string; deployed: boolean; account?: string; ethWei?: string | null; tusdWei?: string | null; stakeWei?: string; staked?: boolean };
type Status = { localBlock: Probe; devnetBlock: Probe; sidecar: Probe; devnetSidecar: Probe; node: Probe; devnetNode: Probe; reputation: Probe; wallets: Wallet[]; running: Flags | null };
type Check = { rule: string; verdict: string; detail?: string; entity?: string; frameIndex?: number; name?: string };
type Admission = { id: number; txHash?: string; envelopeId?: string; sender?: string; at: number; outcome: string; checks: Check[] };
type RuleText = { id: string; name: string; text: string };
type SealedInfo = { mempoolId: string; rules: RuleText[]; revealRules?: RuleText[]; batchHook?: string | null; builders: string[]; pending: number; tickets?: number };
type TxEvent = { kind: string; status: string; at: number };

const STORAGE_KEY = 'leanseal.flags';
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

let schema: FlagDef[] = [];
let presets: Preset[] = [];
let optionState: OptionState = {};
let defaults: Flags = {};
let flags: Flags = {};
let runs: Run[] = [];
let running = false;
let selectedTx = '';
let mempoolView: 'standard' | 'sealed' = 'standard';
let sealedInfo: SealedInfo | null = null;

const pages: Record<string, { label: string; meta: string }> = {
  overview: { label: 'Run', meta: 'Pick a scenario and run it' },
  flags: { label: 'Settings', meta: 'Every option, one place' },
  checks: { label: 'Checks', meta: 'Why the mempool let each transaction in' },
  sealed: { label: 'Sealed', meta: 'Encrypted envelopes and who opened them' },
  wallets: { label: 'Wallets', meta: 'Quantum-safe accounts and balances' }
};

type PasskeyWallet = { network: string; available: boolean; account?: string; created?: boolean; ethWei?: string | null };
type PasskeyStatus = { unlocked: boolean; id?: string; wallets?: PasskeyWallet[] };
let passkeyStatus: PasskeyStatus = { unlocked: false };
let passkeyBusy = false;
let keyLoaded = false;


function readStoredFlags(): Flags {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Flags;
  } catch {
    return {};
  }
}

function storeFlags() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch {
    return;
  }
}

function el(tag: string, cls = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function short(hex?: string) {
  return hex ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : '—';
}

function tusd(wei?: string | null) {
  return wei ? `${(Number(BigInt(wei)) / 1e18).toFixed(6)} tUSD` : '—';
}

function eth(wei?: string | null) {
  return wei ? `${(Number(BigInt(wei)) / 1e18).toFixed(5)} ETH` : '—';
}

function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function optionLabel(key: string, value: FlagValue) {
  if (key === 'mevBot') return value ? 'on' : 'off';
  if (key === 'slippageBps') return `${Number(value) / 100}%`;
  if (key === 'verifyGas') return value === 0 ? 'auto' : Number(value) >= 1_000_000 ? `${Number(value) / 1_000_000}M` : `${Number(value) / 1000}k`;
  return String(value);
}

function showMessage(message: string) {
  $('#dashboard-alert p').textContent = message;
  $('#dashboard-alert').hidden = false;
}

function activateTab(name: string) {
  const page = pages[name];
  if (page) {
    $('#page-label').textContent = page.label;
    $('#page-meta').textContent = page.meta;
  }
  $$<HTMLButtonElement>('[data-tab]').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $$('[data-panel]').forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  if (name === 'checks') void loadAdmissions();
}

function showLive(name: string) {
  $$<HTMLButtonElement>('#live-tabs button').forEach((b) => {
    const on = b.dataset.live === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  $$('[data-live-panel]').forEach((p) => { p.hidden = p.dataset.livePanel !== name; });
}

function clearResult() {
  $('#run-meta').textContent = flags.network === 'devnet' ? 'No runs on the devnet yet.' : 'No runs on the local chain yet.';
  $$('[data-r]').forEach((n) => { n.textContent = '—'; });
  $('#verdict').hidden = true;
  $('#verdict-empty').hidden = false;
  renderTxs(null);
  $('#run-state').textContent = 'idle';
  showLive('log');
}

function showLatestRun() {
  if (running) return;
  $('#log').textContent = '';
  const last = runs.find((r) => r.flags.network === flags.network);
  if (!last) return clearResult();
  setResult(last);
  $('#run-state').textContent = 'last run';
  showLive('result');
}

function renderFacts() {
  $('#side-network').replaceChildren(el('i'), document.createTextNode(flags.network === 'devnet' ? ' Public hackathon devnet' : ' Our local chain'));
  $$<HTMLButtonElement>('#net-switch button').forEach((b) => {
    const on = b.dataset.net === flags.network;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('#checks-net').textContent = `ALT MEMPOOL · ${String(flags.network).toUpperCase()}`;
  renderPresets();
  renderSummary();
  renderPasskey();
  if (lastNetwork !== flags.network) {
    lastNetwork = String(flags.network);
    showLatestRun();
  }
  void checkFlags();
}

let lastNetwork = '';

function setFlags(next: Flags) {
  flags = next;
  storeFlags();
  renderFacts();
}

function sameFlags(a: Flags, b: Flags) {
  return schema.every((d) => a[d.key] === b[d.key]);
}

const presetFor = (f: Flags) => presets.find((p) => sameFlags({ ...p.flags, network: f.network }, f));

function renderPresets() {
  const select = $<HTMLSelectElement>('#scenario');
  const current = presetFor(flags);
  const group = (label: string, list: Preset[]) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...list.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.title;
      return o;
    }));
    return g;
  };
  const options: HTMLElement[] = [group('LeanSeal', presets.filter((p) => p.group === 'core')), group('Extras', presets.filter((p) => p.group !== 'core'))];
  if (!current) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Custom settings';
    options.unshift(o);
  }
  select.replaceChildren(...options);
  select.value = current?.id ?? '';
}

const LANE_TEXT: Record<string, string> = { public: 'Public mempool', sealed: 'Encrypted, then public', batch: 'Sealed mempool → batch auction' };

function renderSummary() {
  const current = presetFor(flags);
  $('#scenario-text').textContent = current?.text ?? 'Your own mix of settings.';
  const facts: Array<[string, string]> = [
    ['Route', flags.action === 'swap' ? LANE_TEXT[String(flags.lane)] ?? String(flags.lane) : 'Send 1 gwei'],
    ['Wallet', `${flags.wallet === 'passkey' ? 'Your passkey' : 'Demo'} · ${flags.scheme === 'lss' ? 'leanSphincs-s' : 'SHA2'}`],
    ['Gas', flags.gas === 'sponsor' ? 'Free (sponsor pays)' : 'Wallet pays'],
  ];
  $('#scenario-facts').replaceChildren(...facts.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
}

function passkeyWallet() {
  return passkeyStatus.wallets?.find((w) => w.network === flags.network);
}

function pkButton(text: string, onClick: () => Promise<void>, ghost = false) {
  const b = el('button', ghost ? 'ghost' : '', text) as HTMLButtonElement;
  b.type = 'button';
  b.disabled = passkeyBusy;
  b.addEventListener('click', () => {
    passkeyBusy = true;
    renderPasskey();
    onClick().catch((e: Error) => showMessage(e.message)).finally(() => { passkeyBusy = false; renderPasskey(); });
  });
  return b;
}

function renderPasskey() {
  const text = $('#pk-text');
  const actions = $('#pk-actions');
  const blocked = pk.supported();
  if (blocked) {
    text.textContent = blocked;
    actions.replaceChildren();
    return;
  }
  if (!passkeyStatus.unlocked || !keyLoaded) {
    text.textContent = 'Sign in with Face ID or a fingerprint. Your quantum-safe key is made here, in this browser.';
    actions.replaceChildren(
      pkButton(pk.hasCredential() ? 'Unlock with passkey' : 'Create passkey', () => unlock(!pk.hasCredential())),
      ...(pk.hasCredential() ? [pkButton('Use a new passkey', () => unlock(true), true)] : [])
    );
    return;
  }
  const w = passkeyWallet();
  const net = flags.network === 'devnet' ? 'devnet' : 'local chain';
  if (!w?.available) {
    text.textContent = `Unlocked. Wallets are not set up on the ${net} yet.`;
    actions.replaceChildren(pkButton('Lock', lock, true));
    return;
  }
  text.replaceChildren(el('span', 'mono', short(w.account)), document.createTextNode(w.created ? ` · ${eth(w.ethWei)}` : ` · not created on the ${net} yet`));
  actions.replaceChildren(
    ...(w.created
      ? [pkButton('Swap with my wallet', async () => { setFlags({ ...(presets.find((p) => p.id === 'passkey')?.flags ?? flags), network: flags.network }); activateTab('overview'); })]
      : [pkButton('Create my wallet (free)', () => createWallet())]),
    pkButton('Lock', lock, true)
  );
}

async function unlock(create: boolean) {
  const prf = create ? await pk.createPasskey() : await pk.unlockPasskey();
  const key = await pk.loadKey(prf);
  keyLoaded = true;
  const res = await fetch('/api/passkey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(key) });
  if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
  passkeyStatus = await res.json() as PasskeyStatus;
  void checkFlags();
}

async function lock() {
  pk.forget();
  keyLoaded = false;
  await fetch('/api/passkey', { method: 'DELETE' });
  passkeyStatus = { unlocked: false };
  void checkFlags();
}

async function refreshPasskey() {
  const res = await fetch('/api/passkey').catch(() => null);
  if (!res?.ok) return;
  passkeyStatus = await res.json() as PasskeyStatus;
  renderPasskey();
}

async function createWallet() {
  const res = await fetch('/api/passkey/onboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: flags.network }) });
  if (res.status !== 202) throw new Error(((await res.json()) as { error: string }).error);
  activateTab('overview');
}

async function answerSign(e: { reqId: string; id: string; digest: string }) {
  if (!keyLoaded || passkeyStatus.id !== e.id) return;
  const t0 = performance.now();
  const signature = await pk.sign(e.digest);
  logLine('sys', `PASSKEY signed ${short(e.digest)} in this browser (${Math.round(performance.now() - t0)} ms)`);
  await fetch('/api/sign/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reqId: e.reqId, signature }) });
}

function segFor(def: FlagDef) {
  const seg = el('div', 'seg');
  const states = optionState[def.key] ?? def.options.map((value) => ({ value, ok: true, reason: '' }));
  states.forEach(({ value, ok, reason }) => {
    const on = flags[def.key] === value;
    const b = el('button', on ? 'on' : '', optionLabel(def.key, value)) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.disabled = !ok && !on;
    if (!ok) b.title = reason;
    b.addEventListener('click', () => setFlags({ ...flags, [def.key]: value }));
    seg.append(b);
  });
  return seg;
}

function renderControls() {
  $('#quick-flags').replaceChildren(...schema.filter((def) => def.key !== 'network').map((def) => {
    const row = el('div', 'quick-row');
    row.append(el('span', '', def.label), segFor(def));
    return row;
  }));
  $('#flag-grid').replaceChildren(...schema.map((def) => {
    const card = el('article', 'surface flag-card');
    card.append(el('span', 'eyebrow', def.key.toUpperCase()), el('h3', '', def.label), el('p', '', def.help), segFor(def));
    const current = optionState[def.key]?.find((o) => o.value === flags[def.key]);
    if (current && !current.ok) card.append(el('p', 'seg-note', current.reason));
    return card;
  }));
}

async function checkFlags() {
  const res = await fetch('/api/flags/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(flags) }).catch(() => null);
  if (!res?.ok) return;
  const { problems, options } = await res.json() as { problems: string[]; options: OptionState };
  optionState = options;
  renderControls();
  const list = $('#flag-problems');
  list.replaceChildren(...problems.map((p) => el('li', '', p)));
  list.hidden = problems.length === 0;
  setRunEnabled(!running && problems.length === 0);
}

function setRunEnabled(on: boolean) {
  $$<HTMLButtonElement>('#run-main').forEach((b) => { b.disabled = !on; });
}

async function startRun() {
  const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(flags) });
  if (res.status === 202) return;
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error: string };
  showMessage(body.error);
}

function logLine(cls: string, text: string) {
  const log = $('#log');
  log.append(el('span', cls, `${text}\n`));
  log.scrollTop = log.scrollHeight;
}

function runLabel(run: Run) {
  const what = run.flags.action === 'onboard' ? 'create wallet' : run.flags.action === 'transfer' ? 'transfer' : `${run.flags.lane} swap`;
  return `run #${run.id} · ${what} · ${run.flags.network === 'devnet' ? 'devnet' : 'local'} · ${run.flags.wallet === 'passkey' ? 'passkey wallet' : 'demo wallet'}`;
}

function setResult(run: Run) {
  $('#run-meta').textContent = runLabel(run);
  $('[data-r="quote"]').textContent = run.quote && run.quote !== '0' ? tusd(run.quote) : '—';
  $('[data-r="received"]').textContent = run.received && run.received !== '0' ? tusd(run.received) : '—';
  $('[data-r="loss"]').textContent = run.lossPct === undefined ? '—' : `${run.lossPct.toFixed(3)}%`;
  $('[data-r="gas"]').textContent = run.gasUsed ? run.gasUsed.toLocaleString() : '—';
  const v = $('#verdict');
  v.hidden = false;
  $('#verdict-empty').hidden = true;
  v.className = `verdict ${run.ok && (run.lossPct ?? 0) <= 0.01 ? 'good' : 'bad'}`;
  v.textContent = verdictText(run);
  renderTxs(run);
}

const EXPLORER_NODE: Record<string, string> = { local: 'http://127.0.0.1:14347/rpc', devnet: 'https://altmempool.forshtat.com/rpc' };

function txRow(label: string, hash: string, note: string, explorer: boolean, network: string) {
  const row = el('div', 'tx-row');
  const copy = el('button', 'quiet-button', 'Copy') as HTMLButtonElement;
  copy.type = 'button';
  copy.addEventListener('click', () => { void navigator.clipboard.writeText(hash).then(() => { copy.textContent = 'Copied'; }); });
  const actions = el('span', 'tx-actions');
  actions.append(copy);
  if (explorer) {
    const a = el('a', 'quiet-button', 'Open ↗') as HTMLAnchorElement;
    a.href = `https://explorer.altmempool.wtf/tx/${hash}?node=${encodeURIComponent(EXPLORER_NODE[network] ?? EXPLORER_NODE.local)}`;
    a.target = '_blank';
    a.rel = 'noopener';
    actions.append(a);
  }
  row.append(el('span', 'tx-label', label), el('code', 'tx-hash', short(hash)), actions, el('small', 'tx-note', note));
  return row;
}

function renderTxs(run: Run | null) {
  const list = $('#tx-list');
  if (!run) {
    list.replaceChildren(el('p', 'live-empty', 'No transactions yet.'));
    return;
  }
  const net = String(run.flags.network);
  const rows: HTMLElement[] = [];
  if (run.txHash) {
    const label = run.flags.action === 'onboard' ? 'Wallet created' : run.flags.lane === 'batch' ? 'Commit' : run.flags.action === 'transfer' ? 'Transfer' : 'Swap';
    rows.push(txRow(label, run.txHash, 'Frame transaction through the alt mempool', true, net));
  }
  if (run.batch?.revealTx) rows.push(txRow('Reveal', run.batch.revealTx, 'Sent by a node keeper (normal transaction)', false, net));
  if (run.batch?.ticket) rows.push(txRow('Sealed ticket', run.batch.ticket, 'Not a transaction: lives only in our sealed mempool', false, net));
  list.replaceChildren(...(rows.length ? rows : [el('p', 'live-empty', 'No transactions in this run.')]));
}

function verdictText(run: Run) {
  if (!run.ok) return `Failed: ${run.error ?? 'unknown error'}`;
  const verify = run.frameGas?.[0] ? ` VERIFY frame used ${run.frameGas[0].toLocaleString()} gas.` : '';
  if (run.flags.action === 'onboard') return `Wallet created in block ${run.block}, in one transaction. The sponsor paid the gas.`;
  if (run.flags.action === 'transfer') return `Mined in block ${run.block}.${verify}`;
  if (run.flags.lane === 'batch') {
    const blocked = run.batch?.frontRunsBlocked ? ` The bot saw the order only after it was revealed and tried to front-run ${run.batch.frontRunsBlocked}×: ${run.batch.blockedReason}.` : '';
    return `Batch ${run.batch?.round ?? '?'} settled at one price: loss ${run.lossPct?.toFixed(3) ?? '0'}%. Reveal ${run.batch?.ticketStatus ?? '?'}${run.batch?.note ? ` (${run.batch.note})` : ''}.${blocked}`;
  }
  if (run.botTargeted && (run.lossPct ?? 0) > 0.01) return `Sandwiched: the bot read the swap and made ${run.botProfit ?? '?'} wei; Alice lost ${run.lossPct?.toFixed(3) ?? '?'}%.${verify}`;
  return run.flags.lane === 'sealed'
    ? `Protected: the bot saw only ciphertext. Mined in block ${run.block}, loss ${run.lossPct?.toFixed(3) ?? '0'}%.${verify}`
    : `Mined in block ${run.block} with no sandwich (bot ${run.flags.mevBot ? 'found nothing' : 'off'}).${verify}`;
}

function connectEvents() {
  const es = new EventSource('/events');
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'start') {
      running = true;
      setRunEnabled(false);
      $('#log').textContent = '';
      $('#verdict').hidden = true;
      $('#verdict-empty').hidden = false;
      $('#run-meta').textContent = '';
      renderTxs(null);
      showLive('log');
      $$('[data-r]').forEach((n) => { n.textContent = '…'; });
      $('#run-state').textContent = e.mode === 'onboard' ? `run #${e.runId} · create wallet` : `run #${e.runId} · ${e.flags.action} · ${e.flags.lane}`;
      logLine('sys', `flags: ${schema.map((d) => `${d.key}=${optionLabel(d.key, e.flags[d.key])}`).join('  ')}`);
    } else if (e.type === 'line') {
      if (e.line.trim().startsWith('{')) return;
      logLine(e.stream === 'alice' ? 'alice' : 'bot', `${e.stream === 'alice' ? 'ALICE ' : 'BOT   '} ${e.line}`);
    } else if (e.type === 'result') {
      running = false;
      $('#run-state').textContent = e.run.ok ? 'done' : 'failed';
      setResult(e.run as Run);
      showLive('result');
      void checkFlags();
      void loadRuns();
      void loadStatus();
      void refreshPasskey();
    } else if (e.type === 'sign') {
      void answerSign(e).catch((err: Error) => logLine('sys', `passkey signing failed: ${err.message}`));
    } else if (e.type === 'error') {
      running = false;
      logLine('sys', `error: ${e.message}`);
      void checkFlags();
    }
  };
  es.onerror = () => { $('#sync-status').replaceChildren(el('i'), document.createTextNode(' Reconnecting')); };
}

function serviceLine(name: string, p: Probe, extra = '') {
  const line = el('div', 'readiness-line');
  const label = el('span');
  const dot = el('i', 'ready-dot');
  if (!p.up) dot.style.background = '#c4352b';
  label.append(dot, document.createTextNode(` ${name}`));
  line.append(label, el('strong', '', p.up ? `up · ${p.ms} ms${extra}` : 'down'));
  return line;
}

async function loadStatus() {
  const res = await fetch('/api/status').catch(() => null);
  if (!res?.ok) {
    $('#sync-status').replaceChildren(el('i'), document.createTextNode(' API offline'));
    return;
  }
  const s = await res.json() as Status;
  $('#sync-status').replaceChildren(el('i'), document.createTextNode(` Synced ${new Date().toLocaleTimeString()}`));
  const block = (p: Probe) => (p.up ? ` · block ${Number(p.value).toLocaleString()}` : '');
  $('#service-lines').replaceChildren(
    serviceLine('Local chain', s.localBlock, block(s.localBlock)),
    serviceLine('Local alt mempool', s.sidecar),
    serviceLine('Sealed mempool', s.node),
    serviceLine('Devnet chain', s.devnetBlock, block(s.devnetBlock)),
    serviceLine('Devnet alt mempool', s.devnetSidecar),
    serviceLine('Devnet sealed mempool', s.devnetNode)
  );
  renderWallets(s.wallets, s.reputation);
}

function renderWallets(wallets: Wallet[], reputation: Probe) {
  const rep = new Map<string, { status: string; opsSeen: number; opsIncluded: number }>();
  const items = (reputation.value as { items?: Array<{ address: string; status: string; opsSeen: number; opsIncluded: number }> } | undefined)?.items ?? [];
  items.forEach((r) => rep.set(r.address.toLowerCase(), r));
  $('#wallet-cards').replaceChildren(...wallets.map((w) => {
    const card = el('article', 'surface asset-card wallet-card');
    card.append(el('span', 'eyebrow', `${w.network.toUpperCase()} · ${w.scheme === 'lss' ? 'LEANSPHINCS-S' : 'SLH-DSA-SHA2'}`));
    card.append(el('h3', '', w.deployed ? short(w.account) : 'Not deployed'));
    if (w.deployed) {
      const r = rep.get(w.account!.toLowerCase());
      const dl = el('dl');
      const rows: Array<[string, string]> = [
        ['ETH', eth(w.ethWei)],
        ['tUSD', w.tusdWei ? tusd(w.tusdWei) : '—'],
        ['Stake', w.staked ? eth(w.stakeWei) : 'unstaked'],
        ['Reputation', r ? `${r.status} · ${r.opsIncluded}/${r.opsSeen} included` : w.network === 'local' ? 'no record' : '—']
      ];
      rows.forEach(([k, v]) => dl.append(el('dt', '', k), el('dd', '', v)));
      card.append(dl);
    }
    const foot = el('footer');
    foot.append(el('span', '', w.scheme === 'lss' ? 'fits 100k unstaked' : 'needs stake (over 100k)'), el('span', '', w.network));
    card.append(foot);
    return card;
  }));
}

async function loadRuns() {
  const res = await fetch('/api/runs').catch(() => null);
  if (!res?.ok) return;
  runs = await res.json() as Run[];
  const list = $('#run-list');
  list.replaceChildren(...(runs.length ? runs.slice(0, 8).map((r) => {
    const row = el('div', 'activity-row');
    const what = r.flags.action === 'onboard' ? `#${r.id} create wallet · ${r.flags.network}` : `#${r.id} ${r.flags.action} · ${r.flags.lane} · ${r.flags.scheme}${r.flags.wallet === 'passkey' ? ' · passkey' : ''}`;
    const outcome = !r.ok ? `failed` : r.lossPct !== undefined ? `loss ${r.lossPct.toFixed(3)}%` : `block ${r.block}`;
    row.append(el('span', '', what), el('span', '', `${outcome} · ${ago(r.at)}`));
    row.classList.add('pick');
    row.title = 'Show this run';
    row.addEventListener('click', () => { if (!running) { setResult(r); $('#log').textContent = ''; $('#run-state').textContent = r.ok ? 'done' : 'failed'; showLive('result'); } });
    return row;
  }) : [el('div', 'loading-row', 'No runs yet. Pick flags and press Run.')]));
  renderSealed();
}

function renderSealed() {
  const sealed = runs.filter((r) => r.flags.lane === 'sealed');
  const last = sealed[0];
  $('[data-s="sign"]').textContent = last?.signMs !== undefined ? `${last.signMs} ms` : '—';
  $('[data-s="round"]').textContent = last?.envelope?.round ? `#${last.envelope.round}` : '—';
  $('[data-s="door"]').textContent = last ? (last.envelope ? 'passed' : 'refused') : '—';
  $('[data-s="opened"]').textContent = last?.envelope?.openedBy ?? (last ? 'not opened' : '—');
  $('#sealed-last').textContent = last ? `last: run #${last.id}, ${last.ok ? `block ${last.block}` : last.error ?? 'failed'}` : 'no sealed run yet';
  const verdicts = new Map((last?.sealedChecks ?? []).map((c) => [c.rule, c]));
  $('#door-list').replaceChildren(...(sealedInfo?.rules ?? []).map((r) => {
    const c = verdicts.get(r.id);
    const row = el('div', `check-row ${c?.verdict ?? ''}`);
    row.append(el('span', 'dot'), el('span', '', `${r.id} · ${r.name}`), el('em', '', c ? c.verdict.toUpperCase() : ''), el('small', '', c?.detail ?? r.text));
    return row;
  }));
  const table = $('#envelope-table');
  table.replaceChildren(...(sealed.length ? sealed.slice(0, 10).map((r) => {
    const tr = el('tr');
    tr.append(el('td', 'mono', short(r.envelope?.id)), el('td', '', r.envelope?.status ?? 'refused at the door'), el('td', '', r.envelope?.openedBy ?? '—'), el('td', '', r.lossPct !== undefined ? `${r.lossPct.toFixed(3)}%` : '—'));
    return tr;
  }) : [(() => { const tr = el('tr'); const td = el('td', 'loading-row', 'No sealed runs yet.'); td.setAttribute('colspan', '4'); tr.append(td); return tr; })()]));
}

const keyOf = (a: Admission) => a.txHash ?? a.envelopeId ?? `refused #${a.id}`;

async function loadSealedInfo() {
  const res = await fetch('/api/mempool').catch(() => null);
  if (!res?.ok) return;
  sealedInfo = await res.json() as SealedInfo;
  $('#sealed-mempool-id').textContent = sealedInfo.mempoolId;
  renderSealed();
}

async function loadAdmissions() {
  const sealed = mempoolView === 'sealed';
  const res = await fetch(sealed ? `/api/admissions?mempool=sealed&network=${flags.network}` : `/api/admissions?network=${flags.network}`).catch(() => null);
  const table = $('#admission-table');
  $('#admission-key').textContent = sealed ? 'Envelope' : 'Tx';
  $('#checks-net').textContent = sealed ? `LEANSEAL SEALED MEMPOOL · ${String(flags.network).toUpperCase()}` : `ALT MEMPOOL · ${String(flags.network).toUpperCase()}`;
  $('#mempool-id').textContent = sealed && sealedInfo
    ? `mempool id ${sealedInfo.mempoolId} · ${sealedInfo.rules.length} SEAL rules · ${sealedInfo.pending} pending`
    : 'the standard ERC-8421 rule set: global checks, then per entity for each validation frame';
  if (!res?.ok) {
    table.replaceChildren(el('tr', 'loading-row', 'Mempool unreachable.'));
    return;
  }
  const items = await res.json() as Admission[];
  const select = (a: Admission, tr?: HTMLElement) => {
    selectedTx = keyOf(a);
    $$('#admission-table tr').forEach((row) => row.classList.remove('on'));
    tr?.classList.add('on');
    renderChecks(a);
    if (a.txHash && !sealed) void loadEvents(a.txHash);
    else $('#event-list').replaceChildren();
  };
  const rows = items.map((a) => {
    const key = keyOf(a);
    const tr = el('tr', `pick${key === selectedTx ? ' on' : ''}`);
    tr.append(el('td', '', ago(a.at)), el('td', 'mono', key.startsWith('0x') ? short(key) : key), el('td', 'mono', short(a.sender)), el('td', `out-${a.outcome}`, a.outcome));
    tr.addEventListener('click', () => select(a, tr));
    return tr;
  });
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'loading-row', sealed ? 'No envelopes yet. Run a sealed swap.' : 'No admissions yet.');
    td.setAttribute('colspan', '4');
    tr.append(td);
    rows.push(tr);
  }
  table.replaceChildren(...rows);
  if (items.length && !items.some((a) => keyOf(a) === selectedTx)) select(items[0], rows[0]);
}

function renderChecks(a: Admission) {
  const key = keyOf(a);
  $('#check-title').textContent = `${a.outcome === 'included' ? 'Admitted' : a.outcome} · ${key.startsWith('0x') ? short(key) : key}`;
  const passed = a.checks.filter((c) => c.verdict === 'pass').length;
  $('#check-count').textContent = `${passed}/${a.checks.length} passed`;
  $('#check-list').replaceChildren(...a.checks.map((c) => {
    const row = el('div', `check-row ${c.verdict}`);
    const scope = c.entity ? `${c.entity} · frame ${c.frameIndex}` : c.name ? 'sealed' : 'global';
    const text = c.detail ?? [...(sealedInfo?.rules ?? []), ...(sealedInfo?.revealRules ?? [])].find((r) => r.id === c.rule)?.text;
    row.append(el('span', 'dot'), el('span', '', c.name ? `${c.rule} · ${c.name}` : c.rule), el('em', '', `${c.verdict.toUpperCase()} · ${scope}`));
    if (text) row.append(el('small', '', text));
    return row;
  }));
}

async function loadEvents(hash: string) {
  const res = await fetch(`/api/tx/${hash}?network=${flags.network}`).catch(() => null);
  const list = $('#event-list');
  if (!res?.ok) {
    list.replaceChildren();
    return;
  }
  const { events } = await res.json() as { events: TxEvent[] };
  list.replaceChildren(el('span', 'eyebrow', 'LIFECYCLE'), ...events.map((e) => {
    const row = el('div', 'check-row pass');
    row.append(el('span', 'dot'), el('span', '', e.kind), el('em', '', `${e.status} · ${new Date(e.at).toLocaleTimeString()}`));
    return row;
  }));
}

async function init() {
  $$<HTMLButtonElement>('[data-tab]').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab!)));
  $$('[data-open-tab]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    activateTab(link.dataset.openTab!);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  $$('[data-refresh]').forEach((b) => b.addEventListener('click', () => { void loadStatus(); void loadRuns(); void loadAdmissions(); }));
  $('#dashboard-alert button').addEventListener('click', () => { $('#dashboard-alert').hidden = true; });
  $$<HTMLButtonElement>('#run-main').forEach((b) => b.addEventListener('click', () => { void startRun(); }));
  $$<HTMLButtonElement>('#live-tabs button').forEach((b) => b.addEventListener('click', () => showLive(b.dataset.live!)));
  const dialog = $<HTMLDialogElement>('#advanced-dialog');
  $('#advanced-open').addEventListener('click', () => dialog.showModal());
  $$('#advanced-close, #advanced-done').forEach((b) => b.addEventListener('click', () => dialog.close()));
  $('#advanced-reset').addEventListener('click', () => setFlags({ ...defaults, network: flags.network }));
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
  $<HTMLSelectElement>('#scenario').addEventListener('change', (ev) => {
    const p = presets.find((x) => x.id === (ev.target as HTMLSelectElement).value);
    if (p) setFlags({ ...p.flags, network: flags.network });
  });
  $$<HTMLButtonElement>('#net-switch button').forEach((b) => b.addEventListener('click', () => setFlags({ ...flags, network: b.dataset.net! })));
  $('#reset-flags').addEventListener('click', () => setFlags({ ...defaults }));
  $$<HTMLButtonElement>('#mempool-switch button').forEach((b) => b.addEventListener('click', () => {
    mempoolView = b.dataset.mempool === 'sealed' ? 'sealed' : 'standard';
    $$('#mempool-switch button').forEach((x) => x.classList.toggle('on', x === b));
    selectedTx = '';
    void loadAdmissions();
  }));
  const res = await fetch('/api/flags').catch(() => null);
  if (!res?.ok) {
    showMessage('Cannot reach the LeanSeal API. Start it with: cd demo && npx --prefix ../workshop tsx server.ts');
    return;
  }
  const body = await res.json() as { defaults: Flags; schema: FlagDef[]; presets: Preset[] };
  schema = body.schema;
  presets = body.presets;
  defaults = body.defaults;
  const stored = readStoredFlags();
  flags = Object.fromEntries(schema.map((d) => [d.key, d.options.includes(stored[d.key]) ? stored[d.key] : defaults[d.key]]));
  renderControls();
  renderFacts();
  connectEvents();
  await loadSealedInfo();
  await Promise.all([loadStatus(), loadRuns(), loadAdmissions(), refreshPasskey()]);
  showLatestRun();
  setInterval(() => { void loadStatus(); }, 10_000);
  setInterval(() => { if (!$<HTMLElement>('[data-panel="checks"]').hidden) void loadAdmissions(); }, 15_000);
}

void init();
