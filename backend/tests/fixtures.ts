import { col } from '../src/mongo';

/** Deterministic noise so tests never flake. */
export function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

/**
 * A machine that idles around 40 C, then repeatedly overheats: a steady climb past its 70 C limit,
 * followed by a recovery. Exactly the pattern the predictor is meant to anticipate.
 */
export async function storeOverheatingHistory(deviceId: string, readings = 3000, seed = 11) {
  const r = rng(seed);
  const now = Date.now();
  const ts: number[] = [];
  const temp: number[] = [];
  for (let i = 0; i < readings; i++) {
    const phase = i % 200;
    let v = 40;
    if (phase >= 120 && phase < 160) v = 40 + (phase - 120) * 0.95; // ramp 40 -> 78
    else if (phase >= 160) v = 78 - (phase - 160) * 0.95; // cool down
    ts.push((now - (readings - i) * 2000) / 1000);
    temp.push(v + (r() - 0.5) * 0.6);
  }
  await col('telemetry').insertMany(ts.map((t, i) => ({ deviceId, ts: new Date(t * 1000), temperature: temp[i] })));
}
