import PDFDocument from 'pdfkit';
import { Response } from 'express';
import { config } from '../config';
import { col } from '../mongo';
import { DeviceBrief, deviceBriefs } from './deviceQueries';
import { csvBody, csvHeader } from '../util';
import { listDocuments, Viewer } from './kb/store';

/**
 * Reports. Every report is one MongoDB query (or aggregation) plus column metadata, so the same definition drives the
 * on-screen preview, the CSV export and the PDF export. Large reports are read in keyset-paginated batches and
 * streamed, so memory use does not grow with the number of rows.
 */
export interface Filters { from: Date; to: Date; deviceId?: string; machineType?: string; includeSimulated: boolean }
export type Col = { key: string; header: string; weight?: number; fmt?: 'time' | 'num1' | 'pct' | 'bool' };

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
}

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
  },
  {
    id: 'telemetry-history',
    title: 'Telemetry history',
    description: 'Raw readings in the chosen period. Pick a device or machine type to keep the report focused.',
    uses: ['range', 'device', 'machineType', 'simulated'],
    hasSimulated: true,
    columns: [{ key: 'ts', header: 'Time', weight: 1.7, fmt: 'time' }, ...DEVICE_COLS, ...METRICS.map((m) => ({ key: m, header: m[0].toUpperCase() + m.slice(1), weight: 0.8, fmt: 'num1' as const }))],
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
type Row = Record<string, any>;
interface Source {
  /** Rows after `after` (the previous batch's last sortKey), in sortKey order. Every row carries its own `sortKey`. */
  fetch(f: Filters, after: any, limit: number): Promise<Row[]>;
  count(f: Filters): Promise<number>;
}

/** Devices matching the machine-type / single-device / simulated filters (null = no restriction). */
function deviceFilter(f: Filters): Record<string, unknown> | null {
  const w: Record<string, unknown> = {};
  if (f.deviceId) w._id = f.deviceId;
  if (f.machineType) w.type = f.machineType;
  if (!f.includeSimulated) w.simulated = { $ne: true };
  return Object.keys(w).length ? w : null;
}

async function scopeIds(f: Filters): Promise<string[] | null> {
  const w = deviceFilter(f);
  if (!w) return null;
  return (await col('devices').find(w, { projection: { _id: 1 } }).toArray()).map((d) => d._id as string);
}

const deviceCols = (b?: DeviceBrief) => ({ assetNo: b?.assetNo ?? null, deviceName: b?.name ?? null, deviceType: b?.type ?? null, simulated: b?.simulated ?? false });
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Event collections (telemetry, alerts, maintenance): filter by time and device scope, paginate by `_id`. */
function eventSource(collection: string, timeField: string, shape: (r: Row, b: Map<string, DeviceBrief>) => Row): Source {
  const base = async (f: Filters) => {
    const filter: Record<string, unknown> = { [timeField]: { $gte: f.from, $lt: f.to } };
    const ids = await scopeIds(f);
    if (ids) filter.deviceId = { $in: ids };
    return filter;
  };
  return {
    async fetch(f, after, limit) {
      const filter = await base(f);
      if (after !== undefined && after !== null) filter._id = { $gt: after };
      const rows = await col(collection).find(filter).sort({ _id: 1 }).limit(limit).toArray();
      const briefs = await deviceBriefs(rows.map((r) => r.deviceId));
      return rows.map((r) => ({ ...shape(r, briefs), sortKey: r._id }));
    },
    count: async (f) => col(collection).countDocuments(await base(f)),
  };
}

const METRIC_LIST = ['temperature', 'cpu', 'memory', 'battery', 'signal', 'vibration', 'pressure', 'current'];
const metricValues = (r: Row) => Object.fromEntries(METRIC_LIST.map((m) => [m, r[m] ?? null]));

/** Small, aggregated reports are computed in one go and then sliced by position. */
function computedSource(compute: (f: Filters) => Promise<Row[]>): Source {
  return {
    async fetch(f, after, limit) {
      const all = (await compute(f)).map((r, i) => ({ ...r, sortKey: i + 1 }));
      return all.filter((r) => r.sortKey > (after ?? 0)).slice(0, limit);
    },
    count: async (f) => (await compute(f)).length,
  };
}

const SOURCES: Record<string, Source> = {
  'telemetry-history': eventSource('telemetry', 'ts', (r, b) => ({ ts: r.ts, ...deviceCols(b.get(r.deviceId)), ...metricValues(r) })),
  'alert-history': eventSource('alerts', 'createdAt', (r, b) => ({
    createdAt: r.createdAt, ...deviceCols(b.get(r.deviceId)), type: r.type, severity: r.severity, metric: r.metric, value: r.value, status: r.status,
    minutesOpen: round1(((r.resolvedAt ? new Date(r.resolvedAt).getTime() : Date.now()) - new Date(r.createdAt).getTime()) / 60_000), message: r.message,
  })),
  'maintenance-history': eventSource('maintenance_records', 'performedAt', (r, b) => ({
    performedAt: r.performedAt, ...deviceCols(b.get(r.deviceId)), kind: r.kind, summary: r.summary, details: r.details, performedByName: r.performedByName,
  })),

  // one row per device, keyed by its asset number
  'device-health': {
    async fetch(f, after, limit) {
      const filter: Record<string, unknown> = { ...deviceFilter(f), assetNo: { $gt: after ?? 0 } };
      const devices = await col('devices').find(filter, { projection: { apiKeyHash: 0 } }).sort({ assetNo: 1 }).limit(limit).toArray();
      const ids = devices.map((d) => d._id as string);
      const open = await col('alerts').aggregate([{ $match: { deviceId: { $in: ids }, status: 'open' } }, { $group: { _id: '$deviceId', n: { $sum: 1 } } }]).toArray();
      const openBy = new Map(open.map((o) => [o._id as string, o.n as number]));
      return Promise.all(devices.map(async (d) => {
        const [lt, p] = await Promise.all([
          col('telemetry').find({ deviceId: d._id }).sort({ ts: -1 }).limit(1).next(),
          col('prediction_history').find({ deviceId: d._id }).sort({ createdAt: -1, probability: -1 }).limit(1).next(),
        ]);
        return {
          sortKey: d.assetNo, assetNo: d.assetNo, deviceName: d.name, deviceType: d.type, simulated: !!d.simulated, status: d.status, active: d.active !== false,
          firmware: d.firmwareVersion, lastSeen: d.lastSeen, openAlerts: openBy.get(d._id as string) ?? 0, ...metricValues(lt ?? {}),
          riskLevel: p?.level ?? null, riskMetric: p?.metric ?? null, riskProbability: p?.probability ?? null,
        };
      }));
    },
    count: async (f) => col('devices').countDocuments(deviceFilter(f) ?? {}),
  },

  'predictive-summary': computedSource(async (f) => {
    const ids = await scopeIds(f);
    const match: Record<string, unknown> = { createdAt: { $gte: f.from, $lt: f.to } };
    if (ids) match.deviceId = { $in: ids };
    const groups = await col('prediction_history').aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $group: {
        _id: { deviceId: '$deviceId', metric: '$metric' }, snapshots: { $sum: 1 }, maxProbability: { $max: '$probability' }, avgProbability: { $avg: '$probability' },
        elevatedSnapshots: { $sum: { $cond: [{ $ne: ['$level', 'low'] }, 1, 0] } }, lastLevel: { $first: '$level' }, soonestBreachSeconds: { $min: '$secondsToBreach' },
        modelVersion: { $first: '$modelVersion' }, basis: { $first: '$modelSource' },
      } },
    ]).toArray();
    const briefs = await deviceBriefs(groups.map((g) => g._id.deviceId));
    return groups
      .map((g) => ({ ...deviceCols(briefs.get(g._id.deviceId)), metric: g._id.metric, snapshots: g.snapshots, maxProbability: g.maxProbability, avgProbability: g.avgProbability,
        elevatedSnapshots: g.elevatedSnapshots, lastLevel: g.lastLevel, soonestBreachSeconds: g.soonestBreachSeconds ?? null, modelVersion: g.modelVersion, basis: g.basis }))
      .sort((a, b) => (a.assetNo ?? 0) - (b.assetNo ?? 0) || String(a.metric).localeCompare(String(b.metric)));
  }),

  'machine-type-comparison': computedSource(async (f) => {
    const filter: Record<string, unknown> = { active: { $ne: false } };
    if (f.machineType) filter.type = f.machineType;
    if (!f.includeSimulated) filter.simulated = { $ne: true };
    const devices = await col('devices').find(filter, { projection: { type: 1, status: 1, simulated: 1 } }).toArray();
    const ids = devices.map((d) => d._id as string);
    const range = { $gte: f.from, $lt: f.to };
    const [alertRows, maintRows, peakRows] = await Promise.all([
      col('alerts').aggregate([{ $match: { deviceId: { $in: ids }, createdAt: range } }, { $group: { _id: { d: '$deviceId', t: '$type', s: '$severity' }, n: { $sum: 1 } } }]).toArray(),
      col('maintenance_records').aggregate([{ $match: { deviceId: { $in: ids }, performedAt: range } }, { $group: { _id: '$deviceId', n: { $sum: 1 } } }]).toArray(),
      col('prediction_history').aggregate([{ $match: { deviceId: { $in: ids }, createdAt: range } }, { $group: { _id: '$deviceId', peak: { $max: '$probability' } } }]).toArray(),
    ]);
    const typeOf = new Map(devices.map((d) => [d._id as string, d.type as string]));
    const by = new Map<string, Row>();
    const entry = (type: string) => {
      if (!by.has(type)) by.set(type, { machineType: type, devices: 0, simulatedDevices: 0, online: 0, degraded: 0, offline: 0, alerts: 0, critical: 0, thresholdAlerts: 0, predictiveAlerts: 0, maintenance: 0, peaks: [] as number[] });
      return by.get(type)!;
    };
    for (const d of devices) {
      const e = entry(d.type);
      e.devices++; if (d.simulated) e.simulatedDevices++;
      if (d.status === 'online') e.online++; else if (d.status === 'degraded') e.degraded++; else if (d.status === 'offline') e.offline++;
    }
    for (const a of alertRows) {
      const e = entry(typeOf.get(a._id.d)!);
      e.alerts += a.n;
      if (a._id.s === 'critical') e.critical += a.n;
      if (a._id.t === 'threshold') e.thresholdAlerts += a.n;
      if (a._id.t === 'predictive') e.predictiveAlerts += a.n;
    }
    for (const m of maintRows) entry(typeOf.get(m._id as string)!).maintenance += m.n;
    for (const p of peakRows) entry(typeOf.get(p._id as string)!).peaks.push(p.peak);
    return [...by.values()].sort((a, b) => a.machineType.localeCompare(b.machineType)).map(({ peaks, ...e }) => ({
      ...e, alertsPerDevice: e.devices ? round1(e.alerts / e.devices) : null, avgRisk: peaks.length ? peaks.reduce((s: number, v: number) => s + v, 0) / peaks.length : null,
    }));
  }),

  'model-performance': computedSource(async () => {
    const versions = await col('model_versions').find({}, { projection: { model: 0 } }).sort({ _id: 1 }).toArray();
    return versions.map((v) => ({
      scope: v.scope, version: v.version, source: v.source, samples: v.samples, auc: v.evaluation?.auc ?? null, precision: v.evaluation?.precision ?? null, recall: v.evaluation?.recall ?? null,
      f1: v.evaluation?.f1 ?? null, brier: v.evaluation?.brier ?? null, positiveRate: v.evaluation?.positiveRate ?? null, isActive: !!v.isActive, activated: !!v.activated,
      reason: v.reason, trainedBy: v.trainedBy, trainedAt: v.trainedAt,
    }));
  }),
};

async function* batches(def: ReportDef, f: Filters, viewer: Viewer, maxRows: number): AsyncGenerator<Row[]> {
  if (def.id === 'knowledge-base') {
    yield (await listDocuments(viewer, {})).slice(0, maxRows);
    return;
  }
  const src = SOURCES[def.id];
  if (!src) return;
  let last: any;
  let sent = 0;
  while (sent < maxRows) {
    const rows = await src.fetch(f, last, Math.min(BATCH, maxRows - sent));
    if (!rows.length) return;
    sent += rows.length;
    last = rows[rows.length - 1].sortKey;
    yield rows;
    if (rows.length < Math.min(BATCH, maxRows)) return;
  }
}

export const KNOWLEDGE_REPORT: ReportDef = {
  id: 'knowledge-base', title: 'Knowledge base inventory', description: 'The documents you can read, their indexing status and visibility.', uses: [],
  hasSimulated: false, columns: KB_COLUMNS,
};
export const ALL_REPORTS: ReportDef[] = [...REPORTS, KNOWLEDGE_REPORT];
export const findReport = (id: string) => ALL_REPORTS.find((r) => r.id === id);

async function count(def: ReportDef, f: Filters, viewer: Viewer): Promise<number> {
  if (def.id === 'knowledge-base') return (await listDocuments(viewer, {})).length;
  return SOURCES[def.id]?.count(f) ?? 0;
}

/** Devices matched by the filters, and how many of them are simulated - so reports can say what they include. */
export async function scopeInfo(f: Filters) {
  const w = deviceFilter(f) ?? {};
  const [devices, simulatedDevices] = await Promise.all([col('devices').countDocuments(w), col('devices').countDocuments({ ...w, simulated: true })]);
  return { devices, simulatedDevices };
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
