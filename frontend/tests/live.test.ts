import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, isPushConnected, PushEvent } from '../src/live';

const enc = new TextEncoder();

/** A fetch response whose body streams the given chunks, then stays open (like a real SSE connection). */
function streamResponse(chunks: string[], keepOpen = true) {
  const signalRef: { signal?: AbortSignal } = {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!keepOpen) controller.close();
      signalRef.signal?.addEventListener('abort', () => { try { controller.close(); } catch { /* already closed */ } });
    },
  });
  return { response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }), signalRef };
}

const waitFor = async (check: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return check();
};

afterEach(() => vi.unstubAllGlobals());

describe('push stream client', () => {
  it('connects with the bearer token, reports connectivity and dispatches parsed events', async () => {
    const events: PushEvent[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const { response, signalRef } = streamResponse([
        'retry: 3000\n\nevent: hello\ndata: {}\n\n',
        'event: alert\ndata: {"type":"alert","data":{"id":7},"ts":1}\n\n',
        // an event split across two network chunks must still be reassembled
        'event: tick\ndata: {"type":"ti',
        'ck","ts":2}\n\n',
        ': ping\n\n',
      ]);
      signalRef.signal = init?.signal ?? undefined;
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const stop = connectEvents(() => 'tok-123', (e) => events.push(e));
    expect(await waitFor(() => events.length >= 2)).toBe(true);

    expect(fetchMock).toHaveBeenCalledWith('/api/events', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok-123' }) }));
    expect(events.map((e) => e.type)).toEqual(['alert', 'tick']);
    expect(events[0].data).toEqual({ id: 7 });
    expect(isPushConnected()).toBe(true);

    stop();
    expect(isPushConnected()).toBe(false);
  });

  it('does not connect without a sign-in token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const stop = connectEvents(() => null, () => undefined);
    await new Promise((r) => setTimeout(r, 150));
    expect(fetchMock).not.toHaveBeenCalled();
    stop();
  });

  it('ignores malformed events instead of crashing', async () => {
    const events: PushEvent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      const { response, signalRef } = streamResponse(['event: hello\ndata: {}\n\n', 'event: alert\ndata: {not json}\n\n', 'event: alert\ndata: {"type":"alert","ts":3}\n\n']);
      signalRef.signal = init?.signal ?? undefined;
      return response;
    }));
    const stop = connectEvents(() => 't', (e) => events.push(e));
    expect(await waitFor(() => events.length === 1)).toBe(true);
    expect(events[0].ts).toBe(3);
    stop();
  });
});
