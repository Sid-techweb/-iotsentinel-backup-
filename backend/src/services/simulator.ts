import { config } from '../config';
import { q } from '../db';
import { emptyMetrics, METRIC_KEYS, METRICS, MetricKey, Metrics } from '../ml/metrics';
import { pick, rand } from '../util';
import { baselinesFor } from './deviceTypes';
import { createIncident, INCIDENT_CATEGORIES, Severity } from './incidents';
import { ingest } from './ingest';
import { rulesForType } from './rules';

/**
 * Fleet simulator (the "IoT devices / simulator" box in the architecture).
 * Every tick each simulated device reports telemetry through the same ingest
 * pipeline a real device would use, but only the signals its machine type has.
 * Healthy devices wobble around a baseline; every so often a device starts a slow
 * fault (overheating, memory leak, battery drain, weak signal, bearing vibration...)
 * so the predictor has real degradation to catch, or drops offline to exercise
 * missed-heartbeat detection.
 */

export type Baseline = Partial<Record<MetricKey, number>>;

const NOISE: Record<MetricKey, number> = { temperature: 0.5, cpu: 2, memory: 0.8, battery: 0.05, signal: 1.2, vibration: 0.12, pressure: 0.06, current: 0.35 };
const WANDER: Record<MetricKey, number> = { temperature: 1.5, cpu: 3, memory: 1.5, battery: 0, signal: 2, vibration: 0.25, pressure: 0.15, current: 0.7 };
const CLAMP: Record<MetricKey, [number, number]> = {
  temperature: [-20, 150], cpu: [0, 100], memory: [0, 100], battery: [0, 100], signal: [-120, -20], vibration: [0, 40], pressure: [0, 20], current: [0, 60],
};

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
  base: Baseline;
  tick: number;
  phase: number;
  batteryLevel: number;
  offsets: Partial<Record<MetricKey, number>>;
  fault?: Fault;
  offlineTicks: number;
}

const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

export function newState(id: string, type: string, base: Baseline): SimState {
  return { id, type, base, tick: 0, phase: rand(0, 6.28), batteryLevel: base.battery === undefined ? 0 : rand(55, 92), offsets: {}, offlineTicks: 0 };
}

/** One reading containing only the signals this machine type reports. */
export function reading(s: SimState): Metrics {
  const out = emptyMetrics();
  for (const k of METRIC_KEYS) {
    const start = s.base[k];
    if (start === undefined) continue;
    const b = k === 'battery' ? s.batteryLevel : start;
    const v = b + WANDER[k] * Math.sin(s.tick / 18 + s.phase) + NOISE[k] * gauss() + (s.offsets[k] ?? 0);
    const [lo, hi] = CLAMP[k];
    out[k] = Math.round(Math.max(lo, Math.min(hi, v)) * 100) / 100;
  }
  s.tick++;
  if (s.base.battery !== undefined) s.batteryLevel = Math.max(3, s.batteryLevel - 0.004);
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

async function startFault(s: SimState, forced?: MetricKey, noOutage = false) {
  if (!noOutage && Math.random() < 0.15) { s.offlineTicks = 8 + Math.floor(rand(0, 6)); return; }
  const choices = METRIC_KEYS.filter((k) => s.base[k] !== undefined);
  if (!choices.length) return;
  const metric = forced && choices.includes(forced) ? forced : pick(choices);
  const { dir, range } = METRICS[metric];
  const rules = (await rulesForType(s.type)).filter((r) => r.metric === metric && r.enabled);
  const warn = rules.find((r) => r.severity === 'warning') ?? rules[0];
  const crit = rules.find((r) => r.severity === 'critical');
  if (!warn) return;
  const start = metric === 'battery' ? s.batteryLevel : (s.base[metric] as number);
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

const sims = new Map<string, SimState>();
let paused = false;

export const simulatorStatus = () => ({ running: !paused, devices: sims.size, activeFaults: [...sims.values()].filter((s) => s.fault || s.offlineTicks > 0).length });
export const setSimulatorPaused = (v: boolean) => { paused = v; };

/** Force a degradation on one simulated device so the predictor can be demonstrated on demand. */
export async function injectFault(deviceId: string, metric?: MetricKey): Promise<boolean> {
  const s = sims.get(deviceId);
  if (!s || s.fault) return false;
  await startFault(s, metric, true);
  return !!s.fault;
}

async function ensureState(d: { id: string; type: string }) {
  if (!sims.has(d.id)) sims.set(d.id, newState(d.id, d.type, await baselinesFor(d.type)));
  return sims.get(d.id)!;
}

export function startSimulator() {
  const tick = async () => {
    if (paused) return;
    try {
      const devs = await q<{ id: string; type: string }>('SELECT id, type FROM devices WHERE simulated AND active');
      for (const d of devs) await ensureState(d);
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
    try {
      const devs = await q<{ id: string; type: string }>('SELECT id, type FROM devices WHERE simulated AND active ORDER BY random() LIMIT 2');
      for (const d of devs) await startFault(await ensureState(d));
    } catch (e) {
      console.error('[sim]', e);
    }
  }, config.simIntervalMs * 2);

  return setInterval(tick, config.simIntervalMs);
}
