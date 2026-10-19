import { useSyncExternalStore } from 'react';

/**
 * Server-Sent Events client. The browser opens one authenticated stream; every event the
 * backend publishes (alerts, incidents, firmware, fresh telemetry...) reaches us instantly.
 * While it is connected the regular polling slows right down and becomes a safety net.
 */
let connected = false;
const listeners = new Set<() => void>();

function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  listeners.forEach((l) => l());
}

export const isPushConnected = () => connected;
export const usePushConnected = () =>
  useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => connected);

export interface PushEvent { type: string; data?: Record<string, unknown>; ts: number }

/** Parse a text/event-stream body. fetch (not EventSource) is used so the sign-in header can be sent. */
export function connectEvents(getToken: () => string | null, onEvent: (e: PushEvent) => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let retry = 1000;

  const run = async () => {
    while (!stopped) {
      const token = getToken();
      if (!token) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      controller = new AbortController();
      try {
        const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`stream refused (${res.status})`);
        retry = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
            const name = block.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
            if (name === 'hello') { setConnected(true); continue; }
            if (name === 'busy') throw new Error('server is at its stream limit');
            if (data) { try { onEvent(JSON.parse(data) as PushEvent); } catch { /* ignore malformed event */ } }
          }
        }
      } catch {
        /* network drop, sign-out or server restart: fall through and reconnect */
      }
      setConnected(false);
      if (stopped) break;
      await new Promise((r) => setTimeout(r, retry));
      retry = Math.min(retry * 2, 15000);
    }
  };
  void run();

  return () => {
    stopped = true;
    controller?.abort();
    setConnected(false);
  };
}
