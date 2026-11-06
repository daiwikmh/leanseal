import { useRef, useState, type KeyboardEvent } from 'react';

const panels = [
  {
    id: 'overview', label: 'Overview', eyebrow: 'ONE PLACE TO FOLLOW THE EXPERIMENT',
    title: 'See the whole transaction journey.',
    steps: ['Choose a scenario', 'Run the swap', 'Read the result'],
    text: 'Compare public and sealed swaps, follow execution logs, and inspect quoted output, received tokens, gas, and recent runs.',
  },
  {
    id: 'checks', label: 'Admission checks', eyebrow: 'KNOW WHY A TRANSACTION GETS IN',
    title: 'Inspect every admission decision.',
    steps: ['Select a transaction', 'Read the rules', 'Trace the outcome'],
    text: 'Switch between standard ERC-8421 and sealed-envelope admissions. Inspect the verdict and details for each check instead of guessing why a submission was rejected.',
  },
  {
    id: 'sealed', label: 'Sealed lane', eyebrow: 'YOUR TRANSACTION, FROM SIGNATURE TO RECEIPT',
    title: 'Follow the sealed lane.',
    steps: ['Sign', 'Seal', 'Admit', 'Open', 'Include'],
    text: 'Inspect the checks. Compare the outcome. Trace who opened the envelope.',
  },
  {
    id: 'wallets', label: 'PQ wallets', eyebrow: 'POST-QUANTUM ACCOUNTS, SIDE BY SIDE',
    title: 'Get to know your signing account.',
    steps: ['Inspect account', 'Check balances', 'Compare schemes'],
    text: 'Inspect deployed wallets, ETH and tUSD balances, and staking status across the local chain and devnet. Compare the signature schemes used by the prototype.',
  },
];

export default function ConsolePreview() {
  const [selected, setSelected] = useState(2);
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

  return <div className="console-preview" aria-label="Explore the LeanSeal console">
    <div className="preview-bar"><span><img src="/logo.svg" alt="" width="18" height="18" />leanseal / console</span><span>Workflow preview</span></div>
    <div className="preview-body">
      <div className="preview-menu" role="tablist" aria-label="Console features">
        {panels.map((item, index) => <button key={item.id} type="button" role="tab" id={`preview-tab-${item.id}`} aria-controls={`preview-panel-${item.id}`} aria-selected={index === selected} tabIndex={index === selected ? 0 : -1} ref={node => { tabs.current[index] = node; }} onClick={() => setSelected(index)} onKeyDown={event => navigate(event,index)}>{item.label}</button>)}
      </div>
      {panels.map((item,index) => <div key={item.id} className="preview-main" role="tabpanel" id={`preview-panel-${item.id}`} aria-labelledby={`preview-tab-${item.id}`} hidden={index !== selected} tabIndex={0}>
        <p className="eyebrow">{item.eyebrow}</p><h3>{item.title}</h3>
        <div className="preview-flow" style={{gridTemplateColumns:`repeat(${item.steps.length}, minmax(0, 1fr))`}}>{item.steps.map((step,i) => <div key={step}><span>{String(i+1).padStart(2,'0')}</span><strong>{step}</strong></div>)}</div>
        <p className="muted">{item.text}</p>
        <a className="solid-link" href="/dashboard">Explore your console ↗</a>
      </div>)}
    </div>
    <span className="preview-sr" aria-live="polite">{panel.label} selected</span>
  </div>;
}
