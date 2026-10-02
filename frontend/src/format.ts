import { METRIC_META, MetricKey } from './api';

export function timeAgo(iso: string | number | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function eta(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '-';
  if (sec <= 0) return 'now';
  if (sec < 90) return `~${Math.round(sec)}s`;
  if (sec < 5400) return `~${(sec / 60).toFixed(1)} min`;
  return `~${(sec / 3600).toFixed(1)} h`;
}

export function fmtMetric(key: MetricKey, v: number | null | undefined): string {
  if (v === null || v === undefined) return '-';
  const m = METRIC_META[key];
  return `${v.toFixed(m.digits)}${m.unit}`;
}

export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const clock = (iso: string | number) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
