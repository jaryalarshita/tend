import { ACTION_LABELS } from '../../shared/actions.js';
import { evidenceLines, money } from './format.js';
import { canApprove, isLocked } from './QueueGrid.jsx';

// Everything behind one row: full evidence, the AI's reasoning and the message that
// will go to the customer, which the owner can rewrite before approving.
export default function DetailPanel({ row, onEdit, setDecision, onClose }) {
  if (!row) {
    return <aside className="detail empty">Click a row to see its evidence and the message Tend will send.</aside>;
  }

  const { evidence } = row;
  return (
    <aside className="detail" aria-label={`Details for ${row.customer}`}>
      <header className="detail-head">
        <div>
          <span className={`badge type-${row.type}`}>{row.typeLabel}</span>
          <h2>{row.customer}</h2>
          <p className="muted">
            {row.atStake != null && <>At stake {money(row.atStake)} · </>}
            Proposed: <strong>{ACTION_LABELS[row.action]}</strong>
            {row.proposedAmount > 0 && <> for {money(row.proposedAmount)}</>}
            {row.quantity != null && <> ({row.quantity} packs)</>}
          </p>
        </div>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </header>

      {row.result && (
        <p className={`banner ${row.result.status === 'failed' ? 'error-banner' : 'info-banner'}`}>
          {row.result.status === 'done' && (row.result.sentToPayPal === false ? '✓ Recorded as handled: ' : '✓ Carried out in PayPal: ')}
          {row.result.status === 'failed' && '⚠ PayPal said no: '}
          {row.result.status === 'awaiting_payment' && 'Waiting for payment: '}
          {row.result.detail}
          {row.result.paypalRef && <span className="muted"> · PayPal ref {row.result.paypalRef}</span>}
          {row.result.status === 'failed' && ' You can fix the row and carry it out again.'}
        </p>
      )}

      <div className="detail-body">
        <section>
          <h3>Evidence from PayPal and the shop</h3>
          <dl className="evidence">
            {evidenceLines(evidence).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {evidence.customerMessage && (
            <blockquote className="quote">
              <span className="muted">Customer wrote:</span> “{evidence.customerMessage}”
            </blockquote>
          )}
          {evidence.messages?.length > 0 && (
            <div className="thread">
              <span className="muted">Dispute messages</span>
              {evidence.messages.map((message, index) => (
                <p key={index} className={`bubble from-${message.from.toLowerCase()}`}>
                  <strong>{message.from === 'SELLER' ? 'You' : 'Buyer'}:</strong> {message.text}
                </p>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3>
            Why{' '}
            {row.source === 'rules'
              ? '(rule-based, AI unavailable)'
              : `(${row.risk} risk${row.source === 'cached' ? ', from an earlier AI review' : ''})`}
          </h3>
          <p>{row.reason}</p>
          {row.warnings?.map((warning) => (
            <p key={warning} className="warning">
              ⚠ {warning}
            </p>
          ))}

          {row.type !== 'low_stock' && (
            <label className="message-edit">
              Message to {row.customer}
              <textarea
                rows={4}
                value={row.customerMessage}
                readOnly={isLocked(row)}
                onChange={(event) => onEdit(row.id, 'customerMessage', event.target.value)}
              />
            </label>
          )}

          {!isLocked(row) && (
          <div className="detail-actions">
            <button
              type="button"
              className="primary"
              disabled={!canApprove(row) || row.decision === 'approved'}
              onClick={() => setDecision([row.id], 'approved')}
            >
              {row.decision === 'approved' ? 'Approved ✓' : 'Approve'}
            </button>
            <button type="button" onClick={() => setDecision([row.id], 'rejected')}>
              {row.decision === 'rejected' ? 'Rejected' : 'Reject'}
            </button>
            {row.decision !== 'pending' && (
              <button type="button" className="ghost" onClick={() => setDecision([row.id], 'pending')}>
                Undo
              </button>
            )}
          </div>
          )}
        </section>
      </div>
    </aside>
  );
}
