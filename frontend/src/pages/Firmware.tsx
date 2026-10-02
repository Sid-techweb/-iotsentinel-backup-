import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Rocket, ShieldCheck } from 'lucide-react';
import { Compliance, FwUpdate, Release, api, useLive } from '../api';
import { timeAgo } from '../format';
import { Badge, Card, Empty, Kpi, PageHead, StatusBadge, toast } from '../components/ui';

export default function Firmware() {
  const qc = useQueryClient();
  const { data: comp } = useLive<Compliance[]>('/firmware/compliance', 4000);
  const { data: releases } = useLive<Release[]>('/firmware/releases', 8000);
  const { data: updates } = useLive<FwUpdate[]>('/firmware/updates', 1500);

  const push = useMutation({
    mutationFn: (deviceId: string) => api.post('/firmware/updates', { deviceId }),
    onSuccess: () => { qc.invalidateQueries(); toast('Update started'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const bulk = useMutation({
    mutationFn: () => api.post<{ started: number }>('/firmware/updates/bulk'),
    onSuccess: (r) => { qc.invalidateQueries(); toast(r.started ? `Rolling out to ${r.started} device(s)` : 'No eligible devices (outdated devices must be online)'); },
  });

  const outdated = (comp ?? []).filter((c) => c.outdated);
  const running = (updates ?? []).filter((u) => u.status === 'in_progress').length;
  const busy = new Set((updates ?? []).filter((u) => u.status === 'in_progress').map((u) => u.deviceId));
  const types = [...new Set((comp ?? []).map((c) => c.type))];

  return (
    <>
      <PageHead title="Firmware" desc="Track installed versions against the latest release and roll updates out under control.">
        <button className="btn primary" disabled={!outdated.length || bulk.isPending} onClick={() => bulk.mutate()}><Rocket size={15} />Update all outdated ({outdated.length})</button>
      </PageHead>

      <div className="grid kpis">
        <Kpi label="On latest release" value={(comp?.length ?? 0) - outdated.length} tone="ok" note={`of ${comp?.length ?? 0} devices`} />
        <Kpi label="Behind latest" value={outdated.length} tone={outdated.length ? 'warn' : 'ok'} note="update available" />
        <Kpi label="Missed security releases" value={outdated.filter((c) => c.missedSecurityReleases > 0).length} tone="warn" note="devices skipped a patch release" />
        <Kpi label="Updates running" value={running} note="in progress now" />
      </div>
      <p className="muted small" style={{ margin: '-4px 0 16px' }}>
        <ShieldCheck size={13} style={{ verticalAlign: -2 }} /> An outdated version is a maintenance signal. It is not treated as proof that a device is vulnerable.
      </p>

      <div className="grid g-main">
        <Card title="Device compliance" flush>
          <div className="table-wrap"><table>
            <thead><tr><th>Device</th><th>Status</th><th>Installed</th><th>Latest</th><th /></tr></thead>
            <tbody>
              {(comp ?? []).map((c) => (
                <tr key={c.id}>
                  <td><div className="strong">{c.name}</div><div className="muted small">{c.type}</div></td>
                  <td><StatusBadge status={c.status} /></td>
                  <td className="mono">{c.current}</td>
                  <td className="mono">{c.latest ?? '-'} {c.missedSecurityReleases > 0 && <Badge tone="warn">{c.missedSecurityReleases} security</Badge>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {c.outdated
                      ? <button className="btn sm" disabled={c.status === 'offline' || busy.has(c.id) || push.isPending} onClick={() => push.mutate(c.id)}>{busy.has(c.id) ? 'Updating…' : 'Update'}</button>
                      : <Badge tone="ok">current</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>

        <div className="stack">
          <Card title="Rollout activity" flush>
            {!updates?.length ? <Empty>No updates yet.</Empty> : (
              <ul className="feed" style={{ maxHeight: 330, overflow: 'auto' }}>
                {updates.slice(0, 10).map((u) => (
                  <li key={u.id} style={{ gridTemplateColumns: '1fr auto' }}>
                    <div>
                      <div className="strong">{u.deviceName}</div>
                      <div className="muted small mono">{u.fromVersion} → {u.toVersion} · {timeAgo(u.updatedAt)}</div>
                      <div className={`progress ${u.status === 'failed' ? 'bad' : ''}`} style={{ marginTop: 6 }}><i style={{ width: `${u.status === 'failed' ? 100 : u.progress}%` }} /></div>
                    </div>
                    <Badge tone={u.status === 'completed' ? 'ok' : u.status === 'failed' ? 'crit' : 'info'}>{u.status.replace('_', ' ')}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Releases" flush>
            <div className="table-wrap"><table>
              <tbody>
                {types.map((t) => (
                  <tr key={t}>
                    <td style={{ verticalAlign: 'top' }}><div className="strong">{t}</div></td>
                    <td>
                      {(releases ?? []).filter((r) => r.deviceType === t).map((r, i) => (
                        <div key={r.id} className="row" style={{ gap: 8, marginBottom: 3 }}>
                          <span className="mono" style={{ width: 50 }}>{r.version}</span>
                          {i === 0 && <Badge tone="accent">latest</Badge>}
                          {r.securityPatch && <Badge tone="info">security</Badge>}
                          <span className="muted small">{r.deviceCount} device{r.deviceCount === 1 ? '' : 's'}</span>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </Card>
        </div>
      </div>
    </>
  );
}
