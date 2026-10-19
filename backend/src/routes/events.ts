import { Router } from 'express';
import { addClient } from '../services/events';

export const eventsRouter = Router();

/**
 * Server-Sent Events stream. The browser opens it once (with its sign-in token) and is told
 * the moment alerts, incidents, firmware or fresh telemetry change, instead of polling for them.
 */
eventsRouter.get('/', (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
  });
  if (!addClient(res)) {
    res.write('event: busy\ndata: {}\n\n');
    return res.end();
  }
  res.write('retry: 3000\n\nevent: hello\ndata: {}\n\n');
});
