export const METRIC_KEYS = ['temperature', 'cpu', 'memory', 'battery', 'signal'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export type Metrics = Record<MetricKey, number | null>;

/**
 * dir  =  1: higher is worse (breach when value rises above threshold)
 * dir  = -1: lower is worse  (breach when value falls below threshold)
 * range: typical operating span, used to normalise features across metrics
 */
export const METRICS: Record<MetricKey, { label: string; unit: string; dir: 1 | -1; range: number }> = {
  temperature: { label: 'Temperature', unit: '°C', dir: 1, range: 50 },
  cpu: { label: 'CPU load', unit: '%', dir: 1, range: 100 },
  memory: { label: 'Memory use', unit: '%', dir: 1, range: 100 },
  battery: { label: 'Battery', unit: '%', dir: -1, range: 100 },
  signal: { label: 'Signal strength', unit: ' dBm', dir: -1, range: 60 },
};
