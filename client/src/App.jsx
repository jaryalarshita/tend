import { useEffect, useMemo, useState } from 'react';
import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';

// AG Grid Community, registered once. Every feature Tend uses is in the free edition.
ModuleRegistry.registerModules([AllCommunityModule]);

const columnDefs = [
  { field: 'check', flex: 2 },
  {
    field: 'status',
    flex: 1,
    cellStyle: (params) => ({ color: params.value === 'Ready' ? '#15803d' : '#b45309', fontWeight: 600 }),
  },
  { field: 'fix', headerName: 'How to fix', flex: 3 },
];

export default function App() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        return res.json();
      })
      .then(setHealth)
      .catch((err) => setError(err.message));
  }, []);

  const rows = useMemo(() => {
    if (!health) return [];
    return [
      {
        check: 'PayPal sandbox keys',
        status: health.paypalConfigured ? 'Ready' : 'Missing',
        fix: health.paypalConfigured ? '' : 'Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env',
      },
      {
        check: 'Gemini API key',
        status: health.geminiConfigured ? 'Ready' : 'Missing',
        fix: health.geminiConfigured ? '' : 'Add GEMINI_API_KEY to .env',
      },
    ];
  }, [health]);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '3rem auto', maxWidth: 800, padding: '0 1rem' }}>
      <h1>Tend</h1>
      <p>An AI back office for PayPal sellers. You approve, Tend acts.</p>
      {error && <p role="alert">Could not reach the API: {error}</p>}
      <div style={{ height: 160 }}>
        <AgGridReact theme={themeQuartz} rowData={rows} columnDefs={columnDefs} domLayout="normal" />
      </div>
    </main>
  );
}
