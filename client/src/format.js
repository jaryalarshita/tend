const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const money = (value) => (value == null ? '' : usd.format(value));

const REASON_LABELS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  UNAUTHORISED: 'Unauthorised payment',
  CREDIT_NOT_PROCESSED: 'Credit not processed',
  DUPLICATE_TRANSACTION: 'Duplicate charge',
  INCORRECT_AMOUNT: 'Incorrect amount',
};

const words = (value) => String(value ?? '').toLowerCase().replaceAll('_', ' ');
const days = (n) => (n === 0 ? 'today' : n === 1 ? '1 day ago' : `${n} days ago`);

// One line per row for the grid's Evidence column. The detail panel shows everything.
export function evidenceSummary(row) {
  const e = row.evidence;
  switch (row.type) {
    case 'overdue_invoice':
      return `${e.invoiceNumber} · ${e.daysOverdue} days overdue · last contact ${days(e.lastContactedDaysAgo)}`;
    case 'refund_request':
      return `${e.item} · "${e.customerMessage}"`;
    case 'dispute':
      return `${REASON_LABELS[e.reason] ?? words(e.reason)} · ${words(e.stage)} · ${words(e.status)}`;
    case 'low_stock':
      return `${e.product} · ${e.onHand} left, reorder at ${e.reorderPoint} · ${money(e.unitPrice)} a pack`;
    default:
      return '';
  }
}

// Turns an evidence object into labelled lines for the detail panel.
const EVIDENCE_LABELS = {
  invoiceNumber: 'Invoice',
  status: 'PayPal status',
  dueDate: 'Due date',
  daysOverdue: 'Days overdue',
  lastContactedDaysAgo: 'Last contacted',
  remindedByTend: 'Already reminded by Tend',
  item: 'Item',
  orderedDaysAgo: 'Ordered',
  captureStatus: 'Payment status',
  shipping: 'Shipping',
  deliveredDaysAgo: 'Delivered',
  messageDaysAgo: 'Message received',
  reason: 'Dispute reason',
  stage: 'Stage',
  openedDaysAgo: 'Opened',
  sellerResponseDue: 'Seller response due',
  captureId: 'Payment ID',
  product: 'Product',
  onHand: 'Packs on hand',
  reorderPoint: 'Reorder point',
  weeklyUse: 'Packs used a week',
  weeksLeft: 'Weeks of stock left',
  unitPrice: 'Price a pack',
  supplierStock: 'Supplier has',
  deliveryDays: 'Delivery time',
};
const HIDDEN = new Set(['customerMessage', 'messages', 'allowedActions']);

export function evidenceLines(evidence) {
  return Object.entries(evidence)
    .filter(([key, value]) => !HIDDEN.has(key) && value != null)
    .map(([key, value]) => {
      let text = value;
      if (typeof value === 'boolean') text = value ? 'Yes' : 'No';
      else if (key.endsWith('DaysAgo')) text = days(value);
      else if (key === 'unitPrice') text = money(value);
      else if (key === 'deliveryDays') text = `${value} days`;
      else if (key === 'sellerResponseDue') text = new Date(value).toLocaleDateString();
      else if (key === 'reason') text = REASON_LABELS[value] ?? words(value);
      else if (['status', 'stage', 'captureStatus', 'shipping'].includes(key)) text = words(value);
      return [EVIDENCE_LABELS[key] ?? key, String(text)];
    });
}
