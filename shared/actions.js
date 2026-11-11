// Shared by the server and the browser, so an owner's edit in the grid is priced by
// exactly the same rules the server uses before anything is sent to PayPal.

// The actions Tend can carry out (or deliberately not carry out) for each kind of item.
export const ACTIONS = {
  overdue_invoice: ['send_reminder', 'hold'],
  refund_request: ['full_refund', 'partial_refund', 'decline', 'review'],
  dispute: ['send_message', 'make_offer', 'accept_claim', 'review'],
  low_stock: ['reorder', 'skip'],
};

export const TYPE_LABELS = {
  overdue_invoice: 'Overdue invoice',
  refund_request: 'Refund request',
  dispute: 'Dispute',
  low_stock: 'Low stock',
};

export const ACTION_LABELS = {
  send_reminder: 'Send reminder',
  hold: 'Hold',
  full_refund: 'Full refund',
  partial_refund: 'Partial refund',
  decline: 'Decline',
  review: 'Needs review',
  send_message: 'Reply to buyer',
  make_offer: 'Make offer',
  accept_claim: 'Accept claim',
  reorder: 'Reorder',
  skip: 'Skip',
};

// The owner (or Gemini) may size these amounts, up to what PayPal says was paid.
export const AMOUNT_EDITABLE = new Set(['partial_refund', 'make_offer']);
// "review" is a placeholder: the owner must pick a real action before approving.
export const NOT_APPROVABLE = new Set(['review']);

const toCents = (value) => Math.round(Number(value) * 100);
const fromCents = (cents) => cents / 100;

export function defaultQuantity(evidence) {
  const target = Math.ceil(evidence.weeklyUse * 4 + evidence.reorderPoint - evidence.onHand);
  return Math.max(1, Math.min(target, evidence.supplierStock));
}

// Works out the money for one action. `amount` and `quantity` are only suggestions
// (from Gemini or the owner): fixed amounts always come from PayPal, prices from the catalog.
export function priceAction(item, action, { amount: suggestedAmount, quantity: suggestedQuantity } = {}) {
  const warnings = [];
  let amount = 0;
  let quantity = null;

  switch (action) {
    case 'send_reminder':
    case 'full_refund':
    case 'accept_claim':
      amount = item.amount;
      break;
    case 'partial_refund':
    case 'make_offer': {
      const cents = suggestedAmount == null || suggestedAmount === '' ? NaN : toCents(suggestedAmount);
      if (!Number.isFinite(cents) || cents <= 0) {
        warnings.push('No valid amount yet. Set one before approving.');
        amount = null;
      } else if (cents > toCents(item.amount)) {
        warnings.push(`Amount was above the $${item.amount.toFixed(2)} paid, so it was capped.`);
        amount = item.amount;
      } else {
        amount = fromCents(cents);
      }
      break;
    }
    case 'reorder': {
      const suggested = Number(suggestedQuantity);
      quantity = Number.isInteger(suggested) && suggested >= 1 ? suggested : defaultQuantity(item.evidence);
      if (quantity > item.evidence.supplierStock) {
        warnings.push(`Supplier only has ${item.evidence.supplierStock}, so the quantity was reduced.`);
        quantity = item.evidence.supplierStock;
      }
      amount = fromCents(toCents(item.evidence.unitPrice) * quantity);
      break;
    }
    default:
      amount = 0; // hold, skip, decline, review and send_message move no money.
  }

  return { amount, quantity, warnings };
}
