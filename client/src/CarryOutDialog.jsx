import { useCallback, useEffect, useState } from 'react';
import { money } from './format.js';
import PayPalCheckout from './PayPalCheckout.jsx';

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed with status ${res.status}`), { status: res.status, data });
  return data;
}

// The passcode is remembered for this browser tab only. Storage can be blocked, so every
// access is guarded and the dialog works without it.
const PASSCODE_KEY = 'tend-owner-passcode';
const readPasscode = () => {
  try {
    return sessionStorage.getItem(PASSCODE_KEY) ?? '';
  } catch {
    return '';
  }
};
const savePasscode = (value) => {
  try {
    sessionStorage.setItem(PASSCODE_KEY, value);
  } catch {
    // Not saved; the owner types it again next time.
  }
};

const STATUS_TEXT = { done: 'Done', failed: 'Failed', awaiting_payment: 'Waiting for payment' };

// The confirmation step between "approved" and "sent to PayPal". It shows the server's
// own plan (amounts re-checked against fresh PayPal data), and only a confirmed plan runs.
export default function CarryOutDialog({ actions, rowsById, onResults, onClose }) {
  const [stage, setStage] = useState('planning'); // planning | review | running | done | error
  const [plan, setPlan] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [paid, setPaid] = useState(null);
  const [error, setError] = useState('');
  const [needsPasscode, setNeedsPasscode] = useState(false);
  const [passcode, setPasscode] = useState(readPasscode);
  const [passcodeError, setPasscodeError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((res) => res.json())
      .then((health) => !cancelled && setNeedsPasscode(Boolean(health.passcodeRequired)))
      .catch(() => {});
    postJson('/api/execute/plan', { actions })
      .then((data) => {
        if (cancelled) return;
        setPlan(data);
        setStage('review');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setStage('error');
      });
    return () => {
      cancelled = true;
    };
  }, [actions]);

  async function confirm() {
    setStage('running');
    setPasscodeError('');
    try {
      const headers = passcode ? { 'X-Tend-Passcode': passcode } : {};
      const data = await postJson('/api/execute', { planId: plan.planId }, headers);
      if (passcode) savePasscode(passcode);
      setOutcome(data);
      onResults(data.results);
      setStage('done');
    } catch (err) {
      // A missing or wrong passcode (or too many tries) leaves the plan unused: try again.
      if (err.data?.passcode || err.status === 429) {
        setNeedsPasscode(true);
        setPasscodeError(err.message);
        setStage('review');
        return;
      }
      setError(err.message);
      setStage('error');
    }
  }

  const onPaid = useCallback(
    (data) => {
      setPaid(data);
      onResults(data.results);
    },
    [onResults],
  );

  const name = (id) => rowsById.get(id)?.customer ?? id;
  const counts = outcome?.results.reduce((all, r) => ({ ...all, [r.status]: (all[r.status] ?? 0) + 1 }), {}) ?? {};
  const busy = stage === 'planning' || stage === 'running';

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="carry-out-title">
        <header className="dialog-head">
          <h2 id="carry-out-title">
            {stage === 'done' ? 'Carried out' : stage === 'error' ? 'Something went wrong' : 'Carry out approved actions'}
          </h2>
          <button type="button" className="ghost" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </header>

        {stage === 'planning' && <p className="muted">Re-checking every approved row against PayPal…</p>}

        {stage === 'error' && <p className="banner error-banner">{error}</p>}

        {(stage === 'review' || stage === 'running') && plan && (
          <>
            {plan.steps.length > 0 ? (
              <>
                <p>
                  Tend will do exactly this, with amounts re-checked against PayPal just now. Nothing happens until you
                  confirm.
                </p>
                <ol className="plan">
                  {plan.steps.map((step) => (
                    <li key={step.itemId} className={`plan-step kind-${step.kind}`}>
                      <span>{step.label}</span>
                      {step.kind === 'checkout' && <span className="tag">Pay with PayPal next</span>}
                      {step.kind === 'record' && <span className="tag">No PayPal call</span>}
                      {step.warnings?.map((warning) => (
                        <small key={warning} className="warning">
                          ⚠ {warning}
                        </small>
                      ))}
                    </li>
                  ))}
                </ol>
                <dl className="plan-totals">
                  {plan.totals.refunds > 0 && (
                    <div>
                      <dt>Paid back to customers</dt>
                      <dd>{money(plan.totals.refunds)}</dd>
                    </div>
                  )}
                  {plan.totals.reminders > 0 && (
                    <div>
                      <dt>Chased with reminders</dt>
                      <dd>{money(plan.totals.reminders)}</dd>
                    </div>
                  )}
                  {plan.totals.reorders > 0 && (
                    <div>
                      <dt>Reorders to pay for</dt>
                      <dd>{money(plan.totals.reorders)}</dd>
                    </div>
                  )}
                </dl>
              </>
            ) : (
              <p>None of the approved rows can be carried out right now.</p>
            )}

            {plan.rejected.length > 0 && (
              <div className="plan-rejected">
                <strong>Left out ({plan.rejected.length})</strong>
                <ul>
                  {plan.rejected.map((item) => (
                    <li key={item.id}>
                      {name(item.id)}: {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {needsPasscode && plan.steps.length > 0 && (
              <label className="passcode">
                Owner passcode
                <input
                  type="password"
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value)}
                  autoComplete="off"
                  disabled={stage === 'running'}
                  aria-describedby="passcode-help"
                />
                <small id="passcode-help" className={passcodeError ? 'warning' : 'muted'}>
                  {passcodeError || 'This hosted demo asks for a passcode before anything is sent to PayPal.'}
                </small>
              </label>
            )}

            <div className="dialog-actions">
              <button type="button" onClick={onClose} disabled={stage === 'running'}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={confirm}
                disabled={stage === 'running' || plan.steps.length === 0 || (needsPasscode && !passcode)}
              >
                {stage === 'running' ? 'Sending to PayPal…' : `Confirm and carry out ${plan.steps.length}`}
              </button>
            </div>
          </>
        )}

        {stage === 'done' && outcome && (
          <>
            <p>
              {Object.entries(counts)
                .map(([status, n]) => `${n} ${STATUS_TEXT[status].toLowerCase()}`)
                .join(' · ')}
            </p>
            <ul className="results">
              {outcome.results.map((result) => {
                const status = paid?.results.find((r) => r.id === result.id)?.status ?? result.status;
                return (
                  <li key={result.id} className={`result result-${status}`}>
                    <strong>{STATUS_TEXT[status]}</strong> {name(result.id)}
                    <span className="muted"> · {paid?.results.find((r) => r.id === result.id)?.detail ?? result.detail}</span>
                  </li>
                );
              })}
            </ul>

            {outcome.checkout && !paid && (
              <section className="checkout">
                <h3>Pay for the reorders: {money(outcome.checkout.total)}</h3>
                <p className="muted">
                  Sign in with the PayPal <strong>sandbox buyer</strong> account (not your real PayPal). Prices are the
                  catalog&apos;s.
                </p>
                <PayPalCheckout orderId={outcome.checkout.orderId} onPaid={onPaid} />
              </section>
            )}
            {paid && <p className="banner info-banner">Reorders paid. PayPal payment {paid.captureId}.</p>}

            <div className="dialog-actions">
              <button type="button" className="primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
