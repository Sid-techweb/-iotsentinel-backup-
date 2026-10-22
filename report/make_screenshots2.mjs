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

// ------------------------------------------------------------------ second pass: assistant and remaining screens
const login = await api('POST', '/auth/login', null, { email: ADMIN.email, password: ADMIN.password });
const token = login.token;
const devices = await api('GET', '/devices', token);
const pump = devices.find((d) => d.type === 'Pump Station');
const cnc = devices.find((d) => d.type === 'CNC Machine');
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.25 });
await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'light'); } catch { /* ignore */ } });
await ctx.addInitScript((t) => { try { localStorage.setItem('iot-token', t); } catch { /* ignore */ } }, token);
const page = await ctx.newPage();
const shot = async (name, opts = {}) => { await sleep(opts.wait ?? 1800); await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: !!opts.full }); console.log('saved', name); };
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
await ask('Which machine types have the most threshold breaches?', '14-assistant-live-data', true);
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
