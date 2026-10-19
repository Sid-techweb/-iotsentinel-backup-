export const METRIC_KEYS = ['temperature', 'cpu', 'memory', 'battery', 'signal', 'vibration', 'pressure', 'current'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export type Metrics = Record<MetricKey, number | null>;

/**
 * dir  =  1: higher is worse (breach when value rises above threshold)
 * dir  = -1: lower is worse  (breach when value falls below threshold)
 * range: typical operating span, used to normalise features across metrics
 * Which of these signals a machine actually reports is decided by its machine type.
 */
export const METRICS: Record<MetricKey, { label: string; unit: string; dir: 1 | -1; range: number }> = {
  temperature: { label: 'Temperature', unit: '°C', dir: 1, range: 50 },
  cpu: { label: 'CPU load', unit: '%', dir: 1, range: 100 },
  memory: { label: 'Memory use', unit: '%', dir: 1, range: 100 },
  battery: { label: 'Battery', unit: '%', dir: -1, range: 100 },
  signal: { label: 'Signal strength', unit: ' dBm', dir: -1, range: 60 },
  vibration: { label: 'Vibration', unit: ' mm/s', dir: 1, range: 12 },
  pressure: { label: 'Pressure', unit: ' bar', dir: 1, range: 10 },
  current: { label: 'Motor current', unit: ' A', dir: 1, range: 30 },
};

export const emptyMetrics = (): Metrics =>
  Object.fromEntries(METRIC_KEYS.map((k) => [k, null])) as Metrics;

/** Sensible simulator starting values when a machine type does not define its own. */
export const DEFAULT_BASELINE: Record<MetricKey, number> = {
  temperature: 40, cpu: 30, memory: 50, battery: 80, signal: -60, vibration: 3, pressure: 5, current: 12,
};
