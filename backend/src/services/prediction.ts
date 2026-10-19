import { predictFromSeries, Point } from '../ml/predictor';
import { keys, redis } from '../redis';
import { deviceTypeOf } from './deviceTypes';
import { predictionLimits } from './rules';

export async function recentPoints(deviceId: string, n = 90): Promise<Point[]> {
  const raw = await redis.lrange(keys.recent(deviceId), 0, n - 1);
  return raw.map((s) => JSON.parse(s) as Point).reverse(); // list is newest-first
}

/** Forecast for one device, using its machine type's alert limits and (if trained) its own model. */
export async function predictDevice(deviceId: string, type?: string | null) {
  const machineType = type ?? (await deviceTypeOf(deviceId));
  const [points, limits] = await Promise.all([recentPoints(deviceId), predictionLimits(machineType)]);
  return { points, prediction: predictFromSeries(points, limits, machineType) };
}
