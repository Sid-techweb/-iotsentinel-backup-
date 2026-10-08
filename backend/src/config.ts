import 'dotenv/config';

const simIntervalMs = Number(process.env.SIM_INTERVAL_MS ?? 2000);

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://iot:iot@localhost:5433/iotmonitor',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  simulator: (process.env.SIMULATOR ?? 'true') === 'true',
  simIntervalMs,
  // A device is declared offline when no heartbeat arrived for this long.
  offlineAfterMs: Number(process.env.OFFLINE_AFTER_MS ?? simIntervalMs * 6),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  retentionDays: Number(process.env.TELEMETRY_RETENTION_DAYS ?? 7),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
};
