import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, Device, downloadCsv, Incident, IncidentSeverity, IncidentSummary, useLive } from '../api';
import { useAuth } from '../auth';
import { clock, timeAgo } from '../format';
import { Card, Empty, Kpi, Modal, PageHead, SeverityBadge, toast } from '../components/ui';

const SEVERITIES: IncidentSeverity[] = ['critical', 'high', 'medium', 'low'];
const CATEGORIES = ['Brute-force login', 'Unsigned firmware attempt', 'Unexpected open port', 'Certificate expiring', 'Configuration tampering', 'Malformed / replayed packets', 'Unauthorized access'];

export default function Incidents() {
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const { data } = useLive<Incident[]>(`/incidents${status ? `?status=${status}` : ''}`, 4000);
  const { data: sum } = useLive<IncidentSummary>('/incidents/summary', 6000);

  const setState = useMutation({
    mutationFn: (v: { id: number; status: string }) => api.patch(`/incidents/${v.id}`, { status: v.status }),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const bySev = (s: string) => sum?.bySeverity.find((x) => x.severity === s)?.count ?? 0;
  const trend = (sum?.trend ?? []).map((t) => ({ label: clock(t.hour), count: t.count }));

  return (
    <>
      <PageHead title="Security incidents" desc="Security events reported by devices, consolidated into one triage queue.">
        <button className="btn" onClick={() => downloadCsv(`/incidents/export.csv${status ? `?status=${status}` : ''}`, 'security-incidents.csv').catch((e: Error) => toast(e.message, 'error'))}><Download size={15} />Export CSV</button>
        <button className="btn primary" disabled={!isAdmin} onClick={() => setAdding(true)}><Plus size={15} />Report incident</button>
      </PageHead>

      <div className="grid kpis">
        {SEVERITIES.map((s) => <Kpi key={s} label={`${s[0].toUpperCase()}${s.slice(1)} (unresolved)`} value={bySev(s)} tone={bySev(s) ? (s === 'critical' || s === 'high' ? 'crit' : 'warn') : 'ok'} />)}
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <Card title="By category" sub="All time">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={sum?.byCategory ?? []} layout="vertical" margin={{ left: 40, right: 12 }}>
              <XAxis type="number" hide allowDecimals={false} />
              <YAxis dataKey="category" type="category" stroke="var(--muted)" fontSize={11} width={150} tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: 'var(--surface2)' }} contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="count" name="Incidents" fill="var(--accent)" radius={[0, 4, 4, 0]} barSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Last 24 hours" sub="Incidents per hour">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={trend} margin={{ left: -24, right: 6 }}>
              <XAxis dataKey="label" stroke="var(--muted)" fontSize={11} tickLine={false} />
              <YAxis stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip cursor={{ fill: 'var(--surface2)' }} contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="count" name="Incidents" fill="var(--crit)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <div className="chips" style={{ marginBottom: 12 }}>
        {[['', 'All'], ['open', 'Open'], ['investigating', 'Investigating'], ['resolved', 'Resolved']].map(([v, l]) => <button key={l} className={`chip ${status === v ? 'on' : ''}`} onClick={() => setStatus(v)}>{l}</button>)}
      </div>
      <Card flush>
        {!data?.length ? <Empty>No incidents.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Severity</th><th>Category</th><th>Device</th><th>Details</th><th>Reported</th><th>Status</th></tr></thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id}>
                  <td><SeverityBadge severity={i.severity} /></td>
                  <td className="strong">{i.category}</td>
                  <td>{i.deviceName ?? <span className="muted">-</span>}</td>
                  <td style={{ maxWidth: 420 }}>{i.description}</td>
                  <td className="muted nowrap">{timeAgo(i.createdAt)}</td>
                  <td>
                    <select className="input" style={{ padding: '3px 8px' }} disabled={!isAdmin} value={i.status} aria-label="Incident status" onChange={(e) => setState.mutate({ id: i.id, status: e.target.value })}>
                      <option value="open">open</option><option value="investigating">investigating</option><option value="resolved">resolved</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      {adding && <ReportModal onClose={() => setAdding(false)} />}
    </>
  );
}

function ReportModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: devices } = useLive<Device[]>('/devices', false);
  const [f, setF] = useState({ deviceId: '', category: CATEGORIES[0], severity: 'medium', description: '' });
  const m = useMutation({
    mutationFn: () => api.post('/incidents', { ...f, deviceId: f.deviceId || null }),
    onSuccess: () => { qc.invalidateQueries(); toast('Incident recorded'); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal title="Report security incident" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={m.isPending || f.description.trim().length < 3} onClick={() => m.mutate()}>Record</button></>}>
      <label className="field">Device<select className="input" value={f.deviceId} onChange={(e) => set('deviceId', e.target.value)}><option value="">Not device-specific</option>{devices?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <div className="form-2">
        <label className="field">Category<select className="input" value={f.category} onChange={(e) => set('category', e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="field">Severity<select className="input" value={f.severity} onChange={(e) => set('severity', e.target.value)}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select></label>
      </div>
      <label className="field">Description<textarea className="input" rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="What was observed?" /></label>
    </Modal>
  );
}
