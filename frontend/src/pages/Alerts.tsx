import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Eye } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, api, METRIC_META, useLive } from '../api';
import { useAuth } from '../auth';
import { timeAgo } from '../format';
import { Badge, Card, Empty, PageHead, SeverityBadge, toast } from '../components/ui';

const TYPES = [['', 'All types'], ['predictive', 'Predictive'], ['threshold', 'Threshold'], ['heartbeat', 'Heartbeat']];
const TYPE_TONE = { predictive: 'pred', threshold: 'warn', heartbeat: 'crit' } as const;

export default function Alerts() {
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState('active');
  const [type, setType] = useState('');
  const [severity, setSeverity] = useState('');
  const qs = new URLSearchParams({ status, ...(type && { type }), ...(severity && { severity }) }).toString();
  const { data } = useLive<Alert[]>(`/alerts?${qs}`, 3000);

  const act = useMutation({
    mutationFn: (v: { id: number; status: 'acknowledged' | 'resolved' }) => api.patch(`/alerts/${v.id}`, { status: v.status }),
    onSuccess: () => { qc.invalidateQueries(); toast('Alert updated'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <>
      <PageHead title="Alerts" desc="Threshold breaches, missed heartbeats and model-predicted problems. Alerts clear themselves once a device recovers." />
      <div className="row" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <div className="chips">
          {[['active', 'Active'], ['resolved', 'Resolved'], ['', 'All']].map(([v, l]) => <button key={l} className={`chip ${status === v ? 'on' : ''}`} onClick={() => setStatus(v)}>{l}</button>)}
        </div>
        <div className="row">
          <select className="input" value={type} onChange={(e) => setType(e.target.value)} aria-label="Alert type">{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
            <option value="">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option>
          </select>
        </div>
      </div>
      <Card flush>
        {!data?.length ? <Empty>{data ? 'No alerts match - all clear.' : 'Loading…'}</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Severity</th><th>Type</th><th>Device</th><th>Message</th><th>Raised</th><th>State</th><th /></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td><SeverityBadge severity={a.severity} /></td>
                  <td><Badge tone={TYPE_TONE[a.type]}>{a.type}</Badge></td>
                  <td><Link to={`/devices/${a.deviceId}`} className="strong">{a.deviceName}</Link>{a.metric && <div className="muted small">{METRIC_META[a.metric].label}</div>}</td>
                  <td style={{ maxWidth: 440 }}>{a.message}</td>
                  <td className="muted nowrap">{timeAgo(a.createdAt)}</td>
                  <td><Badge tone={a.status === 'open' ? 'crit' : a.status === 'acknowledged' ? 'warn' : 'ok'}>{a.status}</Badge></td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    {a.status === 'open' && <button className="btn sm" disabled={!isAdmin} onClick={() => act.mutate({ id: a.id, status: 'acknowledged' })}><Eye size={12} />Ack</button>}{' '}
                    {a.status !== 'resolved' && <button className="btn sm" disabled={!isAdmin} onClick={() => act.mutate({ id: a.id, status: 'resolved' })}><Check size={12} />Resolve</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
