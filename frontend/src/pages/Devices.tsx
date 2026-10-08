import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, Device, DEVICE_TYPES, useLive } from '../api';
import { useAuth } from '../auth';
import { fmtMetric, timeAgo } from '../format';
import { Badge, Card, Empty, ErrorBox, Modal, PageHead, StatusBadge, toast } from '../components/ui';

const FILTERS = ['all', 'online', 'degraded', 'offline'] as const;

export default function Devices() {
  const nav = useNavigate();
  const { isAdmin } = useAuth();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const { data, error } = useLive<Device[]>('/devices', 3000);

  const rows = (data ?? []).filter((d) => (filter === 'all' || d.status === filter) &&
    `${d.name} ${d.type} ${d.location}`.toLowerCase().includes(search.toLowerCase()));
  const count = (s: string) => (s === 'all' ? data?.length : data?.filter((d) => d.status === s).length) ?? 0;

  return (
    <>
      <PageHead title="Devices" desc="Central inventory with live connectivity and the latest readings.">
        <button className="btn primary" disabled={!isAdmin} title={isAdmin ? undefined : 'Read-only account'} onClick={() => setAdding(true)}><Plus size={15} />Register device</button>
      </PageHead>

      <div className="row" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <div className="chips">
          {FILTERS.map((f) => <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f} · {count(f)}</button>)}
        </div>
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--muted)' }} />
          <input className="input" style={{ paddingLeft: 30, width: 260 }} placeholder="Search name, type, location…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search devices" />
        </div>
      </div>

      <Card flush>
        {error && !data ? <ErrorBox error={error} /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Device</th><th>Status</th><th>Location</th><th>Firmware</th><th className="num">Temp</th><th className="num">CPU</th><th className="num">Memory</th><th>Last seen</th><th className="num">Alerts</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="click" onClick={() => nav(`/devices/${d.id}`)}>
                  <td><div className="strong">{d.name}</div><div className="muted small">{d.type}{d.simulated ? ' · simulated' : ''}</div></td>
                  <td><StatusBadge status={d.status} /></td>
                  <td>{d.location}</td>
                  <td className="nowrap mono">{d.firmwareVersion} {d.outdated && <Badge tone="warn">update</Badge>}</td>
                  <td className="num">{fmtMetric('temperature', d.latest?.temperature)}</td>
                  <td className="num">{fmtMetric('cpu', d.latest?.cpu)}</td>
                  <td className="num">{fmtMetric('memory', d.latest?.memory)}</td>
                  <td className="muted nowrap">{timeAgo(d.lastSeen)}</td>
                  <td className="num">{d.openAlerts ? <Badge tone="crit">{d.openAlerts}</Badge> : <span className="muted">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>{!rows.length && <Empty>No devices match.</Empty>}</div>
        )}
      </Card>
      {adding && <RegisterModal onClose={() => setAdding(false)} />}
    </>
  );
}

function RegisterModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', type: DEVICE_TYPES[0], location: '', ipAddress: '', firmwareVersion: '1.0.0', simulated: true });
  const [created, setCreated] = useState<Device | null>(null);
  const m = useMutation({
    mutationFn: () => api.post<Device>('/devices', { ...f, ipAddress: f.ipAddress || undefined, location: f.location || 'Unassigned' }),
    onSuccess: (d) => { setCreated(d); qc.invalidateQueries(); toast(`${d.name} registered`); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));

  if (created) {
    const curl = `curl -X POST ${location.origin}/api/telemetry \\\n  -H "x-api-key: ${created.apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"temperature":41.5,"cpu":22,"memory":48}'`;
    return (
      <Modal title="Device registered" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
        <p style={{ margin: 0 }}><b>{created.name}</b> is in the inventory{created.simulated ? ' and the simulator will start reporting for it.' : '. It will show offline until it sends its first heartbeat.'}</p>
        <label className="field">Device API key
          <div className="row"><input className="input mono" readOnly value={created.apiKey} style={{ flex: 1 }} />
            <button className="btn" onClick={() => { navigator.clipboard?.writeText(created.apiKey ?? ''); toast('Key copied'); }}><Copy size={14} /></button></div>
        </label>
        <div className="muted small">Send telemetry from the device:</div>
        <pre className="code">{curl}</pre>
      </Modal>
    );
  }
  return (
    <Modal title="Register device" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending || f.name.trim().length < 2} onClick={() => m.mutate()}>Register</button></>}>
      <label className="field">Name<input className="input" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. sensor-plantC-01" /></label>
      <div className="form-2">
        <label className="field">Type<select className="input" value={f.type} onChange={(e) => set('type', e.target.value)}>{DEVICE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label className="field">Location<input className="input" value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Plant C" /></label>
        <label className="field">IP address (optional)<input className="input" value={f.ipAddress} onChange={(e) => set('ipAddress', e.target.value)} placeholder="10.20.0.50" /></label>
        <label className="field">Firmware version<input className="input mono" value={f.firmwareVersion} onChange={(e) => set('firmwareVersion', e.target.value)} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={f.simulated} onChange={(e) => set('simulated', e.target.checked)} />Attach to the built-in device simulator</label>
    </Modal>
  );
}
