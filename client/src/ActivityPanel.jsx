import { useEffect, useRef, useState } from 'react';

const ICONS = { start: '…', passed: '•', ok: '✓', warn: '!', fail: '✕' };
const KIND_LABELS = {
  paypal: 'PayPal',
  stock: 'Stock',
  history: 'History',
  ai: 'AI',
  rules: 'Rules',
  command: 'Command',
  action: 'PayPal',
  done: 'Done',
};

const timeOf = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// A compact list of steps, newest last. Used in the panel, the loading screen and dialogs.
export function StepList({ steps, emptyText = 'Nothing yet.' }) {
  const endRef = useRef(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [steps.length]);

  if (steps.length === 0) return <p className="muted steps-empty">{emptyText}</p>;
  return (
    <ol className="steps" aria-live="polite">
      {steps.map((step, index) => {
        // A "started" step is only still running if nothing has happened since.
        const status = step.status === 'start' && index < steps.length - 1 ? 'passed' : step.status;
        return (
          <li key={step.id} className={`step step-${status}`}>
            <span className="step-icon" aria-hidden="true">
              {ICONS[status]}
            </span>
            <span className="step-kind">{KIND_LABELS[step.kind] ?? step.kind}</span>
            <span className="step-text">
              {step.text}
              {step.detail && <small className="muted"> · {step.detail}</small>}
            </span>
            <time className="step-time muted">{timeOf(step.at)}</time>
          </li>
        );
      })}
      <li ref={endRef} aria-hidden="true" className="steps-end" />
    </ol>
  );
}

// A floating "Agent activity" button that opens the live feed of what Tend is doing.
export default function ActivityPanel({ steps, connected }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(0);
  const latest = steps.at(-1);
  const working = latest && latest.status === 'start' && Date.now() - latest.at < 120_000;
  const unseen = open ? 0 : steps.length - seen;

  useEffect(() => {
    if (open) setSeen(steps.length);
  }, [open, steps.length]);

  return (
    <div className={`activity${open ? ' open' : ''}`}>
      {open && (
        <section className="activity-panel" aria-label="Agent activity">
          <header>
            <strong>Agent activity</strong>
            <span className={`dot${connected ? ' live' : ''}`} title={connected ? 'Live' : 'Reconnecting…'} />
            <span className="muted">{connected ? 'live' : 'reconnecting…'}</span>
            <button type="button" className="ghost" onClick={() => setOpen(false)} aria-label="Close activity">
              ✕
            </button>
          </header>
          <StepList steps={steps} emptyText="Steps appear here as Tend reads PayPal, asks the AI and carries out actions." />
        </section>
      )}
      <button
        type="button"
        className={`activity-toggle${working ? ' working' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={`dot${working ? ' pulse' : connected ? ' live' : ''}`} aria-hidden="true" />
        Agent activity
        {unseen > 0 && <span className="badge-count">{unseen > 99 ? '99+' : unseen}</span>}
      </button>
    </div>
  );
}
