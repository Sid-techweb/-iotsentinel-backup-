import { config } from '../config';
import { q } from '../db';
import { METRIC_KEYS, METRICS, MetricKey, Metrics } from '../ml/metrics';
import { pick, rand } from '../util';
import { createIncident, INCIDENT_CATEGORIES, Severity } from './incidents';
import { ingest } from './ingest';
import { getRules } from './rules';

/**
 * Fleet simulator (the "IoT devices / simulator" box in the architecture).
 * Every tick each simulated device reports telemetry through the same ingest
 * pipeline a real device would use. Healthy devices wobble around a baseline;
 * every so often a device starts a slow fault (overheating, memory leak, battery
 * drain, weak signal) so the predictor has real degradation to catch, or drops
 * offline to exercise missed-heartbeat detection.
 */

export const BASELINES: Record<string, Metrics> = {
  'Smart Sensor': { temperature: 28, cpu: 18, memory: 42, battery: 85, signal: -58 },
  'Asset Tracker': { temperature: 30, cpu: 20, memory: 40, battery: 78, signal: -66 },
  Gateway: { temperature: 46, cpu: 34, memory: 55, battery: null, signal: -50 },
  'IP Camera': { temperature: 50, cpu: 45, memory: 60, battery: null, signal: -55 },
  'Smart Meter': { temperature: 35, cpu: 15, memory: 38, battery: null, signal: -62 },
  'Industrial Controller': { temperature: 52, cpu: 40, memory: 58, battery: null, signal: -52 },
};

const NOISE: Record<MetricKey, number> = { temperature: 0.5, cpu: 2, memory: 0.8, battery: 0.05, signal: 1.2 };
const WANDER: Record<MetricKey, number> = { temperature: 1.5, cpu: 3, memory: 1.5, battery: 0, signal: 2 };

interface Fault {
  metric: MetricKey;
  rate: number; // signed offset change per tick while ramping
  rampTicks: number;
  holdTicks: number;
  phase: 'ramp' | 'hold' | 'recover';
  t: number;
}

export interface SimState {
  id: string;
  type: string;
  tick: number;
  phase: number;
  batteryLevel: number;
  offsets: Partial<Record<MetricKey, number>>;
  fault?: Fault;
  offlineTicks: number;
}

const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

export function newState(id: string, type: string): SimState {
  const base = BASELINES[type] ?? BASELINES['Smart Sensor'];
  return { id, type, tick: 0, phase: rand(0, 6.28), batteryLevel: base.battery === null ? 0 : rand(55, 92), offsets: {}, offlineTicks: 0 };
}

export function reading(s: SimState): Metrics {
  const base = BASELINES[s.type] ?? BASELINES['Smart Sensor'];
  const out: Metrics = { temperature: null, cpu: null, memory: null, battery: null, signal: null };
  for (const k of METRIC_KEYS) {
    if (base[k] === null) continue;
    const b = k === 'battery' ? s.batteryLevel : (base[k] as number);
    const v = b + WANDER[k] * Math.sin(s.tick / 18 + s.phase) + NOISE[k] * gauss() + (s.offsets[k] ?? 0);
    out[k] = Math.round(Math.max(k === 'signal' ? -120 : 0, Math.min(k === 'signal' ? -20 : 100, v)) * 100) / 100;
  }
  s.tick++;
  if (base.battery !== null) s.batteryLevel = Math.max(3, s.batteryLevel - 0.004);
  return out;
}

function advanceFault(s: SimState) {
  const f = s.fault;
  if (!f) return;
  f.t++;
  if (f.phase === 'ramp') {
    s.offsets[f.metric] = (s.offsets[f.metric] ?? 0) + f.rate;
    if (f.t >= f.rampTicks) { f.phase = 'hold'; f.t = 0; }
  } else if (f.phase === 'hold') {
    if (f.t >= f.holdTicks) { f.phase = 'recover'; f.t = 0; }
  } else {
    const next = (s.offsets[f.metric] ?? 0) * 0.55;
    s.offsets[f.metric] = next;
    if (Math.abs(next) < METRICS[f.metric].range * 0.004) { delete s.offsets[f.metric]; s.fault = undefined; }
  }
}

async function startFault(s: SimState) {
  if (Math.random() < 0.15) { s.offlineTicks = 8 + Math.floor(rand(0, 6)); return; }
  const base = BASELINES[s.type] ?? BASELINES['Smart Sensor'];
  const choices = METRIC_KEYS.filter((k) => base[k] !== null);
  const metric = pick(choices);
  const { dir, range } = METRICS[metric];
  const rules = (await getRules()).filter((r) => r.metric === metric && r.enabled);
  const warn = rules.find((r) => r.severity === 'warning') ?? rules[0];
  const crit = rules.find((r) => r.severity === 'critical');
  if (!warn) return;
  const start = metric === 'battery' ? s.batteryLevel : (base[metric] as number);
  const goCritical = crit !== undefined && Math.random() < 0.3;
  const target = (goCritical ? crit!.threshold : warn.threshold);
  const distance = Math.abs(target - start) + range * 0.05;
  const rampTicks = Math.floor(rand(30, 46));
  s.fault = { metric, rate: (dir * distance) / rampTicks, rampTicks, holdTicks: 4, phase: 'ramp', t: 0 };
}

const TEMPLATES: { category: (typeof INCIDENT_CATEGORIES)[number]; severity: Severity; text: () => string }[] = [
  { category: 'Brute-force login', severity: 'high', text: () => `${Math.floor(rand(25, 90))} failed admin logins in 60s from 203.0.113.${Math.floor(rand(2, 250))}` },
  { category: 'Unsigned firmware attempt', severity: 'critical', text: () => 'Firmware image rejected: signature verification failed' },
  { category: 'Unexpected open port', severity: 'medium', text: () => `Port ${pick([23, 2323, 8081, 5555])}/tcp opened outside the approved baseline` },
  { category: 'Certificate expiring', severity: 'low', text: () => `Device TLS certificate expires in ${Math.floor(rand(3, 14))} days` },
  { category: 'Configuration tampering', severity: 'high', text: () => 'Configuration hash changed without an approved change request' },
  { category: 'Malformed / replayed packets', severity: 'medium', text: () => `${Math.floor(rand(12, 60))} replayed MQTT frames dropped in the last minute` },
];

export function startSimulator() {
  const sims = new Map<string, SimState>();

  const tick = async () => {
    try {
      const devs = await q<{ id: string; type: string }>('SELECT id, type FROM devices WHERE simulated');
      for (const d of devs) if (!sims.has(d.id)) sims.set(d.id, newState(d.id, d.type));
      for (const id of sims.keys()) if (!devs.find((d) => d.id === id)) sims.delete(id);

      const list = [...sims.values()];
      const active = list.filter((s) => s.fault || s.offlineTicks > 0).length;
      if (list.length && active < 3 && Math.random() < 0.04) {
        const idle = list.filter((s) => !s.fault && s.offlineTicks === 0);
        if (idle.length) await startFault(pick(idle));
      }

      await Promise.all(
        list.map(async (s) => {
          advanceFault(s);
          if (s.offlineTicks > 0) { s.offlineTicks--; return; }
          try { await ingest(s.id, reading(s)); } catch (e) { console.error('[sim]', e); }
        }),
      );

      if (list.length && Math.random() < 0.012) {
        const tpl = pick(TEMPLATES);
        await createIncident({ deviceId: pick(list).id, category: tpl.category, severity: tpl.severity, description: tpl.text() });
      }
    } catch (e) {
      console.error('[sim]', e);
    }
  };

  // kick off two faults shortly after boot so the demo has something to predict
  setTimeout(async () => {
    const devs = await q<{ id: string; type: string }>('SELECT id, type FROM devices WHERE simulated ORDER BY random() LIMIT 2');
    for (const d of devs) {
      if (!sims.has(d.id)) sims.set(d.id, newState(d.id, d.type));
      await startFault(sims.get(d.id)!);
    }
  }, config.simIntervalMs * 2);

  return setInterval(tick, config.simIntervalMs);
}
