import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clock, eta, fmtMetric, pct, timeAgo } from '../src/format';

describe('timeAgo', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T12:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it('describes recent, minute, hour and day gaps', () => {
    expect(timeAgo('2026-01-01T11:59:59Z')).toBe('just now');
    expect(timeAgo('2026-01-01T11:59:30Z')).toBe('30s ago');
    expect(timeAgo('2026-01-01T11:55:00Z')).toBe('5m ago');
    expect(timeAgo('2026-01-01T09:00:00Z')).toBe('3h ago');
    expect(timeAgo('2025-12-30T12:00:00Z')).toBe('2d ago');
  });

  it('copes with missing values and clock skew', () => {
    expect(timeAgo(null)).toBe('never');
    expect(timeAgo(undefined)).toBe('never');
    expect(timeAgo('2026-01-01T12:00:30Z')).toBe('just now'); // a timestamp slightly in the future
  });
});

describe('eta', () => {
  it('picks a readable unit', () => {
    expect(eta(0)).toBe('now');
    expect(eta(42)).toBe('~42s');
    expect(eta(150)).toBe('~2.5 min');
    expect(eta(7200)).toBe('~2.0 h');
    expect(eta(null)).toBe('-');
  });
});

describe('metric formatting', () => {
  it('uses each metric’s unit and precision', () => {
    expect(fmtMetric('temperature', 41.567)).toBe('41.6°C');
    expect(fmtMetric('cpu', 22.4)).toBe('22%');
    expect(fmtMetric('signal', -61.2)).toBe('-61 dBm');
    expect(fmtMetric('vibration', 3.24)).toBe('3.2 mm/s');
    expect(fmtMetric('pressure', 5.55)).toBe('5.5 bar');
    expect(fmtMetric('current', 14)).toBe('14.0 A');
    expect(fmtMetric('battery', null)).toBe('-');
  });

  it('formats percentages and clock times', () => {
    expect(pct(0.874)).toBe('87%');
    expect(clock('2026-01-01T09:05:00Z')).toMatch(/\d{1,2}:\d{2}/);
  });
});
