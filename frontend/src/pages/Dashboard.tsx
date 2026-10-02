import { AlertTriangle, BrainCircuit, Cpu, ShieldAlert, Wifi, Wrench } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { FleetPrediction, Summary, useLive } from '../api';
import { clock, eta, timeAgo } from '../format';
import { Badge, Card, Empty, ErrorBox, Kpi, PageHead, RiskBar, SeverityBadge } from '../components/ui';
import { METRIC_META } from '../api';

const STATUS_COLORS = { online: 'var(--ok)', degraded: 'var(--warn)', offline: 'var(--off)' };

export default function Dashboard() {
  const nav = useNavigate();
  const { data: s, error } = useLive<Summary>('/dashboard/summary', 3000);
  const { data: preds } = useLive<FleetPrediction[]>('/anomaly/predictions', 3000);
  if (error && !s) return <ErrorBox error={error} />;
  if (!s) return <div className="empty">Loading fleet…</div>;

  const alertTotal = s.alerts.reduce((n, a) => n + a.count, 0);
  const critical = s.alerts.filter((a) => a.severity === 'critical').reduce((n, a) => n + a.count, 0);
  const predictive = s.alerts.filter((a) => a.type === 'predictive').reduce((n, a) => n + a.count, 0);
  const incidents = s.incidents.reduce((n, a) => n + a.count, 0);
  const atRisk = (preds ?? []).filter((p) => p.level === 'high' || p.level === 'elevated');
  const healthy = s.totals.all ? Math.round((s.totals.online / s.totals.all) * 100) : 0;

  const pie = (['online', 'degraded', 'offline'] as const).map((k) => ({ name: k, value: s.totals[k] })).filter((d) => d.value > 0);

  // alert activity per minute for the last 30 minutes
  const now = new Date();
  now.setSeconds(0, 0);
  const buckets = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(now.getTime() - (29 - i) * 60000);
    return { key: d.toISOString().slice(0, 16), label: clock(d.toISOString()), threshold: 0, heartbeat: 0, predictive: 0 };
  });
  for (const r of s.alertTrend) {
    const b = buckets.find((x) => x.key === new Date(r.minute).toISOString().slice(0, 16));
    if (b) (b as any)[r.type] += r.count;
  }

  return (
    <>
      <PageHead title="Fleet overview" desc="Live health, alerts and security posture across every registered device." />

      <div className="grid kpis">
        <Kpi label="Devices" icon={<Cpu size={14} />} value={s.totals.all} note={`${s.totals.online} online · ${s.totals.degraded} degraded · ${s.totals.offline} offline`} />
        <Kpi label="Fleet availability" icon={<Wifi size={14} />} value={`${healthy}%`} tone={healthy >= 90 ? 'ok' : healthy >= 70 ? 'warn' : 'crit'} note="devices reporting normally" />
        <Kpi label="Active alerts" icon={<AlertTriangle size={14} />} value={alertTotal} tone={critical ? 'crit' : alertTotal ? 'warn' : 'ok'} note={`${critical} critical · ${predictive} predictive`} />
        <Kpi label="Predicted at risk" icon={<BrainCircuit size={14} />} value={atRisk.length} tone={atRisk.length ? 'pred' : 'ok'} note="devices the model expects to breach" />
        <Kpi label="Open incidents" icon={<ShieldAlert size={14} />} value={incidents} tone={s.incidents.some((i) => i.severity === 'critical') ? 'crit' : incidents ? 'warn' : 'ok'} note="security events to review" />
        <Kpi label="Firmware behind" icon={<Wrench size={14} />} value={s.firmwareOutdated} tone={s.firmwareOutdated ? 'warn' : 'ok'} note="devices not on latest release" />
      </div>

      <div className="grid g-main">
        <div className="stack">
          <Card title="Predicted to breach soon" sub="Anomaly model forecast - acts before the threshold alert fires"
            action={<Link className="btn sm" to="/anomaly">Open predictor</Link>} flush>
            {(preds ?? []).filter((p) => p.level !== 'low').length === 0 ? (
              <Empty>No device is trending toward a threshold right now.</Empty>
            ) : (
              <div className="table-wrap"><table>
                <thead><tr><th>Device</th><th>Metric</th><th>Risk</th><th className="num">Breach in</th></tr></thead>
                <tbody>
                  {(preds ?? []).filter((p) => p.level !== 'low').slice(0, 6).map((p) => (
                    <tr key={p.deviceId} className="click" onClick={() => nav(`/devices/${p.deviceId}`)}>
                      <td><div className="strong">{p.name}</div><div className="muted small">{p.type} · {p.location}</div></td>
                      <td>{p.topMetric ? METRIC_META[p.topMetric].label : '-'}</td>
                      <td><RiskBar p={p.riskScore} level={p.level} /></td>
                      <td className="num nowrap strong">{p.level === 'breached' ? <Badge tone="crit">breached</Badge> : eta(p.secondsToBreach)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>

          <Card title="Alert activity" sub="Last 30 minutes, by detection method">
            <ResponsiveContainer width="100%" height={190}>
              <AreaChart data={buckets} margin={{ left: -24, right: 6, top: 6 }}>
                <XAxis dataKey="label" stroke="var(--muted)" fontSize={11} tickLine={false} interval={4} />
                <YAxis stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                <Area type="monotone" dataKey="predictive" name="Predictive" stackId="1" stroke="var(--pred)" fill="var(--pred)" fillOpacity={0.35} />
                <Area type="monotone" dataKey="threshold" name="Threshold" stackId="1" stroke="var(--warn)" fill="var(--warn)" fillOpacity={0.35} />
                <Area type="monotone" dataKey="heartbeat" name="Missed heartbeat" stackId="1" stroke="var(--crit)" fill="var(--crit)" fillOpacity={0.35} />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        </div>

        <div className="stack">
          <Card title="Fleet health">
            <div className="row" style={{ justifyContent: 'center', gap: 24 }}>
              <div style={{ width: 150, height: 150, position: 'relative' }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={pie} dataKey="value" innerRadius={48} outerRadius={70} paddingAngle={3} stroke="none">
                      {pie.map((d) => <Cell key={d.name} fill={STATUS_COLORS[d.name]} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', pointerEvents: 'none' }}>
                  <div><div style={{ fontSize: 26, fontWeight: 700 }}>{s.totals.all}</div><div className="muted small">devices</div></div>
                </div>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {(['online', 'degraded', 'offline'] as const).map((k) => (
                  <div key={k} className="row" style={{ gap: 8 }}>
                    <i className="dot" style={{ color: STATUS_COLORS[k] }} /><span style={{ width: 70 }}>{k}</span><b>{s.totals[k]}</b>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Card title="Live activity" sub="Newest alerts and security events" flush>
            <ul className="feed">
              {s.activity.map((a) => (
                <li key={`${a.kind}-${a.id}`}>
                  <span className="ico" style={{ background: a.kind === 'alert' ? 'var(--warn-soft)' : 'var(--crit-soft)', color: a.kind === 'alert' ? 'var(--warn)' : 'var(--crit)' }}>
                    {a.kind === 'alert' ? <AlertTriangle size={14} /> : <ShieldAlert size={14} />}
                  </span>
                  <div><div className="t">{a.text}</div><div className="muted small">{a.deviceName}</div></div>
                  <div style={{ textAlign: 'right' }}><SeverityBadge severity={a.severity as any} /><div className="muted small">{timeAgo(a.createdAt)}</div></div>
                </li>
              ))}
              {!s.activity.length && <Empty>Nothing yet.</Empty>}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
