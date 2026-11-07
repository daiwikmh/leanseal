import * as pk from './passkey';

type FlagValue = string | number | boolean;
type Flags = Record<string, FlagValue>;
type FlagDef = { key: string; label: string; options: FlagValue[]; help: string };
type Preset = { id: string; group: 'core' | 'extra'; title: string; text: string; flags: Flags };
type OptionState = Record<string, Array<{ value: FlagValue; ok: boolean; reason: string }>>;

type Run = {
  id: number;
  transferTo?: string;
  order?: { side: 'buy' | 'sell'; amountWei: string };
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
  batch?: { round?: string; ticket?: string; ticketStatus?: string; note?: string; revealTx?: string; frontRunsBlocked?: number; blockedReason?: string; refunded?: boolean };
  admissionOutcome?: string;
};

type Probe = { up: boolean; ms: number; value?: unknown; error?: string };
type Wallet = { network: string; scheme: string; deployed: boolean; account?: string; ethWei?: string | null; tusdWei?: string | null; stakeWei?: string; staked?: boolean };
type Status = { public?: boolean; localBlock?: Probe; devnetBlock: Probe; sidecar?: Probe; devnetSidecar: Probe; node?: Probe; devnetNode: Probe; reputation?: Probe; wallets: Wallet[] };
type Check = { rule: string; verdict: string; detail?: string; entity?: string; frameIndex?: number; name?: string };
type Admission = { id: number; txHash?: string; envelopeId?: string; sender?: string; at: number; outcome: string; checks: Check[] };
type RuleText = { id: string; name: string; text: string };
type SealedInfo = { mempoolId: string; rules: RuleText[]; revealRules?: RuleText[]; batchHook?: string | null; builders: string[]; pending: number; tickets?: number };
type TxEvent = { kind: string; status: string; at: number };

const STORAGE_KEY = 'leanseal.flags';
const SESSION_KEY = 'leanseal.session';

function sessionId(): string {
  try {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) return saved;
    const fresh = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

const SESSION = sessionId();
const nativeFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('/api')) {
    const headers = new Headers(init.headers);
    headers.set('x-leanseal-session', SESSION);
    return nativeFetch(input, { ...init, headers });
  }
  return nativeFetch(input, init);
};
let isPublic = false;
type Mode = 'individual' | 'institution';
const MODE_KEY = 'leanseal.mode';

function storedMode(): Mode | null {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'individual' || m === 'institution' ? m : null;
  } catch {
    return null;
  }
}

let mode: Mode = storedMode() ?? 'individual';

const INSTITUTION_PRESETS: Record<string, { title: string; text: string }> = {
  protected: { title: 'Sealed block trade', text: 'Your order travels as a sealed hash through our ERC-8421 mempool. Every order in the batch fills at one price, so no one can trade ahead of you.' },
  passkey: { title: 'Sealed block trade, desk operator wallet', text: 'The same sealed block trade, signed by the desk operator. The quantum-safe key is made in this browser from a passkey and never leaves it.' },
  attack: { title: 'Same order on the public mempool', text: 'The order in plain sight. A bot trades around it and takes up to your slippage.' },
};

const INSTITUTION_ONLY = 'passkey';
const visiblePresets = () => (mode === 'institution' ? presets.filter((p) => p.id === INSTITUTION_ONLY) : presets);

const presetTitle = (p: Preset) => (mode === 'institution' ? INSTITUTION_PRESETS[p.id]?.title : undefined) ?? p.title;
const presetText = (p: Preset) => (mode === 'institution' ? INSTITUTION_PRESETS[p.id]?.text : undefined) ?? p.text;
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
let sealedInfo: SealedInfo | null = null;

const pages: Record<string, { label: string; meta: string }> = {
  overview: { label: 'Run', meta: 'Pick a scenario and run it' },
  flags: { label: 'Settings', meta: 'Every option, one place' },
  checks: { label: 'Checks', meta: 'Why the alt mempool let each transaction in' },
  sealed: { label: 'Sealed mempool', meta: 'Our ERC-8421 custom mempool and the orders it carries' },
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
  if (name === 'sealed') void loadSealedInfo();
  if (name === 'wallets') { renderWallets(); if (passkeyStatus.unlocked) void loadVault(); }
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
  $('#side-network').replaceChildren(el('i'), document.createTextNode(flags.network === 'devnet' ? ' Public hackathon devnet · chain 1337' : ' Local chain on this machine'));
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

const presetFor = (f: Flags) => visiblePresets().find((p) => sameFlags({ ...p.flags, network: f.network }, f));

function renderPresets() {
  const select = $<HTMLSelectElement>('#scenario');
  const current = presetFor(flags);
  const group = (label: string, list: Preset[]) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...list.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = presetTitle(p);
      return o;
    }));
    return g;
  };
  const shown = visiblePresets();
  const core = shown.filter((p) => p.group === 'core');
  const extras = shown.filter((p) => p.group !== 'core');
  const options: HTMLElement[] = [...(core.length ? [group('LeanSeal', core)] : []), ...(extras.length ? [group('Extras', extras)] : [])];
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

const DEMO_RECIPIENT = '0x8943545177806ED17B9F23F0a21ee5948eCaa776';

function transferTarget(): string {
  const v = (document.querySelector<HTMLInputElement>('#transfer-to')?.value ?? '').trim();
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : '';
}

function renderSummary() {
  $('#transfer-to-row').hidden = flags.action !== 'transfer';
  const current = presetFor(flags);
  $('#scenario-text').textContent = current ? presetText(current) : 'Your own mix of settings.';
  const facts: Array<[string, string]> = [
    ['Route', flags.action === 'swap' ? LANE_TEXT[String(flags.lane)] ?? String(flags.lane) : `Send 1 wei to ${transferTarget() ? short(transferTarget()) : 'our demo recipient'}`],
    ['Wallet', `${flags.wallet === 'passkey' ? (mode === 'institution' ? 'Desk operator (passkey)' : 'Your passkey') : 'Demo'} · ${flags.scheme === 'lss' ? 'leanSphincs-s' : 'SHA2'}`],
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
  if (mode === 'institution') void loadVault();
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
  const locked = new Set(isPublic || mode === 'institution' ? ['network'] : []);
  $('#settings-note').textContent = mode === 'institution'
    ? 'Institution orders use the order ticket on the Run tab; these settings apply to the Individual scenarios.'
    : 'Saved in this browser. Greyed-out options can\'t work with the rest; hover one to see why.';
  $('#flag-grid').replaceChildren(...schema.filter((def) => !locked.has(def.key)).map((def) => {
    const row = el('div', 'settings-row');
    const label = el('div', 'settings-label');
    label.append(el('strong', '', def.label), el('small', '', def.help));
    row.append(label, segFor(def));
    const current = optionState[def.key]?.find((o) => o.value === flags[def.key]);
    if (current && !current.ok) row.append(el('p', 'seg-note', current.reason));
    return row;
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
  const typed = $<HTMLInputElement>('#transfer-to').value.trim();
  if (flags.action === 'transfer' && typed && !transferTarget()) return showMessage('The recipient must be a 0x… address with 40 hex characters.');
  const payload = flags.action === 'transfer' && transferTarget() ? { ...flags, transferTo: transferTarget() } : flags;
  const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
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
  const what = run.order ? `${run.order.side} order` : run.flags.action === 'onboard' ? 'create wallet' : run.flags.action === 'withdraw' ? 'withdraw' : run.flags.action === 'faucet' ? 'test funds' : run.flags.action === 'transfer' ? 'transfer' : `${run.flags.lane} swap`;
  return `run #${run.id} · ${what} · ${run.flags.network === 'devnet' ? 'devnet' : 'local'} · ${run.flags.wallet === 'passkey' ? 'passkey wallet' : 'demo wallet'}`;
}

function setResult(run: Run) {
  $('#run-meta').textContent = runLabel(run);
  const out = run.order?.side === 'sell' ? (w: string) => eth(w) : (w: string) => tusd(w);
  $('[data-r="quote"]').textContent = run.quote && run.quote !== '0' ? out(run.quote) : '—';
  $('[data-r="received"]').textContent = run.received && run.received !== '0' ? out(run.received) : '—';
  $('[data-r="loss"]').textContent = run.lossPct === undefined ? '—' : `${run.lossPct.toFixed(3)}%`;
  $('[data-r="gas"]').textContent = run.gasUsed ? run.gasUsed.toLocaleString() : '—';
  const v = $('#verdict');
  v.hidden = false;
  $('#verdict-empty').hidden = true;
  v.className = `verdict ${run.ok && (run.lossPct ?? 0) <= 0.01 ? 'good' : 'bad'}`;
  v.textContent = verdictText(run) + sizeNote(run);
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

function sizeNote(run: Run) {
  if (mode !== 'institution' || run.flags.action !== 'swap' || !run.ok || run.lossPct === undefined) return '';
  const loss = Math.max(run.lossPct, 0);
  const dollars = Math.round((5_000_000 * loss) / 100).toLocaleString();
  return ` Illustrative at size (not measured): the same ${loss.toFixed(2)}% on a $5M order is $${dollars}; a 3% sandwich would be $150,000.`;
}

type Vault = { ready: boolean; account?: string; walletEth?: string; walletTusd?: string; vaultEth?: string; vaultTusd?: string; sqrtPriceX96?: string; liquidity?: string; faucetReadyAt?: number };
let vault: Vault = { ready: false };
let orderSide: 'buy' | 'sell' = 'buy';
let orderBps = 300;
const Q96 = 2n ** 96n;
const BOND = 10n ** 9n;

function toWei(text: string): bigint | null {
  const m = text.trim().match(/^(\d*)(?:\.(\d{0,18}))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || '0') * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0') || '0');
}

const fromWei = (wei: bigint) => (Number(wei) / 1e18).toFixed(6).replace(/\.?0+$/, '');

function quote(side: 'buy' | 'sell', amount: bigint): bigint | null {
  if (!vault.sqrtPriceX96 || !vault.liquidity) return null;
  const sp = BigInt(vault.sqrtPriceX96);
  const l = BigInt(vault.liquidity);
  const x = (l * Q96) / sp;
  const y = (l * sp) / Q96;
  const d = (amount * 997_000n) / 1_000_000n;
  return side === 'buy' ? (y * d) / (x + d) : (x * d) / (y + d);
}

function maxAmount(): bigint {
  if (!vault.ready) return 0n;
  if (orderSide === 'buy') {
    const total = BigInt(vault.vaultEth!) + BigInt(vault.walletEth!) - BOND * 3n;
    return total > 0n ? total : 0n;
  }
  return BigInt(vault.vaultTusd!) + BigInt(vault.walletTusd!);
}

function renderOrder() {
  $$<HTMLButtonElement>('#order-side button').forEach((b) => b.classList.toggle('on', b.dataset.side === orderSide));
  $$<HTMLButtonElement>('#order-slip button').forEach((b) => b.classList.toggle('on', Number(b.dataset.bps) === orderBps));
  $('#order-unit').textContent = orderSide === 'buy' ? 'ETH' : 'tUSD';
  const submit = $<HTMLButtonElement>('#order-submit');
  const est = $('#order-estimate');
  if (!vault.ready) {
    $('#vault-balances').replaceChildren(el('dt', '', 'Wallet'), el('dd', '', '—'), el('dt', '', 'Pool vault'), el('dd', '', '—'));
    est.textContent = 'Unlock your passkey and create your wallet (sidebar) to trade.';
    submit.disabled = true;
    $$<HTMLButtonElement>('#faucet-btn, #withdraw-btn').forEach((b) => { b.disabled = true; });
    return;
  }
  $('#vault-balances').replaceChildren(
    el('dt', '', 'Wallet'), el('dd', '', `${fromWei(BigInt(vault.walletEth!))} ETH · ${fromWei(BigInt(vault.walletTusd!))} tUSD`),
    el('dt', '', 'Pool vault'), el('dd', '', `${fromWei(BigInt(vault.vaultEth!))} ETH · ${fromWei(BigInt(vault.vaultTusd!))} tUSD`)
  );
  const faucetWait = vault.faucetReadyAt ? vault.faucetReadyAt - Date.now() : 0;
  const faucet = $<HTMLButtonElement>('#faucet-btn');
  faucet.disabled = running || faucetWait > 0;
  faucet.textContent = faucetWait > 0 ? `Test funds in ${Math.ceil(faucetWait / 60000)} min` : 'Get test funds';
  $<HTMLButtonElement>('#withdraw-btn').disabled = running || (BigInt(vault.vaultEth!) === 0n && BigInt(vault.vaultTusd!) === 0n);
  const amount = toWei($<HTMLInputElement>('#order-amount').value);
  const max = maxAmount();
  if (amount === null || amount === 0n) {
    est.textContent = 'Enter an amount.';
    submit.disabled = true;
    return;
  }
  if (amount > max) {
    est.textContent = `More than you hold (max ${fromWei(max)} ${orderSide === 'buy' ? 'ETH' : 'tUSD'}). Use "Get test funds".`;
    submit.disabled = true;
    return;
  }
  const q = quote(orderSide, amount);
  const unitOut = orderSide === 'buy' ? 'tUSD' : 'ETH';
  est.textContent = q === null ? '' : `Estimated fill ≈ ${fromWei(q)} ${unitOut} at the current pool price. You get at least ${fromWei((q * BigInt(10_000 - orderBps)) / 10_000n)} ${unitOut}, or a full refund.`;
  submit.disabled = running;
}

async function loadVault() {
  const res = await fetch('/api/vault?network=devnet').catch(() => null);
  vault = res?.ok ? await res.json() as Vault : { ready: false };
  renderOrder();
  if (!$<HTMLElement>('[data-panel="wallets"]').hidden) renderWallets();
}

async function postAction(path: string, body?: unknown) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (res.status !== 202) showMessage(((await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error: string }).error);
}

function submitOrder() {
  const amount = toWei($<HTMLInputElement>('#order-amount').value);
  const base = presets.find((p) => p.id === INSTITUTION_ONLY)?.flags ?? flags;
  if (amount === null) return;
  void postAction('/api/run', { ...base, network: 'devnet', mevBot: false, slippageBps: orderBps, order: { side: orderSide, amountWei: amount.toString() } });
}

function renderNetworkLock() {
  const locked = isPublic || mode === 'institution';
  $('#net-switch').hidden = locked;
  $('#net-fixed').hidden = !locked;
}

function applyMode(next: Mode) {
  mode = next;
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    mode = next;
  }
  $<HTMLSelectElement>('#view-select').value = next;
  const inst = next === 'institution';
  $('#order-ticket').hidden = !inst;
  $('#scenario-block').hidden = inst;
  renderNetworkLock();
  if (inst) void loadVault();
  $('#wallet-eyebrow').textContent = next === 'institution' ? 'DESK OPERATOR WALLET' : 'YOUR WALLET';
  pages.overview.meta = next === 'institution' ? 'Sealed block trades on Uniswap v4' : 'Pick a scenario and run it';
  if ($$('[data-tab="overview"].active').length) $('#page-meta').textContent = pages.overview.meta;
  const only = inst ? presets.find((p) => p.id === INSTITUTION_ONLY) : undefined;
  if (only && (!presetFor(flags) || flags.network !== 'devnet')) {
    setFlags({ ...only.flags, network: 'devnet' });
    return;
  }
  renderPresets();
  renderSummary();
}

function verdictText(run: Run) {
  if (!run.ok) return `Failed: ${run.error ?? 'unknown error'}`;
  const verify = run.frameGas?.[0] ? ` VERIFY frame used ${run.frameGas[0].toLocaleString()} gas.` : '';
  if (run.flags.action === 'onboard') return `Wallet created in block ${run.block}, in one transaction. The sponsor paid the gas.`;
  if (run.flags.action === 'faucet') return 'Test ETH and tUSD sent to your wallet.';
  if (run.flags.action === 'withdraw') return 'Your vault balance was sent back to your wallet. The sponsor paid the gas.';
  if (run.order && run.ok && !run.batch?.refunded) {
    const amount = run.order.side === 'sell' ? tusd(run.order.amountWei) : eth(run.order.amountWei);
    const got = run.received && run.received !== '0' ? (run.order.side === 'sell' ? eth(run.received) : tusd(run.received)) : '—';
    return `${run.order.side === 'sell' ? 'Sold' : 'Bought with'} ${amount} → ${got} in batch ${run.batch?.round ?? '?'}, at the batch's one price (${run.lossPct?.toFixed(3) ?? '0'}% from the quote). Proceeds are in your pool vault.`;
  }
  if (run.flags.action === 'transfer') return `Sent 1 wei to ${short(run.transferTo ?? DEMO_RECIPIENT)}, mined in block ${run.block}. The wallet's post-quantum signature was verified on chain.${verify}`;
  if (run.flags.lane === 'batch' && run.batch?.refunded) return `Refunded: by the time batch ${run.batch.round ?? '?'} settled, the price had moved past your ${Number(run.flags.slippageBps) / 100}% limit, so the pool gave your money back instead of filling at a worse price. Nothing was lost.`;
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
  const es = new EventSource(`/events?session=${encodeURIComponent(SESSION)}`);
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
    } else if (e.type === 'progress') {
      if (e.quote) $('[data-r="quote"]').textContent = tusd(e.quote);
      if (e.gasUsed) $('[data-r="gas"]').textContent = Number(e.gasUsed).toLocaleString();
      if (e.block) $('#run-meta').textContent = `commit mined in block ${Number(e.block).toLocaleString()} · waiting for the batch`;
    } else if (e.type === 'line') {
      if (e.line.trim().startsWith('{')) return;
      logLine(e.stream === 'alice' ? 'alice' : 'bot', `${e.stream === 'alice' ? 'ALICE ' : 'BOT   '} ${e.line}`);
    } else if (e.type === 'result') {
      running = false;
      if (mode === 'institution') void loadVault();
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
  const local = s.localBlock && s.sidecar && s.node
    ? [serviceLine('Local chain', s.localBlock, block(s.localBlock)), serviceLine('Local alt mempool', s.sidecar), serviceLine('Sealed mempool', s.node)]
    : [];
  $('#service-lines').replaceChildren(
    ...local,
    serviceLine('Devnet chain', s.devnetBlock, block(s.devnetBlock)),
    serviceLine('Devnet alt mempool', s.devnetSidecar),
    serviceLine('Devnet sealed mempool', s.devnetNode)
  );
  renderWallets(s.wallets, s.reputation ?? { up: false, ms: 0 });
}

let lastWallets: { wallets: Wallet[]; reputation: Probe } = { wallets: [], reputation: { up: false, ms: 0 } };

function walletCard(eyebrow: string, title: string, rows: Array<[string, string]>, foot: [string, string]) {
  const card = el('article', 'surface asset-card wallet-card');
  card.append(el('span', 'eyebrow', eyebrow), el('h3', 'mono', title));
  const dl = el('dl');
  rows.forEach(([k, v]) => dl.append(el('dt', '', k), el('dd', '', v)));
  const footer = el('footer');
  footer.append(el('span', '', foot[0]), el('span', '', foot[1]));
  card.append(dl, footer);
  return card;
}

function renderWallets(wallets: Wallet[] = lastWallets.wallets, reputation: Probe = lastWallets.reputation) {
  lastWallets = { wallets, reputation };
  const rep = new Map<string, { status: string; opsSeen: number; opsIncluded: number }>();
  const items = (reputation.value as { items?: Array<{ address: string; status: string; opsSeen: number; opsIncluded: number }> } | undefined)?.items ?? [];
  items.forEach((r) => rep.set(r.address.toLowerCase(), r));
  const cards: HTMLElement[] = [];
  const mine = (passkeyStatus.wallets ?? []).filter((w) => w.available);
  if (!passkeyStatus.unlocked || !keyLoaded) {
    const card = el('article', 'surface asset-card wallet-card');
    card.append(el('span', 'eyebrow', 'YOUR PASSKEY WALLET'), el('h3', '', 'Locked'), el('p', 'muted', 'Unlock with your passkey in the sidebar to see your wallet here.'));
    cards.push(card);
  }
  mine.forEach((w) => {
    const rows: Array<[string, string]> = [['Status', w.created ? 'Created' : 'Not created yet'], ['Wallet ETH', eth(w.ethWei)]];
    if (w.network === 'devnet' && vault.ready && vault.account?.toLowerCase() === w.account?.toLowerCase()) {
      rows.push(['Pool vault', `${fromWei(BigInt(vault.vaultEth!))} ETH · ${fromWei(BigInt(vault.vaultTusd!))} tUSD`], ['Wallet tUSD', `${fromWei(BigInt(vault.walletTusd!))} tUSD`]);
    }
    cards.push(walletCard(`YOUR PASSKEY WALLET · ${w.network === 'devnet' ? 'LIVE DEVNET' : 'LOCAL'}`, short(w.account), rows, ['leanSphincs-s · key in your browser', w.network]));
  });
  wallets.filter((w) => w.deployed).forEach((w) => {
    const r = rep.get(w.account!.toLowerCase());
    cards.push(walletCard(`DEMO WALLET · ${w.network.toUpperCase()} · ${w.scheme === 'lss' ? 'LEANSPHINCS-S' : 'SLH-DSA-SHA2'}`, short(w.account), [
      ['ETH', eth(w.ethWei)],
      ['tUSD', w.tusdWei ? tusd(w.tusdWei) : '—'],
      ['Stake', w.staked ? eth(w.stakeWei) : 'unstaked'],
      ['Reputation', r ? `${r.status} · ${r.opsIncluded}/${r.opsSeen} included` : '—'],
    ], [w.scheme === 'lss' ? 'fits 100k unstaked' : 'needs stake (over 100k)', w.network]));
  });
  $('#wallet-cards').replaceChildren(...cards);
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
}

const keyOf = (a: Admission) => a.txHash ?? a.envelopeId ?? `refused #${a.id}`;

const RULES_DOC = 'https://github.com/daiwikmh/leanseal/blob/main/docs/leanseal-mempool.md';

function kv(target: string, rows: Array<[string, string | HTMLElement]>) {
  $(target).replaceChildren(...rows.flatMap(([k, v]) => {
    const dd = el('dd');
    if (typeof v === 'string') dd.textContent = v;
    else dd.append(v);
    return [el('dt', '', k), dd];
  }));
}

function link(text: string, href: string) {
  const a = el('a', '', text) as HTMLAnchorElement;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

async function loadSealedInfo() {
  const net = isPublic || mode === 'institution' ? 'devnet' : String(flags.network);
  const res = await fetch(`/api/mempool?network=${net}`).catch(() => null);
  if (!res?.ok) {
    kv('#sm-facts', [['Status', 'Sealed mempool unreachable']]);
    return;
  }
  sealedInfo = await res.json() as SealedInfo;
  const rpcUrl = net === 'devnet' ? (isPublic ? `${location.origin}/rpc` : 'https://129-212-188-106.sslip.io/rpc') : 'http://127.0.0.1:14347/rpc';
  kv('#sm-facts', [
    ['Mempool ID', el('code', '', sealedInfo.mempoolId)],
    ['Rules', link('Published rules document ↗', RULES_DOC)],
    ['Network', net === 'devnet' ? 'Live devnet (chain 1337)' : 'Local chain'],
    ['Public RPC', el('code', '', rpcUrl)],
    ['Orders waiting', String(sealedInfo.tickets ?? 0)],
    ['Batch pool (hook)', sealedInfo.batchHook ? el('code', '', short(sealedInfo.batchHook)) : '—'],
  ]);
  $('#sm-rules').replaceChildren(...(sealedInfo.revealRules ?? []).map((r) => {
    const row = el('div', 'check-row pass');
    row.append(el('span', 'dot'), el('span', '', `${r.id} · ${r.name}`), el('small', '', r.text));
    return row;
  }));
  void loadSealedOrders();
}

async function loadSealedOrders() {
  const net = isPublic || mode === 'institution' ? 'devnet' : String(flags.network);
  const res = await fetch(`/api/admissions?mempool=sealed&network=${net}`).catch(() => null);
  const table = $('#sm-table');
  const empty = (text: string) => { const tr = el('tr'); const td = el('td', 'loading-row', text); td.setAttribute('colspan', '5'); tr.append(td); return tr; };
  if (!res?.ok) return table.replaceChildren(empty('Sealed mempool unreachable.'));
  const items = (await res.json() as Array<Admission & { kind?: string; nonce?: string; source?: string }>).filter((a) => a.kind !== 'envelope');
  if (!items.length) return table.replaceChildren(empty('No sealed orders yet. Run a protected swap.'));
  table.replaceChildren(...items.slice(0, 15).map((a) => {
    const tr = el('tr', 'pick');
    const passed = a.checks.filter((c) => c.verdict === 'pass').length;
    tr.append(el('td', '', ago(a.at)), el('td', 'mono', short(a.envelopeId)), el('td', '', a.nonce ? `#${a.nonce}` : '—'), el('td', '', a.source === 'gossip' ? 'another node' : 'a wallet'), el('td', a.outcome === 'accepted' ? 'out-included' : 'out-rejected', `${passed}/${a.checks.length} ✓`));
    tr.addEventListener('click', () => { $<HTMLInputElement>('#ticket-input').value = a.envelopeId ?? ''; void checkTicket(); });
    return tr;
  }));
}

async function checkTicket() {
  const id = $<HTMLInputElement>('#ticket-input').value.trim();
  if (!/^0x[0-9a-fA-F]+$/.test(id)) return kv('#ticket-result', [['Ticket', 'Paste a ticket ID starting with 0x']]);
  const net = isPublic || mode === 'institution' ? 'devnet' : String(flags.network);
  const res = await fetch(`/api/ticket/${id}?network=${net}`).catch(() => null);
  const t = res?.ok ? await res.json() as { error?: string; status?: string; batchRound?: string; revealTx?: string; note?: string; round?: number } : { error: 'node unreachable' };
  if (t.error) return kv('#ticket-result', [['Ticket', short(id)], ['Result', t.error.includes('no ticket') ? 'This node does not know this ticket (it may predate a restart, or belong to another network).' : t.error]]);
  const status: Record<string, string> = { locked: 'Sealed: waiting for its drand round', revealed: 'Revealed on chain', failed: 'Reveal failed', expired: 'Expired' };
  kv('#ticket-result', [
    ['Ticket', short(id)],
    ['Status', status[t.status ?? ''] ?? t.status ?? '—'],
    ['Batch', t.batchRound ? `#${t.batchRound}` : '—'],
    ['Reveal tx', t.revealTx ? el('code', '', short(t.revealTx)) : '—'],
    ...(t.note ? [['Note', t.note] as [string, string]] : []),
  ]);
}

async function loadAdmissions() {
  const net = isPublic || mode === 'institution' ? 'devnet' : String(flags.network);
  const res = await fetch(`/api/admissions?network=${net}`).catch(() => null);
  const table = $('#admission-table');
  $('#checks-net').textContent = `ALT MEMPOOL · ERC-8421 · ${net === 'devnet' ? 'LIVE DEVNET' : 'LOCAL'}`;
  if (!res?.ok) {
    const tr = el('tr'); const td = el('td', 'loading-row', 'Alt mempool unreachable.'); td.setAttribute('colspan', '3'); tr.append(td);
    table.replaceChildren(tr);
    return;
  }
  const items = await res.json() as Admission[];
  const select = (a: Admission, tr?: HTMLElement) => {
    selectedTx = keyOf(a);
    $$('#admission-table tr').forEach((row) => row.classList.remove('on'));
    tr?.classList.add('on');
    renderChecks(a);
    if (a.txHash) void loadEvents(a.txHash, net);
    else $('#event-list').textContent = '';
  };
  const rows = items.map((a) => {
    const key = keyOf(a);
    const tr = el('tr', `pick${key === selectedTx ? ' on' : ''}`);
    const passed = a.checks.filter((c) => c.verdict === 'pass').length;
    tr.append(el('td', '', ago(a.at)), el('td', 'mono', key.startsWith('0x') ? short(key) : key), el('td', `out-${a.outcome}`, `${a.outcome === 'included' ? 'Admitted' : a.outcome} · ${passed}/${a.checks.length}`));
    tr.addEventListener('click', () => select(a, tr));
    return tr;
  });
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'loading-row', 'No transactions yet.');
    td.setAttribute('colspan', '3');
    tr.append(td);
    rows.push(tr);
  }
  table.replaceChildren(...rows);
  if (items.length && !items.some((a) => keyOf(a) === selectedTx)) select(items[0], rows[0]);
}

function checkRow(c: Check) {
  const row = el('div', `check-row ${c.verdict}`);
  const scope = c.entity ? `${c.entity} · frame ${c.frameIndex}` : 'whole transaction';
  row.append(el('span', 'dot'), el('span', '', c.name ? `${c.rule} · ${c.name}` : c.rule), el('em', '', `${c.verdict.toUpperCase()} · ${scope}`));
  if (c.detail) row.append(el('small', '', c.detail));
  return row;
}

function renderChecks(a: Admission) {
  const key = keyOf(a);
  const passed = a.checks.filter((c) => c.verdict === 'pass');
  const other = a.checks.filter((c) => c.verdict !== 'pass');
  $('#check-title').textContent = `${a.outcome === 'included' ? 'Admitted' : a.outcome[0].toUpperCase() + a.outcome.slice(1)} · ${key.startsWith('0x') ? short(key) : key}`;
  const summary = $('#check-summary');
  summary.className = `check-summary ${other.some((c) => c.verdict === 'fail') ? 'bad' : 'good'}`;
  summary.textContent = other.length
    ? `${passed.length}/${a.checks.length} rules passed. ${other.length} need${other.length === 1 ? 's' : ''} attention:`
    : `✓ All ${a.checks.length} ERC-8421 rules passed.`;
  $('#check-failed').replaceChildren(...other.map(checkRow));
  $('#check-all').hidden = a.checks.length === 0;
  $('#check-all-label').textContent = `Show all ${a.checks.length} checks`;
  $('#check-list').replaceChildren(...a.checks.map(checkRow));
}

async function loadEvents(hash: string, net: string) {
  const res = await fetch(`/api/tx/${hash}?network=${net}`).catch(() => null);
  const line = $('#event-list');
  if (!res?.ok) {
    line.textContent = '';
    return;
  }
  const { events } = await res.json() as { events: TxEvent[] };
  line.textContent = events.length ? `Lifecycle: ${events.map((e) => e.kind === 'statusChanged' ? e.status : e.kind).filter((v, i, arr) => arr.indexOf(v) === i).join(' → ')}` : '';
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
  $<HTMLSelectElement>('#view-select').addEventListener('change', (ev) => applyMode((ev.target as HTMLSelectElement).value as Mode));
  $$<HTMLButtonElement>('#order-side button').forEach((b) => b.addEventListener('click', () => {
    orderSide = b.dataset.side as 'buy' | 'sell';
    $<HTMLInputElement>('#order-amount').value = orderSide === 'buy' ? '0.0005' : '0.01';
    renderOrder();
  }));
  $$<HTMLButtonElement>('#order-slip button').forEach((b) => b.addEventListener('click', () => { orderBps = Number(b.dataset.bps); renderOrder(); }));
  $<HTMLInputElement>('#order-amount').addEventListener('input', () => renderOrder());
  $('#order-max').addEventListener('click', () => { $<HTMLInputElement>('#order-amount').value = fromWei(maxAmount()); renderOrder(); });
  $('#order-submit').addEventListener('click', () => submitOrder());
  $<HTMLInputElement>('#transfer-to').addEventListener('input', () => renderSummary());
  $('#faucet-btn').addEventListener('click', () => { void postAction('/api/faucet?network=devnet'); });
  $('#withdraw-btn').addEventListener('click', () => { void postAction('/api/withdraw?network=devnet'); });
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
  $('#ticket-check').addEventListener('click', () => { void checkTicket(); });
  $<HTMLInputElement>('#ticket-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void checkTicket(); });
  $('#sm-refresh').addEventListener('click', () => { void loadSealedInfo(); });
  const res = await fetch('/api/flags').catch(() => null);
  if (!res?.ok) {
    showMessage('Cannot reach the LeanSeal API. Start it with: cd demo && npx --prefix ../workshop tsx server.ts');
    return;
  }
  const body = await res.json() as { public?: boolean; defaults: Flags; schema: FlagDef[]; presets: Preset[] };
  isPublic = !!body.public;
  schema = body.schema;
  presets = body.presets;
  defaults = body.defaults;
  const stored = isPublic ? {} : readStoredFlags();
  flags = Object.fromEntries(schema.map((d) => [d.key, d.options.includes(stored[d.key]) ? stored[d.key] : defaults[d.key]]));
  renderNetworkLock();
  renderControls();
  renderFacts();
  connectEvents();
  await loadSealedInfo();
  await Promise.all([loadStatus(), loadRuns(), loadAdmissions(), refreshPasskey()]);
  applyMode(mode);
  showLatestRun();
  setInterval(() => { void loadStatus(); if (mode === 'institution' && !running) void loadVault(); }, 10_000);
  setInterval(() => {
    if (!$<HTMLElement>('[data-panel="checks"]').hidden) void loadAdmissions();
    if (!$<HTMLElement>('[data-panel="sealed"]').hidden) void loadSealedOrders();
  }, 15_000);
}

void init();
