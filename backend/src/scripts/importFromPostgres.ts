import { pool } from '../db';
import { bumpCounter, col, ensureIndexes, mongo } from '../mongo';
import { camelize } from '../util';

/**
 * One-off copy of an existing installation's operational data from PostgreSQL into MongoDB.
 *
 *   npm run migrate:to-mongo            # copy
 *   npm run migrate:to-mongo -- --dry-run   # only count what would be copied
 *
 * - Ids are preserved (users and devices keep their UUIDs, everything else its integer id), so the knowledge base and
 *   chat history that stay in PostgreSQL still point at the right users and devices.
 * - It is idempotent: rows are upserted by id, so running it twice does not duplicate anything.
 * - Nothing is deleted from PostgreSQL. The old tables stay as a backup until you drop them yourself.
 * - Telemetry older than TELEMETRY_RETENTION_DAYS is copied but will be expired by MongoDB's TTL index shortly after.
 */
const dry = process.argv.includes('--dry-run');
const BATCH = 5000;

type Spec = {
  table: string;
  collection: string;
  /** Integer-id collections use a counter; `counter` names it (defaults to the collection). */
  counter?: string | false;
  map?: (row: Record<string, any>) => Record<string, any>;
  /** Column holding the identity when it is not `id`. */
  idColumn?: string;
  /** Large tables are copied in id-ordered batches. */
  batched?: boolean;
};

const dropKeys = (row: Record<string, any>, ...keys: string[]) => { for (const k of keys) delete row[k]; return row; };

const SPECS: Spec[] = [
  { table: 'users', collection: 'users', counter: false },
  { table: 'devices', collection: 'devices', counter: false, map: (r) => { dropKeys(r, 'apiKey'); if (r.active === undefined) r.active = true; return r; } },
  { table: 'device_types', collection: 'device_types' },
  { table: 'rules', collection: 'rules', map: (r) => ({ ...r, deviceType: r.deviceType ?? null }) },
  { table: 'firmware_releases', collection: 'firmware_releases' },
  { table: 'firmware_updates', collection: 'firmware_updates' },
  { table: 'alerts', collection: 'alerts' },
  { table: 'security_incidents', collection: 'security_incidents' },
  { table: 'webhooks', collection: 'webhooks' },
  { table: 'webhook_deliveries', collection: 'webhook_deliveries' },
  { table: 'maintenance_records', collection: 'maintenance_records' },
  { table: 'prediction_history', collection: 'prediction_history', batched: true },
  { table: 'model_versions', collection: 'model_versions' },
  { table: 'models', collection: 'models', idColumn: 'scope', counter: false },
  { table: 'audit_logs', collection: 'audit_logs', batched: true },
  { table: 'telemetry', collection: 'telemetry', counter: false, batched: true, map: (r) => dropKeys(r, 'id') },
];

async function exists(table: string) {
  const r = await pool.query('SELECT to_regclass($1) AS t', [`public.${table}`]);
  return !!r.rows[0].t;
}

async function copy(spec: Spec) {
  if (!(await exists(spec.table))) { console.log(`  ${spec.table}: table not found, skipped`); return; }
  const total = Number((await pool.query(`SELECT count(*) AS n FROM ${spec.table}`)).rows[0].n);
  if (dry) { console.log(`  ${spec.table} -> ${spec.collection}: ${total} rows`); return; }

  const idCol = spec.idColumn ?? 'id';
  const telemetry = spec.table === 'telemetry';
  let done = 0;
  let lastId = 0;
  let maxId = 0;
  for (;;) {
    // telemetry is keyed by its serial id for paging but stored without it (MongoDB generates an ObjectId)
    const sql = spec.batched
      ? `SELECT * FROM ${spec.table} WHERE id > $1 ORDER BY id LIMIT ${BATCH}`
      : `SELECT * FROM ${spec.table}`;
    const rows = (await pool.query(sql, spec.batched ? [lastId] : [])).rows;
    if (!rows.length) break;
    const ops = [];
    const docs: Record<string, any>[] = [];
    for (const raw of rows) {
      const row = camelize<Record<string, any>>(raw);
      if (spec.batched) lastId = Number(raw.id);
      const idValue = row[idCol];
      let doc = spec.map ? spec.map({ ...row }) : { ...row };
      if (telemetry) { docs.push(doc); continue; }
      delete doc.id;
      if (idCol !== 'id') delete doc[idCol];
      doc = { _id: idValue, ...doc };
      if (typeof idValue === 'number') maxId = Math.max(maxId, idValue);
      ops.push({ replaceOne: { filter: { _id: idValue }, replacement: doc, upsert: true } });
    }
    if (telemetry) {
      // idempotent without ids: skip readings already copied (same device and timestamp)
      const existing = new Set((await col('telemetry').find({ deviceId: { $in: [...new Set(docs.map((d) => d.deviceId))] }, ts: { $gte: docs.reduce((m, d) => (d.ts < m ? d.ts : m), docs[0].ts), $lte: docs.reduce((m, d) => (d.ts > m ? d.ts : m), docs[0].ts) } }, { projection: { deviceId: 1, ts: 1 } }).toArray()).map((d) => `${d.deviceId}|${new Date(d.ts).getTime()}`));
      const fresh = docs.filter((d) => !existing.has(`${d.deviceId}|${new Date(d.ts).getTime()}`));
      if (fresh.length) await col('telemetry').insertMany(fresh, { ordered: false });
    } else if (ops.length) {
      await col(spec.collection).bulkWrite(ops, { ordered: false });
    }
    done += rows.length;
    if (!spec.batched) break;
  }
  if (spec.counter !== false && maxId > 0) await bumpCounter(typeof spec.counter === 'string' ? spec.counter : spec.collection, maxId);
  console.log(`  ${spec.table} -> ${spec.collection}: ${done} of ${total} rows copied`);
}

async function main() {
  console.log(dry ? 'Dry run - nothing will be written.' : 'Copying operational data from PostgreSQL to MongoDB...');
  if (!dry) await ensureIndexes();
  for (const spec of SPECS) await copy(spec);
  if (!dry) {
    const max = (await pool.query('SELECT COALESCE(max(asset_no), 0) AS m FROM devices').catch(() => ({ rows: [{ m: 0 }] }))).rows[0].m;
    await bumpCounter('assetNo', Number(max));
    console.log('Done. PostgreSQL data was left untouched; remove the old tables yourself once you have checked the app.');
  }
}

main()
  .then(() => Promise.all([pool.end(), mongo.close()]))
  .catch(async (e) => { console.error(e); await Promise.allSettled([pool.end(), mongo.close()]); process.exit(1); });
