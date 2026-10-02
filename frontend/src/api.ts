import { useQuery } from '@tanstack/react-query';

export type Status = 'online' | 'offline' | 'degraded';
export type MetricKey = 'temperature' | 'cpu' | 'memory' | 'battery' | 'signal';
export type Severity = 'info' | 'warning' | 'critical';
export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type RiskLevel = 'low' | 'elevated' | 'high' | 'breached';

export const METRIC_KEYS: MetricKey[] = ['temperature', 'cpu', 'memory', 'battery', 'signal'];
export const METRIC_META: Record<MetricKey, { label: string; unit: string; digits: number }> = {
  temperature: { label: 'Temperature', unit: '°C', digits: 1 },
  cpu: { label: 'CPU load', unit: '%', digits: 0 },
  memory: { label: 'Memory use', unit: '%', digits: 0 },
  battery: { label: 'Battery', unit: '%', digits: 0 },
  signal: { label: 'Signal strength', unit: ' dBm', digits: 0 },
};
export const DEVICE_TYPES = ['Smart Sensor', 'Asset Tracker', 'Gateway', 'IP Camera', 'Smart Meter', 'Industrial Controller'];

export type Reading = Record<MetricKey, number | null>;
export interface LatestReading extends Reading { ts: number }

export interface Device {
  id: string; name: string; type: string; location: string; ipAddress: string | null;
  firmwareVersion: string; status: Status; simulated: boolean; lastSeen: string | null; createdAt: string;
  openAlerts: number; latestFirmware: string | null; outdated: boolean; latest: LatestReading | null; apiKey?: string;
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
export interface Rule { id: number; metric: MetricKey; operator: '>' | '<'; threshold: number; severity: 'warning' | 'critical'; enabled: boolean }
export interface Release { id: number; deviceType: string; version: string; notes: string; securityPatch: boolean; releasedAt: string; deviceCount: number }
export interface Compliance { id: string; name: string; type: string; status: Status; current: string; latest: string | null; outdated: boolean; missedSecurityReleases: number }
export interface FwUpdate { id: number; deviceId: string; deviceName: string; deviceType: string; fromVersion: string; toVersion: string; status: 'in_progress' | 'completed' | 'failed'; progress: number; createdAt: string; updatedAt: string }

export interface MetricForecast {
  metric: MetricKey; label: string; unit: string; current: number; threshold: number; probability: number; level: RiskLevel;
  breached: boolean; secondsToBreach: number | null; slopePerMin: number;
  forecast?: { t: number; value: number; lo: number; hi: number }[];
}
export interface FleetPrediction {
  deviceId: string; name: string; type: string; location: string; status: Status;
  riskScore: number; level: RiskLevel; topMetric: MetricKey | null; secondsToBreach: number | null; metrics: MetricForecast[];
}
export interface DevicePrediction {
  device: { id: string; name: string; type: string; location: string; status: Status };
  points: (Reading & { ts: number })[];
  prediction: { riskScore: number; level: RiskLevel; topMetric: MetricKey | null; secondsToBreach: number | null; sampleCount: number; metrics: MetricForecast[] };
}
export interface ModelCard {
  version: string; trainedAt: string; algorithm: string; window: number; horizon: number; trainSize: number; testSize: number;
  alertProbability: number; parameterCount: number; features: { name: string; weight: number }[];
  evaluation: { accuracy: number; precision: number; recall: number; f1: number; auc: number; brier: number; avgLeadReadings: number; positiveRate: number };
}
export interface Summary {
  totals: { online: number; degraded: number; offline: number; all: number };
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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
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

/** Poll an endpoint so the console stays live without a page refresh. */
export function useLive<T>(path: string, interval: number | false = 3000, enabled = true) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => api.get<T>(path),
    refetchInterval: interval,
    enabled,
    placeholderData: (prev) => prev,
  });
}
