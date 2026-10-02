import fs from 'fs';
import path from 'path';
import { MODEL_PATH, trainModel } from './model';

const model = trainModel();
fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
fs.writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2));

const e = model.evaluation;
console.log('Anomaly prediction model trained ->', MODEL_PATH);
console.log(`  train/test episodes : ${model.trainSize}/${model.testSize}`);
console.log(`  accuracy ${(e.accuracy * 100).toFixed(1)}%  precision ${(e.precision * 100).toFixed(1)}%  recall ${(e.recall * 100).toFixed(1)}%  F1 ${e.f1.toFixed(3)}`);
console.log(`  AUC ${e.auc.toFixed(3)}  Brier ${e.brier.toFixed(3)}  avg lead ${e.avgLeadReadings.toFixed(1)} readings before breach`);
