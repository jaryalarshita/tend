import catalog from './data/catalog.json' with { type: 'json' };

const MAX_RESULTS = 10;
const MIN_MATCH_RATIO = 0.6;
const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'of', 'the', 'with']);

// Lets "box" match "boxes" and "light" match "lights".
const stem = (word) => word.replace(/(?<=x)es$|s$/, '');

function toTerms(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => !STOP_WORDS.has(word))
    .map(stem);
}

export function searchCatalog({ query, maxPrice }) {
  const terms = [...new Set(toTerms(query ?? ''))];
  if (terms.length === 0) return [];
  const requiredMatches = Math.ceil(terms.length * MIN_MATCH_RATIO);

  return catalog
    .filter((product) => maxPrice == null || product.price <= maxPrice)
    .map((product) => {
      const productTerms = new Set(toTerms(`${product.name} ${product.category}`));
      return { product, matches: terms.filter((term) => productTerms.has(term)).length };
    })
    .filter(({ matches }) => matches >= requiredMatches)
    .sort((a, b) => b.matches - a.matches || a.product.price - b.product.price)
    .slice(0, MAX_RESULTS)
    .map(({ product }) => product);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

// Prices, suppliers and delivery dates always come from the catalog, never from the AI,
// so the model cannot invent a price. Problems are returned so the agent can fix them.
export function buildCart({ items, budget = null, deadline = null }, today = new Date()) {
  const rows = [];
  const errors = [];

  for (const { productId, quantity, reason } of items ?? []) {
    const product = catalog.find((candidate) => candidate.id === productId);
    if (!product) {
      errors.push(`Unknown product ID: ${productId}`);
    } else if (!Number.isInteger(quantity) || quantity < 1) {
      errors.push(`${productId}: quantity must be a whole number of at least 1`);
    } else if (quantity > product.stock) {
      errors.push(`${productId}: requested ${quantity} but only ${product.stock} in stock`);
    } else {
      const deliveryDate = addDays(today, product.deliveryDays);
      rows.push({
        productId,
        product: product.name,
        supplier: product.supplier,
        quantity,
        unitPrice: product.price,
        lineTotal: (Math.round(product.price * 100) * quantity) / 100,
        deliveryDate,
        arrivesLate: deadline != null && deliveryDate > deadline,
        reason: reason ?? '',
      });
    }
  }

  const totalCents = rows.reduce((sum, row) => sum + Math.round(row.lineTotal * 100), 0);
  const total = totalCents / 100;

  return {
    rows,
    errors,
    total,
    budget,
    deadline,
    remaining: budget == null ? null : (Math.round(budget * 100) - totalCents) / 100,
    overBudget: budget != null && total > budget,
  };
}
