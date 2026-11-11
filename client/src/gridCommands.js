// Applies the agent's grid operations through the AG Grid API and the same edit rules
// as a manual change. Returns a plain-English line per operation for the command log.
import { ACTION_LABELS, ACTIONS, TYPE_LABELS } from '../../shared/actions.js';
import { money } from './format.js';

const NUMBER_COLUMNS = new Set(['atStake', 'proposedAmount', 'quantity']);
const COLUMN_NAMES = {
  typeLabel: 'Type',
  customer: 'Customer',
  atStake: 'At stake',
  evidence: 'Evidence',
  action: 'Action',
  proposedAmount: 'Amount',
  quantity: 'Qty',
  risk: 'Risk',
  decision: 'Decision',
  reason: 'Reason',
};
const CONDITION_WORDS = {
  equals: 'is',
  notEqual: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  greaterThan: '>',
  greaterThanOrEqual: '≥',
  lessThan: '<',
  lessThanOrEqual: '≤',
};

// Several conditions on one text column mean "either"; on a number column, "all" (a range).
export function buildFilterModel(filters) {
  const byColumn = {};
  for (const filter of filters) (byColumn[filter.column] ??= []).push(filter);

  const model = {};
  for (const [column, list] of Object.entries(byColumn)) {
    const numeric = NUMBER_COLUMNS.has(column);
    const conditions = list.map((f) => ({
      filterType: numeric ? 'number' : 'text',
      type: f.condition,
      filter: numeric ? Number(f.value) : f.value,
    }));
    if (numeric && conditions.some((c) => !Number.isFinite(c.filter))) continue;
    model[column] =
      conditions.length === 1
        ? conditions[0]
        : { filterType: numeric ? 'number' : 'text', operator: numeric ? 'AND' : 'OR', conditions: conditions.slice(0, 4) };
  }
  return model;
}

const describeFilter = (f) => {
  const value = f.column === 'atStake' || f.column === 'proposedAmount' ? money(Number(f.value)) : `“${f.value}”`;
  return `${COLUMN_NAMES[f.column]} ${CONDITION_WORDS[f.condition]} ${value}`;
};

// Same grouping as buildFilterModel: "or" within a text column, "and" between columns.
function describeFilters(filters) {
  const byColumn = {};
  for (const filter of filters) (byColumn[filter.column] ??= []).push(filter);
  return Object.entries(byColumn)
    .map(([column, list]) => {
      const joined = list.map(describeFilter).join(NUMBER_COLUMNS.has(column) ? ' and ' : ' or ');
      return list.length > 1 ? `(${joined})` : joined;
    })
    .join(' and ');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ctx: { api, rows, applyEdit, canApprove, setRows, setQuickFilter, setFocus }
// Rows are updated in one go at the end, so a command is a single, undoable change.
export function applyOperations(operations, ctx) {
  const { api, applyEdit, canApprove } = ctx;
  let rows = ctx.rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const changed = new Set();
  const log = [];

  for (const operation of operations) {
    switch (operation.op) {
      case 'filter': {
        const model = buildFilterModel(operation.filters);
        api.setFilterModel(model);
        log.push(`Filtered: ${describeFilters(operation.filters)}`);
        break;
      }
      case 'clear_filters':
        api.setFilterModel(null);
        ctx.setQuickFilter('');
        ctx.setFocus(null);
        log.push('Cleared all filters');
        break;
      case 'focus':
        ctx.setFocus(new Set(operation.rowIds));
        log.push(`Showing ${plural(operation.rowIds.length, 'chosen row')}`);
        break;
      case 'sort':
        api.applyColumnState({ state: [{ colId: operation.column, sort: operation.direction }], defaultState: { sort: null } });
        log.push(`Sorted by ${COLUMN_NAMES[operation.column]} ${operation.direction === 'asc' ? '↑' : '↓'}`);
        break;
      case 'search':
        ctx.setQuickFilter(operation.text);
        log.push(`Searched for “${operation.text}”`);
        break;
      case 'decide': {
        let done = 0;
        let skipped = 0;
        for (const id of operation.rowIds) {
          const row = byId.get(id);
          if (operation.decision === 'approved' && !canApprove(row)) {
            skipped++;
            continue;
          }
          byId.set(id, { ...row, decision: operation.decision });
          changed.add(id);
          done++;
        }
        const verb = { approved: 'Approved', rejected: 'Rejected', pending: 'Reset' }[operation.decision];
        log.push(`${verb} ${plural(done, 'row')}${skipped ? ` (${skipped} skipped: need an action or amount first)` : ''}`);
        break;
      }
      case 'edit': {
        let done = 0;
        let skipped = 0;
        const results = [];
        for (const id of operation.rowIds) {
          const row = byId.get(id);
          let value = operation.value;
          if (operation.field === 'action' && !ACTIONS[row.type].includes(value)) {
            skipped++;
            continue;
          }
          if (operation.field === 'proposedAmount' || operation.field === 'quantity') value = Number(value);
          const edited = applyEdit(row, operation.field, value);
          byId.set(id, edited);
          results.push(edited);
          changed.add(id);
          done++;
        }
        const shown =
          operation.field === 'action' ? ACTION_LABELS[operation.value] ?? operation.value
          : operation.field === 'proposedAmount' ? money(Number(operation.value))
          : operation.field === 'customerMessage' ? 'a new message'
          : operation.value;
        const name = { action: 'action', proposedAmount: 'amount', quantity: 'quantity', customerMessage: 'message' }[operation.field];
        // Report what the money rules actually allowed, not just what was asked for.
        const field = operation.field === 'proposedAmount' ? 'proposedAmount' : 'quantity';
        const adjusted =
          ['proposedAmount', 'quantity'].includes(operation.field) &&
          results.filter((row) => row[field] !== Number(operation.value));
        let note = skipped ? ` (${skipped} skipped: not allowed for that type)` : '';
        if (adjusted?.length) {
          const actual = [...new Set(adjusted.map((row) => (field === 'proposedAmount' ? money(row[field]) ?? 'none' : row[field])))];
          note += ` (limited to ${actual.join(', ')} by the money rules)`;
        }
        log.push(`Asked to set ${name} to ${shown} on ${plural(done, 'row')}${note}`);
        break;
      }
      default:
        break;
    }
  }

  if (changed.size) {
    rows = rows.map((row) => byId.get(row.id));
    ctx.setRows(rows);
  }
  return { log, changed: [...changed] };
}

// Everything a command can change, so one click can put it back.
export const snapshotView = (api, extra) => ({
  filterModel: api.getFilterModel(),
  columnState: api.getColumnState(),
  ...extra,
});

export function restoreView(api, snapshot) {
  api.setFilterModel(snapshot.filterModel ?? null);
  api.applyColumnState({ state: snapshot.columnState, applyOrder: true });
}

export const SUGGESTIONS = [
  'Show refunds and disputes over $30',
  'Approve all the reorders',
  'Reject refunds the AI declined',
  'Sort by amount at stake, biggest first',
  'Show only high risk',
  `Set ${TYPE_LABELS.low_stock.toLowerCase()} quantities to 10 packs`,
];
