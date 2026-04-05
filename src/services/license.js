import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import { join } from 'path';
import { ROOT_DIR } from '../config.js';
import { log } from '../logger.js';

// ================================================================
// ZAYA PLUS — LICENSE SYSTEM (Supabase Online)
// Tokens ficam no Supabase. Validacao online.
// .license local é cache — servidor é a verdade.
// ================================================================

const SUPABASE_URL = 'https://qzgzpfcdfanhtehrikyy.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF6Z3pwZmNkZmFuaHRlaHJpa3l5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTMwMjEzOCwiZXhwIjoyMDg0ODc4MTM4fQ.LXQRc0y38UROwof1d5hBpnNgOPsFEr7AhvMuLcXIVZg';
const TABLE = 'licenses';

const LICENSE_FILE = join(ROOT_DIR, '.license');
const SECRET_KEY = crypto.createHash('sha256').update(SUPABASE_KEY + 'zaya-plus-hmac').digest();

// ================================================================
// SUPABASE HELPERS
// ================================================================

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

async function sbSelect(filter) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?${filter}`, { headers });
  if (!r.ok) throw new Error(`Supabase SELECT: ${r.status}`);
  return r.json();
}

async function sbInsert(body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
    method: 'POST', headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Supabase INSERT: ${r.status}`);
  return r.json();
}

async function sbUpdate(filter, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?${filter}`, {
    method: 'PATCH', headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Supabase UPDATE: ${r.status}`);
  return r.json();
}

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
// VALIDATE LICENSE (online)
// ================================================================

export async function validateLicense(token) {
  try {
    const fingerprint = getMachineFingerprint();

    // Buscar no Supabase
    const rows = await sbSelect(`token=eq.${encodeURIComponent(token)}&select=*`);
    if (!rows || rows.length === 0) return { valid: false, error: 'Token invalido' };

    const record = rows[0];

    // Revogado?
    if (record.revoked) return { valid: false, error: 'Licenca revogada' };

    // Expirado?
    if (record.expires_at && new Date(record.expires_at) < new Date()) return { valid: false, error: 'Licenca expirada' };

    // Ativado em OUTRO computador?
    if (record.activated && record.fingerprint && record.fingerprint !== fingerprint) {
      return { valid: false, error: 'Token ja ativado em outro computador' };
    }

    // Primeira ativação
    if (!record.activated) {
      await sbUpdate(`token=eq.${encodeURIComponent(token)}`, {
        fingerprint,
        activated: true,
        activated_at: new Date().toISOString(),
        machine_info: { hostname: os.hostname(), platform: os.platform(), arch: os.arch() }
      });
      log.server.info(`Licença ativada online: ${token.slice(0, 8)}...`);
      return { valid: true, plan: record.plan, activated: true };
    }

    // Mesmo computador — OK
    return { valid: true, plan: record.plan };
  } catch (err) {
    log.server.error({ err: err.message }, 'Erro validação online');

    // Fallback: se não tem internet, verificar cache local
    const local = checkLocalLicenseSync();
    if (local.valid) {
      log.server.info('Validação offline via cache local');
      return local;
    }

    return { valid: false, error: 'Sem conexao. Tente novamente.' };
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
// DEACTIVATE (permite reativar em outra máquina)
// ================================================================

export async function deactivateLicense(token) {
  try {
    await sbUpdate(`token=eq.${encodeURIComponent(token)}`, {
      activated: false, fingerprint: null, machine_info: {}
    });
    if (fs.existsSync(LICENSE_FILE)) fs.unlinkSync(LICENSE_FILE);
    log.server.info(`Licença desativada: ${token.slice(0, 8)}...`);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
}

// ================================================================
// REVOKE (bloqueia permanentemente)
// ================================================================

export async function revokeLicense(token) {
  try {
    await sbUpdate(`token=eq.${encodeURIComponent(token)}`, {
      revoked: true, revoked_at: new Date().toISOString()
    });
    log.server.info(`Licença REVOGADA: ${token.slice(0, 8)}...`);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
}

// ================================================================
// GENERATE LICENSE (admin)
// ================================================================

export async function generateLicense(plan, email, name) {
  const token = crypto.randomUUID();
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);

  await sbInsert({
    token, plan: plan || 'basic', email: email || '', name: name || '',
    activated: false, revoked: false,
    expires_at: expires.toISOString()
  });

  log.server.info(`Licença gerada: ${token} — ${plan} para ${email}`);
  return token;
}

// ================================================================
// LIST LICENSES (admin)
// ================================================================

export async function listLicenses() {
  return await sbSelect('select=*&order=created_at.desc');
}

// ================================================================
// IS LICENSED (sync — usa cache local)
// ================================================================

export function isLicensed() {
  return checkLocalLicenseSync().valid;
}

// ================================================================
// VERIFICACAO PERIODICA (a cada 30min)
// Checa online se a licença foi revogada/expirada
// ================================================================

let lastCheck = 0;

export async function periodicLicenseCheck() {
  if (Date.now() - lastCheck < 5 * 60 * 1000) return; // a cada 5 minutos
  lastCheck = Date.now();

  if (!fs.existsSync(LICENSE_FILE)) return;

  try {
    const local = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
    const rows = await sbSelect(`token=eq.${encodeURIComponent(local.token)}&select=revoked,expires_at`);

    if (rows && rows[0]) {
      const remote = rows[0];
      if (remote.revoked || (remote.expires_at && new Date(remote.expires_at) < new Date())) {
        fs.unlinkSync(LICENSE_FILE);
        log.server.warn('Licenca revogada/expirada remotamente — acesso BLOQUEADO');
        // Forcar encerramento do servidor
        setTimeout(() => {
          console.log('\n  \x1b[31m\x1b[1m  LICENCA REVOGADA — Servidor encerrado\x1b[0m\n');
          process.exit(1);
        }, 2000);
      }
    }
  } catch (e) {
    // Sem internet — mantém cache local
  }
}

// Verificar na inicializacao
periodicLicenseCheck();
