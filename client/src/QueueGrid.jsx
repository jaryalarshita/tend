import { forwardRef, useCallback, useEffect, useMemo, useRef } from 'react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { ACTION_LABELS, ACTIONS, AMOUNT_EDITABLE } from '../../shared/actions.js';
import { evidenceSummary, money } from './format.js';

// AG Grid Community, registered once. Every feature used here is in the free edition.
ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: '#0f766e',
  fontFamily: 'inherit',
  headerFontWeight: 600,
  headerBackgroundColor: '#f6f7f5',
  rowHoverColor: '#f2f7f6',
  selectedRowBackgroundColor: '#e6f2f0',
  wrapperBorderRadius: 10,
  spacing: 7,
});

// Done in PayPal: nothing about the row can change any more.
export const isLocked = (row) => row?.result?.status === 'done';
export const canApprove = (row) => !isLocked(row) && row.action !== 'review' && row.proposedAmount != null;

const RESULT_BADGES = {
  done: { text: '✓ Done', className: 'badge-done' },
  awaiting_payment: { text: 'Pay…', className: 'badge-awaiting' },
};

function DecisionCell({ data, node, context }) {
  if (node.rowPinned) return null;
  const badge = RESULT_BADGES[data.result?.status];
  if (badge) {
    return (
      <span className={`result-badge ${badge.className}`} title={data.result.detail}>
        {badge.text}
      </span>
    );
  }
  const { decision } = data;
  const approvable = canApprove(data);
  return (
    <div className="decision">
      <button
        type="button"
        className={`decision-btn approve${decision === 'approved' ? ' on' : ''}`}
        disabled={!approvable}
        title={approvable ? 'Approve' : 'Pick an action and amount first'}
        aria-label={`Approve ${data.customer}`}
        onClick={(event) => {
          event.stopPropagation();
          context.setDecision([data.id], decision === 'approved' ? 'pending' : 'approved');
        }}
      >
        ✓
      </button>
      <button
        type="button"
        className={`decision-btn reject${decision === 'rejected' ? ' on' : ''}`}
        title="Reject"
        aria-label={`Reject ${data.customer}`}
        onClick={(event) => {
          event.stopPropagation();
          context.setDecision([data.id], decision === 'rejected' ? 'pending' : 'rejected');
        }}
      >
        ✕
      </button>
    </div>
  );
}

function TypeCell({ data, node }) {
  if (node.rowPinned) return null;
  return <span className={`badge type-${data.type}`}>{data.typeLabel}</span>;
}

function RiskCell({ value, node }) {
  if (node.rowPinned || !value) return null;
  return <span className={`pill risk-${value}`}>{value}</span>;
}

// A plain <select> changes the action in one click, offering only this row's actions.
function ActionCell({ value, data, node, context }) {
  if (node.rowPinned) return null;
  return (
    <select
      className={`action-select${value === 'review' ? ' needs-review' : ''}`}
      value={value}
      disabled={isLocked(data)}
      aria-label={`Action for ${data.customer}`}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => context.onEdit(data.id, 'action', event.target.value)}
    >
      {ACTIONS[data.type].map((action) => (
        <option key={action} value={action}>
          {ACTION_LABELS[action]}
        </option>
      ))}
    </select>
  );
}

function AmountCell({ value, data, node }) {
  if (node.rowPinned) return <strong>{money(value)}</strong>;
  if (value == null) return <span className="set-amount">Set amount</span>;
  const editable = AMOUNT_EDITABLE.has(data.action);
  return (
    <span className={editable ? 'editable-value' : ''} title={editable ? 'Double-click to change' : undefined}>
      {value === 0 ? '—' : money(value)}
    </span>
  );
}

// The underline goes on the text, not the cell: borders on AG Grid's absolutely
// positioned cells drift and repaint when the page is zoomed.
function QuantityCell({ value, data, node }) {
  if (node.rowPinned || value == null) return null;
  return (
    <span className={data.action === 'reorder' ? 'editable-value' : ''} title="Double-click to change">
      {value}
    </span>
  );
}

function ReasonCell({ data, node }) {
  if (node.rowPinned) return null;
  return (
    <div className="reason">
      {data.result && (
        <span className={`tag result-tag result-${data.result.status}`} title={data.result.detail}>
          {data.result.status === 'failed' ? `Failed: ${data.result.detail}` : data.result.detail}
        </span>
      )}
      {data.source === 'rules' && <span className="tag">Rules</span>}
      {data.source === 'cached' && (
        <span className="tag" title="Gemini was busy, so this is its earlier review of the same item.">
          Earlier
        </span>
      )}
      {data.warnings?.length > 0 && <span className="warn" title={data.warnings.join('\n')}>⚠</span>}
      <span>{data.reason}</span>
    </div>
  );
}

const columnDefs = [
  {
    field: 'decision',
    headerName: 'Decision',
    width: 100,
    pinned: 'left',
    sortable: false,
    cellRenderer: DecisionCell,
    // Whether Approve is enabled depends on the action and amount too, so redraw this
    // cell whenever its row changes, not only when the decision does.
    equals: () => false,
    filter: 'agTextColumnFilter',
    suppressHeaderFilterButton: true,
  },
  { field: 'typeLabel', headerName: 'Type', width: 152, cellRenderer: TypeCell, filter: 'agTextColumnFilter' },
  { field: 'customer', width: 160, filter: 'agTextColumnFilter', suppressHeaderFilterButton: true },
  {
    field: 'atStake',
    headerName: 'At stake',
    width: 120,
    type: 'rightAligned',
    filter: 'agNumberColumnFilter',
    valueFormatter: ({ value }) => (value == null ? '—' : money(value)),
  },
  {
    colId: 'evidence',
    headerName: 'Evidence',
    flex: 2,
    minWidth: 140,
    valueGetter: ({ data, node }) => (node.rowPinned ? '' : evidenceSummary(data)),
    tooltipValueGetter: ({ value }) => value,
    filter: 'agTextColumnFilter',
    suppressHeaderFilterButton: true,
  },
  {
    field: 'action',
    headerName: 'Action ✎',
    headerTooltip: 'Pick a different action from the menu. Only actions that fit the row are listed.',
    width: 156,
    // Shown, filtered and searched by its label ("Partial refund"), stored as the action key.
    refData: ACTION_LABELS,
    // The menu locks once the row is done in PayPal, so redraw on any row change.
    equals: () => false,
    filterValueGetter: ({ data }) => ACTION_LABELS[data.action],
    getQuickFilterText: ({ data }) => ACTION_LABELS[data.action],
    cellRenderer: ActionCell,
    filter: 'agTextColumnFilter',
  },
  {
    field: 'proposedAmount',
    headerName: 'Amount ✎',
    headerTooltip: 'Editable for partial refunds and dispute offers, up to what PayPal says was paid.',
    width: 114,
    type: 'rightAligned',
    editable: ({ data, node }) => !node.rowPinned && !isLocked(data) && AMOUNT_EDITABLE.has(data.action),
    cellEditor: 'agNumberCellEditor',
    cellEditorParams: { min: 0, precision: 2 },
    cellRenderer: AmountCell,
    filter: 'agNumberColumnFilter',
    suppressHeaderFilterButton: true,
  },
  {
    field: 'quantity',
    width: 72,
    type: 'rightAligned',
    editable: ({ data, node }) => !node.rowPinned && !isLocked(data) && data.action === 'reorder',
    cellEditor: 'agNumberCellEditor',
    cellEditorParams: { min: 1, precision: 0 },
    cellRenderer: QuantityCell,
    filter: 'agNumberColumnFilter',
    suppressHeaderFilterButton: true,
    headerName: 'Qty ✎',
    headerTooltip: 'Editable for reorders. The price always comes from the catalog.',
  },
  { field: 'risk', width: 96, cellRenderer: RiskCell, filter: 'agTextColumnFilter' },
  {
    field: 'reason',
    headerName: 'Why (AI reasoning)',
    flex: 3,
    minWidth: 200,
    cellRenderer: ReasonCell,
    // Also shows the PayPal result, so redraw on any row change, not only a new reason.
    equals: () => false,
    tooltipField: 'reason',
    filter: 'agTextColumnFilter',
    suppressHeaderFilterButton: true,
  },
];

// Up to four conditions per column, so the agent can ask for "refunds or disputes".
const defaultColDef = { resizable: true, sortable: true, filterParams: { maxNumConditions: 4 } };

const rowClassRules = {
  'row-approved': ({ data, node }) => !node.rowPinned && data?.decision === 'approved',
  'row-rejected': ({ data, node }) => !node.rowPinned && data?.decision === 'rejected',
  'row-done': ({ data, node }) => !node.rowPinned && data?.result?.status === 'done',
  'row-failed': ({ data, node }) => !node.rowPinned && data?.result?.status === 'failed',
};

const rowSelection = { mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false };

const QueueGrid = forwardRef(function QueueGrid(
  { rows, quickFilter, focusIds, onEdit, onSelectRow, setDecision, onFilterChanged },
  ref,
) {
  // "Focus" shows only rows the agent picked by ID, through AG Grid's external filter.
  // The callbacks read a ref so they stay stable; the grid is told when the set changes.
  const focusRef = useRef(focusIds);
  focusRef.current = focusIds;
  const isExternalFilterPresent = useCallback(() => focusRef.current != null, []);
  const doesExternalFilterPass = useCallback((node) => focusRef.current?.has(node.data.id) ?? true, []);
  useEffect(() => {
    ref.current?.api?.onFilterChanged();
  }, [focusIds, ref]);

  const pinnedBottomRowData = useMemo(() => {
    const approved = rows.filter((row) => row.decision === 'approved');
    const sum = (list, key) => Math.round(list.reduce((total, row) => total + (row[key] ?? 0) * 100, 0)) / 100;
    return [
      {
        id: 'totals',
        customer: `Total · ${approved.length}/${rows.length} approved`,
        atStake: sum(rows, 'atStake'),
        proposedAmount: sum(approved, 'proposedAmount'),
      },
    ];
  }, [rows]);

  return (
    <AgGridReact
      ref={ref}
      theme={theme}
      rowData={rows}
      columnDefs={columnDefs}
      defaultColDef={defaultColDef}
      getRowId={({ data }) => data.id}
      context={{ setDecision, onEdit }}
      rowClassRules={rowClassRules}
      rowSelection={rowSelection}
      selectionColumnDef={{ pinned: 'left', width: 48 }}
      pinnedBottomRowData={pinnedBottomRowData}
      quickFilterText={quickFilter}
      isExternalFilterPresent={isExternalFilterPresent}
      doesExternalFilterPass={doesExternalFilterPass}
      readOnlyEdit
      onCellEditRequest={({ data, colDef, newValue }) => onEdit(data.id, colDef.field, newValue)}
      onRowClicked={({ data, node }) => !node.rowPinned && onSelectRow(data.id)}
      onFilterChanged={onFilterChanged}
      singleClickEdit={false}
      tooltipShowDelay={400}
      domLayout="autoHeight"
      // Fixed heights and no row animation: measured heights and 0.4 s row slides made
      // some rows trail behind when the page was zoomed.
      rowHeight={40}
      headerHeight={42}
      animateRows={false}
    />
  );
});

export default QueueGrid;
