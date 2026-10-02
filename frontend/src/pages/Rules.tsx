import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, METRIC_META, Rule, useLive } from '../api';
import { Badge, Card, PageHead, toast } from '../components/ui';

export default function Rules() {
  const qc = useQueryClient();
  const { data } = useLive<Rule[]>('/rules', false);
  const save = useMutation({
    mutationFn: (v: { id: number; threshold?: number; enabled?: boolean }) => api.put(`/rules/${v.id}`, v),
    onSuccess: () => { qc.invalidateQueries(); toast('Rule saved'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <>
      <PageHead title="Alert rules" desc="Configurable thresholds for rule-based alerts. Changes apply to the next reading." />
      <Card flush>
        <div className="table-wrap"><table>
          <thead><tr><th>Metric</th><th>Condition</th><th>Severity</th><th>Threshold</th><th>Enabled</th></tr></thead>
          <tbody>
            {(data ?? []).map((r) => <RuleRow key={r.id} rule={r} onSave={(v) => save.mutate({ id: r.id, ...v })} />)}
          </tbody>
        </table></div>
      </Card>
      <p className="muted small" style={{ marginTop: 12 }}>
        The anomaly predictor forecasts against the <b>warning</b> threshold of each metric, so lowering it makes predictions fire earlier and raising it later.
      </p>
    </>
  );
}

function RuleRow({ rule, onSave }: { rule: Rule; onSave: (v: { threshold?: number; enabled?: boolean }) => void }) {
  const [val, setVal] = useState(String(rule.threshold));
  const m = METRIC_META[rule.metric];
  const commit = () => {
    const n = Number(val);
    if (!Number.isFinite(n)) { setVal(String(rule.threshold)); return; }
    if (n !== rule.threshold) onSave({ threshold: n });
  };
  return (
    <tr>
      <td className="strong">{m.label}</td>
      <td>{rule.operator === '>' ? 'rises above' : 'falls below'}</td>
      <td><Badge tone={rule.severity === 'critical' ? 'crit' : 'warn'}>{rule.severity}</Badge></td>
      <td><div className="row" style={{ gap: 6 }}><input className="input mono" style={{ width: 92 }} value={val} onChange={(e) => setVal(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label={`${m.label} ${rule.severity} threshold`} /><span className="muted">{m.unit.trim()}</span></div></td>
      <td><input type="checkbox" checked={rule.enabled} onChange={(e) => onSave({ enabled: e.target.checked })} aria-label="Enabled" /></td>
    </tr>
  );
}
