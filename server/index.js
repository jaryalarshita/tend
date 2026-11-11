import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { proposeActions } from './agent.js';
import { isConfigured as isPayPalConfigured } from './paypal.js';
import { collectItems } from './sources.js';

dotenv.config({ quiet: true });

// A Gemini review takes ~15 s, so the queue is cached and only rebuilt on request.
// Concurrent requests share one in-flight build instead of calling Gemini twice.
let cachedQueue = null;
let building = null;

async function buildQueue() {
  const startedAt = Date.now();
  const { items, errors } = await collectItems();
  const { rows, model, aiError, fallbackFrom, cachedReviewAt } = await proposeActions(items);
  return {
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    model,
    aiError,
    fallbackFrom,
    cachedReviewAt,
    sourceErrors: errors,
    rows,
  };
}

const app = express();
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const port = process.env.PORT || 3001;

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    paypalConfigured: isPayPalConfigured(),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
});

app.get('/api/queue', async (req, res, next) => {
  try {
    if (!cachedQueue || req.query.refresh === '1') {
      building ??= buildQueue().finally(() => {
        building = null;
      });
      cachedQueue = await building;
    }
    res.json(cachedQueue);
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
