import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { METRIC_META, MetricForecast, MetricKey } from '../api';

interface Props {
  metric: MetricKey;
  /** [secondsFromNow (<=0), value] */
  history: { t: number; value: number }[];
  forecast?: MetricForecast;
  threshold?: number;
  height?: number;
}

/** History (solid), model forecast (dashed + confidence band) and the alert threshold (red line). */
export default function ForecastChart({ metric, history, forecast, threshold, height = 210 }: Props) {
  const meta = METRIC_META[metric];
  const last = history[history.length - 1];
  const rows: any[] = history.map((h) => ({ t: h.t, value: h.value }));
  if (forecast?.forecast && last) {
    forecast.forecast.forEach((f, i) =>
      rows.push({ t: f.t, forecast: f.value, band: [Math.min(f.lo, f.hi), Math.max(f.lo, f.hi)], ...(i === 0 ? { value: last.value } : {}) }),
    );
  }
  const limit = threshold ?? forecast?.threshold;
  const risky = forecast && (forecast.level === 'high' || forecast.level === 'breached');
  const lineColor = risky ? 'var(--crit)' : 'var(--accent)';

  const vals = rows.flatMap((r) => [r.value, r.forecast, ...(r.band ?? [])]).filter((v) => typeof v === 'number') as number[];
  if (limit !== undefined) vals.push(limit);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(1, (hi - lo) * 0.12);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickCount={6} stroke="var(--muted)" fontSize={11} tickLine={false}
          tickFormatter={(t: number) => (Math.abs(t) < 0.5 ? 'now' : Math.abs(t) >= 90 ? `${(t / 60).toFixed(1)}m` : `${t > 0 ? '+' : ''}${Math.round(t)}s`)} />
        <YAxis domain={[Math.floor(lo - pad), Math.ceil(hi + pad)]} stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
        <Tooltip
          contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
          labelFormatter={(t) => (Number(t) <= 0 ? `${Math.abs(Math.round(Number(t)))}s ago` : `in ${Math.round(Number(t))}s (forecast)`)}
          formatter={(v: any, name) => (Array.isArray(v) ? [`${v[0].toFixed(1)} – ${v[1].toFixed(1)}`, 'Confidence band'] : [`${Number(v).toFixed(1)}${meta.unit}`, name === 'forecast' ? 'Forecast' : meta.label])}
        />
        {limit !== undefined && <ReferenceLine y={limit} stroke="var(--crit)" strokeDasharray="5 4" label={{ value: `limit ${limit}${meta.unit.trim()}`, fill: 'var(--crit)', fontSize: 11, position: 'insideTopLeft' }} />}
        <ReferenceLine x={0} stroke="var(--muted)" strokeOpacity={0.5} />
        <Area type="monotone" dataKey="band" stroke="none" fill="var(--pred)" fillOpacity={0.18} isAnimationActive={false} connectNulls />
        <Line type="monotone" dataKey="value" stroke={lineColor} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
        <Line type="linear" dataKey="forecast" stroke="var(--pred)" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export const ChartLegend = () => (
  <div className="legend">
    <span><i style={{ borderColor: 'var(--accent)' }} />Measured</span>
    <span><i className="dash" style={{ borderColor: 'var(--pred)' }} />Model forecast</span>
    <span><i className="fill" style={{ background: 'var(--pred)' }} />Confidence band</span>
    <span><i className="dash" style={{ borderColor: 'var(--crit)' }} />Alert limit</span>
  </div>
);
