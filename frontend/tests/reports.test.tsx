import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth';
import { setToken } from '../src/api';
import { Toaster } from '../src/components/ui';
import Reports from '../src/pages/Reports';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
let calls: string[] = [];

const CATALOGUE = [
  { id: 'device-health', title: 'Device health', description: 'Status and risk', uses: ['device', 'machineType', 'simulated'], note: null },
  { id: 'alert-history', title: 'Alert history', description: 'All alerts', uses: ['range', 'device', 'machineType', 'simulated'], note: null },
];
const preview = (id: string, rows: object[] = []) => ({
  report: { id, title: id }, generatedAt: new Date().toISOString(), total: rows.length, scope: { devices: 2, simulatedDevices: 1 },
  notes: ['Rows marked simulated come from the built-in device simulator, not from physical equipment. 1 of 2 devices in scope are simulated.'],
  columns: [{ key: 'deviceName', header: 'Device' }, { key: 'simulated', header: 'Simulated', fmt: 'bool' }], rows,
});

function mock(rows: object[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = String(input);
    calls.push(url);
    if (url === '/api/auth/me') return json({ id: 'u1', email: 'a@b.c', name: 'Ada', role: 'viewer' });
    if (url === '/api/reports') return json(CATALOGUE);
    if (url.startsWith('/api/reports/device-health/csv') || url.startsWith('/api/reports/device-health/pdf')) return new Response('x', { status: 200 });
    if (url.startsWith('/api/reports/alert-history')) return json(preview('alert-history', []));
    if (url.startsWith('/api/reports/device-health')) return json(preview('device-health', rows));
    if (url === '/api/device-types') return json([{ id: 1, name: 'Smart Sensor' }]);
    if (url === '/api/devices') return json([]);
    return json({});
  }));
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><AuthProvider><Reports /><Toaster /></AuthProvider></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { calls = []; setToken('tok'); URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn(); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe('Reports page', () => {
  it('lists the reports and previews the selected one, marking simulated devices', async () => {
    mock([{ deviceName: 'Pump 1', simulated: true }, { deviceName: 'Pump 2', simulated: false }]);
    renderPage();
    expect(await screen.findByText('Pump 1')).toBeInTheDocument();
    expect(screen.getByText('sim')).toBeInTheDocument();
    expect(screen.getByText(/built-in device simulator/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alert history/ })).toBeInTheDocument();
  });

  it('shows an empty state when no rows match', async () => {
    mock([]);
    renderPage();
    expect(await screen.findByText('No rows match these filters.')).toBeInTheDocument();
  });

  it('sends the chosen filters and switches reports', async () => {
    mock([]);
    renderPage();
    await screen.findByText('No rows match these filters.');
    await userEvent.click(screen.getByRole('button', { name: /Alert history/ }));
    await waitFor(() => expect(calls.some((c) => c.startsWith('/api/reports/alert-history?from='))).toBe(true));
    await userEvent.click(screen.getByLabelText('Include simulated devices'));
    await waitFor(() => expect(calls.some((c) => c.includes('includeSimulated=false'))).toBe(true));
  });

  it('downloads CSV and PDF using the same filters', async () => {
    mock([{ deviceName: 'Pump 1', simulated: false }]);
    renderPage();
    await screen.findByText('Pump 1');
    await userEvent.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(calls).toContain('/api/reports/device-health/csv'));
    await userEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(calls).toContain('/api/reports/device-health/pdf'));
  });

  it('offers to explain the report with the assistant', async () => {
    mock([]);
    renderPage();
    const link = await screen.findByRole('link', { name: /Explain with assistant/ });
    expect(link.getAttribute('href')).toMatch(/^\/assistant\?q=/);
    await waitFor(() => expect(decodeURIComponent(screen.getByRole('link', { name: /Explain with assistant/ }).getAttribute('href')!)).toContain('device health'));
  });
});
