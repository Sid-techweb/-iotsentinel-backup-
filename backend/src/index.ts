import { createApp } from './app';
import { config } from './config';
import { migrate, pool } from './db';
import { loadModel } from './ml/model';
import { redis } from './redis';
import { startIngestionWorker, syncSystemDocs } from './services/kb/ingest';
import { startEventBus, stopEventBus } from './services/events';
import { ensureGlobalVersion, loadStoredModels } from './services/retrain';
import { ensureReferenceData, seedIfEmpty } from './services/seed';
import { startSimulator } from './services/simulator';
import { startSweeper } from './services/sweeper';
import { sleep } from './util';

async function waitFor(name: string, fn: () => Promise<unknown>) {
  for (let i = 0; i < 30; i++) {
    try { await fn(); return; } catch { console.log(`[boot] waiting for ${name}...`); await sleep(1500); }
  }
  throw new Error(`${name} did not become ready`);
}

async function main() {
  await waitFor('postgres', () => pool.query('SELECT 1'));
  await waitFor('redis', () => redis.ping());
  await migrate();
  const newTypes = await ensureReferenceData();
  loadModel();
  await loadStoredModels();
  await ensureGlobalVersion();
  await seedIfEmpty(newTypes);

  startEventBus();
  const ingestion = startIngestionWorker();
  syncSystemDocs().then((r) => { if (r.added || r.updated || r.removed) console.log('[kb] application docs synced', r); }).catch((e) => console.warn('[kb] doc sync failed', e.message));
  const sweeper = startSweeper();
  const sim = config.simulator ? startSimulator() : null;
  const server = createApp().listen(config.port, () =>
    console.log(`[api] listening on :${config.port}  (simulator ${config.simulator ? 'on' : 'off'})`));

  const shutdown = () => {
    clearInterval(sweeper);
    if (ingestion) clearInterval(ingestion);
    if (sim) clearInterval(sim);
    void stopEventBus();
    server.close(() => Promise.all([pool.end(), redis.quit()]).finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref(); // open SSE streams must not block shutdown
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
