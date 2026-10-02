export const WINDOW = 20; // readings the model looks at
export const HORIZON = 20; // readings into the future it predicts over
export const MIN_POINTS = 8;

export const FEATURE_NAMES = [
  'headroom to threshold',
  'projected movement over horizon',
  'projected margin',
  'volatility (residual σ)',
  'trend ÷ headroom',
];

const clip = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface LinFit {
  slope: number; // per reading
  last: number; // fitted value at the newest reading (denoised level)
  resid: number; // residual standard deviation
}

/** Ordinary least squares over the window. */
export function linFit(y: number[]): LinFit {
  const n = y.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (y[i] - (intercept + slope * i)) ** 2;
  return { slope, last: intercept + slope * (n - 1), resid: Math.sqrt(ss / n) };
}

/**
 * Turn a window of readings into model features.
 * `stress` is the series oriented so that "higher = closer to breach";
 * `T` is the breach level in that orientation and `R` the metric's operating range.
 */
export function extract(stress: number[], T: number, R: number): { x: number[]; fit: LinFit } | null {
  if (stress.length < MIN_POINTS) return null;
  const fit = linFit(stress.slice(-WINDOW));
  const h = (T - fit.last) / R; // headroom
  const g = (fit.slope * HORIZON) / R; // movement expected over the horizon
  return {
    fit,
    x: [
      clip(h, -0.5, 1),
      clip(g, -0.5, 0.8),
      clip(h - g, -1, 1.5),
      clip(fit.resid / R, 0, 0.2),
      clip(g / Math.max(h, 0.03), -1, 5),
    ],
  };
}
