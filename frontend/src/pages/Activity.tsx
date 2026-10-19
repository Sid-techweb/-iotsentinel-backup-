import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Alert, Device, METRIC_KEYS, METRIC_META, MetricKey, Readings, Rule, TelemetryRow, useLive } from '../api';
import { Badge, Card, Empty, PageHead, SeverityBadge } from '../components/ui';
import { clock, fmtMetric, timeAgo } from '../format';

const RANGES = [['15m', '15 min'], ['1h', '1 hour'], ['6h', '6 hours'], ['24h', '24 hours']] as const;
const STORE_KEY = 'iot-activity-device';
const TYPE_COLOR = { threshold: 'var(--warn)', heartbeat: 'var(--crit)', predictive: 'var(--pred)' } as const;

const readStored = () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } };

export default function Activity() {
  const { data: devices } = useLive<Device[]>('/devices', 15000);
  const [deviceId, setDeviceId] = useState<string | null>(readStored());
  const [range, setRange] = useState<(typeof RANGES)[number][0]>('1h');

  // remember the chosen device between visits; fall back to the first device
  const selected = devices?.find((d) => d.id === deviceId) ?? devices?.[0];
  useEffect(() => {
    if (selected) try { localStorage.setItem(STORE_KEY, selected.id); } catch { /* storage unavailable */ }
  }, [selected]);

  const id = selected?.id ?? '';
  const { data: hist } = useLive<Readings>(`/devices/${id}/readings?range=${range}`, 5000, !!id);
  const { data: rules } = useLive<Rule[]>('/rules', false);

  const metrics = METRIC_KEYS.filter((k) => hist?.points.some((p) => p[k] !== null));

  return (
    <>
      <PageHead title="Activity" desc="Investigate what happened to a device - history, alert lifecycle and raw readings.">
        <select className="input" value={selected?.id ?? ''} onChange={(e) => setDeviceId(e.target.value)} aria-label="Device">
          {devices?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <div className="chips">
          {RANGES.map(([v, l]) => <button key={v} className={`chip ${range === v ? 'on' : ''}`} onClick={() => setRange(v)}>{l}</button>)}
        </div>
      </PageHead>

      {!selected ? <Empty>No devices yet.</Empty> : (
        <div className="stack">
          <div className="grid g2">
            {metrics.map((k) => <MetricHistory key={k} metric={k} readings={hist!} rules={(rules ?? []).filter((r) => r.metric === k && r.enabled)} />)}
            {hist && !metrics.length && <Card><Empty>No readings in this window.</Empty></Card>}
          </div>
          <Lifecycle deviceId={selected.id} rangeSeconds={hist?.rangeSeconds ?? 3600} />
          <RawReadings device={selected} />
        </div>
      )}
    </>
  );
}

function MetricHistory({ metric, readings, rules }: { metric: MetricKey; readings: Readings; rules: Rule[] }) {
  const meta = METRIC_META[metric];
  const data = readings.points.filter((p) => p[metric] !== null).map((p) => ({ t: new Date(p.ts).getTime(), v: p[metric] as number }));
  const vals = [...data.map((d) => d.v), ...rules.map((r) => r.threshold)];
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = Math.max(1, (hi - lo) * 0.1);
  const last = data[data.length - 1]?.v;
  return (
    <Card title={meta.label} sub={`averaged per ${readings.bucketSeconds}s`} action={last !== undefined && <b>{last.toFixed(meta.digits)}{meta.unit}</b>}>
      <ResponsiveContainer width="100%" height={190}>
        <LineChart data={data} margin={{ top: 6, right: 12, left: -10, bottom: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={clock} stroke="var(--muted)" fontSize={11} tickLine={false} tickCount={5} />
          <YAxis domain={[Math.floor(lo - pad), Math.ceil(hi + pad)]} stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
          <Tooltip contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
            labelFormatter={(t) => new Date(Number(t)).toLocaleString()} formatter={(v) => [`${Number(v).toFixed(meta.digits)}${meta.unit}`, meta.label]} />
          {rules.map((r) => <ReferenceLine key={r.id} y={r.threshold} stroke={r.severity === 'critical' ? 'var(--crit)' : 'var(--warn)'} strokeDasharray="5 4" />)}
          <Line type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}

/** Each alert drawn as a bar from "started" to "resolved" (or still active) on the selected time window. */
function Lifecycle({ deviceId, rangeSeconds }: { deviceId: string; rangeSeconds: number }) {
  const { data } = useLive<Alert[]>(`/alerts?deviceId=${deviceId}&rangeSec=${rangeSeconds}`, 5000);
  const now = Date.now();
  const winStart = now - rangeSeconds * 1000;
  const rows = (data ?? []).filter((a) => new Date(a.createdAt).getTime() < now).slice(0, 14);
  return (
    <Card title="Alert lifecycle" sub="Started → active → resolved" flush
      action={<div className="legend">{Object.entries(TYPE_COLOR).map(([t, c]) => <span key={t}><i style={{ borderColor: c }} />{t}</span>)}</div>}>
      {!rows.length ? <Empty>No alerts in this window.</Empty> : (
        <div className="lifecycle">
          {rows.map((a) => {
            const start = Math.max(new Date(a.createdAt).getTime(), winStart);
            const end = a.resolvedAt ? new Date(a.resolvedAt).getTime() : now;
            const left = ((start - winStart) / (rangeSeconds * 1000)) * 100;
            const width = Math.max(1, ((end - start) / (rangeSeconds * 1000)) * 100);
            return (
              <div className="lc-row" key={a.id}>
                <div className="lc-label"><SeverityBadge severity={a.severity} /> <span className="small">{a.message}</span></div>
                <div className="lc-track" title={`${a.status} · started ${timeAgo(a.createdAt)}`}>
                  <span className="lc-bar" style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, background: TYPE_COLOR[a.type], opacity: a.resolvedAt ? 0.55 : 1 }} />
                </div>
                <div className="lc-state"><Badge tone={a.resolvedAt ? 'ok' : a.status === 'acknowledged' ? 'warn' : 'crit'}>{a.resolvedAt ? 'resolved' : 'active'}</Badge></div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function RawReadings({ device }: { device: Device }) {
  const { data } = useLive<TelemetryRow[]>(`/devices/${device.id}/telemetry?limit=100`, 5000);
  const rows = [...(data ?? [])].reverse();
  const shown = METRIC_KEYS.filter((k) => rows.some((r) => r[k] !== null)); // only the signals this machine type reports

  const exportCsv = () => {
    const head = ['timestamp', ...METRIC_KEYS].join(',');
    const lines = rows.map((r) => [r.ts, ...METRIC_KEYS.map((k) => r[k] ?? '')].join(','));
    const url = URL.createObjectURL(new Blob([[head, ...lines].join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${device.name}-readings.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card title="Raw readings" sub="Latest 100 readings, newest first" flush
      action={<button className="btn sm" onClick={exportCsv} disabled={!rows.length}><Download size={13} />Export CSV</button>}>
      {!rows.length ? <Empty>No readings.</Empty> : (
        <div className="table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}><table>
          <thead><tr><th>Time</th>{shown.map((k) => <th key={k} className="num">{METRIC_META[k].label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ts}>
                <td className="nowrap muted">{new Date(r.ts).toLocaleTimeString()}</td>
                {shown.map((k) => <td key={k} className="num">{fmtMetric(k, r[k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Card>
  );
}
