import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, KeyRound, Power, Sparkles, Trash2, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, api, Device, DevicePrediction, FwUpdate, Incident, METRIC_KEYS, METRIC_META, MetricKey, useLive } from '../api';
import { useAuth } from '../auth';
import Flash from '../components/Flash';
import ExplainPanel from '../components/ExplainPanel';
import ForecastChart, { ChartLegend } from '../components/ForecastChart';
import MaintenanceCard from '../components/MaintenanceCard';
import { Badge, Card, Empty, ErrorBox, Modal, PageHead, RiskBadge, SeverityBadge, StatusBadge, toast } from '../components/ui';
import { eta, fmtMetric, pct, timeAgo } from '../format';

interface History { alerts: Alert[]; incidents: Incident[]; updates: FwUpdate[] }

export default function DeviceDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [newKey, setNewKey] = useState<string | null>(null);
  const { data: dev, error } = useLive<Device>(`/devices/${id}`, 3000);
  const { data: pred } = useLive<DevicePrediction>(`/anomaly/predictions/${id}`, 2500);
  const { data: hist } = useLive<History>(`/devices/${id}/history`, 4000);

  const update = useMutation({
    mutationFn: () => api.post('/firmware/updates', { deviceId: id }),
    onSuccess: () => { toast('Firmware update started'); qc.invalidateQueries(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const rotate = useMutation({
    mutationFn: () => api.post<{ apiKey: string }>(`/devices/${id}/key`),
    onSuccess: (r) => setNewKey(r.apiKey),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const toggleActive = useMutation({
    mutationFn: (active: boolean) => api.patch<Device>(`/devices/${id}`, { active }),
    onSuccess: (d) => { toast(d.active ? 'Device reactivated' : 'Device deactivated'); qc.invalidateQueries(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/devices/${id}`),
    onSuccess: () => { toast('Device removed'); qc.invalidateQueries(); nav('/devices'); },
  });

  if (error && !dev) return <><Link to="/devices" className="btn sm"><ArrowLeft size={14} />Devices</Link><div style={{ marginTop: 14 }}><ErrorBox error={error} /></div></>;
  if (!dev) return <div className="empty">Loading device…</div>;

  const points = pred?.points ?? [];
  const lastTs = points.length ? points[points.length - 1].ts : Date.now();
  const forecasts = new Map((pred?.prediction.metrics ?? []).map((m) => [m.metric, m]));
  const shown = METRIC_KEYS.filter((k) => dev.latest?.[k] !== null && dev.latest?.[k] !== undefined);

  return (
    <>
      <div style={{ marginBottom: 12 }}><Link to="/devices" className="btn sm ghost"><ArrowLeft size={14} />All devices</Link></div>
      <PageHead title={dev.name} desc={`Asset #${dev.assetNo} · ${dev.type} · ${dev.location}${dev.ipAddress ? ` · ${dev.ipAddress}` : ''}`}>
        {dev.active ? <StatusBadge status={dev.status} /> : <Badge>deactivated</Badge>}
        {dev.simulated && <Badge tone="info">simulated</Badge>}
        {pred && dev.active && <RiskBadge level={pred.prediction.level} />}
        <Link className="btn sm" to={`/assistant?device=${dev.id}&q=${encodeURIComponent('Why is this device showing its current risk level?')}`}><Sparkles size={14} />Ask the assistant</Link>
        <button className="btn sm" disabled={!isAdmin || toggleActive.isPending}
          onClick={() => (dev.active ? confirm(`Deactivate ${dev.name}? It stops being monitored, its open alerts are closed and it can no longer send telemetry. History is kept.`) : true) && toggleActive.mutate(!dev.active)}>
          <Power size={14} />{dev.active ? 'Deactivate' : 'Reactivate'}
        </button>
        <button className="btn danger sm" disabled={!isAdmin} onClick={() => confirm(`Remove ${dev.name}? Its history will be deleted.`) && remove.mutate()}><Trash2 size={14} />Remove</button>
      </PageHead>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 16 }}>
        {shown.map((k) => {
          const f = forecasts.get(k);
          return (
            <div key={k} className={`metric-tile ${f?.level ?? ''}`}>
              <div className="muted small">{METRIC_META[k].label}</div>
              <div className="v"><Flash value={dev.latest?.[k]}>{fmtMetric(k, dev.latest?.[k])}</Flash></div>
              <div className="small" style={{ color: f && f.level !== 'low' ? 'var(--warn)' : 'var(--muted)' }}>
                {f ? (f.breached ? 'limit exceeded' : f.level === 'low' ? 'stable' : `${pct(f.probability)} risk · ${eta(f.secondsToBreach)}`) : '-'}
              </div>
            </div>
          );
        })}
        {!shown.length && <Empty>No telemetry received yet.</Empty>}
      </div>

      <div className="grid g-main">
        <div className="stack">
          <Card title="Telemetry &amp; forecast" sub="Model projection over the next ~40 s" action={<ChartLegend />}>
            <div className="stack" style={{ gap: 22 }}>
              {shown.map((k: MetricKey) => {
                const f = forecasts.get(k);
                const series = points.filter((p) => p[k] !== null).map((p) => ({ t: (p.ts - lastTs) / 1000, value: p[k] as number }));
                return (
                  <div key={k}>
                    <div className="chart-title"><b>{METRIC_META[k].label}</b>
                      {f && f.level !== 'low' && !f.breached && <Badge tone="pred">breach {eta(f.secondsToBreach)} · {pct(f.probability)}</Badge>}
                      {f?.breached && <Badge tone="crit">limit exceeded</Badge>}
                    </div>
                    <ForecastChart metric={k} history={series} forecast={f} height={170} />
                  </div>
                );
              })}
            </div>
          </Card>

          {(pred?.prediction.metrics ?? []).slice(0, 2).length > 0 && dev.active && (
            <Card title="Why this risk?" sub="How the model reached its probability - using only the numbers it was given">
              <div className="stack" style={{ gap: 14 }}>
                {(pred?.prediction.metrics ?? []).slice(0, 2).map((f) => <ExplainPanel key={f.metric} forecast={f} />)}
              </div>
            </Card>
          )}
        </div>

        <div className="stack">
          <Card title="Firmware" action={dev.outdated ? <button className="btn sm primary" disabled={!isAdmin || update.isPending || dev.status === 'offline'} onClick={() => update.mutate()}><Wrench size={13} />Update to {dev.latestFirmware}</button> : <Badge tone="ok">up to date</Badge>}>
            <dl className="kv" style={{ margin: 0 }}>
              <dt>Installed</dt><dd className="mono">{dev.firmwareVersion}</dd>
              <dt>Latest release</dt><dd className="mono">{dev.latestFirmware ?? '-'}</dd>
              <dt>Last seen</dt><dd>{timeAgo(dev.lastSeen)}</dd>
              <dt>Registered</dt><dd>{timeAgo(dev.createdAt)}</dd>
            </dl>
            {hist?.updates[0] && (
              <div style={{ marginTop: 12 }}>
                <div className="muted small">Last update: {hist.updates[0].fromVersion} → {hist.updates[0].toVersion} ({hist.updates[0].status.replace('_', ' ')})</div>
                <div className={`progress ${hist.updates[0].status === 'failed' ? 'bad' : ''}`} style={{ marginTop: 6 }}><i style={{ width: `${hist.updates[0].status === 'failed' ? 100 : hist.updates[0].progress}%` }} /></div>
              </div>
            )}
          </Card>

          <MaintenanceCard deviceId={dev.id} />

          <Card title="Recent alerts" flush>
            <ul className="feed">
              {hist?.alerts.slice(0, 6).map((a) => (
                <li key={a.id} style={{ gridTemplateColumns: 'auto 1fr auto' }}>
                  <Badge tone={a.type === 'predictive' ? 'pred' : ''}>{a.type}</Badge>
                  <div><div className="t">{a.message}</div><div className="muted small">{timeAgo(a.createdAt)} · {a.status}</div></div>
                  <SeverityBadge severity={a.severity} />
                </li>
              ))}
              {!hist?.alerts.length && <Empty>No alerts for this device.</Empty>}
            </ul>
          </Card>

          <Card title="Security incidents" flush>
            <ul className="feed">
              {hist?.incidents.slice(0, 4).map((i) => (
                <li key={i.id} style={{ gridTemplateColumns: 'auto 1fr auto' }}><Badge>{i.status}</Badge><div><div className="t strong">{i.category}</div><div className="muted small">{i.description}</div></div><SeverityBadge severity={i.severity} /></li>
              ))}
              {!hist?.incidents.length && <Empty>No incidents recorded.</Empty>}
            </ul>
          </Card>

          <Card title="Device key" sub="Used by the device in the x-api-key header">
            <p className="muted small" style={{ marginTop: 0 }}>Keys are stored hashed, so the current key cannot be shown again. Generating a new one immediately stops the old key from working.</p>
            <button className="btn" disabled={!isAdmin || rotate.isPending} onClick={() => confirm('Generate a new key? The device will stop reporting until it is updated with the new key.') && rotate.mutate()}><KeyRound size={14} />Generate new key</button>
          </Card>
        </div>
      </div>
      {newKey && (
        <Modal title="New device key" onClose={() => setNewKey(null)} footer={<button className="btn primary" onClick={() => setNewKey(null)}>I have saved it</button>}>
          <p style={{ margin: 0 }}>Copy this key now - it is shown only once.</p>
          <div className="row"><input className="input mono" readOnly style={{ flex: 1 }} value={newKey} />
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(newKey); toast('Key copied'); }}><Copy size={14} /></button></div>
          <pre className="code">{[
            `curl -X POST ${location.origin}/api/telemetry`,
            `  -H "x-api-key: ${newKey}"`,
            '  -H "Content-Type: application/json"',
            `  -d '{"temperature":41.5,"cpu":22}'`,
          ].join(' \\\n')}</pre>
        </Modal>
      )}
    </>
  );
}
