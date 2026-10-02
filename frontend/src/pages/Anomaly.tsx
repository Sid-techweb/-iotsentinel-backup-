import { useState } from 'react';
import { DevicePrediction, FleetPrediction, METRIC_META, ModelCard, useLive } from '../api';
import ForecastChart, { ChartLegend } from '../components/ForecastChart';
import { Badge, Card, Empty, PageHead, RiskBadge, RiskBar } from '../components/ui';
import { eta, pct } from '../format';
import { Link } from 'react-router-dom';

export default function Anomaly() {
  const { data: fleet } = useLive<FleetPrediction[]>('/anomaly/predictions', 2500);
  const { data: model } = useLive<ModelCard>('/anomaly/model', false);
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
      <PageHead title="Anomaly prediction" desc="Forecasts which devices will breach a limit before it happens, so staff can act ahead of the alert." />

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

      {model && (
        <div className="grid g2" style={{ marginTop: 16 }}>
          <Card title="How the prediction works">
            <ol className="steps">
              <li><b>Window.</b> The last {model.window} readings of each metric are read from the Redis rolling buffer.</li>
              <li><b>Features.</b> A least-squares fit gives the denoised level, trend and volatility; these are compared with the alert limit to get headroom and projected margin.</li>
              <li><b>Classifier.</b> A logistic-regression model ({model.parameterCount} parameters) outputs the probability the limit is crossed within {model.horizon} readings.</li>
              <li><b>Act early.</b> Above {pct(model.alertProbability)} a predictive alert opens with an estimated time-to-breach; it clears itself when the trend recovers.</li>
            </ol>
            <p className="muted small" style={{ marginBottom: 0 }}>Trained on {model.trainSize.toLocaleString()} synthetic drift / leak / recovery episodes in normalised units, so one model covers every metric. Evaluated on {model.testSize.toLocaleString()} held-out episodes.</p>
          </Card>

          <Card title="Model card" sub={`${model.algorithm} · v${model.version}`}>
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
              <dt>Trained</dt><dd>{new Date(model.trainedAt).toLocaleDateString()}</dd>
            </dl>
          </Card>
        </div>
      )}
    </>
  );
}
