import { describe, expect, it } from 'vitest';
import { compareVersions, hashKey, newDeviceKey, toCsv } from '../../src/util';
import { effectiveRules, Rule } from '../../src/services/rules';
import { isPrivateIp, sign } from '../../src/services/webhooks';

describe('compareVersions', () => {
  it('orders semantic versions numerically, not alphabetically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });
});

describe('device keys', () => {
  it('are random, long enough, and hashed deterministically', () => {
    const a = newDeviceKey();
    const b = newDeviceKey();
    expect(a).not.toBe(b);
    expect(a).toHaveLength(32);
    expect(hashKey(a)).toBe(hashKey(a));
    expect(hashKey(a)).not.toContain(a);
    expect(hashKey(a)).toHaveLength(64);
  });
});

describe('toCsv', () => {
  const cols = [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }];

  it('quotes commas, quotes and newlines', () => {
    const csv = toCsv([{ a: 'x,y', b: 'say "hi"\nthere' }], cols);
    expect(csv).toBe('A,B\r\n"x,y","say ""hi""\nthere"\r\n');
  });

  it('neutralises spreadsheet formulas (CSV injection)', () => {
    const csv = toCsv([{ a: '=HYPERLINK("http://evil")', b: '+1' }, { a: '@cmd', b: '-2' }], cols);
    for (const cell of ['=HYPERLINK', '+1', '@cmd', '-2']) expect(csv).not.toMatch(new RegExp(`(^|,|\\r\\n)"?${cell.replace(/[+]/g, '\\+')}`));
    expect(csv).toContain("'=HYPERLINK");
  });

  it('renders null as empty and dates as ISO strings', () => {
    expect(toCsv([{ a: null, b: new Date('2026-01-02T03:04:05Z') }], cols)).toBe('A,B\r\n,2026-01-02T03:04:05.000Z\r\n');
  });
});

describe('effectiveRules', () => {
  const rule = (id: number, metric: any, severity: any, threshold: number, deviceType: string | null, enabled = true): Rule =>
    ({ id, metric, operator: '>', threshold, severity, enabled, deviceType });
  const all = [
    rule(1, 'temperature', 'warning', 70, null), rule(2, 'temperature', 'critical', 85, null),
    rule(3, 'temperature', 'warning', 75, 'CNC Machine'), rule(4, 'cpu', 'warning', 85, null),
  ];

  it('uses the defaults when a type has no override', () => {
    expect(effectiveRules(all, 'Gateway').map((r) => r.id).sort()).toEqual([1, 2, 4]);
    expect(effectiveRules(all, null).map((r) => r.id).sort()).toEqual([1, 2, 4]);
  });

  it('lets a type override win over the default for that metric and severity only', () => {
    const cnc = effectiveRules(all, 'CNC Machine');
    expect(cnc.find((r) => r.metric === 'temperature' && r.severity === 'warning')!.threshold).toBe(75);
    expect(cnc.find((r) => r.metric === 'temperature' && r.severity === 'critical')!.threshold).toBe(85);
    expect(cnc).toHaveLength(3);
  });

  it('respects an override that disables a limit', () => {
    const disabled = [...all, rule(5, 'cpu', 'warning', 85, 'Gateway', false)];
    expect(effectiveRules(disabled, 'Gateway').find((r) => r.metric === 'cpu')!.enabled).toBe(false);
    expect(effectiveRules(disabled, 'IP Camera').find((r) => r.metric === 'cpu')!.enabled).toBe(true);
  });
});

describe('webhook helpers', () => {
  it('recognises private, loopback and link-local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '172.31.255.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd12::3', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '203.0.113.5', '2606:4700:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('signs bodies with HMAC-SHA256 so receivers can verify them', () => {
    const sig = sign('secret', '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sign('secret', '{"a":1}')).toBe(sig);
    expect(sign('other', '{"a":1}')).not.toBe(sig);
    expect(sign('secret', '{"a":2}')).not.toBe(sig);
  });
});
