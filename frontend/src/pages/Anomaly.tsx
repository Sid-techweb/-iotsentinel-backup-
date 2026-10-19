import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DevicePrediction, FleetPrediction, METRIC_META, ModelCard, ModelScope, ModelVersion, PredictionSnapshot, RetrainResult, useLive } from '../api';
import { useAuth } from '../auth';
import ExplainPanel from '../components/ExplainPanel';
import ForecastChart, { ChartLegend } from '../components/ForecastChart';
import { Badge, Card, Empty, Modal, PageHead, RiskBadge, RiskBar, toast } from '../components/ui';
import { eta, pct, timeAgo } from '../format';

export default function Anomaly() {
  const { data: fleet } = useLive<FleetPrediction[]>('/anomaly/predictions', 2500);
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [scope, setScope] = useState('global');
  const { data: scopes } = useLive<ModelScope[]>('/anomaly/models', 15000);
  const { data: model } = useLive<ModelCard>(`/anomaly/model?scope=${encodeURIComponent(scope)}`, 15000);
  const [result, setResult] = useState<RetrainResult | null>(null);
  const retrain = useMutation({
    mutationFn: () => api.post<RetrainResult>('/anomaly/retrain', { deviceType: scope }),
    onSuccess: (r) => { setResult(r); qc.invalidateQueries(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const useGlobal = useMutation({
    mutationFn: () => api.del(`/anomaly/models/${encodeURIComponent(scope)}`),
    onSuccess: () => { qc.invalidateQueries(); toast('Using the global model again'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const current = scopes?.find((m) => m.scope === scope);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? fleet?.[0]?.deviceId ?? null;
  const { data: detail } = useLive<DevicePrediction>(`/anomaly/predictions/${selected}`, 2500, !!selected);

  const flagged = (fleet ?? []).filter((p) => p.level === 'high' || p.level === 'breached').length;
  const watch = (fleet ?? []).filter((p) => p.level === 'elevated').length;
  const ev = model?.evaluation;

  const pts = detail?.points ?? [];
  const lastTs = pts.length ? pts[pts.length - 1].ts : Date.now();
  const charts = (detail?.prediction.metrics ?? []).slice(0, 3);

  return (
    <>
      <PageHead title="Anomaly prediction" desc="Forecasts which devices will breach a limit before it happens, so staff can act ahead of the alert.">
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Model to inspect">
          {scopes?.map((m) => <option key={m.scope} value={m.scope}>{m.scope === 'global' ? 'Global model' : `${m.scope}${m.own ? ' (own model)' : ''}`}</option>)}
        </select>
      </PageHead>

      <div className="hero" style={{ marginBottom: 16 }}>
        <div>
          <h2>{flagged ? `${flagged} device${flagged > 1 ? 's' : ''} predicted to breach` : 'No imminent breaches predicted'}{watch ? ` · ${watch} on watch` : ''}</h2>
          <p>Every reading updates a per-metric trend model. When the probability of crossing a limit within the next {model?.horizon ?? 20} readings passes {pct(model?.alertProbability ?? 0.5)}, a <b>predictive alert</b> is raised - before the threshold rule fires.</p>
        </div>
        {ev && (
          <div className="mstats">
            <div><b>{ev.auc.toFixed(2)}</b><span>AUC</span></div>
            <div><b>{pct(ev.precision)}</b><span>Precision</span></div>
            <div><b>{pct(ev.recall)}</b><span>Recall</span></div>
            <div><b>{ev.avgLeadReadings.toFixed(1)}</b><span>Avg lead (readings)</span></div>
          </div>
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.5fr)' }}>
        <Card title="Risk ranking" sub="Online devices, riskiest first" flush>
          {!fleet?.length ? <Empty>Waiting for telemetry…</Empty> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Device</th><th>Risk</th><th className="num">ETA</th></tr></thead>
              <tbody>
                {fleet.map((p) => (
                  <tr key={p.deviceId} className={`click ${p.deviceId === selected ? 'sel' : ''}`} onClick={() => setPicked(p.deviceId)}>
                    <td><div className="strong">{p.name}</div><div className="muted small">{p.topMetric ? METRIC_META[p.topMetric].label : '-'}</div></td>
                    <td><RiskBar p={p.riskScore} level={p.level} /></td>
                    <td className="num nowrap">{p.level === 'breached' ? <Badge tone="crit">breached</Badge> : p.level === 'low' ? <span className="muted">-</span> : <b>{eta(p.secondsToBreach)}</b>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>

        <Card title={detail ? detail.device.name : 'Forecast'} sub={detail ? `${detail.device.type} · ${detail.device.location}` : undefined}
          action={detail && <div className="row"><RiskBadge level={detail.prediction.level} /><Link className="btn sm" to={`/devices/${detail.device.id}`}>Open device</Link></div>}>
          {!detail ? <Empty>Select a device.</Empty> : (
            <div className="stack" style={{ gap: 18 }}>
              <ChartLegend />
              {charts.map((f) => (
                <div key={f.metric}>
                  <div className="chart-title">
                    <b>{f.label}</b>
                    <span className="muted small">
                      now {f.current.toFixed(METRIC_META[f.metric].digits)}{f.unit} · {f.slopePerMin >= 0 ? '+' : ''}{f.slopePerMin.toFixed(1)}{f.unit.trim()}/min · {pct(f.probability)} breach probability
                      {f.level !== 'low' && !f.breached && <> · <b style={{ color: 'var(--pred)' }}>{eta(f.secondsToBreach)}</b></>}
                    </span>
                  </div>
                  <ForecastChart metric={f.metric} forecast={f} height={170}
                    history={pts.filter((p) => p[f.metric] !== null).map((p) => ({ t: (p.ts - lastTs) / 1000, value: p[f.metric] as number }))} />
                </div>
              ))}
              {!charts.length && <Empty>Not enough readings yet - the model needs at least 8.</Empty>}
            </div>
          )}
        </Card>
      </div>

      {detail && detail.device.active && (
        <div className="grid g2" style={{ marginTop: 16 }}>
          <Card title="Why this risk?" sub={`${detail.device.name} · what the model saw and how it weighed it`}>
            {detail.prediction.metrics.length === 0 ? <Empty>Not enough readings yet.</Empty> : (
              <div className="stack" style={{ gap: 14 }}>
                {detail.prediction.metrics.slice(0, 2).map((f) => <ExplainPanel key={f.metric} forecast={f} />)}
              </div>
            )}
          </Card>
          <HistoryCard deviceId={detail.device.id} />
        </div>
      )}

      {model && (
        <div className="grid g2" style={{ marginTop: 16 }}>
          <Card title="How the prediction works">
            <ol className="steps">
              <li><b>Window.</b> The last {model.window} readings of each metric are read from the Redis rolling buffer.</li>
              <li><b>Features.</b> A least-squares fit gives the denoised level, trend and volatility; these are compared with the alert limit to get headroom and projected margin.</li>
              <li><b>Classifier.</b> A logistic-regression model ({model.parameterCount} parameters) outputs the probability the limit is crossed within {model.horizon} readings.</li>
              <li><b>Act early.</b> Above {pct(model.alertProbability)} a predictive alert opens with an estimated time-to-breach; it clears itself when the trend recovers.</li>
            </ol>
            <p className="muted small" style={{ marginBottom: 0 }}>
              {model.source === 'synthetic'
                ? <>Trained on {model.trainSize.toLocaleString()} synthetic drift / leak / recovery episodes in normalised units, so one model covers every metric. Evaluated on {model.testSize.toLocaleString()} held-out episodes.</>
                : <>Fitted on {model.trainSize.toLocaleString()} windows of real <b>{model.scope}</b> telemetry and evaluated on the {model.testSize.toLocaleString()} most recent windows it had not seen.</>}
            </p>
          </Card>

          <Card title="Model card" sub={`${model.algorithm} · v${model.version}`}
            action={<Badge tone={model.source === 'telemetry' ? 'pred' : ''}>{model.source === 'telemetry' ? 'trained on telemetry' : 'synthetic data'}</Badge>}>
            {model.fallback && <div className="muted small" style={{ marginBottom: 10 }}><b>{scope}</b> has no model of its own yet, so it uses the global one.</div>}
            {(() => {
              const maxW = Math.max(...model.features.map((f) => Math.abs(f.weight)), 1e-6);
              return model.features.map((f) => (
                <div className="wbar" key={f.name}>
                  <span>{f.name}</span>
                  <div className="track"><i style={{ background: f.weight >= 0 ? 'var(--crit)' : 'var(--ok)', left: f.weight >= 0 ? '50%' : `${50 - (Math.abs(f.weight) / maxW) * 50}%`, width: `${(Math.abs(f.weight) / maxW) * 50}%` }} /></div>
                  <span className="mono muted" style={{ textAlign: 'right' }}>{f.weight.toFixed(2)}</span>
                </div>
              ));
            })()}
            <dl className="kv" style={{ margin: '14px 0 0' }}>
              <dt>Accuracy / F1</dt><dd>{pct(model.evaluation.accuracy)} / {model.evaluation.f1.toFixed(2)}</dd>
              <dt>Brier score (lower is better)</dt><dd>{model.evaluation.brier.toFixed(3)}</dd>
              <dt>Trained</dt><dd>{timeAgo(model.trainedAt)}</dd>
            </dl>
            {scope !== 'global' && (
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn primary sm" disabled={!isAdmin || retrain.isPending} onClick={() => retrain.mutate()}><RefreshCw size={13} className={retrain.isPending ? 'spin' : ''} />{retrain.isPending ? 'Training…' : 'Retrain from telemetry'}</button>
                {current?.own && <button className="btn sm" disabled={!isAdmin || useGlobal.isPending} onClick={() => confirm(`Drop the model trained for ${scope} and use the global one?`) && useGlobal.mutate()}><Undo2 size={13} />Use global model</button>}
              </div>
            )}
            <Versions scope={scope} canEdit={isAdmin} />
          </Card>
        </div>
      )}
      {result && (
        <Modal title={result.activated ? 'Model retrained' : 'Model not replaced'} onClose={() => setResult(null)} footer={<button className="btn primary" onClick={() => setResult(null)}>Close</button>}>
          <p style={{ margin: 0 }}>{result.reason}</p>
          <dl className="kv" style={{ margin: 0 }}>
            <dt>Version</dt><dd>v{result.version}</dd>
            <dt>Windows dropped between train and test</dt><dd>{result.samples.purged.toLocaleString()} (prevents look-ahead leakage)</dd>
            <dt>Training windows</dt><dd>{result.samples.train.toLocaleString()} ({result.samples.positives.toLocaleString()} ended in a breach)</dd>
            <dt>Held-out windows</dt><dd>{result.samples.test.toLocaleString()}</dd>
            <dt>New model: AUC / precision / recall</dt><dd>{result.evaluation.auc.toFixed(2)} / {pct(result.evaluation.precision)} / {pct(result.evaluation.recall)}</dd>
            <dt>Previous model: AUC / precision / recall</dt><dd>{result.previous.auc.toFixed(2)} / {pct(result.previous.precision)} / {pct(result.previous.recall)}</dd>
          </dl>
        </Modal>
      )}
    </>
  );
}

function HistoryCard({ deviceId }: { deviceId: string }) {
  const { data } = useLive<PredictionSnapshot[]>(`/anomaly/history?deviceId=${deviceId}&limit=12`, 15000);
  return (
    <Card title="Prediction history" sub="Snapshots the model stored while a signal looked at risk (at most one every 30 s per signal)" flush>
      {!data?.length ? <Empty>No at-risk predictions recorded for this device.</Empty> : (
        <div className="table-wrap" style={{ maxHeight: 360, overflow: 'auto' }}><table>
          <thead><tr><th>When</th><th>Signal</th><th className="num">Probability</th><th className="num">ETA</th><th>Model</th></tr></thead>
          <tbody>
            {data.map((h) => (
              <tr key={h.id}>
                <td className="muted nowrap">{timeAgo(h.createdAt)}</td>
                <td>{METRIC_META[h.metric].label}</td>
                <td className="num">{pct(h.probability)}</td>
                <td className="num nowrap">{eta(h.secondsToBreach)}</td>
                <td className="nowrap"><Badge tone={h.modelSource === 'telemetry' ? 'pred' : ''}>{h.modelScope} {h.modelVersion}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Card>
  );
}

/** Every trained version for the selected scope - including retrains the validation gate rejected. */
function Versions({ scope, canEdit }: { scope: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data } = useLive<ModelVersion[]>(`/anomaly/models/${encodeURIComponent(scope)}/versions`, 20000);
  const activate = useMutation({
    mutationFn: (v: number) => api.post(`/anomaly/models/${encodeURIComponent(scope)}/versions/${v}/activate`),
    onSuccess: () => { qc.invalidateQueries(); toast('Version activated'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  if (!data?.length) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <div className="strong" style={{ marginBottom: 6 }}>Versions</div>
      <div className="table-wrap"><table>
        <thead><tr><th>Ver.</th><th>Source</th><th className="num">AUC</th><th>Status</th><th /></tr></thead>
        <tbody>
          {data.map((v) => (
            <tr key={v.id} title={v.reason}>
              <td className="mono">v{v.version}</td>
              <td className="small">{v.source}<div className="muted">{timeAgo(v.trainedAt)} · {v.trainedBy}</div></td>
              <td className="num">{v.evaluation.auc.toFixed(2)}</td>
              <td>{v.isActive ? <Badge tone="ok">active</Badge> : v.activated ? <Badge>accepted</Badge> : <Badge tone="crit">rejected</Badge>}</td>
              <td style={{ textAlign: 'right' }}>
                {!v.isActive && v.activated && scope !== 'global' && <button className="btn sm" disabled={!canEdit || activate.isPending} onClick={() => confirm(`Switch ${scope} back to model v${v.version}?`) && activate.mutate(v.version)}>Activate</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}
