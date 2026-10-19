import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { adminWrites, authenticate } from './auth';
import { config } from './config';
import { pool } from './db';
import { byDeviceKey, rateLimit } from './middleware/rateLimit';
import { redis } from './redis';
import { alertsRouter } from './routes/alerts';
import { assistantRouter } from './routes/assistant';
import { reportsRouter } from './routes/reports';
import { anomalyRouter } from './routes/anomaly';
import { auditRouter } from './routes/audit';
import { authRouter } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';
import { deviceTypesRouter } from './routes/deviceTypes';
import { devicesRouter } from './routes/devices';
import { eventsRouter } from './routes/events';
import { firmwareRouter } from './routes/firmware';
import { incidentsRouter } from './routes/incidents';
import { knowledgeRouter } from './routes/knowledge';
import { rulesRouter } from './routes/rules';
import { simulatorRouter } from './routes/simulator';
import { telemetryRouter } from './routes/telemetry';
import { usersRouter } from './routes/users';
import { webhooksRouter } from './routes/webhooks';
import { HttpError } from './util';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', rateLimit({ name: 'api', max: config.apiRequestsPerMinute }));

  app.get('/api/health', async (_req, res) => {
    const [db, cache] = await Promise.all([
      pool.query('SELECT 1').then(() => 'up', () => 'down'),
      redis.ping().then(() => 'up', () => 'down'),
    ]);
    res.status(db === 'up' && cache === 'up' ? 200 : 503).json({ status: db === 'up' && cache === 'up' ? 'ok' : 'degraded', postgres: db, redis: cache, simulator: config.simulator });
  });

  // public: auth + device ingest (device keys). Everything below needs a signed-in user; writes need an admin.
  app.use('/api/auth', authRouter);
  app.use('/api/telemetry', rateLimit({ name: 'device', max: config.deviceRequestsPerMinute, by: byDeviceKey }), telemetryRouter);
  // knowledge base: any signed-in user may upload PRIVATE documents; the router enforces ownership and sharing rules itself
  app.use('/api/knowledge', authenticate, knowledgeRouter);
  app.use('/api/assistant', authenticate, assistantRouter); // read-only for every role: it can answer questions but never change data
  app.use('/api/reports', authenticate, reportsRouter); // read-only for every role
  app.use('/api', authenticate, adminWrites);

  app.use('/api/events', eventsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/devices', devicesRouter);
  app.use('/api/device-types', deviceTypesRouter);
  app.use('/api/simulator', simulatorRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/firmware', firmwareRouter);
  app.use('/api/incidents', incidentsRouter);
  app.use('/api/anomaly', anomalyRouter);
  app.use('/api/rules', rulesRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/audit', auditRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    const e = err as { type?: string; status?: number; code?: string };
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    if (e?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `The file is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.` });
    if ((err as Error)?.name === 'MulterError') return res.status(400).json({ error: `Upload rejected: ${(err as Error).message}` });
    if (e?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (e?.code === '22P02') return res.status(400).json({ error: 'Invalid identifier' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
