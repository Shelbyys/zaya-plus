import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import { join } from 'path';
import { ROOT_DIR } from '../config.js';
import { log } from '../logger.js';

// ================================================================
// ZAYA PLUS — LICENSE SYSTEM (via render-server proxy)
// O cliente NUNCA fala com Supabase diretamente.
// Toda validacao online passa pelo render-server.
// .license local e cache — servidor e a verdade.
// ================================================================

const LICENSE_API = process.env.LICENSE_API_URL || 'https://zaya-plus.onrender.com';

const LICENSE_FILE = join(ROOT_DIR, '.license');
const SECRET_KEY = crypto.createHash('sha256').update('zaya-plus-hmac-client-v2').digest();

// ================================================================
// HARDWARE FINGERPRINT
// ================================================================

function getMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') return iface.mac;
    }
  }
  return 'unknown';
}

export function getMachineFingerprint() {
  const data = [os.hostname(), os.platform(), os.arch(), (os.cpus()[0] || {}).model || '', getMacAddress()].join('|');
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ================================================================
// HMAC SIGNATURE (para proteger .license local)
// ================================================================

function signLicense(token, fingerprint, plan) {
  return crypto.createHmac('sha256', SECRET_KEY).update(token + fingerprint + plan).digest('hex');
}

function verifySignature(data) {
  if (!data.signature) return false;
  try {
    const expected = signLicense(data.token, data.fingerprint, data.plan);
    return crypto.timingSafeEqual(Buffer.from(data.signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// ================================================================
// VALIDATE LICENSE (via render-server)
// ================================================================

export async function validateLicense(token) {
  try {
    const fingerprint = getMachineFingerprint();
    const machine = { hostname: os.hostname(), platform: os.platform(), arch: os.arch() };

    const r = await fetch(`${LICENSE_API}/api/license/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, fingerprint, machine })
    });

    if (!r.ok) {
      // Fallback offline
      const local = checkLocalLicenseSync();
      if (local.valid) return local;
      return { valid: false, error: 'Sem conexao' };
    }

    const data = await r.json();
    return data;
  } catch (err) {
    // Offline fallback
    const local = checkLocalLicenseSync();
    if (local.valid) return local;
    return { valid: false, error: 'Sem conexao' };
  }
}

// ================================================================
// CHECK LOCAL LICENSE (cache)
// ================================================================

function checkLocalLicenseSync() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return { valid: false };
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
    if (data.fingerprint !== getMachineFingerprint()) return { valid: false };
    if (!verifySignature(data)) return { valid: false };
    return { valid: true, plan: data.plan, token: data.token };
  } catch { return { valid: false }; }
}

export async function checkLocalLicense() {
  return checkLocalLicenseSync();
}

// ================================================================
// ACTIVATE LICENSE
// ================================================================

export async function activateLicense(token) {
  const result = await validateLicense(token);
  if (result.valid) {
    const fingerprint = getMachineFingerprint();
    const plan = result.plan;
    fs.writeFileSync(LICENSE_FILE, JSON.stringify({
      token, fingerprint, plan,
      activatedAt: new Date().toISOString(),
      signature: signLicense(token, fingerprint, plan)
    }, null, 2), 'utf-8');
    log.server.info(`Cache local salvo: plano ${plan}`);
  }
  return result;
}

// ================================================================
// IS LICENSED (sync — usa cache local)
// ================================================================

export function isLicensed() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
    if (data.fingerprint !== getMachineFingerprint()) return false;
    if (!verifySignature(data)) return false;
    // Integrity: verify this function exists and hasn't been replaced with "return true"
    if (isLicensed.toString().length < 100) return false;
    return true;
  } catch { return false; }
}

// ================================================================
// VERIFICACAO PERIODICA (a cada 5min via render-server)
// Checa online se a licenca foi revogada/expirada
// ================================================================

let lastCheck = 0;

export async function periodicLicenseCheck() {
  if (Date.now() - lastCheck < 5 * 60 * 1000) return;
  lastCheck = Date.now();
  if (!fs.existsSync(LICENSE_FILE)) return;
  try {
    const local = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
    const r = await fetch(`${LICENSE_API}/api/license/check/${encodeURIComponent(local.token)}`);
    if (r.ok) {
      const data = await r.json();
      if (!data.valid) {
        fs.unlinkSync(LICENSE_FILE);
        log.server.warn('Licenca revogada/expirada remotamente');
        setTimeout(() => { console.log('\n  \x1b[31m\x1b[1m  LICENCA REVOGADA\x1b[0m\n'); process.exit(1); }, 2000);
      }
    }
  } catch (e) {}
}
periodicLicenseCheck();
