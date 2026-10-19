import { Download } from 'lucide-react';
import { useState } from 'react';
import { AuditRow, downloadCsv, useLive } from '../api';
import { Badge, Card, Empty, PageHead, toast } from '../components/ui';
import { timeAgo } from '../format';

const GROUPS = [
  ['', 'Everything'], ['auth', 'Sign-ins'], ['user', 'Users'], ['device', 'Devices'], ['model', 'Models'],
  ['kb', 'Knowledge base'], ['assistant', 'AI assistant'], ['report', 'Reports'], ['webhook', 'Webhooks'], ['rule', 'Rules'],
] as const;

const tone = (action: string) =>
  action.includes('failed') || action.includes('delete') || action.includes('deactivate') ? 'crit'
    : action.startsWith('auth') ? 'info' : action.startsWith('assistant') ? 'pred' : 'accent';

/** Who did what, when, and from where. Administrators only; secrets are never recorded. */
export default function AuditLog() {
  const [group, setGroup] = useState('');
  const qs = `?limit=200${group ? `&action=${group}` : ''}`;
  const { data } = useLive<AuditRow[]>(`/audit${qs}`, 15000);

  return (
    <>
      <PageHead title="Audit log" desc="A record of security-relevant actions: sign-ins, administrative changes, document access and assistant tool use.">
        <button className="btn" onClick={() => downloadCsv(`/audit/export.csv${qs}`, 'audit-log.csv').catch((e: Error) => toast(e.message, 'error'))}><Download size={15} />Export CSV</button>
      </PageHead>
      <div className="chips" style={{ marginBottom: 12 }}>
        {GROUPS.map(([v, l]) => <button key={l} className={`chip ${group === v ? 'on' : ''}`} onClick={() => setGroup(v)}>{l}</button>)}
      </div>
      <Card flush>
        {!data?.length ? <Empty>{data ? 'No entries match.' : 'Loading…'}</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>User</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td className="muted nowrap" title={new Date(r.createdAt).toLocaleString()}>{timeAgo(r.createdAt)}</td>
                  <td>{r.userEmail ?? <span className="muted">anonymous</span>}</td>
                  <td><Badge tone={tone(r.action)}>{r.action}</Badge></td>
                  <td className="small">{r.entity ? `${r.entity}${r.entityId ? ` ${String(r.entityId).slice(0, 8)}` : ''}` : '-'}</td>
                  <td className="small mono ellipsis" style={{ maxWidth: 300 }} title={JSON.stringify(r.details)}>{Object.keys(r.details ?? {}).length ? JSON.stringify(r.details) : ''}</td>
                  <td className="muted small mono">{r.ip ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
