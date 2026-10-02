import { predictFromSeries, Point } from '../ml/predictor';
import { keys, redis } from '../redis';
import { predictionLimits } from './rules';

export async function recentPoints(deviceId: string, n = 90): Promise<Point[]> {
  const raw = await redis.lrange(keys.recent(deviceId), 0, n - 1);
  return raw.map((s) => JSON.parse(s) as Point).reverse(); // list is newest-first
}

export async function predictDevice(deviceId: string) {
  const [points, limits] = await Promise.all([recentPoints(deviceId), predictionLimits()]);
  return { points, prediction: predictFromSeries(points, limits) };
}
