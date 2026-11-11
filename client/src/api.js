import { useEffect, useState } from 'react';

// One random ID per browser tab, so the server can send this tab its own activity steps.
// Storage can be blocked, so the ID still works (for this page load) without it.
function tabSession() {
  const fresh = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^\w-]/g, '');
  try {
    const saved = sessionStorage.getItem('tend-session');
    if (saved) return saved;
    const id = fresh();
    sessionStorage.setItem('tend-session', id);
    return id;
  } catch {
    return fresh();
  }
}

export const SESSION = tabSession();

// fetch() plus this tab's session ID. Every call to the server goes through here.
export function apiFetch(url, options = {}) {
  return fetch(url, { ...options, headers: { ...options.headers, 'X-Tend-Session': SESSION } });
}

const MAX_STEPS = 150;

// Live agent steps from the server (Server-Sent Events). EventSource reconnects by itself,
// and the server only replays steps this tab hasn't seen.
export function useActivity() {
  const [steps, setSteps] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/api/activity?session=${encodeURIComponent(SESSION)}`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      try {
        const step = JSON.parse(message.data);
        setSteps((current) => (current.some((s) => s.id === step.id) ? current : [...current, step].slice(-MAX_STEPS)));
      } catch {
        // Ignore anything that isn't a step.
      }
    };
    return () => source.close();
  }, []);

  return { steps, connected };
}
