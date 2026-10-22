import { Collection, Db, MongoClient } from 'mongodb';
import { config } from './config';

/**
 * Operational data (users, devices, telemetry, alerts, rules, firmware, incidents, webhooks, maintenance,
 * predictions, model versions, audit log) lives in MongoDB. PostgreSQL keeps only the knowledge base and the
 * assistant's conversations (pgvector) - see db.ts.
 *
 * Conventions:
 *  - users and devices use UUID string ids (the same ids PostgreSQL used, so the knowledge-base tables still point at them);
 *  - every other collection uses a small increasing integer id from `counters`, so the REST API's ids stay the same;
 *  - documents are stored in camelCase exactly as the API returns them; `toApi` renames `_id` to `id`.
 */
export const mongo = new MongoClient(config.mongoUrl, { maxPoolSize: 20 });
export const mdb: Db = mongo.db();

export type Doc = any;
export const col = (name: string): Collection<any> => mdb.collection<any>(name);

/** Next integer id for a collection (atomic, safe across several API instances). */
export async function nextId(name: string): Promise<number> {
  const r = await col('counters').findOneAndUpdate({ _id: name as any }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return (r as Doc).seq as number;
}

/** Make sure the counter is at least `value` (used when importing existing rows). */
export async function bumpCounter(name: string, value: number) {
  await col('counters').updateOne({ _id: name as any }, { $max: { seq: value } }, { upsert: true });
}

/** `_id` -> `id`, and nothing else touched. */
export function toApi<T = any>(doc: Doc | null | undefined): T | undefined {
  if (!doc) return undefined;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest } as T;
}
export const toApiList = <T = any>(docs: Doc[]): T[] => docs.map((d) => toApi<T>(d)!);

/** Escape user text for use inside a MongoDB regular expression. */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function ensureIndexes() {
  const days = config.retentionDays * 86_400;
  await Promise.all([
    // a changed TELEMETRY_RETENTION_DAYS must update the existing TTL index instead of failing
    col('telemetry').createIndex({ ts: 1 }, { expireAfterSeconds: days }).catch(async (e: { code?: number }) => {
      if (e.code !== 85 && e.code !== 86) throw e;
      await mdb.command({ collMod: 'telemetry', index: { keyPattern: { ts: 1 }, expireAfterSeconds: days } });
    }),
    col('users').createIndex({ email: 1 }, { unique: true }),
    col('devices').createIndex({ name: 1 }, { unique: true }),
    col('devices').createIndex({ assetNo: 1 }, { unique: true }),
    col('devices').createIndex({ apiKeyHash: 1 }, { unique: true, partialFilterExpression: { apiKeyHash: { $type: 'string' } } }),
    col('devices').createIndex({ type: 1 }),
    col('telemetry').createIndex({ deviceId: 1, ts: -1 }),
    col('device_types').createIndex({ name: 1 }, { unique: true }),
    col('rules').createIndex({ metric: 1, severity: 1, deviceType: 1 }, { unique: true }),
    col('alerts').createIndex({ status: 1, createdAt: -1 }),
    col('alerts').createIndex({ deviceId: 1, type: 1 }),
    col('firmware_releases').createIndex({ deviceType: 1, version: 1 }, { unique: true }),
    col('firmware_updates').createIndex({ deviceId: 1, createdAt: -1 }),
    col('security_incidents').createIndex({ createdAt: -1 }),
    col('security_incidents').createIndex({ deviceId: 1 }),
    col('webhook_deliveries').createIndex({ webhookId: 1, createdAt: -1 }),
    col('maintenance_records').createIndex({ deviceId: 1, performedAt: -1 }),
    col('prediction_history').createIndex({ deviceId: 1, createdAt: -1 }),
    col('prediction_history').createIndex({ createdAt: -1 }),
    col('model_versions').createIndex({ scope: 1, version: 1 }, { unique: true }),
    col('model_versions').createIndex({ scope: 1 }, { unique: true, partialFilterExpression: { isActive: true } }), // one active version per scope
    col('audit_logs').createIndex({ createdAt: -1 }),
    col('audit_logs').createIndex({ action: 1, createdAt: -1 }),
    col('audit_logs').createIndex({ userId: 1, createdAt: -1 }),
  ]);
}

/** Remove everything that belongs to a device (MongoDB has no foreign-key cascade). Incidents keep their text and lose the link. */
export async function deleteDeviceData(deviceId: string) {
  await Promise.all([
    col('telemetry').deleteMany({ deviceId }),
    col('alerts').deleteMany({ deviceId }),
    col('firmware_updates').deleteMany({ deviceId }),
    col('maintenance_records').deleteMany({ deviceId }),
    col('prediction_history').deleteMany({ deviceId }),
    col('security_incidents').updateMany({ deviceId }, { $set: { deviceId: null } }),
    col('devices').deleteOne({ _id: deviceId as any }),
  ]);
}

export async function pingMongo() {
  await mdb.command({ ping: 1 });
}
