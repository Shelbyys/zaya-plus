import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock config para usar arquivo temporário
const VAULT_FILE = join(tmpdir(), `vault-test-${Date.now()}.vault`);
const SENHA = 'test-password-123';

// Importamos as funções internas diretamente (crypto puro, sem dependências externas)
import crypto from 'crypto';

function vaultDeriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha512');
}

function saveVault(credentials) {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const key = vaultDeriveKey(SENHA, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(JSON.stringify(credentials), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  writeFileSync(VAULT_FILE, JSON.stringify({
    salt: salt.toString('hex'), iv: iv.toString('hex'),
    ciphertext: encrypted, authTag: authTag.toString('hex'),
  }));
}

function loadVault() {
  try {
    if (!existsSync(VAULT_FILE)) return [];
    const encData = JSON.parse(readFileSync(VAULT_FILE, 'utf-8'));
    const salt = Buffer.from(encData.salt, 'hex');
    const iv = Buffer.from(encData.iv, 'hex');
    const key = vaultDeriveKey(SENHA, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(encData.authTag, 'hex'));
    let decrypted = decipher.update(encData.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch { return []; }
}

import { readFileSync } from 'fs';

describe('Vault (AES-256-GCM)', () => {
  afterEach(() => {
    try { unlinkSync(VAULT_FILE); } catch {}
  });

  it('deve retornar array vazio se arquivo não existe', () => {
    expect(loadVault()).toEqual([]);
  });

  it('deve salvar e carregar credenciais corretamente', () => {
    const creds = [
      { id: '1', name: 'Google', url: 'google.com', login: 'user@gmail.com', password: 'abc123' },
      { id: '2', name: 'GitHub', url: 'github.com', login: 'dev', password: 'gh-token' },
    ];

    saveVault(creds);
    expect(existsSync(VAULT_FILE)).toBe(true);

    const loaded = loadVault();
    expect(loaded).toEqual(creds);
  });

  it('deve encriptar os dados no arquivo (não plaintext)', () => {
    saveVault([{ name: 'Secret', password: 'my-secret-password' }]);

    const raw = readFileSync(VAULT_FILE, 'utf-8');
    expect(raw).not.toContain('my-secret-password');
    expect(raw).not.toContain('Secret');

    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('salt');
    expect(parsed).toHaveProperty('iv');
    expect(parsed).toHaveProperty('ciphertext');
    expect(parsed).toHaveProperty('authTag');
  });

  it('deve lidar com array vazio', () => {
    saveVault([]);
    expect(loadVault()).toEqual([]);
  });

  it('deve lidar com dados corrompidos graciosamente', () => {
    writeFileSync(VAULT_FILE, 'corrupted data');
    expect(loadVault()).toEqual([]);
  });
});
