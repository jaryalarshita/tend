// Fills the PayPal sandbox with demo data for Tend's fictional shop, Little Lantern Gifts:
//   - corporate gift invoices, some overdue, one already reminded, one paid
//   - card sales captured in PayPal (refundable), some with a customer message
// Run with `npm run seed`. Add `-- --reset` to cancel the previous demo invoices first.
//
// Sales are written to server/data/sales.json. PayPal has no customer inbox, and sandbox
// transaction search can lag by hours, so Tend reads sales from that file and looks each
// capture up live in PayPal by its ID.
import { writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import { paypalRequest } from '../server/paypal.js';

dotenv.config({ quiet: true });

const SALES_FILE = new URL('../server/data/sales.json', import.meta.url);
const INVOICE_PREFIX = 'TEND-';
const CURRENCY = 'USD';
// PayPal's sandbox test Visa. Card orders capture instantly, with no buyer login.
const TEST_CARD = { number: '4032039317984658', expiry: '2030-12', security_code: '123' };
const TEST_BILLING_ADDRESS = {
  address_line_1: '1 Main St',
  admin_area_2: 'San Jose',
  admin_area_1: 'CA',
  postal_code: '95131',
  country_code: 'US',
};

// dueInDays < 0 means overdue. `reminded` sends one reminder now, `paid` records a payment.
const INVOICES = [
  {
    customer: 'Northwind Dental',
    email: 'accounts@northwind-dental.example.com',
    items: [{ name: 'Staff holiday hamper', quantity: 31, price: 40 }],
    dueInDays: -21,
  },
  {
    customer: 'Bloom & Stem Florist',
    email: 'hello@bloomandstem.example.com',
    items: [{ name: 'Soy candle gift box', quantity: 7, price: 26.5 }],
    dueInDays: -9,
  },
  {
    customer: 'Harbor View Hotel',
    email: 'finance@harborviewhotel.example.com',
    items: [
      { name: 'Guest room welcome box', quantity: 40, price: 18 },
      { name: 'Lobby fairy light jars', quantity: 12, price: 24 },
    ],
    dueInDays: -3,
  },
  {
    customer: 'Pinecone Yoga Studio',
    email: 'pinecone.yoga@example.com',
    items: [{ name: 'Candle and card set', quantity: 6, price: 13 }],
    dueInDays: -34,
    reminded: true,
  },
  {
    customer: 'Cedar & Co Accountants',
    email: 'office@cedarandco.example.com',
    items: [{ name: 'Client thank-you box', quantity: 25, price: 26 }],
    dueInDays: 5,
  },
  {
    customer: 'Little Fern Studio',
    email: 'studio@littlefern.example.com',
    items: [{ name: 'Wrapped candle trio', quantity: 5, price: 19 }],
    dueInDays: 12,
  },
  {
    customer: 'Oakline Realty',
    email: 'admin@oaklinerealty.example.com',
    items: [{ name: 'New homeowner gift box', quantity: 10, price: 32 }],
    dueInDays: -15,
    paid: true,
  },
];

// shipping is what the shop's courier reports; message is what the customer wrote.
const SALES = [
  {
    customer: 'Priya Raman',
    email: 'priya.raman@example.com',
    item: 'Holiday candle gift box',
    amount: 48,
    shipping: { status: 'delivered', daysAgo: 2 },
    message: {
      daysAgo: 1,
      text: 'One of the two candles arrived smashed, glass all through the box. Photo attached. Could I get a refund for the broken one?',
    },
  },
  {
    customer: 'Tom Becker',
    email: 'tom.becker@example.com',
    item: 'Fairy light jar',
    amount: 32,
    shipping: { status: 'delivered', daysAgo: 4 },
    message: {
      daysAgo: 2,
      text: "The lights don't turn on at all, even with brand new batteries. Really disappointed, it was a gift.",
    },
  },
  {
    customer: 'Ana Souza',
    email: 'ana.souza@example.com',
    item: 'Custom gift hamper, large',
    amount: 120,
    shipping: { status: 'delivered', daysAgo: 6 },
    message: {
      daysAgo: 3,
      text: 'I ordered the large hamper by mistake, I meant the medium one. Can I swap it or get the difference back?',
    },
  },
  {
    customer: 'Jake Morrow',
    email: 'jake.morrow@example.com',
    item: 'Deluxe holiday hamper',
    amount: 210,
    shipping: { status: 'delivered', daysAgo: 9 },
    message: {
      daysAgo: 1,
      text: 'Found the same thing cheaper somewhere else. Refund me the full amount please, I already used some of it.',
    },
  },
  {
    customer: 'Mei Lin',
    email: 'mei.lin@example.com',
    item: 'Wrapped candle trio',
    amount: 26,
    shipping: { status: 'in_transit', daysAgo: 0 },
    message: null,
  },
  {
    customer: 'Sam Okafor',
    email: 'sam.okafor@example.com',
    item: 'Fairy light jar, pair',
    amount: 64,
    shipping: { status: 'delivered', daysAgo: 3 },
    message: null,
  },
];

const money = (value) => ({ currency_code: CURRENCY, value: Number(value).toFixed(2) });
const today = new Date();
const dateOffset = (days) => {
  const date = new Date(today);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};
const timeOffset = (days) => new Date(today.getTime() - days * 86_400_000).toISOString();
// A short run ID keeps invoice numbers unique when the script is run more than once.
const runId = today.toISOString().replace(/\D/g, '').slice(2, 12);

async function resetDemoInvoices() {
  const list = await paypalRequest('GET', '/v2/invoicing/invoices?page=1&page_size=100', {
    action: 'list invoices',
  });
  const demo = (list.items ?? []).filter((inv) => inv.detail?.invoice_number?.startsWith(INVOICE_PREFIX));
  for (const inv of demo) {
    if (inv.status === 'DRAFT') {
      await paypalRequest('DELETE', `/v2/invoicing/invoices/${inv.id}`, { action: 'delete a draft invoice' });
    } else if (['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) {
      await paypalRequest('POST', `/v2/invoicing/invoices/${inv.id}/cancel`, {
        action: 'cancel an old demo invoice',
        body: { send_to_invoicer: false, send_to_recipient: false },
      });
    } else {
      continue; // Paid and cancelled invoices are left as history.
    }
    console.log(`  removed ${inv.detail.invoice_number} (${inv.status})`);
  }
}

async function createInvoice(spec, index) {
  const invoiceNumber = `${INVOICE_PREFIX}${runId}-${String(index + 1).padStart(2, '0')}`;
  // Invoices are dated 30 days before they fall due, so overdue ones look real.
  const created = await paypalRequest('POST', '/v2/invoicing/invoices', {
    action: `create invoice for ${spec.customer}`,
    body: {
      detail: {
        invoice_number: invoiceNumber,
        currency_code: CURRENCY,
        invoice_date: dateOffset(spec.dueInDays - 30),
        payment_term: { due_date: dateOffset(spec.dueInDays) },
        note: 'Thank you for ordering with Little Lantern Gifts.',
      },
      invoicer: { business_name: 'Little Lantern Gifts' },
      primary_recipients: [
        { billing_info: { business_name: spec.customer, email_address: spec.email } },
      ],
      items: spec.items.map((item) => ({
        name: item.name,
        quantity: String(item.quantity),
        unit_amount: money(item.price),
      })),
    },
  });
  const id = created.id ?? created.href?.split('/').pop();

  await paypalRequest('POST', `/v2/invoicing/invoices/${id}/send`, {
    action: `send invoice ${invoiceNumber}`,
    body: { send_to_invoicer: false, send_to_recipient: true },
  });
  if (spec.reminded) {
    await paypalRequest('POST', `/v2/invoicing/invoices/${id}/remind`, {
      action: `remind on invoice ${invoiceNumber}`,
      body: {
        subject: 'Friendly reminder: invoice overdue',
        note: 'Just a reminder that this invoice is now past due.',
        send_to_invoicer: false,
        send_to_recipient: true,
      },
    });
  }
  const total = spec.items.reduce((sum, item) => sum + Math.round(item.price * 100) * item.quantity, 0) / 100;
  if (spec.paid) {
    await paypalRequest('POST', `/v2/invoicing/invoices/${id}/payments`, {
      action: `record payment on ${invoiceNumber}`,
      body: { method: 'BANK_TRANSFER', payment_date: dateOffset(spec.dueInDays - 2), amount: money(total) },
    });
  }

  const state = spec.paid ? 'paid' : spec.dueInDays < 0 ? `${-spec.dueInDays} days overdue` : `due in ${spec.dueInDays} days`;
  console.log(`  ${invoiceNumber}  ${spec.customer.padEnd(24)} $${total.toFixed(2).padStart(8)}  ${state}${spec.reminded ? ', reminded' : ''}`);
}

async function createSale(spec, index) {
  const order = await paypalRequest('POST', '/v2/checkout/orders', {
    action: `create the sale for ${spec.customer}`,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          invoice_id: `TEND-S-${runId}-${index + 1}`,
          custom_id: 'tend-demo',
          description: spec.item,
          amount: money(spec.amount),
        },
      ],
      payment_source: {
        card: { ...TEST_CARD, name: spec.customer, billing_address: TEST_BILLING_ADDRESS },
      },
    },
  });
  // Card orders with payment_source usually complete straight away; capture if not.
  const paid = order.status === 'COMPLETED'
    ? order
    : await paypalRequest('POST', `/v2/checkout/orders/${order.id}/capture`, { action: 'capture the sale' });
  const capture = paid.purchase_units[0].payments.captures[0];

  console.log(`  ${capture.id}  ${spec.customer.padEnd(14)} $${spec.amount.toFixed(2).padStart(7)}  ${spec.item}${spec.message ? '  (has message)' : ''}`);
  return {
    orderId: order.id,
    captureId: capture.id,
    customer: spec.customer,
    email: spec.email,
    item: spec.item,
    amount: money(spec.amount),
    paidAt: capture.create_time ?? today.toISOString(),
    shipping: {
      status: spec.shipping.status,
      ...(spec.shipping.status === 'delivered' && { deliveredAt: timeOffset(spec.shipping.daysAgo) }),
    },
    message: spec.message && { receivedAt: timeOffset(spec.message.daysAgo), text: spec.message.text },
  };
}

async function main() {
  if (process.argv.includes('--reset')) {
    console.log('Removing previous demo invoices...');
    await resetDemoInvoices();
  }

  console.log('\nCreating invoices...');
  for (const [index, spec] of INVOICES.entries()) await createInvoice(spec, index);

  console.log('\nCreating paid card sales...');
  const sales = [];
  for (const [index, spec] of SALES.entries()) sales.push(await createSale(spec, index));

  await writeFile(SALES_FILE, `${JSON.stringify({ shop: 'Little Lantern Gifts', createdAt: today.toISOString(), sales }, null, 2)}\n`);
  console.log(`\nSaved ${sales.length} sales to server/data/sales.json`);
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`);
  process.exit(1);
});
