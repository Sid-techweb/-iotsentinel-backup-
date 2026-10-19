import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { api, DeviceType, METRIC_META, Rule, useLive } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, Empty, PageHead, toast } from '../components/ui';

export default function Rules() {
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [scope, setScope] = useState(''); // '' = defaults for every machine type
  const { data: types } = useLive<DeviceType[]>('/device-types', false);
  const { data } = useLive<Rule[]>(`/rules${scope ? `?deviceType=${encodeURIComponent(scope)}` : ''}`, false);

  const save = useMutation({
    mutationFn: (v: { rule: Rule; threshold?: number; enabled?: boolean }) => {
      const { rule, ...change } = v;
      // editing a limit while a machine type is selected creates (or updates) that type's own override
      return scope && rule.inherited
        ? api.put('/rules/override', { deviceType: scope, metric: rule.metric, severity: rule.severity, ...change })
        : api.put(`/rules/${rule.id}`, change);
    },
    onSuccess: () => { qc.invalidateQueries(); toast('Rule saved'); },
    onError: (e: Error) => { qc.invalidateQueries(); toast(e.message, 'error'); },
  });
  const reset = useMutation({
    mutationFn: (rule: Rule) => api.del(`/rules/${rule.id}`),
    onSuccess: () => { qc.invalidateQueries(); toast('Back to the default limit'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <>
      <PageHead title="Alert rules" desc="Limits that raise threshold alerts. Set them for every machine type, or override them for one.">
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Machine type scope">
          <option value="">Defaults (all machine types)</option>
          {types?.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
        </select>
      </PageHead>

      {scope && <p className="muted small" style={{ margin: '-6px 0 14px' }}>
        Showing the limits for <b>{scope}</b>, only for the signals it reports. Change a value to give this machine type its own limit; “Reset” returns it to the default.
      </p>}

      <Card flush>
        {!data?.length ? <Empty>No rules.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Metric</th><th>Condition</th><th>Severity</th><th>Threshold</th><th>Enabled</th>{scope && <th>Source</th>}</tr></thead>
            <tbody>
              {data.map((r) => (
                <RuleRow key={`${scope}:${r.id}:${r.threshold}`} rule={r} locked={!isAdmin} showSource={!!scope}
                  onSave={(v) => save.mutate({ rule: r, ...v })} onReset={() => reset.mutate(r)} />
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      <p className="muted small" style={{ marginTop: 12 }}>
        The anomaly predictor forecasts against the <b>warning</b> limit of each metric, so lowering it makes predictions fire earlier and raising it later.
      </p>
    </>
  );
}

function RuleRow({ rule, locked, showSource, onSave, onReset }: {
  rule: Rule; locked: boolean; showSource: boolean;
  onSave: (v: { threshold?: number; enabled?: boolean }) => void; onReset: () => void;
}) {
  const [val, setVal] = useState(String(rule.threshold));
  const m = METRIC_META[rule.metric];
  const commit = () => {
    const n = Number(val);
    if (!Number.isFinite(n) || val.trim() === '') { setVal(String(rule.threshold)); return; }
    if (n !== rule.threshold) onSave({ threshold: n });
  };
  return (
    <tr>
      <td className="strong">{m.label}</td>
      <td>{rule.operator === '>' ? 'rises above' : 'falls below'}</td>
      <td><Badge tone={rule.severity === 'critical' ? 'crit' : 'warn'}>{rule.severity}</Badge></td>
      <td><div className="row" style={{ gap: 6 }}><input className="input mono" style={{ width: 92 }} disabled={locked} value={val} onChange={(e) => setVal(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label={`${m.label} ${rule.severity} threshold`} /><span className="muted">{m.unit.trim()}</span></div></td>
      <td><input type="checkbox" disabled={locked} checked={rule.enabled} onChange={(e) => onSave({ enabled: e.target.checked })} aria-label="Enabled" /></td>
      {showSource && (
        <td className="nowrap">
          {rule.inherited ? <span className="muted small">default</span> : (
            <span className="row" style={{ gap: 8 }}><Badge tone="pred">override</Badge>
              {!locked && <button className="btn sm ghost" onClick={onReset}><RotateCcw size={12} />Reset</button>}</span>
          )}
        </td>
      )}
    </tr>
  );
}
