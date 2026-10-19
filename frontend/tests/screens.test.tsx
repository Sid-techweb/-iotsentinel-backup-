import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth';
import { setToken } from '../src/api';
import { LoginPage } from '../src/pages/AuthPages';
import Rules from '../src/pages/Rules';

interface Call { method: string; url: string; body?: any }
let calls: Call[] = [];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const rule = (id: number, metric: string, severity: string, threshold: number, deviceType: string | null, inherited = false) =>
  ({ id, metric, operator: '>', threshold, severity, enabled: true, deviceType, inherited });

function mockApi(user: { role: 'admin' | 'viewer' } | null = { role: 'admin' }) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/auth/me') return user ? json({ id: 'u1', email: 'a@b.c', name: 'Ada', role: user.role }) : json({ error: 'no' }, 401);
    if (url === '/api/auth/login') return body.password === 'right-password' ? json({ token: 'tok', user: { id: 'u1', email: body.email, name: 'Ada', role: 'admin' } }) : json({ error: 'Incorrect email or password' }, 401);
    if (url === '/api/device-types') return json([{ id: 1, name: 'Gateway', metrics: ['cpu'], deviceCount: 1 }, { id: 2, name: 'CNC Machine', metrics: ['cpu', 'vibration'], deviceCount: 1 }]);
    if (url.startsWith('/api/rules?deviceType=CNC')) return json([rule(1, 'cpu', 'warning', 85, null, true), rule(2, 'vibration', 'warning', 6, 'CNC Machine', false)]);
    if (url === '/api/rules') return json([rule(1, 'cpu', 'warning', 85, null), rule(3, 'cpu', 'critical', 95, null)]);
    if (url.startsWith('/api/rules/')) return json({});
    return json({});
  }));
}

function renderWithProviders(ui: React.ReactNode, route = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={ui} />
            <Route path="/login" element={ui} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { calls = []; setToken('tok'); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe('sign-in screen', () => {
  it('signs in with valid credentials', async () => {
    setToken(null);
    mockApi(null);
    renderWithProviders(<LoginPage />, '/login');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'right-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/login')).toBe(true));
    expect(calls.find((c) => c.url === '/api/auth/login')!.body).toEqual({ email: 'ada@example.com', password: 'right-password' });
  });

  it('shows the server’s message for wrong credentials and does not sign in', async () => {
    setToken(null);
    mockApi(null);
    renderWithProviders(<LoginPage />, '/login');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password');
  });
});

describe('alert rules screen', () => {
  it('lists the default limits and saves an edit to a default rule', async () => {
    mockApi();
    renderWithProviders(<Rules />);
    const input = await screen.findByLabelText('CPU load warning threshold');
    expect(input).toHaveValue('85');

    await userEvent.clear(input);
    await userEvent.type(input, '80');
    await userEvent.tab();
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/rules/1');
    expect(put.body).toEqual({ threshold: 80 });
  });

  it('creates a machine-type override when an inherited limit is edited, and marks existing overrides', async () => {
    mockApi();
    renderWithProviders(<Rules />);
    await screen.findByLabelText('CPU load warning threshold');
    await userEvent.selectOptions(screen.getByLabelText('Machine type scope'), 'CNC Machine');

    const cpu = await screen.findByLabelText('CPU load warning threshold');
    const vibRow = screen.getByLabelText('Vibration warning threshold').closest('tr')!;
    expect(within(vibRow).getByText('override')).toBeInTheDocument();
    expect(within(cpu.closest('tr')!).getByText('default')).toBeInTheDocument();

    await userEvent.clear(cpu);
    await userEvent.type(cpu, '70');
    await userEvent.tab();
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/rules/override')).toBe(true));
    expect(calls.find((c) => c.url === '/api/rules/override')!.body).toEqual({ deviceType: 'CNC Machine', metric: 'cpu', severity: 'warning', threshold: 70 });
  });

  it('locks editing for read-only accounts', async () => {
    mockApi({ role: 'viewer' });
    renderWithProviders(<Rules />);
    expect(await screen.findByLabelText('CPU load warning threshold')).toBeDisabled();
  });

  it('ignores a non-numeric entry', async () => {
    mockApi();
    renderWithProviders(<Rules />);
    const input = await screen.findByLabelText('CPU load warning threshold');
    await userEvent.clear(input);
    await userEvent.type(input, 'abc');
    await userEvent.tab();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(input).toHaveValue('85'); // reverted
  });
});
