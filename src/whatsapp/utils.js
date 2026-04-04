import { readFileSync, writeFileSync } from 'fs';
import { WA_CONFIG } from '../config.js';

export function waLoadConfig() {
  try { return JSON.parse(readFileSync(WA_CONFIG, 'utf-8')); }
  catch { return { instances: {}, defaultInstance: null }; }
}

export function waSaveConfig(config) {
  writeFileSync(WA_CONFIG, JSON.stringify(config, null, 2));
}
