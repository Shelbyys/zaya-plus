import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { VAULT_FILE, SENHA } from '../config.js';

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
}

export function loadVault() {
  try {
    if (!existsSync(VAULT_FILE)) return [];
    const encData = JSON.parse(readFileSync(VAULT_FILE, 'utf-8'));
    const salt = Buffer.from(encData.salt, 'hex');
    const iv = Buffer.from(encData.iv, 'hex');
    const key = deriveKey(SENHA, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(encData.authTag, 'hex'));
    let decrypted = decipher.update(encData.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch { return []; }
}

export function saveVault(credentials) {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const key = deriveKey(SENHA, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(JSON.stringify(credentials), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  writeFileSync(VAULT_FILE, JSON.stringify({
    salt: salt.toString('hex'), iv: iv.toString('hex'),
    ciphertext: encrypted, authTag: authTag.toString('hex'),
  }));
}
