import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { isConfigured as isPayPalConfigured } from './paypal.js';

dotenv.config({ quiet: true });

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
