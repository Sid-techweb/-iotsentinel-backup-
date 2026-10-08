import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { config } from './config';
import { pool } from './db';
import { redis } from './redis';
import { adminWrites, authenticate } from './auth';
import { authRouter } from './routes/auth';
import { simulatorRouter } from './routes/simulator';
import { alertsRouter } from './routes/alerts';
import { anomalyRouter } from './routes/anomaly';
import { dashboardRouter } from './routes/dashboard';
import { devicesRouter } from './routes/devices';
import { firmwareRouter } from './routes/firmware';
import { incidentsRouter } from './routes/incidents';
import { rulesRouter } from './routes/rules';
import { telemetryRouter } from './routes/telemetry';
import { HttpError } from './util';

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (_req, res) => {
    const [db, cache] = await Promise.all([
      pool.query('SELECT 1').then(() => 'up', () => 'down'),
      redis.ping().then(() => 'up', () => 'down'),
    ]);
    res.status(db === 'up' && cache === 'up' ? 200 : 503).json({ status: db === 'up' && cache === 'up' ? 'ok' : 'degraded', postgres: db, redis: cache, simulator: config.simulator });
  });

  // public: auth + device ingest (device keys). Everything below needs a signed-in user; writes need an admin.
  app.use('/api/auth', authRouter);
  app.use('/api/telemetry', telemetryRouter);
  app.use('/api', authenticate, adminWrites);

  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/devices', devicesRouter);
  app.use('/api/simulator', simulatorRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/firmware', firmwareRouter);
  app.use('/api/incidents', incidentsRouter);
  app.use('/api/anomaly', anomalyRouter);
  app.use('/api/rules', rulesRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    if ((err as any)?.code === '22P02') return res.status(400).json({ error: 'Invalid identifier' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
