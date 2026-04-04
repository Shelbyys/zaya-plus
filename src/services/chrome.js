import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import { join } from 'path';
import { CHROME_PATH, CHROME_PROFILE, CHROME_DEBUG_PORT, CHROME_BOT_DATA_DIR } from '../config.js';

function syncChromeProfile() {
  const src = join(os.homedir(), 'Library/Application Support/Google/Chrome');
  if (!existsSync(CHROME_BOT_DATA_DIR)) mkdirSync(CHROME_BOT_DATA_DIR, { recursive: true });
  try { writeFileSync(join(CHROME_BOT_DATA_DIR, 'Local State'), readFileSync(join(src, 'Local State'))); } catch {}
  try {
    execSync(`rsync -a --delete --exclude='Cache' --exclude='Code Cache' --exclude='GPUCache' --exclude='DawnWebGPUCache' --exclude='DawnGraphiteCache' --exclude='Service Worker' --exclude='GrShaderCache' --exclude='ShaderCache' "${join(src, CHROME_PROFILE)}/" "${join(CHROME_BOT_DATA_DIR, CHROME_PROFILE)}/"`, { timeout: 30000, stdio: 'ignore' });
  } catch {}
}

export async function ensureChromeDebug() {
  const puppeteer = (await import('puppeteer-core')).default;
  try {
    return await puppeteer.connect({ browserURL: `http://127.0.0.1:${CHROME_DEBUG_PORT}` });
  } catch {}

  syncChromeProfile();
  const child = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
    `--user-data-dir=${CHROME_BOT_DATA_DIR}`,
    `--profile-directory=${CHROME_PROFILE}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1500));
    try { return await puppeteer.connect({ browserURL: `http://127.0.0.1:${CHROME_DEBUG_PORT}` }); } catch {}
  }
  throw new Error('Chrome debug timeout');
}
