type FlagValue = string | number | boolean;
type Flags = Record<string, FlagValue>;
type FlagDef = { key: string; label: string; options: FlagValue[]; help: string };
type Preset = { id: string; title: string; text: string; flags: Flags };
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
type Status = { localBlock: Probe; devnetBlock: Probe; sidecar: Probe; devnetSidecar: Probe; node: Probe; reputation: Probe; wallets: Wallet[]; running: Flags | null };
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
  overview: { label: 'Overview', meta: 'Runs, results and service health' },
  flags: { label: 'Flags', meta: 'Switch network, lane, scheme, bot and limits' },
  checks: { label: 'Admission checks', meta: 'ERC-8421 rule report for each frame transaction' },
  sealed: { label: 'Sealed lane', meta: 'Envelopes, door checks and who opened them' },
  wallets: { label: 'PQ wallets', meta: 'Quantum-safe accounts, stake and balances' }
};


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

function renderFacts() {
  $('#side-network').replaceChildren(el('i'), document.createTextNode(flags.network === 'devnet' ? ' Public hackathon devnet' : ' Local EIP-8141 chain'));
  $('#checks-net').textContent = `ALT MEMPOOL · ${String(flags.network).toUpperCase()}`;
  renderPresets();
  renderSummary();
  void checkFlags();
}

function setFlags(next: Flags) {
  flags = next;
  storeFlags();
  renderFacts();
}

function sameFlags(a: Flags, b: Flags) {
  return schema.every((d) => a[d.key] === b[d.key]);
}

function renderPresets() {
  $('#presets').replaceChildren(...presets.map((p) => {
    const b = el('button', `preset${sameFlags(flags, p.flags) ? ' on' : ''}`) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('aria-pressed', String(sameFlags(flags, p.flags)));
    b.append(el('strong', '', p.title), el('span', '', p.text));
    b.addEventListener('click', () => setFlags({ ...p.flags }));
    return b;
  }));
}

function renderSummary() {
  const p = $('#run-summary');
  const what = flags.action === 'swap' ? 'swaps 0.0001 ETH for tUSD' : 'sends 1 gwei';
  const where = flags.network === 'devnet' ? 'on the public hackathon devnet' : 'on our local chain';
  const lane = flags.lane === 'batch'
    ? 'into a sealed batch auction: only a hash goes on chain, nodes reveal it at a drand round and the whole batch fills at one price'
    : flags.lane === 'sealed'
      ? 'in a sealed envelope that opens publicly at a drand deadline'
      : 'through the public alt mempool, where anyone can read it';
  const scheme = flags.scheme === 'lss' ? 'leanSphincs-s (fast, fits 100k unstaked)' : 'SLH-DSA SHA2 (NIST, staked wallet)';
  const bot = flags.action === 'swap' && flags.network === 'local' ? (flags.mevBot ? ' A sandwich bot is watching.' : ' No bot.') : '';
  p.replaceChildren(
    document.createTextNode('Alice '), el('b', '', what), document.createTextNode(` ${where} `), el('b', '', lane),
    document.createTextNode(', signed with '), el('b', '', scheme), document.createTextNode(`.${bot}`)
  );
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
  $('#quick-flags').replaceChildren(...schema.map((def) => {
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
  $$<HTMLButtonElement>('#run-main, #run-top').forEach((b) => { b.disabled = !on; });
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

function setResult(run: Run) {
  $('[data-r="quote"]').textContent = run.quote && run.quote !== '0' ? tusd(run.quote) : '—';
  $('[data-r="received"]').textContent = run.received && run.received !== '0' ? tusd(run.received) : '—';
  $('[data-r="loss"]').textContent = run.lossPct === undefined ? '—' : `${run.lossPct.toFixed(3)}%`;
  $('[data-r="gas"]').textContent = run.gasUsed ? run.gasUsed.toLocaleString() : '—';
  const v = $('#verdict');
  v.hidden = false;
  v.className = `verdict ${run.ok && (run.lossPct ?? 0) <= 0.01 ? 'good' : 'bad'}`;
  v.textContent = verdictText(run);
}

function verdictText(run: Run) {
  if (!run.ok) return `Failed: ${run.error ?? 'unknown error'}`;
  const verify = run.frameGas?.[0] ? ` VERIFY frame used ${run.frameGas[0].toLocaleString()} gas.` : '';
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
      $$('[data-r]').forEach((n) => { n.textContent = '…'; });
      $('#run-state').textContent = `run #${e.runId} · ${e.flags.action} · ${e.flags.lane}`;
      logLine('sys', `flags: ${schema.map((d) => `${d.key}=${optionLabel(d.key, e.flags[d.key])}`).join('  ')}`);
    } else if (e.type === 'line') {
      logLine(e.stream === 'alice' ? 'alice' : 'bot', `${e.stream === 'alice' ? 'ALICE ' : 'BOT   '} ${e.line}`);
    } else if (e.type === 'result') {
      running = false;
      $('#run-state').textContent = `run #${e.run.id} · ${e.run.ok ? 'done' : 'failed'}`;
      setResult(e.run as Run);
      void checkFlags();
      void loadRuns();
      void loadStatus();
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
  $('[data-metric="block"]').textContent = s.localBlock.up ? Number(s.localBlock.value).toLocaleString() : 'down';
  $('[data-metric="block-note"]').textContent = s.devnetBlock.up ? `devnet at ${Number(s.devnetBlock.value).toLocaleString()}` : 'devnet unreachable';
  $('#service-lines').replaceChildren(
    serviceLine('Local chain (ethrex)', s.localBlock),
    serviceLine('Alt mempool (patched)', s.sidecar),
    serviceLine('Sealed mempool (in sidecar)', s.node),
    serviceLine('Devnet chain', s.devnetBlock),
    serviceLine('Devnet alt mempool', s.devnetSidecar)
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
    const what = `#${r.id} ${r.flags.action} · ${r.flags.lane} · ${r.flags.scheme}${r.flags.mevBot && r.flags.action === 'swap' ? ' · bot' : ''}`;
    const outcome = !r.ok ? `failed` : r.lossPct !== undefined ? `loss ${r.lossPct.toFixed(3)}%` : `block ${r.block}`;
    row.append(el('span', '', what), el('span', '', `${outcome} · ${ago(r.at)}`));
    return row;
  }) : [el('div', 'loading-row', 'No runs yet. Pick flags and press Run.')]));
  const lastLoss = (lane: string) => runs.find((r) => r.flags.action === 'swap' && r.flags.lane === lane && r.ok && r.lossPct !== undefined);
  (['public', 'sealed'] as const).forEach((lane) => {
    const r = lastLoss(lane);
    $(`[data-metric="loss-${lane}"]`).textContent = r ? `${r.lossPct!.toFixed(2)}%` : '—';
    $(`[data-loss="${lane}"]`).className = `metric-card${r ? (r.lossPct! > 0.01 ? ' bad' : ' good') : ''}`;
  });
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
  const res = await fetch(sealed ? '/api/admissions?mempool=sealed' : `/api/admissions?network=${flags.network}`).catch(() => null);
  const table = $('#admission-table');
  $('#admission-key').textContent = sealed ? 'Envelope' : 'Tx';
  $('#checks-net').textContent = sealed ? 'LEANSEAL SEALED MEMPOOL · LOCAL' : `ALT MEMPOOL · ${String(flags.network).toUpperCase()}`;
  $('#mempool-id').textContent = sealed && sealedInfo
    ? `mempool id ${sealedInfo.mempoolId} · ${sealedInfo.rules.length} SEAL rules · ${sealedInfo.pending} pending`
    : 'the standard ERC-8421 rule set: global checks, then per entity for each validation frame';
  if (!res?.ok) {
    table.replaceChildren(el('tr', 'loading-row', 'Mempool unreachable.'));
    return;
  }
  const items = await res.json() as Admission[];
  if (!sealed) {
    const included = items.filter((a) => a.outcome === 'included').length;
    $('[data-metric="admissions"]').textContent = `${included} / ${items.length - included}`;
  }
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
  $$<HTMLButtonElement>('#run-main, #run-top').forEach((b) => b.addEventListener('click', () => { void startRun(); }));
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
  await Promise.all([loadStatus(), loadRuns(), loadAdmissions()]);
  setInterval(() => { void loadStatus(); }, 10_000);
  setInterval(() => { if (!$<HTMLElement>('[data-panel="checks"]').hidden) void loadAdmissions(); }, 15_000);
}

void init();
