import { useQuery } from '@tanstack/react-query';
import { isPushConnected } from './live';

export type Status = 'online' | 'offline' | 'degraded';
export type MetricKey = 'temperature' | 'cpu' | 'memory' | 'battery' | 'signal' | 'vibration' | 'pressure' | 'current';
export type Severity = 'info' | 'warning' | 'critical';
export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type RiskLevel = 'low' | 'elevated' | 'high' | 'breached';

export const METRIC_KEYS: MetricKey[] = ['temperature', 'cpu', 'memory', 'battery', 'signal', 'vibration', 'pressure', 'current'];
export const METRIC_META: Record<MetricKey, { label: string; unit: string; digits: number }> = {
  temperature: { label: 'Temperature', unit: '°C', digits: 1 },
  cpu: { label: 'CPU load', unit: '%', digits: 0 },
  memory: { label: 'Memory use', unit: '%', digits: 0 },
  battery: { label: 'Battery', unit: '%', digits: 0 },
  signal: { label: 'Signal strength', unit: ' dBm', digits: 0 },
  vibration: { label: 'Vibration', unit: ' mm/s', digits: 1 },
  pressure: { label: 'Pressure', unit: ' bar', digits: 1 },
  current: { label: 'Motor current', unit: ' A', digits: 1 },
};

export type Reading = Record<MetricKey, number | null>;
export interface LatestReading extends Reading { ts: number }

export interface Device {
  id: string; assetNo: number; active: boolean; name: string; type: string; location: string; ipAddress: string | null;
  firmwareVersion: string; status: Status; simulated: boolean; lastSeen: string | null; createdAt: string;
  openAlerts: number; latestFirmware: string | null; outdated: boolean; latest: LatestReading | null; apiKey?: string;
}
export interface DeviceType {
  id: number; name: string; description: string; metrics: MetricKey[]; baselines: Partial<Record<MetricKey, number>>;
  deviceCount: number; model: { scope: string; source: string; samples: number; trainedAt: string } | null;
}
export interface Alert {
  id: number; deviceId: string; type: 'threshold' | 'heartbeat' | 'predictive'; severity: Severity; metric: MetricKey | null;
  message: string; value: number | null; status: 'open' | 'acknowledged' | 'resolved'; createdAt: string; resolvedAt: string | null;
  deviceName: string; deviceType: string;
}
export interface Incident {
  id: number; deviceId: string | null; deviceName: string | null; category: string; severity: IncidentSeverity;
  description: string; status: 'open' | 'investigating' | 'resolved'; createdAt: string; updatedAt: string;
}
export interface Rule {
  id: number; metric: MetricKey; operator: '>' | '<'; threshold: number; severity: 'warning' | 'critical'; enabled: boolean;
  deviceType: string | null; inherited?: boolean;
}
export interface Release { id: number; deviceType: string; version: string; notes: string; securityPatch: boolean; releasedAt: string; deviceCount: number }
export interface Compliance { id: string; name: string; type: string; status: Status; current: string; latest: string | null; outdated: boolean; missedSecurityReleases: number }
export interface FwUpdate { id: number; deviceId: string; deviceName: string; deviceType: string; fromVersion: string; toVersion: string; status: 'in_progress' | 'completed' | 'failed'; progress: number; createdAt: string; updatedAt: string }

export interface FeatureContribution { name: string; value: number; standardized: number; weight: number; contribution: number }
export interface Explanation {
  measure: 'threshold-breach';
  model: { scope: string; version: string; source: 'synthetic' | 'telemetry'; auc: number; trainedAt: string };
  threshold: number; direction: 'above' | 'below'; current: number; fittedLevel: number; headroom: number; slopePerMin: number; noise: number;
  readingsUsed: number; horizonReadings: number; horizonSeconds: number; readingIntervalSeconds: number;
  features: FeatureContribution[]; bias: number; logit: number; modelProbability: number;
  adjusted: boolean; adjustmentNote: string | null; linearEtaSeconds: number | null;
}
export interface MetricForecast {
  metric: MetricKey; label: string; unit: string; current: number; threshold: number; probability: number; level: RiskLevel;
  breached: boolean; secondsToBreach: number | null; slopePerMin: number;
  forecast?: { t: number; value: number; lo: number; hi: number }[];
  explanation?: Explanation; modelVersion?: string; modelSource?: 'synthetic' | 'telemetry';
}
export interface Maintenance {
  id: number; deviceId: string; kind: 'inspection' | 'repair' | 'replacement' | 'calibration' | 'firmware' | 'activation' | 'note';
  summary: string; details: string; performedByName: string; performedAt: string; createdAt: string;
}
export interface PredictionSnapshot {
  id: number; deviceId: string; deviceName: string; assetNo: number; deviceType: string; metric: MetricKey; probability: number; level: RiskLevel;
  secondsToBreach: number | null; threshold: number; currentValue: number; slopePerMin: number | null;
  modelScope: string; modelVersion: string; modelSource: 'synthetic' | 'telemetry'; explanation: Explanation; createdAt: string;
}
export interface ModelVersion {
  id: number; scope: string; version: number; source: 'synthetic' | 'telemetry'; samples: number; evaluation: Evaluation;
  previousEvaluation: Evaluation | null; activated: boolean; isActive: boolean; reason: string; trainedBy: string; trainedAt: string;
}
export interface AuditRow {
  id: number; userId: string | null; userEmail: string | null; action: string; entity: string | null; entityId: string | null;
  details: Record<string, unknown>; ip: string | null; createdAt: string;
}
export interface FleetPrediction {
  deviceId: string; name: string; type: string; location: string; status: Status;
  riskScore: number; level: RiskLevel; topMetric: MetricKey | null; secondsToBreach: number | null; metrics: MetricForecast[];
}
export interface DevicePrediction {
  device: { id: string; assetNo: number; name: string; type: string; location: string; status: Status; active: boolean };
  points: (Reading & { ts: number })[];
  prediction: { riskScore: number; level: RiskLevel; topMetric: MetricKey | null; secondsToBreach: number | null; sampleCount: number; metrics: MetricForecast[] };
}
export interface Evaluation { accuracy: number; precision: number; recall: number; f1: number; auc: number; brier: number; avgLeadReadings: number; positiveRate: number }
export interface ModelCard {
  version: string; trainedAt: string; algorithm: string; window: number; horizon: number; trainSize: number; testSize: number;
  scope: string; requestedScope: string; fallback: boolean; source: 'synthetic' | 'telemetry';
  alertProbability: number; parameterCount: number; features: { name: string; weight: number }[]; evaluation: Evaluation;
}
export interface ModelScope { scope: string; source: 'synthetic' | 'telemetry'; samples: number; trainedAt: string; auc: number | null; own: boolean }
export interface RetrainResult {
  scope: string; version: number; activated: boolean; reason: string; samples: { train: number; test: number; positives: number; purged: number };
  evaluation: Evaluation; previous: Evaluation;
}
export interface Summary {
  type: string | null;
  totals: { online: number; degraded: number; offline: number; all: number; inactive: number };
  alerts: { severity: Severity; type: string; count: number }[];
  incidents: { severity: IncidentSeverity; count: number }[];
  firmwareOutdated: number;
  alertTrend: { minute: string; type: string; count: number }[];
  activity: { kind: 'alert' | 'incident'; id: number; severity: string; text: string; deviceName: string; createdAt: string }[];
}
export interface IncidentSummary {
  bySeverity: { severity: IncidentSeverity; count: number }[];
  byCategory: { category: string; count: number }[];
  byStatus: { status: string; count: number }[];
  trend: { hour: string; count: number }[];
}
export interface TelemetryRow extends Reading { ts: string }
export interface Webhook {
  id: number; name: string; url: string; events: string[]; enabled: boolean; createdAt: string;
  lastDelivery: { ok: boolean; statusCode: number | null; error: string | null; createdAt: string } | null; secret?: string;
}
export interface Delivery { id: number; event: string; ok: boolean; statusCode: number | null; error: string | null; durationMs: number; createdAt: string }
export interface UserRow { id: string; email: string; name: string; role: 'admin' | 'viewer'; createdAt: string }

/* ---------- auth + simulator + history types ---------- */
export interface User { id: string; email: string; name: string; role: 'admin' | 'viewer' }
export interface SimStatus { enabled: boolean; running: boolean; devices: number; activeFaults: number }
export interface Readings { rangeSeconds: number; bucketSeconds: number; points: (Reading & { ts: string })[] }

const TOKEN_KEY = 'iot-token';
let token: string | null = null;
let onUnauthorized: (() => void) | null = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage unavailable */ }

export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
}
export const setUnauthorizedHandler = (fn: (() => void) | null) => { onUnauthorized = fn; };

const authHeader = (): Record<string, string> => (token ? { Authorization: 'Bearer ' + token } : {});

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json', ...authHeader() }, ...init });
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/register')) onUnauthorized?.();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  get: <T>(p: string) => req<T>(p),
  post: <T>(p: string, body?: unknown) => req<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(p: string, body: unknown) => req<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(p: string, body: unknown) => req<T>(p, { method: 'PUT', body: JSON.stringify(body) }),
  del: (p: string) => req<void>(p, { method: 'DELETE' }),
};

/** Download an authenticated CSV export (a plain link cannot carry the sign-in header). */
export async function downloadCsv(path: string, filename: string) {
  const res = await fetch(`/api${path}`, { headers: authHeader() });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Keep a screen live. Normally this polls; while the push stream is connected, polling slows to a
 * 20-second safety net because the server tells the app exactly when to refetch.
 */
export function useLive<T>(path: string, interval: number | false = 3000, enabled = true) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => api.get<T>(path),
    refetchInterval: interval === false ? false : () => (isPushConnected() ? Math.max(interval * 6, 20000) : interval),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/* ---------- knowledge base + assistant ---------- */
export interface KbDocument {
  id: string; ownerId: string | null; ownerName: string | null; source: 'upload' | 'system'; title: string; originalName: string; mime: string;
  sizeBytes: number; visibility: 'private' | 'shared'; status: 'queued' | 'processing' | 'ready' | 'failed'; error: string | null; attempts: number;
  pages: number | null; chunkCount: number; embeddingModel: string | null; createdAt: string; updatedAt: string; ingestedAt: string | null; canEdit: boolean;
  chunkPreview?: { chunkIndex: number; page: number | null; section: string | null; charCount: number; preview: string }[];
}
export interface ProviderHealth {
  ok: boolean; provider?: string; error?: string; version?: string;
  chatModel?: { name: string; available: boolean }; embedModel?: { name: string; available: boolean; dimension?: number; dimensionOk?: boolean };
}
export interface KbStatus {
  enabled: boolean; provider: ProviderHealth;
  documents: { total: number; ready: number; queued: number; processing: number; failed: number };
  limits: { maxUploadMb: number; chunkSize: number; chunkOverlap: number; types: string[] };
}
export interface KbHit { documentId: string; title: string; filename: string; source: string; page: number | null; section: string | null; excerpt: string; score: number }
export interface KbSearch { mode: 'hybrid' | 'keyword'; note: string | null; results: KbHit[] }

export interface ChatSource {
  id: string; type: 'document' | 'database'; title: string; excerpt: string; cited?: boolean; timestamp?: string; simulated?: boolean; tool?: string;
  document?: { id: string; filename: string; page: number | null; section: string | null; origin: 'upload' | 'system' };
  device?: { id: string; name: string; assetNo: number };
}
export interface ToolCallInfo { tool: string; args: Record<string, unknown>; ok: boolean; ms: number; error?: string }
export interface ChatMsg {
  id: number | string; role: 'user' | 'assistant'; content: string; sources: ChatSource[]; toolCalls: ToolCallInfo[];
  model: string | null; latencyMs: number | null; error: string | null; createdAt: string; pending?: boolean;
}
export interface Conversation {
  id: string; title: string; deviceId: string | null; deviceName: string | null; assetNo: number | null; createdAt: string; updatedAt: string;
  messageCount?: number; preview?: string | null; messages?: ChatMsg[];
}
export interface AssistantHealth {
  enabled: boolean; provider: ProviderHealth; suggestions: string[];
  documents: { ready: number; queued: number; processing: number; failed: number };
}

/** Upload a file with extra form fields (the JSON content-type header must not be set for multipart). */
export async function uploadForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: authHeader(), body: form });
  if (res.status === 401) onUnauthorized?.();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

/** Download any authenticated file (the sign-in header cannot ride on a plain link). */
export async function downloadFile(path: string, filename: string) {
  const res = await fetch(`/api${path}`, { headers: authHeader() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Download failed (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface StreamHandlers {
  onMeta?: (m: { sources: ChatSource[]; toolCalls: ToolCallInfo[]; kind: string; truncated: boolean }) => void;
  onToken?: (text: string) => void;
  onError?: (message: string) => void;
  onDone?: (d: { messageId: number; text: string; sources: ChatSource[]; cited: string[]; invalidCitations: string[]; uncited: boolean; error: string | null }) => void;
}

/**
 * POST a question and read the streamed answer (server-sent events over fetch, so the sign-in header can be sent).
 * Failures before streaming starts (provider down, rate limit) come back as a normal JSON error and are thrown.
 */
export async function streamAnswer(path: string, body: unknown, h: StreamHandlers, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeader() }, body: JSON.stringify(body ?? {}), signal });
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const name = /^event: (.*)$/m.exec(block)?.[1];
      const raw = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('');
      if (!raw) continue;
      let data: any;
      try { data = JSON.parse(raw); } catch { continue; }
      if (name === 'meta') h.onMeta?.(data);
      else if (name === 'token') h.onToken?.(data.text);
      else if (name === 'error') h.onError?.(data.message);
      else if (name === 'done') h.onDone?.(data);
    }
  }
}
