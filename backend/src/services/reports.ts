import PDFDocument from 'pdfkit';
import { Response } from 'express';
import { config } from '../config';
import { q, q1 } from '../db';
import { csvBody, csvHeader } from '../util';
import { listDocuments, Viewer } from './kb/store';

/**
 * Reports. Every report is one SQL query (parameterised) plus column metadata, so the same definition drives the
 * on-screen preview, the CSV export and the PDF export. Large reports are read in keyset-paginated batches and
 * streamed, so memory use does not grow with the number of rows.
 */
export interface Filters { from: Date; to: Date; deviceId?: string; machineType?: string; includeSimulated: boolean }
export type Col = { key: string; header: string; weight?: number; fmt?: 'time' | 'num1' | 'pct' | 'bool' };
type Params = unknown[];
interface Built { sql: string; params: Params; summary?: (f: Filters) => Promise<{ label: string; value: string | number }[]> }

export interface ReportDef {
  id: string;
  title: string;
  description: string;
  /** which filters the report honours */
  uses: ('range' | 'device' | 'machineType' | 'simulated')[];
  /** an honest caveat printed with the report */
  note?: string;
  columns: Col[];
  /** True when the rows describe devices (so simulated data can be marked). */
  hasSimulated: boolean;
  build(f: Filters, viewer: Viewer): Built | null;
}

const ph = (params: Params, v: unknown) => { params.push(v); return `$${params.length}`; };

/** Device-scope predicate shared by all device-related reports. */
function deviceWhere(f: Filters, params: Params, alias = 'd'): string[] {
  const w: string[] = [];
  if (f.deviceId) w.push(`${alias}.id = ${ph(params, f.deviceId)}`);
  if (f.machineType) w.push(`${alias}.type = ${ph(params, f.machineType)}`);
  if (!f.includeSimulated) w.push(`${alias}.simulated = false`);
  return w;
}
const range = (col: string, f: Filters, params: Params) => `${col} >= ${ph(params, f.from)} AND ${col} < ${ph(params, f.to)}`;
const where = (parts: string[]) => (parts.length ? `WHERE ${parts.join(' AND ')}` : '');

const DEVICE_COLS: Col[] = [
  { key: 'assetNo', header: 'Asset #', weight: 0.7 }, { key: 'deviceName', header: 'Device', weight: 1.6 }, { key: 'deviceType', header: 'Machine type', weight: 1.4 },
  { key: 'simulated', header: 'Simulated', weight: 0.8, fmt: 'bool' },
];

const METRICS = ['temperature', 'cpu', 'memory', 'battery', 'signal', 'vibration', 'pressure', 'current'];

export const REPORTS: ReportDef[] = [
  {
    id: 'device-health',
    title: 'Device health',
    description: 'Current status, latest readings, open alerts and predicted risk for every device.',
    uses: ['device', 'machineType', 'simulated'],
    note: 'Risk is the model\'s probability that a configured threshold will be crossed soon. It is not a prediction of equipment failure.',
    hasSimulated: true,
    columns: [
      ...DEVICE_COLS, { key: 'status', header: 'Status', weight: 0.9 }, { key: 'active', header: 'In service', weight: 0.8, fmt: 'bool' },
      { key: 'firmware', header: 'Firmware', weight: 0.9 }, { key: 'lastSeen', header: 'Last seen', weight: 1.5, fmt: 'time' }, { key: 'openAlerts', header: 'Open alerts', weight: 0.8 },
      ...METRICS.map((m) => ({ key: m, header: m[0].toUpperCase() + m.slice(1), weight: 0.8, fmt: 'num1' as const })),
      { key: 'riskLevel', header: 'Risk level', weight: 0.9 }, { key: 'riskMetric', header: 'Risk metric', weight: 0.9 }, { key: 'riskProbability', header: 'Risk %', weight: 0.7, fmt: 'pct' },
    ],
    build(f) {
      const params: Params = [];
      const w = where(deviceWhere(f, params));
      return {
        params,
        sql: `SELECT d.asset_no AS sort_key, d.asset_no, d.name AS device_name, d.type AS device_type, d.simulated, d.status, d.active, d.firmware_version AS firmware, d.last_seen,
                     (SELECT count(*)::int FROM alerts a WHERE a.device_id = d.id AND a.status = 'open') AS open_alerts,
                     ${METRICS.map((m) => `lt.${m}`).join(', ')}, p.level AS risk_level, p.metric AS risk_metric, p.probability AS risk_probability
                FROM devices d
                LEFT JOIN LATERAL (SELECT * FROM telemetry t WHERE t.device_id = d.id ORDER BY t.ts DESC LIMIT 1) lt ON true
                LEFT JOIN LATERAL (SELECT level, metric, probability FROM prediction_history h WHERE h.device_id = d.id ORDER BY h.created_at DESC, h.probability DESC LIMIT 1) p ON true
                ${w}`,
      };
    },
  },
  {
    id: 'telemetry-history',
    title: 'Telemetry history',
    description: 'Raw readings in the chosen period. Pick a device or machine type to keep the report focused.',
    uses: ['range', 'device', 'machineType', 'simulated'],
    hasSimulated: true,
    columns: [{ key: 'ts', header: 'Time', weight: 1.7, fmt: 'time' }, ...DEVICE_COLS, ...METRICS.map((m) => ({ key: m, header: m[0].toUpperCase() + m.slice(1), weight: 0.8, fmt: 'num1' as const }))],
    build(f) {
      const params: Params = [];
      const w = where([...deviceWhere(f, params), range('t.ts', f, params)]);
      return {
        params,
        sql: `SELECT t.id AS sort_key, t.ts, d.asset_no, d.name AS device_name, d.type AS device_type, d.simulated, ${METRICS.map((m) => `t.${m}`).join(', ')}
                FROM telemetry t JOIN devices d ON d.id = t.device_id ${w}`,
      };
    },
  },
  {
    id: 'alert-history',
    title: 'Alert history',
    description: 'Every alert raised in the period, with how long it took to resolve.',
    uses: ['range', 'device', 'machineType', 'simulated'],
    hasSimulated: true,
    columns: [
      { key: 'createdAt', header: 'Raised', weight: 1.7, fmt: 'time' }, ...DEVICE_COLS, { key: 'type', header: 'Type', weight: 0.9 }, { key: 'severity', header: 'Severity', weight: 0.9 },
      { key: 'metric', header: 'Metric', weight: 0.9 }, { key: 'value', header: 'Value', weight: 0.7, fmt: 'num1' }, { key: 'status', header: 'Status', weight: 0.9 },
      { key: 'minutesOpen', header: 'Minutes open', weight: 0.9, fmt: 'num1' }, { key: 'message', header: 'Message', weight: 3 },
    ],
    build(f) {
      const params: Params = [];
      const w = where([...deviceWhere(f, params), range('a.created_at', f, params)]);
      return {
        params,
        sql: `SELECT a.id AS sort_key, a.created_at, d.asset_no, d.name AS device_name, d.type AS device_type, d.simulated, a.type, a.severity, a.metric, a.value, a.status,
                     round((extract(epoch FROM (COALESCE(a.resolved_at, now()) - a.created_at)) / 60)::numeric, 1)::float AS minutes_open, a.message
                FROM alerts a JOIN devices d ON d.id = a.device_id ${w}`,
      };
    },
  },
  {
    id: 'predictive-summary',
    title: 'Predictive summary',
    description: 'For each device and metric: how often the model flagged elevated risk, and how high it went.',
    uses: ['range', 'device', 'machineType', 'simulated'],
    note: 'Probabilities describe the chance that a configured alert threshold is crossed within the model horizon. Models trained on synthetic data say so in the "Basis" column; synthetic accuracy is not real-world accuracy.',
    hasSimulated: true,
    columns: [
      ...DEVICE_COLS, { key: 'metric', header: 'Metric', weight: 0.9 }, { key: 'snapshots', header: 'Snapshots', weight: 0.8 }, { key: 'maxProbability', header: 'Peak risk %', weight: 0.8, fmt: 'pct' },
      { key: 'avgProbability', header: 'Average risk %', weight: 0.9, fmt: 'pct' }, { key: 'elevatedSnapshots', header: 'Elevated or higher', weight: 1 }, { key: 'lastLevel', header: 'Latest level', weight: 0.9 },
      { key: 'soonestBreachSeconds', header: 'Soonest breach (s)', weight: 1, fmt: 'num1' }, { key: 'modelVersion', header: 'Model', weight: 1 }, { key: 'basis', header: 'Basis', weight: 0.9 },
    ],
    build(f) {
      const params: Params = [];
      const w = where([...deviceWhere(f, params), range('h.created_at', f, params)]);
      return {
        params,
        sql: `SELECT row_number() OVER (ORDER BY d.asset_no, h.metric) AS sort_key, d.asset_no, d.name AS device_name, d.type AS device_type, d.simulated, h.metric,
                     count(*)::int AS snapshots, max(h.probability) AS max_probability, avg(h.probability) AS avg_probability,
                     count(*) FILTER (WHERE h.level <> 'low')::int AS elevated_snapshots,
                     (array_agg(h.level ORDER BY h.created_at DESC))[1] AS last_level,
                     min(h.seconds_to_breach) AS soonest_breach_seconds,
                     (array_agg(h.model_version ORDER BY h.created_at DESC))[1] AS model_version,
                     (array_agg(h.model_source ORDER BY h.created_at DESC))[1] AS basis
                FROM prediction_history h JOIN devices d ON d.id = h.device_id ${w}
               GROUP BY d.id, d.asset_no, d.name, d.type, d.simulated, h.metric`,
      };
    },
  },
  {
    id: 'machine-type-comparison',
    title: 'Machine type comparison',
    description: 'Fleet size, status and alert counts side by side for each machine type.',
    uses: ['range', 'machineType', 'simulated'],
    hasSimulated: false,
    columns: [
      { key: 'machineType', header: 'Machine type', weight: 1.6 }, { key: 'devices', header: 'Devices', weight: 0.8 }, { key: 'simulatedDevices', header: 'Simulated', weight: 0.8 },
      { key: 'online', header: 'Online', weight: 0.7 }, { key: 'degraded', header: 'Degraded', weight: 0.8 }, { key: 'offline', header: 'Offline', weight: 0.7 },
      { key: 'alerts', header: 'Alerts', weight: 0.7 }, { key: 'critical', header: 'Critical', weight: 0.7 }, { key: 'thresholdAlerts', header: 'Threshold', weight: 0.8 },
      { key: 'predictiveAlerts', header: 'Predictive', weight: 0.8 }, { key: 'alertsPerDevice', header: 'Alerts / device', weight: 0.9, fmt: 'num1' },
      { key: 'maintenance', header: 'Maintenance entries', weight: 1 }, { key: 'avgRisk', header: 'Avg peak risk %', weight: 1, fmt: 'pct' },
    ],
    build(f) {
      const params: Params = [];
      const dw = where([...(f.machineType ? [`d.type = ${ph(params, f.machineType)}`] : []), ...(f.includeSimulated ? [] : ['d.simulated = false']), 'd.active']);
      const from = ph(params, f.from); const to = ph(params, f.to);
      return {
        params,
        sql: `SELECT row_number() OVER (ORDER BY d.type) AS sort_key, d.type AS machine_type, count(*)::int AS devices, count(*) FILTER (WHERE d.simulated)::int AS simulated_devices,
                     count(*) FILTER (WHERE d.status = 'online')::int AS online, count(*) FILTER (WHERE d.status = 'degraded')::int AS degraded, count(*) FILTER (WHERE d.status = 'offline')::int AS offline,
                     COALESCE(sum(x.alerts), 0)::int AS alerts, COALESCE(sum(x.critical), 0)::int AS critical,
                     COALESCE(sum(x.threshold_alerts), 0)::int AS threshold_alerts, COALESCE(sum(x.predictive_alerts), 0)::int AS predictive_alerts,
                     round((COALESCE(sum(x.alerts), 0)::numeric / NULLIF(count(*), 0)), 1)::float AS alerts_per_device,
                     COALESCE(sum(x.maintenance), 0)::int AS maintenance, avg(x.peak) AS avg_risk
                FROM devices d
                LEFT JOIN LATERAL (
                  SELECT (SELECT count(*) FROM alerts a WHERE a.device_id = d.id AND a.created_at >= ${from} AND a.created_at < ${to}) AS alerts,
                         (SELECT count(*) FROM alerts a WHERE a.device_id = d.id AND a.severity = 'critical' AND a.created_at >= ${from} AND a.created_at < ${to}) AS critical,
                         (SELECT count(*) FROM alerts a WHERE a.device_id = d.id AND a.type = 'threshold' AND a.created_at >= ${from} AND a.created_at < ${to}) AS threshold_alerts,
                         (SELECT count(*) FROM alerts a WHERE a.device_id = d.id AND a.type = 'predictive' AND a.created_at >= ${from} AND a.created_at < ${to}) AS predictive_alerts,
                         (SELECT count(*) FROM maintenance_records m WHERE m.device_id = d.id AND m.performed_at >= ${from} AND m.performed_at < ${to}) AS maintenance,
                         (SELECT max(h.probability) FROM prediction_history h WHERE h.device_id = d.id AND h.created_at >= ${from} AND h.created_at < ${to}) AS peak
                ) x ON true
                ${dw}
               GROUP BY d.type`,
      };
    },
  },
  {
    id: 'maintenance-history',
    title: 'Maintenance history',
    description: 'Inspections, repairs, calibrations and other recorded maintenance in the period.',
    uses: ['range', 'device', 'machineType', 'simulated'],
    hasSimulated: true,
    columns: [
      { key: 'performedAt', header: 'When', weight: 1.7, fmt: 'time' }, ...DEVICE_COLS, { key: 'kind', header: 'Kind', weight: 1 },
      { key: 'summary', header: 'Summary', weight: 2.4 }, { key: 'details', header: 'Details', weight: 3 }, { key: 'performedByName', header: 'By', weight: 1.2 },
    ],
    build(f) {
      const params: Params = [];
      const w = where([...deviceWhere(f, params), range('m.performed_at', f, params)]);
      return {
        params,
        sql: `SELECT m.id AS sort_key, m.performed_at, d.asset_no, d.name AS device_name, d.type AS device_type, d.simulated, m.kind, m.summary, m.details, m.performed_by_name
                FROM maintenance_records m JOIN devices d ON d.id = m.device_id ${w}`,
      };
    },
  },
  {
    id: 'model-performance',
    title: 'Model performance',
    description: 'Every trained model version with its held-out evaluation, including retrains that were rejected.',
    uses: [],
    note: 'Evaluation uses a time-ordered split (train on the past, test on the future) with a purge gap. Labels mean "an alert threshold was crossed", not "equipment failed". Models marked synthetic were trained on generated data, so their scores describe the generator, not real machines.',
    hasSimulated: false,
    columns: [
      { key: 'scope', header: 'Scope', weight: 1.4 }, { key: 'version', header: 'Ver', weight: 0.5 }, { key: 'source', header: 'Basis', weight: 0.9 }, { key: 'samples', header: 'Samples', weight: 0.8 },
      { key: 'auc', header: 'AUC', weight: 0.7, fmt: 'num1' }, { key: 'precision', header: 'Precision', weight: 0.8, fmt: 'num1' }, { key: 'recall', header: 'Recall', weight: 0.8, fmt: 'num1' },
      { key: 'f1', header: 'F1', weight: 0.6, fmt: 'num1' }, { key: 'brier', header: 'Brier', weight: 0.7, fmt: 'num1' }, { key: 'positiveRate', header: 'Positive rate %', weight: 0.9, fmt: 'pct' },
      { key: 'isActive', header: 'Active', weight: 0.7, fmt: 'bool' }, { key: 'activated', header: 'Passed gate', weight: 0.9, fmt: 'bool' }, { key: 'reason', header: 'Reason', weight: 2.4 },
      { key: 'trainedBy', header: 'Trained by', weight: 1 }, { key: 'trainedAt', header: 'Trained', weight: 1.6, fmt: 'time' },
    ],
    build() {
      const params: Params = [];
      return {
        params,
        sql: `SELECT id AS sort_key, scope, version, source, samples, (evaluation->>'auc')::float AS auc, (evaluation->>'precision')::float AS precision, (evaluation->>'recall')::float AS recall,
                     (evaluation->>'f1')::float AS f1, (evaluation->>'brier')::float AS brier, (evaluation->>'positiveRate')::float AS positive_rate,
                     is_active, activated, reason, trained_by, trained_at
                FROM model_versions`,
      };
    },
  },
];

export const reportById = (id: string) => REPORTS.find((r) => r.id === id);

/** The knowledge-base report is built from the access-checked document list, not raw SQL. */
export const KB_COLUMNS: Col[] = [
  { key: 'title', header: 'Title', weight: 2.4 }, { key: 'originalName', header: 'File', weight: 2 }, { key: 'source', header: 'Origin', weight: 0.9 }, { key: 'visibility', header: 'Visibility', weight: 0.9 },
  { key: 'status', header: 'Status', weight: 0.8 }, { key: 'chunkCount', header: 'Passages', weight: 0.8 }, { key: 'sizeBytes', header: 'Bytes', weight: 0.8 }, { key: 'createdAt', header: 'Added', weight: 1.6, fmt: 'time' },
];

/* ------------------------------------------------------------------------------------------ running */

const BATCH = 2000;

async function* batches(def: ReportDef, f: Filters, viewer: Viewer, maxRows: number): AsyncGenerator<Record<string, any>[]> {
  if (def.id === 'knowledge-base') {
    const docs = await listDocuments(viewer, {});
    yield docs.slice(0, maxRows);
    return;
  }
  const built = def.build(f, viewer);
  if (!built) return;
  let last = 0;
  let sent = 0;
  while (sent < maxRows) {
    const params = [...built.params, last, Math.min(BATCH, maxRows - sent)];
    const rows = await q(
      `SELECT * FROM (${built.sql}) r WHERE sort_key > $${built.params.length + 1} ORDER BY sort_key LIMIT $${built.params.length + 2}`, params);
    if (!rows.length) return;
    sent += rows.length;
    last = Number(rows[rows.length - 1].sortKey);
    yield rows;
    if (rows.length < Math.min(BATCH, maxRows)) return;
  }
}

export const KNOWLEDGE_REPORT: ReportDef = {
  id: 'knowledge-base', title: 'Knowledge base inventory', description: 'The documents you can read, their indexing status and visibility.', uses: [],
  hasSimulated: false, columns: KB_COLUMNS, build: () => null,
};
export const ALL_REPORTS: ReportDef[] = [...REPORTS, KNOWLEDGE_REPORT];
export const findReport = (id: string) => ALL_REPORTS.find((r) => r.id === id);

async function count(def: ReportDef, f: Filters, viewer: Viewer): Promise<number> {
  if (def.id === 'knowledge-base') return (await listDocuments(viewer, {})).length;
  const built = def.build(f, viewer);
  if (!built) return 0;
  return Number((await q1<{ n: string }>(`SELECT count(*) AS n FROM (${built.sql}) r`, built.params))?.n ?? 0);
}

/** Devices matched by the filters, and how many of them are simulated - so reports can say what they include. */
export async function scopeInfo(f: Filters) {
  const params: Params = [];
  const w = where(deviceWhere(f, params));
  const r = await q1<{ total: number; simulated: number }>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE d.simulated)::int AS simulated FROM devices d ${w}`, params);
  return { devices: r?.total ?? 0, simulatedDevices: r?.simulated ?? 0 };
}

export interface Preview {
  report: { id: string; title: string; description: string; note?: string };
  filters: { from: string; to: string; deviceId?: string; machineType?: string; includeSimulated: boolean };
  generatedAt: string; columns: Col[]; rows: Record<string, unknown>[]; total: number; previewRows: number;
  scope: { devices: number; simulatedDevices: number }; notes: string[];
}

const SIM_NOTE = 'Rows marked simulated come from the built-in device simulator, not from physical equipment.';

export async function preview(def: ReportDef, f: Filters, viewer: Viewer, limit = 50): Promise<Preview> {
  const rows: Record<string, unknown>[] = [];
  for await (const b of batches(def, f, viewer, limit)) { rows.push(...b); break; }
  const scope = await scopeInfo(f);
  const notes: string[] = [];
  if (def.note) notes.push(def.note);
  if (def.hasSimulated && scope.simulatedDevices > 0) notes.push(`${SIM_NOTE} ${scope.simulatedDevices} of ${scope.devices} devices in scope are simulated.`);
  return {
    report: { id: def.id, title: def.title, description: def.description, note: def.note },
    filters: { from: f.from.toISOString(), to: f.to.toISOString(), deviceId: f.deviceId, machineType: f.machineType, includeSimulated: f.includeSimulated },
    generatedAt: new Date().toISOString(), columns: def.columns, rows: rows.slice(0, limit), total: await count(def, f, viewer), previewRows: Math.min(rows.length, limit), scope, notes,
  };
}

/** Stream a report as CSV. Rows are fetched in batches and written as they arrive. */
export async function streamCsv(def: ReportDef, f: Filters, viewer: Viewer, res: Response, signal: { aborted: boolean }) {
  res.write('﻿' + csvHeader(def.columns)); // BOM so Excel reads UTF-8 correctly
  let n = 0;
  for await (const rows of batches(def, f, viewer, config.reportMaxRows)) {
    if (signal.aborted) return n;
    n += rows.length;
    if (!res.write(csvBody(rows, def.columns))) await new Promise<void>((r) => res.once('drain', () => r()));
  }
  return n;
}

const fmtCell = (c: Col, v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (c.fmt === 'bool') return v ? 'yes' : 'no';
  if (c.fmt === 'time') return new Date(v as string).toISOString().replace('T', ' ').slice(0, 19);
  if (c.fmt === 'pct') return `${(Number(v) * 100).toFixed(0)}%`;
  if (c.fmt === 'num1') return Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 100) / 100) : String(v);
  return String(v);
};

/** Stream a report as a PDF (A4 landscape, header repeated on every page, page numbers). */
export async function streamPdf(def: ReportDef, f: Filters, viewer: Viewer, res: Response, signal: { aborted: boolean }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, bufferPages: true, info: { Title: `${def.title} - IoT Sentinel`, Author: 'IoT Sentinel' } });
  doc.pipe(res);
  const pw = doc.page.width - 64;
  const scope = await scopeInfo(f);
  const total = await count(def, f, viewer);

  doc.font('Helvetica-Bold').fontSize(17).fillColor('#0e1a2e').text(def.title);
  doc.font('Helvetica').fontSize(9).fillColor('#5a6b84')
    .text(`Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC  |  Period ${f.from.toISOString().slice(0, 16).replace('T', ' ')} to ${f.to.toISOString().slice(0, 16).replace('T', ' ')} UTC`
      + `${f.machineType ? `  |  Machine type: ${f.machineType}` : ''}${f.deviceId ? '  |  Single device' : ''}  |  ${total} row${total === 1 ? '' : 's'}`);
  const notes: string[] = [];
  if (def.note) notes.push(def.note);
  if (def.hasSimulated && scope.simulatedDevices > 0) notes.push(`${SIM_NOTE} ${scope.simulatedDevices} of ${scope.devices} devices in scope are simulated. Simulated devices are marked "yes" in the Simulated column.`);
  if (notes.length) { doc.moveDown(0.4).fontSize(8.5).fillColor('#92400e').text(notes.join('\n'), { width: pw }); }
  doc.moveDown(0.6);

  const weights = def.columns.map((c) => c.weight ?? 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / sum) * pw);
  const fs = def.columns.length > 12 ? 6.5 : def.columns.length > 8 ? 7.5 : 8.5;
  const rowH = fs + 6;

  const header = () => {
    const y = doc.y;
    doc.rect(32, y, pw, rowH + 2).fill('#e8eef7');
    doc.fillColor('#0e1a2e').font('Helvetica-Bold').fontSize(fs);
    let x = 32;
    def.columns.forEach((c, i) => { doc.text(c.header, x + 3, y + 4, { width: widths[i] - 6, height: rowH, ellipsis: true, lineBreak: false }); x += widths[i]; });
    doc.y = y + rowH + 4;
  };
  header();

  let printed = 0;
  let zebra = false;
  const cap = config.reportPdfMaxRows;
  outer: for await (const rows of batches(def, f, viewer, cap)) {
    for (const row of rows) {
      if (signal.aborted) break outer;
      if (doc.y + rowH > doc.page.height - 44) { doc.addPage(); header(); }
      const y = doc.y;
      if (zebra) doc.rect(32, y - 1, pw, rowH).fill('#f5f8fc');
      zebra = !zebra;
      doc.fillColor('#0e1a2e').font('Helvetica').fontSize(fs);
      let x = 32;
      def.columns.forEach((c, i) => { doc.text(fmtCell(c, row[c.key]), x + 3, y + 2, { width: widths[i] - 6, height: rowH, ellipsis: true, lineBreak: false }); x += widths[i]; });
      doc.y = y + rowH;
      printed++;
    }
  }
  if (printed === 0) doc.font('Helvetica-Oblique').fontSize(10).fillColor('#5a6b84').text('No rows match these filters.');
  if (total > printed) doc.moveDown(0.5).font('Helvetica-Oblique').fontSize(8.5).fillColor('#5a6b84').text(`Showing the first ${printed} of ${total} rows. Download the CSV export for the complete data.`);

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // otherwise writing into the margin starts a new page
    doc.font('Helvetica').fontSize(8).fillColor('#8b9cb8')
      .text(`IoT Sentinel  |  ${def.title}  |  Page ${i + 1} of ${range.count}`, 32, doc.page.height - 26, { width: pw, align: 'center', lineBreak: false });
  }
  doc.end();
  await new Promise<void>((r) => res.once('finish', () => r()));
  return printed;
}
