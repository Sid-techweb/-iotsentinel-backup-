import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import pg from 'pg';
import { TEST_DATABASE_URL, TEST_MONGO_URL, TEST_REDIS_URL } from './env';

/** Creates a brand-new, empty test database and clears the test Redis index before every run. */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  // never let a misconfigured URL point the suite at real data
  if (!/^[a-z0-9_]+_test$/.test(dbName)) throw new Error(`Refusing to run tests against database "${dbName}" - its name must end in _test`);
  if (!/\/\d+$/.test(TEST_REDIS_URL) || TEST_REDIS_URL.endsWith('/0')) throw new Error('TEST_REDIS_URL must select a non-default Redis database, e.g. redis://localhost:6379/1');

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  // MongoDB holds the operational data: start from an empty test database there too
  const mongoName = new URL(TEST_MONGO_URL).pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(mongoName)) throw new Error(`Refusing to run tests against MongoDB database "${mongoName}" - its name must end in _test`);
  const mongo = new MongoClient(TEST_MONGO_URL);
  await mongo.connect();
  await mongo.db(mongoName).dropDatabase();
  await mongo.close();

  const redis = new Redis(TEST_REDIS_URL);
  await redis.flushdb();
  await redis.quit();
}
