import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { proposeActions } from './agent.js';
import { interpretCommand } from './commands.js';
import { captureReorder, executePlan, preparePlan } from './executor.js';
import { isConfigured as isPayPalConfigured } from './paypal.js';
import { collectItems } from './sources.js';

dotenv.config({ quiet: true });

// A Gemini review takes 10-60 s, so the queue is cached and only rebuilt on request.
// Concurrent requests share one in-flight build instead of calling Gemini twice.
let cachedQueue = null;
let building = null;

// `fresh` asks Gemini again; otherwise a recent saved review of the same items is reused.
async function buildQueue(fresh) {
  const startedAt = Date.now();
  const { items, errors } = await collectItems();
  const { rows, model, aiError, fallbackFrom, cachedReviewAt, reusedReviewAt, askedCount } = await proposeActions(items, {
    reuseSaved: !fresh,
  });
  return {
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    model,
    aiError,
    fallbackFrom,
    cachedReviewAt,
    reusedReviewAt,
    askedCount,
    sourceErrors: errors,
    rows,
  };
}

const app = express();
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const port = process.env.PORT || 3001;

app.use(express.json({ limit: '200kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    paypalConfigured: isPayPalConfigured(),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
});

app.get('/api/queue', async (req, res, next) => {
  try {
    const fresh = req.query.refresh === '1';
    if (!cachedQueue || fresh) {
      building ??= buildQueue(fresh).finally(() => {
        building = null;
      });
      cachedQueue = await building;
    }
    res.json(cachedQueue);
  } catch (err) {
    next(err);
  }
});

// Typed commands that drive the grid. Gemini returns grid operations only; the browser
// applies them, and nothing here reaches PayPal.
app.post('/api/command', async (req, res, next) => {
  const { text, rows } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim() || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'Send { text, rows }' });
  }
  try {
    res.json(await interpretCommand(text.trim(), rows));
  } catch (err) {
    if (err.failures) {
      // Every model was busy: the browser falls back to a plain search.
      return res.status(503).json({ error: `Gemini is busy (${err.failures.join('; ')})` });
    }
    next(err);
  }
});

// Carrying out approved rows: first a plan with the server's own amounts, then, once the
// owner confirms it, exactly that plan. Reorders are paid through PayPal Checkout.
app.post('/api/execute/plan', async (req, res, next) => {
  try {
    res.json(await preparePlan(req.body?.actions));
  } catch (err) {
    next(err);
  }
});

app.post('/api/execute', async (req, res, next) => {
  try {
    const result = await executePlan(req.body?.planId);
    // PayPal has changed, so the next queue load rebuilds (reusing the review where it can).
    cachedQueue = null;
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/orders/:id/capture', async (req, res, next) => {
  try {
    const result = await captureReorder(req.params.id);
    cachedQueue = null;
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// The client ID is public by design: PayPal's button script needs it in the browser.
// The secret is never sent to the frontend.
app.get('/api/config', (_req, res) => {
  res.json({ paypalClientId: process.env.PAYPAL_CLIENT_ID });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use(express.static(distDir));
app.use((_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
});

app.listen(port, () => {
  console.log(`Tend API listening on http://localhost:${port}`);
});
