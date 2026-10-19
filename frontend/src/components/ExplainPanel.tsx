import { Explanation, METRIC_META, MetricForecast } from '../api';
import { pct } from '../format';
import { Badge } from './ui';

const fmt = (v: number, digits = 1) => v.toFixed(digits);

/**
 * "Why is this the risk?" - built only from numbers the model actually used. Logistic regression is
 * linear, so each feature's push on the log-odds is exact; nothing here is guessed or generated.
 */
export default function ExplainPanel({ forecast }: { forecast: MetricForecast }) {
  const e: Explanation | undefined = forecast.explanation;
  if (!e) return null;
  const meta = METRIC_META[forecast.metric];
  const unit = meta.unit.trim();
  const maxAbs = Math.max(...e.features.map((f) => Math.abs(f.contribution)), 0.01);
  const side = e.direction === 'above' ? 'rise above' : 'fall below';
  const climbing = e.direction === 'above' ? e.slopePerMin > 0 : e.slopePerMin < 0;

  return (
    <div className="explain">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{meta.label}: why {pct(forecast.probability)}?</b>
        <Badge tone={e.model.source === 'telemetry' ? 'pred' : ''}>{e.model.scope} · {e.model.version} · {e.model.source}</Badge>
      </div>

      <p className="small" style={{ margin: '8px 0' }}>
        Now <b>{fmt(e.current)}{unit}</b>; the alert fires if it would {side} <b>{fmt(e.threshold)}{unit}</b>.
        {' '}The noise-free trend is <b>{fmt(e.fittedLevel)}{unit}</b>, {e.headroom >= 0
          ? <><b>{fmt(e.headroom)}{unit}</b> of headroom left</>
          : <>already <b>{fmt(-e.headroom)}{unit}</b> beyond the threshold</>}
        , {climbing ? 'moving toward it' : 'moving away from it'} at <b>{fmt(Math.abs(e.slopePerMin))}{unit}/min</b>.
        {' '}The model looks {e.horizonReadings} readings ahead (about {Math.round(e.horizonSeconds)} s at the observed {fmt(e.readingIntervalSeconds)} s interval)
        and gives <b>{pct(e.modelProbability)}</b> that the threshold is crossed in that window.
        {e.linearEtaSeconds !== null && <> A straight-line extrapolation reaches it in about {Math.round(e.linearEtaSeconds)} s.</>}
      </p>

      {e.adjustmentNote && <div className="note">{e.adjustmentNote}</div>}

      <div className="small muted" style={{ marginBottom: 4 }}>Push of each feature on the log-odds (bias {fmt(e.bias, 2)}, total {fmt(e.logit, 2)}):</div>
      {e.features.map((f) => (
        <div className="wbar" key={f.name} style={{ gridTemplateColumns: '190px 1fr 56px' }}>
          <span title={`value ${f.value.toFixed(3)}, standardised ${f.standardized.toFixed(2)}, weight ${f.weight.toFixed(2)}`}>{f.name}</span>
          <div className="track">
            <i style={{ background: f.contribution >= 0 ? 'var(--crit)' : 'var(--ok)', left: f.contribution >= 0 ? '50%' : `${50 - (Math.abs(f.contribution) / maxAbs) * 50}%`, width: `${(Math.abs(f.contribution) / maxAbs) * 50}%` }} />
          </div>
          <span className="mono muted" style={{ textAlign: 'right' }}>{f.contribution >= 0 ? '+' : ''}{f.contribution.toFixed(2)}</span>
        </div>
      ))}

      <p className="muted small" style={{ margin: '10px 0 0' }}>
        This is the probability of crossing a <b>configured threshold</b>, not of equipment failure. The model was trained on
        {e.model.source === 'synthetic' ? ' synthetic episodes' : ' stored telemetry of this machine type'} (AUC {e.model.auc.toFixed(2)} on its own held-out data).
        {' '}Confidence is limited to {e.readingsUsed} recent readings.
      </p>
    </div>
  );
}
