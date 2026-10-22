import { config } from '../../config';
import { col } from '../../mongo';
import { deviceBriefs, latestFirmwareByType, withDevice } from '../deviceQueries';
import { METRIC_KEYS, METRICS, MetricKey } from '../../ml/metrics';
import { keys, redis } from '../../redis';
import { predictDevice } from '../prediction';
import { listPredictionHistory } from '../predictionHistory';
import { rulesForType } from '../rules';
import { compareVersions } from '../../util';

/**
 * Read-only tools that give the assistant live facts. The model never writes SQL: every tool here is a fixed,
 * parameterised query or an existing service call, bounded in rows and time. None of them can change data.
 */
export interface DeviceRef { id: string; name: string; assetNo: number; type: string; simulated: boolean; active: boolean }

export interface ToolResult {
  tool: ToolName;
  title: string;           // shown in the citation
  facts: string;           // compact, human-readable text handed to the model
  data: unknown;           // structured version, returned to the UI
  device?: { id: string; name: string; assetNo: number };
  asOf: string;
  simulated: boolean;      // true when the data comes (at least partly) from simulated devices
}

export type ToolName =
  | 'fleet_status' | 'top_risk' | 'highest_metric' | 'alerts_summary' | 'telemetry_history' | 'breaches_by_type'
  | 'anomaly_history' | 'explain_prediction' | 'maintenance_attention' | 'device_profile' | 'maintenance_history' | 'model_info';

const TOOL_TIMEOUT_MS = 8000;
const rows = () => config.toolMaxRows;
const iso = () => new Date().toISOString();
const n1 = (v: number | null | undefined, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toFixed(d));
const label = (d: Pick<DeviceRef, 'assetNo' | 'name'>) => `#${d.assetNo} ${d.name}`;
const unitOf = (m: MetricKey) => METRICS[m].unit.trim();
const fmtEta = (s: number | null) => (s === null ? 'no ETA' : s <= 0 ? 'already beyond' : s < 90 ? `~${Math.round(s)} s` : `~${(s / 60).toFixed(1)} min`);

export async function withTimeout<T>(p: Promise<T>, ms = TOOL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The data lookup took too long')), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(timer!); }
}

/* ------------------------------------------------------------------ device lookup */

const REF_FIELDS = { name: 1, assetNo: 1, type: 1, simulated: 1, active: 1 };
const toRef = (d: any): DeviceRef => ({ id: d._id as string, name: d.name, assetNo: d.assetNo, type: d.type, simulated: !!d.simulated, active: d.active !== false });

export async function allDevices(): Promise<DeviceRef[]> {
  return (await col('devices').find({}, { projection: REF_FIELDS }).sort({ assetNo: 1 }).toArray()).map(toRef);
}

export async function deviceById(id: string): Promise<DeviceRef | undefined> {
  const d = await col('devices').findOne({ _id: id as any }, { projection: REF_FIELDS });
  return d ? toRef(d) : undefined;
}

/** Devices in service that are not offline - the ones that have live readings to rank. */
const liveDevices = async () => (await col('devices').find({ active: { $ne: false }, status: { $ne: 'offline' } }, { projection: REF_FIELDS }).sort({ assetNo: 1 }).toArray()).map(toRef);

/* ------------------------------------------------------------------ fleet-level tools */

export async function fleetStatus(): Promise<ToolResult> {
  const devices = col('devices');
  const [counts, inactiveN, unhealthyDocs, simN, total] = await Promise.all([
    devices.aggregate([{ $match: { active: { $ne: false } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    devices.countDocuments({ active: false }),
    devices.find({ active: { $ne: false }, status: { $ne: 'online' } }, { projection: { assetNo: 1, name: 1, type: 1, status: 1, lastSeen: 1 } }).toArray(),
    devices.countDocuments({ simulated: true }),
    devices.countDocuments({}),
  ]);
  unhealthyDocs.sort((a, b) => (a.status < b.status ? 1 : a.status > b.status ? -1 : a.assetNo - b.assetNo));
  const shown = unhealthyDocs.slice(0, rows());
  const open = shown.length
    ? await col('alerts').aggregate([{ $match: { deviceId: { $in: shown.map((d) => d._id) }, status: { $ne: 'resolved' } } }, { $group: { _id: '$deviceId', n: { $sum: 1 } } }]).toArray()
    : [];
  const openBy = new Map(open.map((o) => [o._id as string, o.n as number]));
  const unhealthy = shown.map((d) => ({ assetNo: d.assetNo, name: d.name, type: d.type, status: d.status, openAlerts: openBy.get(d._id as string) ?? 0, lastSeen: d.lastSeen }));
  const c = (s: string) => counts.find((x) => x._id === s)?.n ?? 0;
  const inService = c('online') + c('degraded') + c('offline');
  const lines = [
    `Devices in service: ${inService} (online ${c('online')}, degraded ${c('degraded')}, offline ${c('offline')}). Deactivated: ${inactiveN}.`,
    unhealthy.length
      ? `Unhealthy devices (degraded or offline): ${unhealthy.map((d) => `${label({ assetNo: d.assetNo, name: d.name })} (${d.type}, ${d.status}, ${d.openAlerts} open alert${d.openAlerts === 1 ? '' : 's'})`).join('; ')}.`
      : 'No device is currently degraded or offline.',
    `${simN} of ${total} registered devices are simulated.`,
  ];
  return { tool: 'fleet_status', title: 'Fleet status', facts: lines.join('\n'), asOf: iso(), simulated: simN > 0,
    data: { online: c('online'), degraded: c('degraded'), offline: c('offline'), inactive: inactiveN, unhealthy } };
}

export async function topRisk(n = 5): Promise<ToolResult> {
  const limit = Math.min(Math.max(n, 1), rows());
  const devices = await liveDevices();
  const ranked: any[] = [];
  for (const d of devices) {
    const { prediction } = await predictDevice(d.id, d.type);
    const top = prediction.metrics[0];
    if (!top) continue;
    ranked.push({ device: d, level: prediction.level, probability: top.probability, metric: top.metric, eta: top.secondsToBreach, current: top.current, threshold: top.threshold, model: `${top.explanation.model.scope} ${top.explanation.model.version} (${top.explanation.model.source})` });
  }
  ranked.sort((a, b) => b.probability - a.probability);
  const pick = ranked.slice(0, limit);
  const lines = pick.length
    ? pick.map((r, i) => `${i + 1}. ${label(r.device)} (${r.device.type}): ${METRICS[r.metric as MetricKey].label} ${n1(r.current)}${unitOf(r.metric)} vs limit ${n1(r.threshold)}${unitOf(r.metric)}; probability of crossing the limit ${(r.probability * 100).toFixed(0)}% (${r.level}), ${fmtEta(r.eta)}; model ${r.model}${r.device.simulated ? '; simulated device' : ''}`)
    : ['No device has enough recent readings to be scored.'];
  return { tool: 'top_risk', title: `Top ${pick.length} devices by predicted risk`, facts: ['Risk = probability that a configured threshold is crossed within the model horizon (not the probability of equipment failure).', ...lines].join('\n'),
    asOf: iso(), simulated: pick.some((r) => r.device.simulated), data: pick };
}

export async function highestMetric(metric: MetricKey): Promise<ToolResult> {
  const devices = await liveDevices();
  const latest = devices.length ? await redis.mget(devices.map((d) => keys.latest(d.id))) : [];
  const found: any[] = [];
  devices.forEach((d, i) => {
    const p = latest[i] ? JSON.parse(latest[i]!) : null;
    const v = p?.[metric];
    if (typeof v === 'number') found.push({ device: d, value: v, at: p.ts });
  });
  const desc = METRICS[metric].dir === 1;
  found.sort((a, b) => (desc ? b.value - a.value : a.value - b.value));
  const pick = found.slice(0, 5);
  const word = desc ? 'Highest' : 'Lowest';
  const lines = pick.length
    ? pick.map((r, i) => `${i + 1}. ${label(r.device)} (${r.device.type}): ${n1(r.value)}${unitOf(metric)}${r.device.simulated ? ' (simulated)' : ''}`)
    : [`No device in service currently reports ${METRICS[metric].label}.`];
  return { tool: 'highest_metric', title: `${word} current ${METRICS[metric].label}`, facts: [`${word} latest ${METRICS[metric].label} across devices in service:`, ...lines].join('\n'),
    asOf: iso(), simulated: pick.some((r) => r.device.simulated), data: pick.map((r) => ({ ...r.device, value: r.value })) };
}

export async function alertsSummary(period: 'today' | '24h' | '7d' = 'today'): Promise<ToolResult> {
  const now = new Date();
  const since = period === 'today' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) : new Date(now.getTime() - (period === '24h' ? 24 : 168) * 3_600_000);
  const alerts = col('alerts');
  const [bySevRows, recentRows, totalN, activeN] = await Promise.all([
    alerts.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { severity: '$severity', type: '$type' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
    alerts.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(rows()).toArray(),
    alerts.countDocuments({ createdAt: { $gte: since } }),
    alerts.countDocuments({ createdAt: { $gte: since }, status: { $ne: 'resolved' } }),
  ]);
  const bySev = bySevRows.map((r) => ({ severity: r._id.severity, type: r._id.type, n: r.n }));
  const recent = await withDevice(recentRows.map((r) => ({ ...r, id: r._id, deviceId: r.deviceId })));
  const periodLabel = period === 'today' ? 'today (since 00:00 UTC)' : period === '24h' ? 'the last 24 hours' : 'the last 7 days';
  const lines = [
    `Alerts raised ${periodLabel}: ${totalN} (${activeN} still unresolved).`,
    bySev.length ? `By severity and type: ${bySev.map((r) => `${r.n} ${r.severity} ${r.type}`).join(', ')}.` : 'No alerts in that period.',
    ...recent.slice(0, 10).map((a: any) => `- ${new Date(a.createdAt).toISOString().slice(11, 19)}Z ${label({ assetNo: a.assetNo ?? 0, name: a.deviceName ?? 'unknown' })}: ${a.severity} ${a.type}${a.metric ? ` (${a.metric})` : ''} - ${a.message} [${a.status}]`),
  ];
  return { tool: 'alerts_summary', title: `Alerts ${periodLabel}`, facts: lines.join('\n'), asOf: iso(), simulated: true, data: { period, total: totalN, bySev, recent } };
}

export async function breachesByType(days = 7): Promise<ToolResult> {
  const d = Math.min(Math.max(days, 1), 90);
  const per = await col('alerts').aggregate([
    { $match: { type: 'threshold', createdAt: { $gte: new Date(Date.now() - d * 86_400_000) } } },
    { $group: { _id: '$deviceId', n: { $sum: 1 } } },
  ]).toArray();
  const briefs = await deviceBriefs(per.map((p) => p._id as string));
  const byType = new Map<string, { breaches: number; devices: number }>();
  for (const p of per) {
    const type = briefs.get(p._id as string)?.type;
    if (!type) continue;
    const e = byType.get(type) ?? { breaches: 0, devices: 0 };
    e.breaches += p.n; e.devices += 1;
    byType.set(type, e);
  }
  const data = [...byType].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.breaches - a.breaches).slice(0, rows());
  const lines = data.length
    ? data.map((r, i) => `${i + 1}. ${r.type}: ${r.breaches} threshold breach${r.breaches === 1 ? '' : 'es'} across ${r.devices} device${r.devices === 1 ? '' : 's'}`)
    : ['No threshold breaches in that period.'];
  return { tool: 'breaches_by_type', title: `Threshold breaches by machine type (last ${d} days)`, facts: lines.join('\n'), asOf: iso(), simulated: true, data };
}

export async function maintenanceAttention(n = 5): Promise<ToolResult> {
  const limit = Math.min(Math.max(n, 1), rows());
  const devices = await col('devices').find({ active: { $ne: false } }, { projection: { assetNo: 1, name: 1, type: 1, status: 1, simulated: 1, firmwareVersion: 1 } }).toArray();
  const ids = devices.map((d) => d._id as string);
  const week = new Date(Date.now() - 7 * 86_400_000);
  const [openRows, breachRows, serviceRows, security] = await Promise.all([
    col('alerts').aggregate([{ $match: { deviceId: { $in: ids }, status: { $ne: 'resolved' } } }, { $group: { _id: '$deviceId', open: { $sum: 1 }, critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } } } }]).toArray(),
    col('alerts').aggregate([{ $match: { deviceId: { $in: ids }, type: 'threshold', createdAt: { $gte: week } } }, { $group: { _id: '$deviceId', n: { $sum: 1 } } }]).toArray(),
    col('maintenance_records').aggregate([{ $match: { deviceId: { $in: ids }, kind: { $in: ['inspection', 'repair', 'replacement', 'calibration'] } } }, { $group: { _id: '$deviceId', last: { $max: '$performedAt' } } }]).toArray(),
    col('firmware_releases').find({ securityPatch: true }).toArray(),
  ]);
  const open = new Map(openRows.map((r) => [r._id as string, r]));
  const breaches = new Map(breachRows.map((r) => [r._id as string, r.n as number]));
  const service = new Map(serviceRows.map((r) => [r._id as string, r.last as Date]));
  const scored: any[] = [];
  for (const dev of devices) {
    const id = dev._id as string;
    const d = { id, assetNo: dev.assetNo, name: dev.name, type: dev.type, status: dev.status, simulated: !!dev.simulated, firmwareVersion: dev.firmwareVersion,
      criticalAlerts: open.get(id)?.critical ?? 0, openAlerts: open.get(id)?.open ?? 0, breaches7d: breaches.get(id) ?? 0, lastService: service.get(id) ?? null };
    const { prediction } = d.status === 'offline' ? { prediction: null } : await predictDevice(d.id, d.type);
    const reasons: string[] = [];
    let score = 0;
    if (d.status === 'offline') { score += 4; reasons.push('offline'); }
    if (d.criticalAlerts) { score += 3 * d.criticalAlerts; reasons.push(`${d.criticalAlerts} open critical alert${d.criticalAlerts > 1 ? 's' : ''}`); }
    else if (d.openAlerts) { score += d.openAlerts; reasons.push(`${d.openAlerts} open alert${d.openAlerts > 1 ? 's' : ''}`); }
    if (prediction && (prediction.level === 'high' || prediction.level === 'breached')) { score += 3; reasons.push(`${prediction.level} predicted risk on ${prediction.topMetric}`); }
    else if (prediction?.level === 'elevated') { score += 1; reasons.push('elevated predicted risk'); }
    if (d.breaches7d >= 3) { score += 2; reasons.push(`${d.breaches7d} threshold breaches in 7 days`); }
    const missed = security.filter((s: any) => s.deviceType === d.type && compareVersions(s.version, d.firmwareVersion) > 0).length;
    if (missed) { score += 1; reasons.push(`${missed} security firmware release${missed > 1 ? 's' : ''} not installed`); }
    if (score > 0) scored.push({ device: d, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  const pick = scored.slice(0, limit);
  const lines = pick.length
    ? pick.map((r, i) => `${i + 1}. ${label(r.device)} (${r.device.type}): ${r.reasons.join('; ')}${r.device.lastService ? `; last service ${new Date(r.device.lastService).toISOString().slice(0, 10)}` : '; no service recorded'}${r.device.simulated ? '; simulated device' : ''}`)
    : ['No device currently shows a reason for maintenance attention.'];
  return { tool: 'maintenance_attention', title: 'Devices needing maintenance attention', facts: ['Ranked by open alerts, predicted risk, recent breaches, offline state and missing security firmware:', ...lines].join('\n'),
    asOf: iso(), simulated: pick.some((r) => r.device.simulated), data: pick.map((r) => ({ ...r.device, score: r.score, reasons: r.reasons })) };
}

export async function modelInfo(): Promise<ToolResult> {
  const versions = (await col('model_versions').find({ isActive: true }, { projection: { model: 0 } }).sort({ scope: 1 }).toArray()).map((v) => ({ ...v, id: v._id }));
  const lines = versions.map((v: any) => `${v.scope}: v${v.version} (${v.source}), AUC ${n1(v.evaluation?.auc, 2)}, precision ${n1((v.evaluation?.precision ?? 0) * 100, 0)}%, recall ${n1((v.evaluation?.recall ?? 0) * 100, 0)}%, trained on ${v.samples} samples${v.source === 'synthetic' ? ' - synthetic data, which does not demonstrate real-world accuracy' : ''}`);
  return { tool: 'model_info', title: 'Prediction models in use', facts: ['Active prediction models (they predict threshold breaches, not equipment failures):', ...lines].join('\n'), asOf: iso(), simulated: true, data: versions };
}

/* ------------------------------------------------------------------ device-level tools */

export async function deviceProfile(d: DeviceRef): Promise<ToolResult> {
  const [doc, latestFw, alerts, maint] = await Promise.all([
    col('devices').findOne({ _id: d.id as any }, { projection: { apiKeyHash: 0, apiKey: 0 } }),
    latestFirmwareByType(),
    col('alerts').find({ deviceId: d.id, status: { $ne: 'resolved' } }).sort({ createdAt: -1 }).limit(rows()).toArray(),
    col('maintenance_records').find({ deviceId: d.id }, { projection: { kind: 1, summary: 1, performedAt: 1 } }).sort({ performedAt: -1 }).limit(5).toArray(),
  ]);
  const row = { ...doc, id: d.id, latestFirmware: latestFw.get(doc?.type) ?? null };
  const latestRaw = await redis.get(keys.latest(d.id));
  const latest = latestRaw ? JSON.parse(latestRaw) : null;
  const readings = latest ? METRIC_KEYS.filter((k) => typeof latest[k] === 'number').map((k) => `${METRICS[k].label} ${n1(latest[k])}${unitOf(k)}`).join(', ') : 'none';
  const lines = [
    `${label(d)}: ${row.type} at ${row.location}; status ${row.active !== false ? row.status : 'deactivated'}; last seen ${row.lastSeen ? new Date(row.lastSeen).toISOString() : 'never'}${d.simulated ? '; simulated device' : ''}.`,
    `Firmware ${row.firmwareVersion} (latest release ${row.latestFirmware ?? 'unknown'}${row.latestFirmware && compareVersions(row.firmwareVersion, row.latestFirmware) < 0 ? ', update available' : ''}).`,
    `Latest readings: ${readings}.`,
    alerts.length ? `Open alerts: ${alerts.map((a: any) => `${a.severity} ${a.type}${a.metric ? ` (${a.metric})` : ''}: ${a.message}`).join(' | ')}` : 'No open alerts.',
    maint.length ? `Recent maintenance: ${maint.map((m: any) => `${new Date(m.performedAt).toISOString().slice(0, 10)} ${m.kind} - ${m.summary}`).join(' | ')}` : 'No maintenance recorded.',
  ];
  return { tool: 'device_profile', title: `Device profile: ${label(d)}`, facts: lines.join('\n'), asOf: iso(), simulated: d.simulated, device: { id: d.id, name: d.name, assetNo: d.assetNo }, data: { device: row, alerts, maintenance: maint, latest } };
}

export async function maintenanceHistory(d: DeviceRef): Promise<ToolResult> {
  const data = await col('maintenance_records').find({ deviceId: d.id }, { projection: { kind: 1, summary: 1, details: 1, performedByName: 1, performedAt: 1 } }).sort({ performedAt: -1 }).limit(rows()).toArray();
  const lines = data.length
    ? data.map((m: any) => `- ${new Date(m.performedAt).toISOString().slice(0, 10)} ${m.kind}: ${m.summary}${m.details ? ` (${m.details})` : ''} - ${m.performedByName}`)
    : ['No maintenance has been recorded for this device.'];
  return { tool: 'maintenance_history', title: `Maintenance history: ${label(d)}`, facts: lines.join('\n'), asOf: iso(), simulated: d.simulated, device: { id: d.id, name: d.name, assetNo: d.assetNo }, data };
}

export async function telemetryHistory(d: DeviceRef, metric: MetricKey | null, minutes = 60): Promise<ToolResult> {
  const mins = Math.min(Math.max(minutes, 5), 1440);
  const metricList = metric ? [metric] : METRIC_KEYS.slice();
  const since = new Date(Date.now() - mins * 60_000);
  const stats: any[] = [];
  const lines: string[] = [];
  for (const m of metricList) {
    // the field name comes from the METRIC_KEYS whitelist, never from user text
    const [s] = await col('telemetry').aggregate([
      { $match: { deviceId: d.id, ts: { $gte: since }, [m]: { $ne: null } } },
      { $group: { _id: null, n: { $sum: 1 }, lo: { $min: `$${m}` }, mean: { $avg: `$${m}` }, hi: { $max: `$${m}` } } },
    ]).toArray();
    if (!s || !s.n) continue;
    const last = await col('telemetry').find({ deviceId: d.id, [m]: { $ne: null } }, { projection: { _id: 0, v: `$${m}`, ts: 1, [m]: 1 } }).sort({ ts: -1 }).limit(1).next();
    const bucketMs = Math.max(30, (mins * 60) / 12) * 1000;
    const sample = metric
      ? (await col('telemetry').aggregate([
        { $match: { deviceId: d.id, ts: { $gte: since }, [m]: { $ne: null } } },
        { $group: { _id: { $floor: { $divide: [{ $toLong: '$ts' }, bucketMs] } }, v: { $avg: `$${m}` } } },
        { $sort: { _id: 1 } },
      ]).toArray()).map((p) => ({ t: new Date((p._id as number) * bucketMs), v: p.v as number }))
      : [];
    stats.push({ metric: m, n: s.n, lo: s.lo, mean: s.mean, hi: s.hi, last: last?.[m], sample });
    lines.push(`${METRICS[m].label} over the last ${mins} min: min ${n1(s.lo)}${unitOf(m)}, average ${n1(s.mean)}${unitOf(m)}, max ${n1(s.hi)}${unitOf(m)}, latest ${n1(last?.[m])}${unitOf(m)} (${s.n} readings)`);
    if (sample.length) lines.push(`  trend: ${sample.map((p) => `${p.t.toISOString().slice(11, 16)}Z ${n1(p.v)}`).join(', ')}`);
  }
  if (!lines.length) lines.push('No readings were stored for that signal in the requested period.');
  return { tool: 'telemetry_history', title: `${metric ? METRICS[metric].label : 'Telemetry'} history: ${label(d)}`, facts: lines.join('\n'), asOf: iso(), simulated: d.simulated, device: { id: d.id, name: d.name, assetNo: d.assetNo }, data: stats };
}

export async function anomalyHistory(d: DeviceRef): Promise<ToolResult> {
  const [snaps, alerts] = await Promise.all([
    listPredictionHistory({ deviceId: d.id, limit: 10 }),
    col('alerts').find({ deviceId: d.id, type: 'predictive' }, { projection: { severity: 1, metric: 1, message: 1, status: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(10).toArray(),
  ]);
  const lines = [
    snaps.length
      ? `Stored predictions (most recent first): ${snaps.map((s: any) => `${new Date(s.createdAt).toISOString().slice(11, 19)}Z ${s.metric} ${(s.probability * 100).toFixed(0)}% (${s.level}), ${fmtEta(s.secondsToBreach)}, model ${s.modelScope} ${s.modelVersion}`).join(' | ')}`
      : 'No at-risk predictions have been stored for this device.',
    alerts.length ? `Predictive alerts: ${alerts.map((a: any) => `${new Date(a.createdAt).toISOString().slice(0, 16)}Z ${a.message} [${a.status}]`).join(' | ')}` : 'No predictive alerts for this device.',
  ];
  return { tool: 'anomaly_history', title: `Anomaly history: ${label(d)}`, facts: lines.join('\n'), asOf: iso(), simulated: d.simulated, device: { id: d.id, name: d.name, assetNo: d.assetNo }, data: { snapshots: snaps, alerts } };
}

/**
 * Everything needed to explain why a device has its current risk, taken from the same prediction code that
 * raises the alerts. Feature contributions are exact (the model is linear); nothing is estimated by the LLM.
 */
export async function explainPrediction(d: DeviceRef, metric: MetricKey | null): Promise<ToolResult> {
  const [{ points, prediction }, rules] = await Promise.all([predictDevice(d.id, d.type), rulesForType(d.type)]);
  const m = (metric ? prediction.metrics.find((x) => x.metric === metric) : prediction.metrics[0]);
  if (!m) {
    return { tool: 'explain_prediction', title: `Prediction explanation: ${label(d)}`, facts: `${label(d)} has too few recent readings (fewer than 8 per signal) for the model to produce a prediction${metric ? ` for ${METRICS[metric].label}` : ''}.`,
      asOf: iso(), simulated: d.simulated, device: { id: d.id, name: d.name, assetNo: d.assetNo }, data: null };
  }
  const e = m.explanation;
  const u = unitOf(m.metric);
  const recent = points.slice(-6).map((p) => p[m.metric]).filter((v): v is number => typeof v === 'number');
  const limits = rules.filter((r) => r.metric === m.metric).map((r) => `${r.severity} ${r.operator} ${r.threshold}${u}${r.enabled ? '' : ' (disabled)'}`).join(', ');
  const lines = [
    `${label(d)} (${d.type})${d.simulated ? ', simulated device' : ''}: ${METRICS[m.metric].label} is ${n1(m.current)}${u}.`,
    `Configured limits for this machine type: ${limits}. The model forecasts against the ${m.threshold}${u} limit (a breach means going ${e.direction} it).`,
    `Noise-free trend ${n1(e.fittedLevel)}${u}; headroom ${e.headroom >= 0 ? `${n1(e.headroom)}${u} left` : `${n1(-e.headroom)}${u} already beyond`}; slope ${n1(e.slopePerMin)}${u}/min; reading noise (std) ${n1(e.noise, 2)}${u}; ${e.readingsUsed} recent readings used.`,
    `Horizon: ${e.horizonReadings} readings ahead = about ${Math.round(e.horizonSeconds)} s (observed interval ${n1(e.readingIntervalSeconds)} s).`,
    `Model: ${e.model.scope} ${e.model.version}, trained on ${e.model.source} data, held-out AUC ${n1(e.model.auc, 2)}.`,
    `Model probability that the threshold is crossed within the horizon: ${(e.modelProbability * 100).toFixed(1)}%; reported risk ${(m.probability * 100).toFixed(1)}% (${m.level}); ${fmtEta(m.secondsToBreach)}; straight-line ETA ${e.linearEtaSeconds === null ? 'none (not moving toward the limit)' : fmtEta(e.linearEtaSeconds)}.`,
    `Feature contributions to the log-odds (bias ${n1(e.bias, 2)}, total ${n1(e.logit, 2)}): ${e.features.map((f) => `${f.name} ${f.contribution >= 0 ? '+' : ''}${f.contribution.toFixed(2)}`).join('; ')}.`,
    e.adjustmentNote ? `Note: ${e.adjustmentNote}` : '',
    `Most recent readings (oldest to newest): ${recent.map((v) => n1(v)).join(', ')}${u}.`,
    'Remember: this is a probability of crossing a configured threshold, not of equipment failure.',
  ].filter(Boolean);
  return { tool: 'explain_prediction', title: `Prediction explanation: ${label(d)} - ${METRICS[m.metric].label}`, facts: lines.join('\n'), asOf: iso(), simulated: d.simulated, device: { id: d.id, name: d.name, assetNo: d.assetNo }, data: { forecast: { ...m, forecast: undefined }, recent } };
}
