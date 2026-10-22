// Captures real screenshots of the running application for the project report.
// Uses an isolated demo instance (API :4200, UI :5175, own databases) - never the real data.
import { chromium } from '../e2e/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const API = 'http://localhost:4200/api';
const WEB = 'http://localhost:5175';
const OUT = path.resolve('report/screens');
fs.mkdirSync(OUT, { recursive: true });
const ADMIN = { name: 'Siddharth S', email: 'admin@iot-sentinel.demo', password: 'report-demo-pass-1' };
const VIEWER = { name: 'Maintenance Viewer', email: 'viewer@iot-sentinel.demo', password: 'report-demo-pass-2' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, token, body, isForm) {
  const res = await fetch(API + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 200)}`);
  return json;
}

// ------------------------------------------------------------------ data
const reg = await api('POST', '/auth/register', null, ADMIN);
const token = reg.token;
await api('POST', '/auth/register', null, VIEWER);
const devices = await api('GET', '/devices', token);
const byType = (t) => devices.filter((d) => d.type === t);
const pump = byType('Pump Station')[0];
const cnc = byType('CNC Machine')[0];
console.log('devices', devices.length, 'pump', pump?.name, 'cnc', cnc?.name);

for (const d of [pump, cnc]) {
  try { await api('POST', '/simulator/inject-fault', token, { deviceId: d.id }); } catch (e) { console.log('fault:', e.message); }
}
const maint = [
  [pump, 'inspection', 'Quarterly bearing inspection', 'Vibration 4.1 mm/s at drive end - within limit.'],
  [pump, 'calibration', 'Discharge pressure sensor calibrated', 'Calibrated against reference gauge, error 0.02 bar.'],
  [cnc, 'repair', 'Spindle coolant hose replaced', 'Replaced a worn hose; leak test passed.'],
];
for (const [d, kind, summary, details] of maint) await api('POST', `/devices/${d.id}/maintenance`, token, { kind, summary, details });

// knowledge-base documents
for (const [file, type] of [['docs/demo/pump-maintenance-manual.md', 'text/markdown'], ['docs/demo/inspection-log.csv', 'text/csv']]) {
  const form = new FormData();
  form.append('visibility', 'shared');
  form.append('file', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  try { await api('POST', '/knowledge', token, form, true); } catch (e) { console.log('upload:', e.message); }
}
console.log('waiting for documents to be indexed and the simulator to produce activity...');
for (let i = 0; i < 40; i++) {
  const docs = await api('GET', '/knowledge', token);
  if (docs.filter((d) => d.source === 'upload').every((d) => d.status === 'ready')) break;
  await sleep(3000);
}
await sleep(60_000);

// ------------------------------------------------------------------ screenshots
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'light'); } catch { /* ignore */ } });
const page = await ctx.newPage();
const shot = async (name, opts = {}) => { await sleep(opts.wait ?? 1800); await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: !!opts.full }); console.log('saved', name); };

// signed-out screens
await page.goto(`${WEB}/login`); await shot('01-login');
await page.goto(`${WEB}/register`); await shot('02-register');

// signed-in screens
await ctx.addInitScript((t) => { try { localStorage.setItem('iot-token', t); } catch { /* ignore */ } }, token);
await page.goto(`${WEB}/`); await shot('03-dashboard', { wait: 3500 });
await page.goto(`${WEB}/devices`); await shot('04-devices');
await page.goto(`${WEB}/devices/${pump.id}`); await shot('05-device-detail', { wait: 3500, full: true });
await page.goto(`${WEB}/alerts`); await shot('06-alerts');
await page.goto(`${WEB}/anomaly`); await shot('07-anomaly-prediction', { wait: 3500, full: true });
await page.goto(`${WEB}/activity`); await shot('08-activity', { wait: 3000, full: true });
await page.goto(`${WEB}/types`); await shot('09-machine-types');
await page.goto(`${WEB}/rules`); await shot('10-alert-rules');
await page.goto(`${WEB}/firmware`); await shot('11-firmware');
await page.goto(`${WEB}/incidents`); await shot('12-incidents');
await page.goto(`${WEB}/knowledge`); await shot('13-knowledge-base', { wait: 2500, full: true });

// assistant: one live-data question, one document question
await page.goto(`${WEB}/assistant`); await sleep(2500);
const ask = async (q, file, expand) => {
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(q); await box.press('Enter');
  const last = page.locator('.msg.assistant .bubble').last();
  await last.getByRole('button', { name: /Copy answer/ }).waitFor({ timeout: 180_000 });
  if (expand) { await last.getByRole('button', { name: /cited/ }).click().catch(() => {}); }
  await shot(file, { wait: 1200 });
};
await ask('Which devices need maintenance attention?', '14-assistant-live-data', true);
await ask('What does the pump manual say about bearing inspection?', '15-assistant-document-answer', true);

await page.goto(`${WEB}/reports`); await shot('16-reports', { wait: 2500 });
await page.goto(`${WEB}/audit`); await shot('17-audit-log', { wait: 2500 });
await page.goto(`${WEB}/users`); await shot('18-users');

// the explanation panel on the device page, scrolled into view
await page.goto(`${WEB}/devices/${cnc.id}`); await sleep(3500);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await shot('19-device-explanation', { wait: 1500 });
await browser.close();
console.log('done');
