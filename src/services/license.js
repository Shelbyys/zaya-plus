import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
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
// HARDWARE FINGERPRINT (estável + seguro contra cópia)
// Combina: ID persistente + hardware UUID/serial + CPU + RAM
// Não usa MAC address (muda com rede).
// ================================================================

const MACHINE_ID_FILE = join(ROOT_DIR, '.machine-id');

function getOrCreateMachineId() {
  try {
    if (fs.existsSync(MACHINE_ID_FILE)) {
      const id = fs.readFileSync(MACHINE_ID_FILE, 'utf-8').trim();
      if (id.length >= 32) return id;
    }
  } catch {}
  const id = crypto.randomUUID() + '-' + Date.now().toString(36);
  try { fs.writeFileSync(MACHINE_ID_FILE, id, 'utf-8'); } catch {}
  return id;
}

function getHardwareId() {
  try {
    const platform = os.platform();
    if (platform === 'darwin') {
      // macOS: Hardware UUID (único por Mac, nunca muda)
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf-8', timeout: 5000 });
      const uuid = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      const serial = out.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
      return [uuid ? uuid[1] : '', serial ? serial[1] : ''].join('|');
    }
    if (platform === 'win32') {
      // Windows: UUID da BIOS + serial da placa-mãe (PowerShell — funciona no Win11)
      try {
        const bios = execSync('powershell -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"', { encoding: 'utf-8', timeout: 5000 }).trim();
        const board = execSync('powershell -Command "(Get-CimInstance Win32_BaseBoard).SerialNumber"', { encoding: 'utf-8', timeout: 5000 }).trim();
        return [bios, board].join('|');
      } catch {
        // Fallback: hostname + username
        return [os.hostname(), os.userInfo().username].join('|');
      }
    }
    // Linux: machine-id do sistema
    if (fs.existsSync('/etc/machine-id')) return fs.readFileSync('/etc/machine-id', 'utf-8').trim();
    if (fs.existsSync('/var/lib/dbus/machine-id')) return fs.readFileSync('/var/lib/dbus/machine-id', 'utf-8').trim();
  } catch {}
  return 'no-hw-id';
}

function getDiskSerial() {
  try {
    const platform = os.platform();
    if (platform === 'darwin') {
      const out = execSync('system_profiler SPStorageDataType SPNVMeDataType', { encoding: 'utf-8', timeout: 5000 });
      const serial = out.match(/Serial\s*Number:\s*(\S+)/i);
      return serial ? serial[1] : '';
    }
    if (platform === 'win32') {
      try {
        const out = execSync('powershell -Command "(Get-CimInstance Win32_DiskDrive | Select-Object -First 1).SerialNumber"', { encoding: 'utf-8', timeout: 5000 });
        return out.trim();
      } catch { return ''; }
    }
    if (platform === 'linux') {
      const out = execSync('lsblk -ndo SERIAL /dev/sda 2>/dev/null || lsblk -ndo SERIAL /dev/nvme0n1 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      return out.trim();
    }
  } catch {}
  return '';
}

export function getMachineFingerprint() {
  const machineId = getOrCreateMachineId();
  const hwId = getHardwareId();
  const disk = getDiskSerial();
  const ram = os.totalmem().toString();
  const cpuModel = (os.cpus()[0] || {}).model || '';
  const cpuCores = os.cpus().length.toString();
  const data = [machineId, hwId, disk, os.hostname(), os.platform(), os.arch(), cpuModel, cpuCores, ram].join('|');
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
    if (data.fingerprint !== getMachineFingerprint()) return { valid: false, token: data.token, reason: 'fingerprint_changed' };
    if (!verifySignature(data)) return { valid: false, token: data.token, reason: 'signature_invalid' };
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
    if (data.fingerprint !== getMachineFingerprint()) {
      // Fingerprint mudou (ex: update do sistema) — agenda reativação automática
      if (data.token && !_autoReactivating) {
        _autoReactivating = true;
        autoReactivate(data.token).catch(() => {});
      }
      return false;
    }
    if (!verifySignature(data)) return false;
    // Integrity: verify this function exists and hasn't been replaced with "return true"
    if (isLicensed.toString().length < 100) return false;
    return true;
  } catch { return false; }
}

// ================================================================
// AUTO-REATIVAÇÃO (fingerprint mudou na mesma máquina)
// Tenta revalidar online sem pedir token ao usuário.
// ================================================================

let _autoReactivating = false;

async function autoReactivate(token) {
  try {
    log.server.info('Fingerprint mudou — tentando reativacao automatica...');
    const result = await activateLicense(token);
    if (result.valid) {
      log.server.info('Reativacao automatica OK — licenca atualizada');
    } else {
      log.server.warn(`Reativacao automatica falhou: ${result.error || 'desconhecido'}`);
    }
  } catch (err) {
    log.server.warn(`Reativacao automatica erro: ${err.message}`);
  } finally {
    _autoReactivating = false;
  }
}

// ================================================================
// VERIFICACAO PERIODICA (a cada 5min via render-server)
// Checa online se a licenca foi revogada/expirada
// Tambem recebe notificacoes de update do servidor central
// ================================================================

let lastCheck = 0;
let _lastUpdateVersion = '';

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
        return;
      }

      // Notificação de update do servidor central
      if (data.update && data.update.version !== _lastUpdateVersion) {
        _lastUpdateVersion = data.update.version;
        log.server.info({ update: data.update }, 'Notificacao de update recebida do servidor');

        // Notifica dashboard via Socket.IO
        try {
          const { io } = await import('../state.js');
          io?.emit('zaya-update', {
            message: data.update.message,
            version: data.update.version,
            timestamp: data.update.timestamp
          });
          io?.emit('zaya-proactive', {
            text: data.update.message,
            tipo: 'update',
            timestamp: new Date().toISOString()
          });
        } catch {}

        // Notifica admin via WhatsApp
        try {
          const { sendWhatsApp } = await import('./messaging.js');
          const { ADMIN_JID } = await import('../config.js');
          if (ADMIN_JID) {
            await sendWhatsApp(ADMIN_JID.replace('@s.whatsapp.net', ''), `*ZAYA PLUS*\n\n${data.update.message}\n\nPara atualizar, abra a Zaya e clique em ATUALIZAR AGORA.`);
          }
        } catch {}
      }
    }
  } catch (e) {}
}
periodicLicenseCheck();
