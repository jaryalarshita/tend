import { randomUUID } from 'node:crypto';

// Sandbox only by design: this project must never touch live PayPal money.
const PAYPAL_API = 'https://api-m.sandbox.paypal.com';
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const MAX_ATTEMPTS = 3;

export class PayPalError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
  }
}

export function isConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The sandbox sometimes returns 5xx or drops the connection. Those are worth a retry;
// a 4xx means the request itself was wrong, so retrying would not help.
const isRetryableStatus = (status) => status === 429 || status >= 500;

let cachedToken = null;

async function getAccessToken() {
  if (!isConfigured()) {
    throw new PayPalError('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env', 500);
  }
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
  ).toString('base64');

  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!isRetryableStatus(res.status) || attempt === MAX_ATTEMPTS) break;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw new PayPalError(`Could not reach PayPal: ${err.message}`);
    }
    await sleep(500 * 2 ** (attempt - 1));
  }

  if (!res.ok) {
    const detail = res.status === 401 ? 'check the sandbox client ID and secret' : `status ${res.status}`;
    throw new PayPalError(`PayPal authentication failed: ${detail}`);
  }

  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
  };
  return cachedToken.value;
}

// One way in to every PayPal REST call. `action` finishes the sentence
// "PayPal could not ..." so errors read well in the UI.
// `requestId` lets a caller make an action idempotent across separate calls too: the
// same ID for the same refund means PayPal performs it once, however often it's sent.
export async function paypalRequest(method, path, { body, action = 'complete the request', requestId: fixedId } = {}) {
  const accessToken = await getAccessToken();
  // The same request ID is sent on every retry, so PayPal treats a retried POST as the
  // same request and can never refund or charge twice.
  const requestId = fixedId ?? randomUUID();

  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${PAYPAL_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': requestId,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        throw new PayPalError(`PayPal could not ${action}: ${err.message}`);
      }
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    // Some PayPal actions (send reminder, cancel invoice) answer 204 with no body.
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.details?.[0]?.issue ?? data.message ?? `status ${res.status}`;
      throw new PayPalError(`PayPal could not ${action}: ${detail}`, res.status === 404 ? 404 : 502);
    }
    return data;
  }
}

// Money is summed in whole cents so totals never pick up floating point errors.
const toCents = (amount) => Math.round(Number(amount) * 100);
const toValue = (cents) => (cents / 100).toFixed(2);

// items: [{ name, quantity, unitPrice }]
export async function createOrder(items, currency = 'USD') {
  const totalCents = items.reduce((sum, item) => sum + toCents(item.unitPrice) * item.quantity, 0);
  const money = (cents) => ({ currency_code: currency, value: toValue(cents) });

  const data = await paypalRequest('POST', '/v2/checkout/orders', {
    action: 'create the order',
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            ...money(totalCents),
            breakdown: { item_total: money(totalCents) },
          },
          items: items.map((item) => ({
            name: item.name.slice(0, 127),
            quantity: String(item.quantity),
            unit_amount: money(toCents(item.unitPrice)),
          })),
        },
      ],
    },
  });

  return {
    id: data.id,
    status: data.status,
    approveUrl: data.links?.find((link) => link.rel === 'approve')?.href,
  };
}

// Moves the money. Only succeeds after the buyer has approved the order at PayPal.
export async function captureOrder(orderId) {
  const data = await paypalRequest('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    action: 'capture the payment',
  });
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];

  return {
    id: data.id,
    status: data.status,
    captureId: capture?.id,
    amount: capture?.amount,
  };
}
