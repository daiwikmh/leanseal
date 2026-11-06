import { useRef, useState, type KeyboardEvent } from 'react';

type Panel = { id: string; label: string; eyebrow: string; title: string; steps: string[]; text: string };

const panels: Panel[] = [
  {
    id: 'altmempool', label: 'Alt mempool', eyebrow: 'WHY IT NEEDS ERC-8421',
    title: 'Room for a post-quantum signature.',
    steps: ['Admit', 'Check rules', 'Gossip', 'Bundle'],
    text: 'A NIST post-quantum check costs about 150k gas, over the public 100k limit. Our patched ERC-8421 node gives staked accounts up to 1M and hosts custom mempools with their own rules.',
  },
  {
    id: 'sealed', label: 'Sealed mempool', eyebrow: 'OUR CUSTOM MEMPOOL',
    title: 'Orders travel locked, open on time.',
    steps: ['Lock to drand', 'Check', 'Gossip', 'Reveal'],
    text: 'Each order is time-locked to a drand round and gossiped between nodes. When the round arrives, any node opens it and reveals it, so no single operator can hold it back.',
  },
  {
    id: 'hook', label: 'Uniswap hook', eyebrow: 'SETTLEMENT ON UNISWAP V4',
    title: 'One batch, one price, no side door.',
    steps: ['Deposit', 'Commit hash', 'Reveal', 'Settle'],
    text: 'Orders are committed as hashes, revealed together and settled at one price per side. The hook rejects every other swap, so a bot has nothing to jump ahead of.',
  },
  {
    id: 'wallets', label: 'Wallets', eyebrow: 'QUANTUM-SAFE ACCOUNTS',
    title: 'Keys that survive quantum computers.',
    steps: ['Passkey', 'Key in browser', 'One-tx signup', 'Free gas'],
    text: 'A passkey unlocks a hash-based key inside your browser, never stored. Your first transaction creates the wallet, and a sponsor pays the gas.',
  },
];

export default function ConsolePreview() {
  const [selected, setSelected] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const panel = panels[selected];

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % panels.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + panels.length - 1) % panels.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = panels.length - 1;
    else return;
    event.preventDefault();
    setSelected(next);
    tabs.current[next]?.focus();
  }

  return <div className="console-preview" aria-label="How LeanSeal is built">
    <div className="preview-bar"><span><img src="/logo.png" alt="" width="18" height="18" />leanseal / architecture</span><span>How it works</span></div>
    <div className="preview-body">
      <div className="preview-menu" role="tablist" aria-label="Architecture parts">
        {panels.map((item, index) => <button key={item.id} type="button" role="tab" id={`preview-tab-${item.id}`} aria-controls={`preview-panel-${item.id}`} aria-selected={index === selected} tabIndex={index === selected ? 0 : -1} ref={node => { tabs.current[index] = node; }} onClick={() => setSelected(index)} onKeyDown={event => navigate(event,index)}>{item.label}</button>)}
      </div>
      {panels.map((item,index) => <div key={item.id} className="preview-main" role="tabpanel" id={`preview-panel-${item.id}`} aria-labelledby={`preview-tab-${item.id}`} hidden={index !== selected} tabIndex={0}>
        <p className="eyebrow">{item.eyebrow}</p><h3>{item.title}</h3>
        <div className="preview-flow" style={{gridTemplateColumns:`repeat(${item.steps.length}, minmax(0, 1fr))`}}>{item.steps.map((step,i) => <div key={step}><span>{String(i+1).padStart(2,'0')}</span><strong>{step}</strong></div>)}</div>
        <p className="muted">{item.text}</p>
        <a className="solid-link" href="/dashboard">Try it in the console ↗</a>
      </div>)}
    </div>
    <span className="preview-sr" aria-live="polite">{panel.label} selected</span>
  </div>;
}
