import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import { join } from 'path';
import { ROOT_DIR } from '../config.js';
import { log } from '../logger.js';

// ================================================================
// ZAYA PLUS — LICENSE SYSTEM
// Validação online via GitHub Gist + bloqueio por hardware
// ================================================================

// URL do Gist com os tokens válidos (JSON)
// Formato do Gist: { "tokens": { "uuid-token": { "plan": "pro", "email": "...", "name": "...", "expires": "2027-01-01" } } }
const LICENSE_GIST_URL = process.env.LICENSE_GIST_URL || 'https://gist.githubusercontent.com/Shelbyys/raw/zaya-licenses.json';

const LICENSE_FILE = join(ROOT_DIR, '.license');
const LICENSE_DB_FILE = join(ROOT_DIR, 'licenses.json');

// ================================================================
// SECURITY KEYS
// ================================================================

const LICENSE_SERVER_KEY = process.env.LICENSE_SERVER_KEY || 'zaya-default-server-key';
const SECRET_KEY = crypto.createHash('sha256').update(LICENSE_SERVER_KEY + 'zaya-plus-license-salt').digest();
// AES-256 key for encrypting licenses.json (must be 32 bytes)
const AES_KEY = crypto.createHash('sha256').update(LICENSE_SERVER_KEY + 'zaya-plus-aes-db').digest();
const AES_IV_LENGTH = 16;

// ================================================================
// HMAC SIGNATURE HELPERS
// ================================================================

function signLicense(token, fingerprint, plan) {
  return crypto.createHmac('sha256', SECRET_KEY).update(token + fingerprint + plan).digest('hex');
}

function verifyLicenseSignature(data) {
  if (!data.signature) return false;
  const expected = signLicense(data.token, data.fingerprint, data.plan);
  return crypto.timingSafeEqual(Buffer.from(data.signature, 'hex'), Buffer.from(expected, 'hex'));
}

// ================================================================
// AES-256 ENCRYPTION FOR licenses.json
// ================================================================

function encryptDB(plaintext) {
  const iv = crypto.randomBytes(AES_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptDB(ciphertext) {
  const parts = ciphertext.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encrypted = parts.join(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

// ================================================================
// HARDWARE FINGERPRINT
// ================================================================

function getMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac;
      }
    }
  }
  return 'unknown-mac';
}

export function getMachineFingerprint() {
  const data = [
    os.hostname(),
    os.platform(),
    os.arch(),
    (os.cpus()[0] || {}).model || 'unknown-cpu',
    getMacAddress(),
  ].join('|');
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ================================================================
// LOCAL LICENSE DB (para admin gerar tokens offline)
// ================================================================

function readLicenseDB() {
  try {
    if (fs.existsSync(LICENSE_DB_FILE)) {
      const raw = fs.readFileSync(LICENSE_DB_FILE, 'utf-8');
      // Try encrypted format first, fall back to plain JSON for migration
      try {
        const decrypted = decryptDB(raw);
        return JSON.parse(decrypted);
      } catch {
        // Possibly old unencrypted format — migrate on next write
        return JSON.parse(raw);
      }
    }
  } catch (e) {}
  return { tokens: {} };
}

function writeLicenseDB(db) {
  const encrypted = encryptDB(JSON.stringify(db, null, 2));
  fs.writeFileSync(LICENSE_DB_FILE, encrypted, 'utf-8');
}

// ================================================================
// VALIDATE LICENSE
// ================================================================

export async function validateLicense(token) {
  try {
    const fingerprint = getMachineFingerprint();
    let tokenData = null;

    // 1. Verificar no DB local primeiro
    const localDB = readLicenseDB();
    if (localDB.tokens[token]) {
      tokenData = localDB.tokens[token];
    }

    // 2. Se não encontrou localmente, tentar online (Gist)
    if (!tokenData) {
      try {
        const r = await fetch(LICENSE_GIST_URL + '?t=' + Date.now(), {
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (r.ok) {
          const onlineDB = await r.json();
          if (onlineDB.tokens && onlineDB.tokens[token]) {
            tokenData = onlineDB.tokens[token];
            // Salvar localmente para cache
            localDB.tokens[token] = tokenData;
            writeLicenseDB(localDB);
          }
        }
      } catch (e) {
        log.server.warn({ err: e.message }, 'Erro ao verificar licença online');
      }
    }

    // 3. Token não encontrado
    if (!tokenData) {
      return { valid: false, error: 'Token invalido' };
    }

    // 4a. Verificar se foi revogado
    if (tokenData.revoked) {
      return { valid: false, error: 'Licenca revogada' };
    }

    // 4b. Verificar expiração
    if (tokenData.expires && new Date(tokenData.expires) < new Date()) {
      return { valid: false, error: 'Licenca expirada' };
    }

    // 5. Já ativado em OUTRO computador
    if (tokenData.activated && tokenData.fingerprint && tokenData.fingerprint !== fingerprint) {
      return { valid: false, error: 'Token ja ativado em outro computador' };
    }

    // 6. Primeira ativação — gravar fingerprint
    if (!tokenData.activated) {
      tokenData.activated = true;
      tokenData.fingerprint = fingerprint;
      tokenData.activated_at = new Date().toISOString();
      tokenData.machine = {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch()
      };
      localDB.tokens[token] = tokenData;
      writeLicenseDB(localDB);
      log.server.info(`Licença ativada: ${token.slice(0, 8)}... em ${os.hostname()}`);
      return { valid: true, plan: tokenData.plan, activated: true };
    }

    // 7. Mesmo computador — tudo OK
    return { valid: true, plan: tokenData.plan };
  } catch (err) {
    log.server.error({ err: err.message }, 'Erro na validação de licença');
    return { valid: false, error: 'Erro ao validar: ' + err.message };
  }
}

// ================================================================
// CHECK LOCAL LICENSE (cached .license file)
// ================================================================

export async function checkLocalLicense() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return { valid: false };
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
    if (data.fingerprint !== getMachineFingerprint()) {
      log.server.warn('Fingerprint local não confere — possível troca de máquina');
      return { valid: false };
    }
    // Verify HMAC signature to prevent manual .license crafting
    if (!verifyLicenseSignature(data)) {
      log.server.warn('Assinatura HMAC do .license invalida — possível falsificação');
      return { valid: false };
    }
    return { valid: true, plan: data.plan, token: data.token };
  } catch (err) {
    return { valid: false };
  }
}

// ================================================================
// ACTIVATE LICENSE
// ================================================================

export async function activateLicense(token) {
  const result = await validateLicense(token);
  if (result.valid) {
    const fingerprint = getMachineFingerprint();
    const plan = result.plan;
    const licenseData = {
      token,
      fingerprint,
      plan,
      activatedAt: new Date().toISOString(),
      signature: signLicense(token, fingerprint, plan)
    };
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(licenseData, null, 2), 'utf-8');
    log.server.info(`Licença salva localmente: plano ${plan}`);
  }
  return result;
}

// ================================================================
// DEACTIVATE LICENSE
// ================================================================

export async function deactivateLicense(token) {
  try {
    const db = readLicenseDB();
    if (db.tokens[token]) {
      db.tokens[token].activated = false;
      db.tokens[token].fingerprint = null;
      db.tokens[token].machine = null;
      writeLicenseDB(db);
    }
    if (fs.existsSync(LICENSE_FILE)) fs.unlinkSync(LICENSE_FILE);
    log.server.info(`Licença desativada: ${token.slice(0, 8)}...`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ================================================================
// REVOKE LICENSE (bloqueia permanentemente)
// ================================================================

export async function revokeLicense(token) {
  try {
    const db = readLicenseDB();
    if (db.tokens[token]) {
      db.tokens[token].revoked = true;
      db.tokens[token].revoked_at = new Date().toISOString();
      writeLicenseDB(db);
      log.server.info(`Licença REVOGADA: ${token.slice(0, 8)}...`);
      return { success: true };
    }
    return { success: false, error: 'Token nao encontrado' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ================================================================
// GENERATE LICENSE (admin)
// ================================================================

export async function generateLicense(plan, email, name) {
  const token = crypto.randomUUID();
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);

  const db = readLicenseDB();
  db.tokens[token] = {
    plan: plan || 'basic',
    email: email || '',
    name: name || '',
    activated: false,
    fingerprint: null,
    machine: null,
    created_at: new Date().toISOString(),
    expires: expires.toISOString()
  };
  writeLicenseDB(db);

  log.server.info(`Licença gerada: ${token} — plano ${plan} para ${email}`);
  return token;
}

// ================================================================
// LIST LICENSES (admin)
// ================================================================

export async function listLicenses() {
  const db = readLicenseDB();
  return Object.entries(db.tokens).map(([token, data]) => ({
    token,
    ...data
  }));
}

// ================================================================
// IS LICENSED (sync check)
// ================================================================

export function isLicensed() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
    if (data.fingerprint !== getMachineFingerprint()) return false;
    if (!verifyLicenseSignature(data)) return false;
    return true;
  } catch {
    return false;
  }
}

// ================================================================
// VERIFICACAO PERIODICA (roda no servidor a cada 30min)
// Checa se a licenca foi revogada e desativa localmente
// ================================================================

let lastPeriodicCheck = 0;
const CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutos

export async function periodicLicenseCheck() {
  const now = Date.now();
  if (now - lastPeriodicCheck < CHECK_INTERVAL) return;
  lastPeriodicCheck = now;

  if (!fs.existsSync(LICENSE_FILE)) return;

  try {
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
    const db = readLicenseDB();
    const tokenData = db.tokens[data.token];

    if (!tokenData) return;

    // Se foi revogado pelo admin, deletar licenca local
    if (tokenData.revoked) {
      fs.unlinkSync(LICENSE_FILE);
      log.server.warn('Licenca revogada remotamente — acesso bloqueado');
      return;
    }

    // Se expirou, deletar licenca local
    if (tokenData.expires && new Date(tokenData.expires) < new Date()) {
      fs.unlinkSync(LICENSE_FILE);
      log.server.warn('Licenca expirada — acesso bloqueado');
      return;
    }
  } catch (e) {
    // Silently fail
  }
}
