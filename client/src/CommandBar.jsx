import { useState } from 'react';
import { SUGGESTIONS } from './gridCommands.js';

// Where the owner types commands for the agent, and sees what it did with each one.
export default function CommandBar({ onRun, running, entries, onUndo }) {
  const [text, setText] = useState('');

  function submit(command) {
    const value = command.trim();
    if (!value || running) return;
    onRun(value);
    setText('');
  }

  return (
    <section className="command" aria-label="Tell Tend what to do">
      <form
        className="command-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit(text);
        }}
      >
        <span className="command-icon" aria-hidden="true">
          ✦
        </span>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Tell Tend what to do, e.g. “show disputes over $100” or “reject Jake’s refund”"
          aria-label="Command"
          disabled={running}
          maxLength={300}
        />
        <button type="submit" className="primary" disabled={running || !text.trim()}>
          {running ? 'Working…' : 'Run'}
        </button>
      </form>

      {entries.length === 0 ? (
        <div className="suggestions">
          <span className="muted">Try:</span>
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} type="button" className="chip" disabled={running} onClick={() => submit(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      ) : (
        <ol className="command-log">
          {/* The newest command in full; the two before it on one line each. */}
          {entries.slice(0, 3).map((entry, index) => (
            <li key={entry.id} className={`entry entry-${entry.status}${index > 0 ? ' entry-old' : ''}`}>
              <div className="entry-head">
                <span className="entry-text">“{entry.text}”</span>
                {entry.status === 'running' && <span className="muted">thinking…</span>}
                {index === 0 && entry.undo && (
                  <button type="button" className="ghost undo" onClick={() => onUndo(entry)}>
                    ↶ Undo
                  </button>
                )}
              </div>
              {entry.reply && <p className="entry-reply">{entry.reply}</p>}
              {index === 0 && entry.steps?.length > 0 && (
                <ul className="entry-steps">
                  {entry.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              )}
              {index === 0 && entry.model && <span className="entry-model muted">{entry.model}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
