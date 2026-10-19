import { APIRequestContext, expect, Page, request, test } from '@playwright/test';
import fs from 'node:fs';
import { API_PORT } from '../playwright.config';

/**
 * One end-to-end story, run in order against an empty installation:
 * register -> device -> telemetry -> maintenance -> out of service -> alert -> prediction ->
 * upload a document -> ask about it -> ask about live data -> privacy between users -> reports -> audit log.
 */
test.describe.configure({ mode: 'serial' });

const API = `http://localhost:${API_PORT}/api`;
const ADMIN = { name: 'E2E Admin', email: 'e2e-admin@example.test', password: 'e2e-admin-password-1' };
const VIEWER = { name: 'E2E Viewer', email: 'e2e-viewer@example.test', password: 'e2e-viewer-password-1' };
const TAG = 'KX' + Date.now().toString(36).toUpperCase();
const DEVICE = `Pump E2E ${TAG}`;
const MANUAL = `# Coolant Pump Manual ${TAG}\n\nThe coolant pump ${TAG} must be flushed every 750 operating hours using grade C fluid.\n\nTorque the housing bolts to 45 Nm.\n`;

let api: APIRequestContext;
let adminToken = '';
let viewerToken = '';
let device: { id: string; apiKey: string };

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function sendTelemetry(body: Record<string, number>) {
  const r = await api.post(`${API}/telemetry`, { headers: { 'x-api-key': device.apiKey }, data: body });
  expect(r.status()).toBe(202);
}

async function ask(page: Page, question: string) {
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(question);
  await box.press('Enter');
}

test.beforeAll(async () => { api = await request.newContext(); });
test.afterAll(async () => { await api.dispose(); });

test('01 the first account registered becomes the administrator', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Name').fill(ADMIN.name);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel(/^Password/).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Administrator')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fleet overview' })).toBeVisible();
  adminToken = await page.evaluate(() => localStorage.getItem('iot-token') ?? '');
  expect(adminToken).not.toBe('');
});

test('02 an empty installation shows a usable dashboard', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Fleet overview' })).toBeVisible();
  await expect(page.getByText('Application error')).toHaveCount(0);
});

test('03 a device is registered and reports telemetry', async ({ page }) => {
  const created = await api.post(`${API}/devices`, { headers: auth(adminToken), data: { name: DEVICE, type: 'Smart Sensor', firmwareVersion: '1.0.0', location: 'Lab' } });
  expect(created.status()).toBe(201);
  device = await created.json();
  for (let i = 0; i < 6; i++) await sendTelemetry({ temperature: 40 + i * 0.2, cpu: 30, memory: 45 });
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  await page.goto(`/devices/${device.id}`);
  await expect(page.getByRole('heading', { name: DEVICE })).toBeVisible();
  await expect(page.getByText('online', { exact: true }).first()).toBeVisible();
});

test('04 an administrator records maintenance on the device', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  await page.goto(`/devices/${device.id}`);
  await page.getByRole('button', { name: 'Add entry' }).click();
  await page.getByLabel('Summary').fill('Replaced coolant pump');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Replaced coolant pump')).toBeVisible();
});

test('05 a device can be taken out of service and brought back without losing anything', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  page.on('dialog', (d) => void d.accept());
  await page.goto(`/devices/${device.id}`);
  await page.getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByText('deactivated', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reactivate' }).click();
  await expect(page.getByRole('button', { name: 'Deactivate' })).toBeVisible();
  await expect(page.getByText('Replaced coolant pump')).toBeVisible(); // history survived
});

test('06 a threshold breach opens an alert', async ({ page }) => {
  await sendTelemetry({ cpu: 99 });
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  await page.goto('/alerts');
  const row = page.getByRole('row').filter({ hasText: DEVICE }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/critical/i);
});

test('07 rising readings produce stored predictions and a risk ranking', async ({ page }) => {
  for (let i = 0; i < 30; i++) await sendTelemetry({ temperature: 55 + i * 0.9, cpu: 30 });
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  await page.goto('/anomaly');
  await expect(page.getByRole('heading', { name: 'Anomaly prediction' })).toBeVisible();
  await expect(page.getByText(DEVICE).first()).toBeVisible();
  const history = await api.get(`${API}/anomaly/history?deviceId=${device.id}`, { headers: auth(adminToken) });
  expect((await history.json()).length).toBeGreaterThan(0);
});

test('08 a document is uploaded and indexed', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  await page.goto('/knowledge');
  await page.getByLabel('Choose documents to upload').setInputFiles({ name: `manual-${TAG}.md`, mimeType: 'text/markdown', buffer: Buffer.from(MANUAL) });
  const row = page.getByRole('row').filter({ hasText: `manual-${TAG}.md` });
  await expect(row).toBeVisible();
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 30_000 });
});

test('09 the assistant answers from the document and cites it', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  await page.goto('/assistant');
  await ask(page, `How often must the coolant pump ${TAG} be flushed?`);
  const answer = page.locator('.msg.assistant .bubble').last();
  await expect(answer).toContainText('750', { timeout: 60_000 });
  await expect(answer.getByRole('button', { name: 'Source S1' })).toBeVisible();
  await answer.getByRole('button', { name: /cited/ }).click();
  await expect(page.locator('.source.cited').first()).toContainText(`manual-${TAG}.md`);
});

test('10 the assistant answers a live-data question from the database', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  await page.goto('/assistant');
  await ask(page, 'How many devices are currently online?');
  const answer = page.locator('.msg.assistant .bubble').last();
  await expect(answer.locator('.tool', { hasText: 'Fleet status' })).toBeVisible({ timeout: 60_000 });
  await expect(answer.getByRole('button', { name: 'Source D1' }).first()).toBeVisible({ timeout: 60_000 });
});

test('11 another user cannot see or retrieve a private document', async () => {
  const reg = await api.post(`${API}/auth/register`, { data: VIEWER });
  expect(reg.status()).toBe(201);
  viewerToken = (await reg.json()).token;
  const docs = await (await api.get(`${API}/knowledge`, { headers: auth(viewerToken) })).json();
  expect(docs.some((d: { originalName: string }) => d.originalName === `manual-${TAG}.md`)).toBe(false);

  const conv = await (await api.post(`${API}/assistant/conversations`, { headers: auth(viewerToken), data: {} })).json();
  const res = await api.post(`${API}/assistant/conversations/${conv.id}/messages`, { headers: auth(viewerToken), data: { content: `How often must the coolant pump ${TAG} be flushed?` } });
  expect(await res.text()).not.toContain('750');
  // and viewers cannot change anything
  const change = await api.post(`${API}/devices`, { headers: auth(viewerToken), data: { name: 'x-viewer', type: 'Smart Sensor', firmwareVersion: '1.0.0' } });
  expect(change.status()).toBe(403);
});

test('12 reports download as CSV and PDF with simulated data marked', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  await page.goto('/reports');
  await page.getByRole('button', { name: /Device health/ }).click();
  await expect(page.getByRole('table')).toContainText(DEVICE);

  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV' }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^device-health-.*\.csv$/);
  const csvText = fs.readFileSync((await csv.path())!, 'utf8');
  expect(csvText).toContain('Simulated');
  expect(csvText).toContain(DEVICE);

  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF' }).click()]);
  expect(fs.readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe('%PDF-');
});

test('13 the audit log records the activity (administrators only)', async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('iot-token', t), adminToken);
  await page.goto('/audit');
  await expect(page.getByText('kb.upload').first()).toBeVisible();
  await expect(page.getByText('report.export').first()).toBeVisible();
  await expect(page.getByText('assistant.tool').first()).toBeVisible();
  // a viewer is turned away from the same page
  await page.evaluate((t) => localStorage.setItem('iot-token', t), viewerToken);
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Audit log' })).toHaveCount(0);
});
