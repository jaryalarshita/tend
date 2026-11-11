// A live feed of what Tend is doing (reading PayPal, asking Gemini, applying money rules,
// carrying out actions), streamed to the page with Server-Sent Events.
//
// Each browser tab sends a random session ID. Steps from a visitor's own commands and
// carry-outs go only to that tab; queue reviews hold no visitor input, so they go to all.
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';

const KEEP = 200; // steps kept in memory for tabs that connect later
const REPLAY = 40; // steps sent when a tab connects
const HEARTBEAT_MS = 25_000; // keeps proxies (like Render's) from closing an idle stream

const context = new AsyncLocalStorage();
const bus = new EventEmitter();
bus.setMaxListeners(200);
const recent = [];
let nextId = 1;

const cleanSession = (value) => {
  const text = String(value ?? '').slice(0, 64);
  return /^[\w-]+$/.test(text) ? text : null;
};

// Express middleware: everything a request does is tagged with its tab's session.
export function withSession(req, _res, next) {
  context.run({ session: cleanSession(req.get('X-Tend-Session')) }, next);
}

// Runs `work` as a shared, everyone-can-see job (used for queue reviews).
export const asShared = (work) => context.run({ session: null }, work);

// status: 'start' (in progress), 'ok', 'warn' or 'fail'. kind groups the step for the page.
export function step(kind, text, status = 'ok', detail) {
  const event = {
    id: nextId++,
    at: Date.now(),
    session: context.getStore()?.session ?? null,
    kind,
    status,
    text: String(text).slice(0, 300),
    ...(detail && { detail: String(detail).slice(0, 300) }),
  };
  recent.push(event);
  if (recent.length > KEEP) recent.shift();
  bus.emit('step', event);
  return event;
}

// GET /api/activity?session=…: the live stream for one tab.
export function streamActivity(req, res) {
  const session = cleanSession(req.query.session);
  const visible = (event) => event.session === null || event.session === session;
  const send = (event) => {
    const { session: _hidden, ...shown } = event;
    res.write(`id: ${event.id}\ndata: ${JSON.stringify(shown)}\n\n`);
  };

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Stops proxies from holding events back in a buffer.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Replay recent steps, but only ones this tab hasn't seen (after a reconnect).
  const lastSeen = Number(req.get('Last-Event-ID')) || 0;
  recent.filter((event) => event.id > lastSeen && visible(event)).slice(-REPLAY).forEach(send);

  const onStep = (event) => visible(event) && send(event);
  bus.on('step', onStep);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('step', onStep);
  });
}
