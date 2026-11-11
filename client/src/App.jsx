import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AMOUNT_EDITABLE, priceAction, TYPE_LABELS } from '../../shared/actions.js';
import DetailPanel from './DetailPanel.jsx';
import { money } from './format.js';
import QueueGrid, { canApprove } from './QueueGrid.jsx';

const AT_RISK_TYPES = ['overdue_invoice', 'dispute', 'refund_request'];

// Adds the fields the grid shows but the server does not send.
function toGridRow(row) {
  return {
    ...row,
    typeLabel: TYPE_LABELS[row.type],
    // Low stock has no money at stake, only a purchase to make.
    atStake: row.type === 'low_stock' ? null : row.amount,
    decision: 'pending',
  };
}

// Applies one owner edit, re-pricing with the same rules the server uses.
function applyEdit(row, field, value) {
  if (!['action', 'proposedAmount', 'quantity'].includes(field)) return { ...row, [field]: value };

  const next = { ...row, [field]: value };
  let suggestion;
  if (field === 'action') {
    // Switching to a partial refund or offer keeps the current amount as a starting point.
    suggestion = { amount: AMOUNT_EDITABLE.has(value) && row.proposedAmount ? row.proposedAmount : null, quantity: row.quantity };
  } else {
    suggestion = { amount: next.proposedAmount, quantity: next.quantity };
  }
  const priced = priceAction(row, next.action, suggestion);
  const edited = { ...next, proposedAmount: priced.amount, quantity: priced.quantity, warnings: priced.warnings };
  // An approval only stands for something approvable.
  if (edited.decision === 'approved' && !canApprove(edited)) edited.decision = 'pending';
  return edited;
}

const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Which model reviewed the queue, and whether a fallback or an earlier review was used.
function ReviewStatus({ queue }) {
  if (queue.cachedReviewAt) return <>Showing the {timeOf(queue.cachedReviewAt)} review by {queue.model}</>;
  if (!queue.model) return <>Rule-based proposals · {timeOf(queue.generatedAt)}</>;
  const busy = queue.fallbackFrom?.map((failure) => failure.split(' ')[0]).join(', ');
  return (
    <>
      Reviewed by {queue.model}
      {busy && <span title={queue.fallbackFrom.join('\n')}> (backup: {busy} unavailable)</span>} in{' '}
      {(queue.tookMs / 1000).toFixed(0)}s · {timeOf(queue.generatedAt)}
    </>
  );
}

const sumOf = (rows, key) => Math.round(rows.reduce((total, row) => total + (row[key] ?? 0) * 100, 0)) / 100;

function Summary({ rows }) {
  const atRisk = rows.filter((row) => AT_RISK_TYPES.includes(row.type));
  const byType = (type) => sumOf(atRisk.filter((row) => row.type === type), 'atStake');
  const approved = rows.filter((row) => row.decision === 'approved');
  const approvedOf = (actions) => sumOf(approved.filter((row) => actions.includes(row.action)), 'proposedAmount');
  const pending = rows.filter((row) => row.decision === 'pending').length;

  return (
    <section className="summary" aria-label="Summary">
      <div className="card hero">
        <span className="label">Money at risk</span>
        <strong>{money(sumOf(atRisk, 'atStake'))}</strong>
        <span className="muted">
          {money(byType('overdue_invoice'))} overdue · {money(byType('dispute'))} disputed ·{' '}
          {money(byType('refund_request'))} in refund requests
        </span>
      </div>
      <div className="card">
        <span className="label">Chasing</span>
        <strong>{money(approvedOf(['send_reminder']))}</strong>
        <span className="muted">in approved reminders</span>
      </div>
      <div className="card">
        <span className="label">Paying back</span>
        <strong>{money(approvedOf(['full_refund', 'partial_refund', 'make_offer', 'accept_claim']))}</strong>
        <span className="muted">in approved refunds and offers</span>
      </div>
      <div className="card">
        <span className="label">Restocking</span>
        <strong>{money(approvedOf(['reorder']))}</strong>
        <span className="muted">in approved reorders</span>
      </div>
      <div className="card">
        <span className="label">To decide</span>
        <strong>
          {pending}
          <small> of {rows.length}</small>
        </strong>
        <span className="muted">{approved.length} approved</span>
      </div>
    </section>
  );
}

export default function App() {
  const gridRef = useRef(null);
  const [queue, setQueue] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [quickFilter, setQuickFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/queue${refresh ? '?refresh=1' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `API returned ${res.status}`);
      setQueue(data);
      setRows(data.rows.map(toGridRow));
      setSelectedId(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onEdit = useCallback((id, field, value) => {
    setRows((current) => current.map((row) => (row.id === id ? applyEdit(row, field, value) : row)));
  }, []);

  const setDecision = useCallback((ids, decision) => {
    const wanted = new Set(ids);
    setRows((current) =>
      current.map((row) => {
        if (!wanted.has(row.id)) return row;
        if (decision === 'approved' && !canApprove(row)) return row;
        return { ...row, decision };
      }),
    );
  }, []);

  function decideSelected(decision) {
    const api = gridRef.current?.api;
    const selected = api?.getSelectedRows() ?? [];
    if (selected.length === 0) {
      setNotice('Tick some rows first.');
      return;
    }
    const skipped = decision === 'approved' ? selected.filter((row) => !canApprove(row)).length : 0;
    setDecision(selected.map((row) => row.id), decision);
    api.deselectAll();
    setNotice(
      `${decision === 'approved' ? 'Approved' : 'Rejected'} ${selected.length - skipped} row(s).` +
        (skipped ? ` ${skipped} skipped: they need an action or amount first.` : ''),
    );
  }

  function refresh() {
    const decided = rows.some((row) => row.decision !== 'pending');
    if (decided && !window.confirm('Ask the AI again? Your decisions and edits will be cleared.')) return;
    setNotice('');
    load(true);
  }

  const selectedRow = useMemo(() => rows.find((row) => row.id === selectedId) ?? null, [rows, selectedId]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            ◐
          </span>
          <div>
            <h1>Tend</h1>
            <p className="muted">Little Lantern Gifts · AI back office. You approve, Tend acts.</p>
          </div>
        </div>
        <div className="status muted">
          {queue && !loading && <ReviewStatus queue={queue} />}
        </div>
      </header>

      {queue?.aiError && queue.cachedReviewAt && (
        <p className="banner info-banner" role="status">
          Gemini is busy right now, so this is its last review, from {timeOf(queue.cachedReviewAt)}. Use “Ask the AI
          again” to retry. Anything new since then gets a simple rule-based proposal.
        </p>
      )}
      {queue?.aiError && !queue.cachedReviewAt && (
        <p className="banner warn-banner" role="status">
          Gemini is unavailable ({queue.aiError}). Showing simple rule-based proposals; refunds and disputes need your
          review. Use “Ask the AI again” to retry.
        </p>
      )}
      {queue?.sourceErrors?.map((sourceError) => (
        <p key={sourceError.source} className="banner warn-banner" role="status">
          Could not load {TYPE_LABELS[sourceError.source] ?? sourceError.source}: {sourceError.message}
        </p>
      ))}
      {error && (
        <p className="banner error-banner" role="alert">
          Could not load the queue: {error}
        </p>
      )}

      {loading && !queue ? (
        <div className="loading">
          <div className="spinner" aria-hidden="true" />
          <p>Reading PayPal and asking Gemini to review each item. This usually takes 15 to 60 seconds.</p>
        </div>
      ) : (
        <>
          <Summary rows={rows} />

          <div className="toolbar">
            <input
              type="search"
              placeholder="Search the queue…"
              value={quickFilter}
              onChange={(event) => setQuickFilter(event.target.value)}
              aria-label="Search the queue"
            />
            <button type="button" onClick={() => decideSelected('approved')}>
              Approve selected
            </button>
            <button type="button" onClick={() => decideSelected('rejected')}>
              Reject selected
            </button>
            <span className="notice muted" role="status">
              {notice}
            </span>
            <button type="button" className="ghost refresh" onClick={refresh} disabled={loading}>
              {loading ? 'Reviewing…' : '↻ Ask the AI again'}
            </button>
          </div>

          <div className="grid-wrap">
            <QueueGrid
              ref={gridRef}
              rows={rows}
              quickFilter={quickFilter}
              onEdit={onEdit}
              onSelectRow={setSelectedId}
              setDecision={setDecision}
            />
          </div>

          <p className="hint muted">
            Pick a different action from its menu, or double-click an amount or quantity to change it. Amounts can never go above what PayPal says was
            paid, and reorder prices always come from the catalog.
          </p>

          <DetailPanel row={selectedRow} onEdit={onEdit} setDecision={setDecision} onClose={() => setSelectedId(null)} />
        </>
      )}
    </div>
  );
}
