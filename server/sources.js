// Pulls everything that needs the owner's attention into one list of "items".
// Every amount and price here comes from PayPal or the catalog. Gemini never sets these.
import { readFile } from 'node:fs/promises';
import catalog from './data/catalog.json' with { type: 'json' };
import inventory from './data/inventory.json' with { type: 'json' };
import { doneByItem } from './history.js';
import { paypalRequest } from './paypal.js';

const SALES_FILE = new URL('./data/sales.json', import.meta.url);
// PayPal does not keep a reminder history, so Tend records each reminder it sends here.
const REMINDERS_FILE = new URL('./data/reminders.json', import.meta.url);
const DAY_MS = 86_400_000;
const UNPAID_INVOICE = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID']);
const REFUNDABLE_CAPTURE = new Set(['COMPLETED', 'PARTIALLY_REFUNDED']);
const OPEN_DISPUTE = new Set(['OPEN', 'WAITING_FOR_SELLER_RESPONSE', 'WAITING_FOR_BUYER_RESPONSE', 'UNDER_REVIEW']);

const daysSince = (time, now) => Math.floor((now - new Date(time).getTime()) / DAY_MS);
const toNumber = (money) => Number(money?.value ?? 0);

async function readReminders() {
  try {
    return JSON.parse(await readFile(REMINDERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function overdueInvoices(now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const reminders = await readReminders();
  const items = [];
  for (let page = 1; page <= 5; page++) {
    const list = await paypalRequest('GET', `/v2/invoicing/invoices?page=${page}&page_size=100`, {
      action: 'list invoices',
    });
    for (const invoice of list.items ?? []) {
      const dueDate = invoice.detail?.payment_term?.due_date;
      if (!UNPAID_INVOICE.has(invoice.status) || !dueDate || dueDate >= today) continue;
      const recipient = invoice.primary_recipients?.[0]?.billing_info ?? {};
      // Last contact is the later of the invoice date (when it went out) and Tend's last reminder.
      const lastContact = [invoice.detail?.invoice_date && `${invoice.detail.invoice_date}T00:00:00Z`, reminders[invoice.id]]
        .filter(Boolean)
        .sort()
        .at(-1);
      items.push({
        id: `invoice:${invoice.id}`,
        type: 'overdue_invoice',
        ref: invoice.id,
        customer: recipient.business_name ?? recipient.email_address ?? 'Unknown customer',
        amount: toNumber(invoice.due_amount ?? invoice.amount),
        currency: (invoice.due_amount ?? invoice.amount)?.currency_code ?? 'USD',
        evidence: {
          invoiceNumber: invoice.detail.invoice_number,
          status: invoice.status,
          dueDate,
          daysOverdue: daysSince(`${dueDate}T00:00:00Z`, now),
          lastContactedDaysAgo: lastContact ? daysSince(lastContact, now) : null,
          remindedByTend: Boolean(reminders[invoice.id]),
        },
      });
    }
    if ((list.items ?? []).length < 100) break;
  }
  return items;
}

// Customer refund requests come from the shop's sales log (written by the seed script).
// The capture is looked up live, so a sale that was already refunded drops out.
async function refundRequests(now) {
  const { sales } = JSON.parse(await readFile(SALES_FILE, 'utf8'));
  const withMessages = sales.filter((sale) => sale.message);
  const captures = await Promise.all(
    withMessages.map((sale) =>
      paypalRequest('GET', `/v2/payments/captures/${sale.captureId}`, { action: 'look up a sale' }).catch(() => null),
    ),
  );

  return withMessages.flatMap((sale, index) => {
    const capture = captures[index];
    if (!capture || !REFUNDABLE_CAPTURE.has(capture.status)) return [];
    return [{
      id: `refund:${sale.captureId}`,
      type: 'refund_request',
      ref: sale.captureId,
      customer: sale.customer,
      amount: toNumber(capture.amount),
      currency: capture.amount.currency_code,
      evidence: {
        item: sale.item,
        orderedDaysAgo: daysSince(sale.orderedAt ?? capture.create_time, now),
        captureStatus: capture.status,
        shipping: sale.shipping.status,
        deliveredDaysAgo: sale.shipping.deliveredAt ? daysSince(sale.shipping.deliveredAt, now) : null,
        customerMessage: sale.message.text,
        messageDaysAgo: daysSince(sale.message.receivedAt, now),
      },
    }];
  });
}

async function openDisputes(now) {
  const list = await paypalRequest('GET', '/v1/customer/disputes?page_size=50', { action: 'list disputes' });
  const open = (list.items ?? []).filter((dispute) => OPEN_DISPUTE.has(dispute.status));
  const details = await Promise.all(
    open.map((dispute) =>
      paypalRequest('GET', `/v1/customer/disputes/${dispute.dispute_id}`, { action: 'read a dispute' }),
    ),
  );

  return details.map((dispute) => {
    const transaction = dispute.disputed_transactions?.[0] ?? {};
    return {
      id: `dispute:${dispute.dispute_id}`,
      type: 'dispute',
      ref: dispute.dispute_id,
      customer: transaction.buyer?.name ?? transaction.buyer?.email ?? 'PayPal buyer',
      amount: toNumber(dispute.dispute_amount),
      currency: dispute.dispute_amount?.currency_code ?? 'USD',
      evidence: {
        reason: dispute.reason,
        status: dispute.status,
        stage: dispute.dispute_life_cycle_stage,
        openedDaysAgo: daysSince(dispute.create_time, now),
        sellerResponseDue: dispute.seller_response_due_date ?? null,
        item: transaction.items?.[0]?.item_name ?? null,
        captureId: transaction.seller_transaction_id ?? null,
        messages: (dispute.messages ?? []).slice(-5).map((message) => ({
          from: message.posted_by,
          text: message.content,
        })),
        allowedActions: (dispute.links ?? []).filter((link) => link.method === 'POST').map((link) => link.rel),
      },
    };
  });
}

function lowStock() {
  return inventory
    .filter((stock) => stock.onHand <= stock.reorderPoint)
    .map((stock) => {
      const product = catalog.find((candidate) => candidate.id === stock.productId);
      return {
        id: `reorder:${stock.productId}`,
        type: 'low_stock',
        ref: stock.productId,
        customer: product.supplier,
        // Price of one pack. The line total is worked out once a quantity is chosen.
        amount: product.price,
        currency: 'USD',
        evidence: {
          product: product.name,
          onHand: stock.onHand,
          reorderPoint: stock.reorderPoint,
          weeklyUse: stock.weeklyUse,
          weeksLeft: stock.weeklyUse ? Math.round((stock.onHand / stock.weeklyUse) * 10) / 10 : null,
          unitPrice: product.price,
          supplierStock: product.stock,
          deliveryDays: product.deliveryDays,
        },
      };
    });
}

// One failing source (say, disputes timing out) should not empty the whole queue,
// so each source reports its own error instead.
export async function collectItems(now = Date.now()) {
  const sources = {
    overdue_invoice: () => overdueInvoices(now),
    refund_request: () => refundRequests(now),
    dispute: () => openDisputes(now),
    low_stock: () => lowStock(),
  };
  const items = [];
  const errors = [];
  const results = await Promise.allSettled(Object.values(sources).map((load) => load()));
  Object.keys(sources).forEach((type, index) => {
    const result = results[index];
    if (result.status === 'fulfilled') items.push(...result.value);
    else errors.push({ source: type, message: result.reason?.message ?? String(result.reason) });
  });
  return { items: await applyHistory(items, now), errors };
}

// Once Tend has settled a refund request (refunded or declined) it leaves the queue, and
// so does stock that was reordered or skipped in the last 2 weeks. Invoices and disputes
// stay, since they may need a follow-up, but carry what Tend last did as evidence.
const SETTLED = {
  refund_request: () => true,
  low_stock: (_entry, days) => days < 14,
};

async function applyHistory(items, now) {
  const done = await doneByItem();
  return items.flatMap((item) => {
    const entries = done.get(item.id);
    if (!entries) return [item];
    const latest = entries.at(-1);
    const days = daysSince(latest.at, now);
    if (SETTLED[item.type]?.(latest, days)) return [];

    const evidence = { ...item.evidence, lastTendAction: latest.action, lastTendActionDaysAgo: days };
    // A reminder Tend sent counts as contact, so the AI won't remind again too soon.
    const reminder = entries.findLast((entry) => entry.action === 'send_reminder');
    if (item.type === 'overdue_invoice' && reminder) {
      const reminderDays = daysSince(reminder.at, now);
      evidence.lastContactedDaysAgo = Math.min(evidence.lastContactedDaysAgo ?? reminderDays, reminderDays);
      evidence.remindedByTend = true;
    }
    return [{ ...item, evidence }];
  });
}
