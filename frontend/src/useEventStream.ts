import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getToken } from './api';
import { connectEvents } from './live';

/** What each server event means for the screens: which cached queries are now stale. */
const STALE: Record<string, (key: string) => boolean> = {
  // fresh telemetry: device lists/detail, forecasts and the dashboard (not the heavy history queries)
  tick: (k) => (k.startsWith('/devices') && !k.includes('/readings')) || k.startsWith('/anomaly/predictions') || k.startsWith('/dashboard') || k.startsWith('/simulator'),
  alert: (k) => k.startsWith('/alerts') || k.startsWith('/dashboard') || k.startsWith('/devices') || k.startsWith('/anomaly/predictions'),
  incident: (k) => k.startsWith('/incidents') || k.startsWith('/dashboard'),
  firmware: (k) => k.startsWith('/firmware') || k.startsWith('/devices') || k.startsWith('/dashboard'),
  device: (k) => k.startsWith('/devices') || k.startsWith('/dashboard'),
  rules: (k) => k.startsWith('/rules') || k.startsWith('/anomaly'),
  model: (k) => k.startsWith('/anomaly') || k.startsWith('/device-types'),
  user: (k) => k.startsWith('/users'),
  webhook: (k) => k.startsWith('/webhooks'),
  kb: (k) => k.startsWith('/knowledge') || k.startsWith('/assistant/health'),
};

/** Opens the push stream while the user is signed in and refetches only what changed. */
export function useEventStream(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return connectEvents(getToken, (e) => {
      const stale = STALE[e.type];
      if (stale) void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && stale(q.queryKey[0] as string) });
    });
  }, [enabled, qc]);
}
