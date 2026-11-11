// Carries out the owner's approved rows through PayPal, in two steps:
//   1. preparePlan(): rebuild every approved row from fresh PayPal data, re-price it with
//      the shared money rules, and return a plan with the server's own amounts.
//   2. executePlan(): after the owner confirms that plan, run exactly it, once.
// Anything not in a confirmed plan never runs. Reorders are paid by the owner through
// PayPal Checkout, then captured here.
import { createHash, randomUUID } from 'node:crypto';
import { ACTION_LABELS, ACTIONS, NOT_APPROVABLE, priceAction } from '../shared/actions.js';
import { findDone, record, workKey } from './history.js';
import { captureOrder, createOrder, paypalRequest } from './paypal.js';
import { collectItems } from './sources.js';
import { buildCart } from './tools.js';

const PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_STEPS = 50;
// Actions that are decisions, not PayPal calls: they're recorded so the item is handled.
const RECORD_ONLY = new Set(['hold', 'skip', 'decline']);
// Dispute actions and the PayPal link each one needs to be allowed right now.
const DISPUTE_LINKS = { send_message: 'send_message', make_offer: 'make_offer', accept_claim: 'accept_claim' };

const plans = new Map(); // planId -> { createdAt, steps, used }
const orders = new Map(); // PayPal order ID -> { steps, total }

const clip = (text, max) => String(text ?? '').trim().slice(0, max);
const money = (amount, currency = 'USD') => ({ currency_code: currency, value: Number(amount).toFixed(2) });
// Same row, action and amount always gives the same PayPal request ID, so PayPal itself
// refuses to do the same refund twice, even across separate clicks or server restarts.
const requestIdFor = (key) => {
  const hex = createHash('sha256').update(`tend:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

function forget(expiredBefore) {
  for (const [id, plan] of plans) if (plan.createdAt < expiredBefore) plans.delete(id);
}

function describe(step) {
  const amount = step.amount > 0 ? ` $${step.amount.toFixed(2)}` : '';
  switch (step.action) {
    case 'send_reminder':
      return `Send a payment reminder to ${step.customer} for${amount}`;
    case 'full_refund':
    case 'partial_refund':
      return `Refund ${step.customer}${amount}`;
    case 'send_message':
      return `Reply to ${step.customer}'s dispute`;
    case 'make_offer':
      return `Offer ${step.customer}${amount} to settle the dispute`;
    case 'accept_claim':
      return `Accept ${step.customer}'s claim and refund${amount}`;
    case 'reorder':
      return `Order ${step.quantity} × ${step.product} from ${step.customer} for${amount}`;
    default:
      return `${ACTION_LABELS[step.action]}: ${step.customer} (recorded, nothing sent to PayPal)`;
  }
}

// requests: [{ id, action, amount, quantity, message }] for the rows the owner approved.
export async function preparePlan(requests) {
  forget(Date.now() - PLAN_TTL_MS);
  if (!Array.isArray(requests) || requests.length === 0) throw Object.assign(new Error('Nothing approved to carry out'), { status: 400 });
  if (requests.length > MAX_STEPS) throw Object.assign(new Error(`At most ${MAX_STEPS} rows at a time`), { status: 400 });

  const { items, errors } = await collectItems();
  const byId = new Map(items.map((item) => [item.id, item]));
  const steps = [];
  const rejected = [];

  const seen = new Set();
  for (const request of requests) {
    const item = byId.get(request.id);
    const reject = (reason) => rejected.push({ id: request.id, reason });
    // One step per row, so a row can never be refunded twice in one plan.
    if (seen.has(request.id)) {
      reject('Listed more than once.');
      continue;
    }
    seen.add(request.id);
    if (!item) {
      reject('No longer in PayPal as an open item: it may already be handled, or it changed.');
      continue;
    }
    if (!ACTIONS[item.type].includes(request.action) || NOT_APPROVABLE.has(request.action)) {
      reject(`"${request.action}" can't be carried out for this kind of item.`);
      continue;
    }
    if (item.type === 'dispute' && DISPUTE_LINKS[request.action] && !item.evidence.allowedActions?.includes(DISPUTE_LINKS[request.action])) {
      reject(`PayPal doesn't allow "${ACTION_LABELS[request.action]}" on this dispute right now.`);
      continue;
    }
    // The server prices every step itself; the browser's numbers are only suggestions.
    const priced = priceAction(item, request.action, { amount: request.amount, quantity: request.quantity });
    if (priced.amount == null) {
      reject('No valid amount.');
      continue;
    }
    const key = workKey(item.id, request.action, priced.amount);
    if (await findDone(key)) {
      reject('Already done.');
      continue;
    }
    steps.push({
      key,
      itemId: item.id,
      type: item.type,
      ref: item.ref,
      customer: item.customer,
      currency: item.currency,
      product: item.evidence.product,
      invoiceNumber: item.evidence.invoiceNumber,
      action: request.action,
      amount: priced.amount,
      quantity: priced.quantity,
      warnings: priced.warnings,
      message: clip(request.message, 2000),
      kind: request.action === 'reorder' ? 'checkout' : RECORD_ONLY.has(request.action) ? 'record' : 'paypal',
    });
  }

  steps.forEach((step) => {
    step.label = describe(step);
  });
  const sum = (kind, actions) =>
    Math.round(steps.filter((s) => s.kind === kind && (!actions || actions.includes(s.action))).reduce((t, s) => t + s.amount * 100, 0)) / 100;
  const planId = randomUUID();
  plans.set(planId, { createdAt: Date.now(), steps, used: false });

  return {
    planId,
    expiresInMinutes: PLAN_TTL_MS / 60_000,
    steps: steps.map(({ key, ref, ...visible }) => visible),
    rejected,
    sourceErrors: errors,
    totals: {
      refunds: sum('paypal', ['full_refund', 'partial_refund', 'make_offer', 'accept_claim']),
      reminders: sum('paypal', ['send_reminder']),
      reorders: sum('checkout'),
    },
  };
}

// One PayPal call per step. Messages fall back to plain defaults if the owner left them empty.
async function runStep(step) {
  const requestId = requestIdFor(step.key);
  switch (step.action) {
    case 'send_reminder':
      await paypalRequest('POST', `/v2/invoicing/invoices/${encodeURIComponent(step.ref)}/remind`, {
        action: 'send the reminder',
        requestId,
        body: {
          subject: `Reminder: invoice ${step.invoiceNumber} is overdue`,
          note: clip(step.message || 'Just a reminder that this invoice is now past due. Thank you!', 1000),
          send_to_invoicer: false,
          send_to_recipient: true,
        },
      });
      return { detail: 'Reminder sent' };

    case 'full_refund':
    case 'partial_refund': {
      const refund = await paypalRequest('POST', `/v2/payments/captures/${encodeURIComponent(step.ref)}/refund`, {
        action: 'issue the refund',
        requestId,
        body: {
          amount: money(step.amount, step.currency),
          // PayPal allows 255 characters here.
          ...(step.message && { note_to_payer: clip(step.message, 255) }),
        },
      });
      return { detail: `Refunded $${step.amount.toFixed(2)} (${String(refund.status).toLowerCase()})`, paypalRef: refund.id };
    }

    case 'send_message':
      await paypalRequest('POST', `/v1/customer/disputes/${encodeURIComponent(step.ref)}/send-message`, {
        action: 'reply to the dispute',
        requestId,
        body: { message: clip(step.message || 'Thanks for getting in touch. We are looking into your order now.', 2000) },
      });
      return { detail: 'Reply sent to the buyer' };

    case 'make_offer':
      await paypalRequest('POST', `/v1/customer/disputes/${encodeURIComponent(step.ref)}/make-offer`, {
        action: 'make the offer',
        requestId,
        body: {
          note: clip(step.message || 'We would like to offer a partial refund to settle this.', 2000),
          offer_amount: money(step.amount, step.currency),
          offer_type: 'REFUND',
        },
      });
      return { detail: `Offered $${step.amount.toFixed(2)}` };

    case 'accept_claim':
      await paypalRequest('POST', `/v1/customer/disputes/${encodeURIComponent(step.ref)}/accept-claim`, {
        action: 'accept the claim',
        requestId,
        body: {
          note: clip(step.message || 'We accept the claim and are refunding you.', 2000),
          refund_amount: money(step.amount, step.currency),
        },
      });
      return { detail: `Claim accepted, $${step.amount.toFixed(2)} refunded` };

    default:
      return { detail: 'Recorded, nothing sent to PayPal' };
  }
}

// Runs a confirmed plan exactly once. Reorders become one PayPal order for the owner to pay.
export async function executePlan(planId) {
  const plan = plans.get(planId);
  if (!plan || Date.now() - plan.createdAt > PLAN_TTL_MS) {
    throw Object.assign(new Error('This plan has expired. Press "Carry out" again to get a fresh one.'), { status: 410 });
  }
  if (plan.used) throw Object.assign(new Error('This plan was already carried out.'), { status: 409 });
  plan.used = true;

  const results = [];
  // One at a time: easier on PayPal's rate limits, and results arrive in a clear order.
  for (const step of plan.steps.filter((s) => s.kind !== 'checkout')) {
    try {
      const outcome = await runStep(step);
      await record({ key: step.key, itemId: step.itemId, action: step.action, amount: step.amount, status: 'done', ...outcome });
      results.push({ id: step.itemId, status: 'done', ...outcome });
    } catch (err) {
      await record({ key: step.key, itemId: step.itemId, action: step.action, amount: step.amount, status: 'failed', detail: err.message });
      results.push({ id: step.itemId, status: 'failed', detail: err.message });
    }
  }

  let checkout = null;
  const reorders = plan.steps.filter((s) => s.kind === 'checkout');
  if (reorders.length) {
    try {
      // Prices come from the catalog again here, never from the browser or the AI.
      const cart = buildCart({ items: reorders.map((s) => ({ productId: s.ref, quantity: s.quantity })) });
      if (cart.errors.length) throw new Error(cart.errors.join('; '));
      const order = await createOrder(
        cart.rows.map((row) => ({ name: `${row.product} (${row.supplier})`, quantity: row.quantity, unitPrice: row.unitPrice })),
      );
      orders.set(order.id, { steps: reorders, total: cart.total });
      checkout = { orderId: order.id, total: cart.total, items: cart.rows.length };
      for (const step of reorders) results.push({ id: step.itemId, status: 'awaiting_payment', detail: 'Waiting for you to pay with PayPal' });
    } catch (err) {
      for (const step of reorders) results.push({ id: step.itemId, status: 'failed', detail: err.message });
    }
  }

  return { results, checkout };
}

// Called after the owner approves the reorder payment in PayPal's window.
export async function captureReorder(orderId) {
  const pending = orders.get(orderId);
  if (!pending) throw Object.assign(new Error('Unknown or already paid order'), { status: 404 });
  orders.delete(orderId);

  try {
    const capture = await captureOrder(orderId);
    if (capture.status !== 'COMPLETED') throw new Error(`PayPal says the payment is ${capture.status}`);
    const results = [];
    for (const step of pending.steps) {
      const detail = `Paid · ordered ${step.quantity} packs`;
      await record({ key: step.key, itemId: step.itemId, action: step.action, amount: step.amount, status: 'done', detail, paypalRef: capture.captureId });
      results.push({ id: step.itemId, status: 'done', detail, paypalRef: capture.captureId });
    }
    return { results, captureId: capture.captureId, amount: capture.amount };
  } catch (err) {
    // Let the owner try paying again with the same order.
    orders.set(orderId, pending);
    throw err;
  }
}
