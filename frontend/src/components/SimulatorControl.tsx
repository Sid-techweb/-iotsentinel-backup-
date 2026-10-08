import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Pause, Play, Zap } from 'lucide-react';
import { useState } from 'react';
import { api, Device, METRIC_KEYS, METRIC_META, MetricKey, SimStatus, useLive } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, toast } from './ui';

/** Demo controls: pause the fleet (watch missed-heartbeat detection) or force a fault (watch the predictor react). */
export default function SimulatorControl() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const { data: sim } = useLive<SimStatus>('/simulator', 3000);
  const { data: devices } = useLive<Device[]>('/devices', 10000);
  const [deviceId, setDeviceId] = useState('');
  const [metric, setMetric] = useState<MetricKey | ''>('');

  const toggle = useMutation({
    mutationFn: () => api.post<SimStatus>(`/simulator/${sim?.running ? 'pause' : 'resume'}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/simulator'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const inject = useMutation({
    mutationFn: () => api.post('/simulator/inject-fault', { deviceId: deviceId || candidates[0]?.id, ...(metric && { metric }) }),
    onSuccess: () => { toast('Fault injected - watch Anomaly Prediction'); qc.invalidateQueries(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (!sim?.enabled) return null;
  const candidates = (devices ?? []).filter((d) => d.simulated && d.status !== 'offline');

  return (
    <Card title={<span className="row" style={{ gap: 8 }}><FlaskConical size={15} />Simulator</span>}
      sub="Test the platform without real hardware"
      action={<Badge tone={sim.running ? 'ok' : 'warn'}><i className="dot" />{sim.running ? 'running' : 'paused'}</Badge>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="muted small">{sim.devices} simulated devices · {sim.activeFaults} currently degrading</div>
        <button className="btn" disabled={!isAdmin || toggle.isPending} onClick={() => toggle.mutate()}>
          {sim.running ? <><Pause size={14} />Pause all devices</> : <><Play size={14} />Resume devices</>}
        </button>
        {sim.running === false && <div className="muted small">Paused devices stop reporting, so missed-heartbeat alerts will fire shortly.</div>}
        <div className="form-2">
          <select className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} aria-label="Device to degrade">
            <option value="">Any healthy device</option>
            {candidates.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select className="input" value={metric} onChange={(e) => setMetric(e.target.value as MetricKey | '')} aria-label="Metric to degrade">
            <option value="">Any metric</option>
            {METRIC_KEYS.map((k) => <option key={k} value={k}>{METRIC_META[k].label}</option>)}
          </select>
        </div>
        <button className="btn primary" disabled={!isAdmin || inject.isPending || !candidates.length} onClick={() => inject.mutate()}><Zap size={14} />Trigger a fault</button>
        {!isAdmin && <div className="muted small">Read-only account - controls are disabled.</div>}
      </div>
    </Card>
  );
}
