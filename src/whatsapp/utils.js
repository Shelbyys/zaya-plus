import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs';
import { WA_CONFIG } from '../config.js';

export function waLoadConfig() {
  try { return JSON.parse(readFileSync(WA_CONFIG, 'utf-8')); }
  catch { return { instances: {}, defaultInstance: null }; }
}

// Escrita atômica: escreve em .tmp e renomeia.
// Evita corrupção se processo morrer no meio da escrita.
export function waSaveConfig(config) {
  const tmpPath = WA_CONFIG + '.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    renameSync(tmpPath, WA_CONFIG);
  } catch (e) {
    // Se falhar, limpa o tmp
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch {}
    }
    throw e;
  }
}

// ================================================================
// PER-INSTANCE LOCKS — impede operações simultâneas na mesma instância
// ================================================================

const _instanceLocks = {};

export async function withInstanceLock(name, fn) {
  // Espera lock anterior liberar
  while (_instanceLocks[name]) {
    await _instanceLocks[name].catch(() => {});
  }

  let resolveFn;
  _instanceLocks[name] = new Promise((resolve) => { resolveFn = resolve; });

  try {
    const result = await fn();
    return result;
  } finally {
    resolveFn();
    delete _instanceLocks[name];
  }
}

export function isInstanceLocked(name) {
  return !!_instanceLocks[name];
}

// ================================================================
// PHONE VALIDATION — valida formato antes de chamar Baileys
// ================================================================

export function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, error: 'Telefone vazio' };
  }

  // Remove tudo que não é dígito
  const digits = phone.replace(/\D/g, '');

  // Precisa ter pelo menos 10 dígitos (DDI + DDD + número)
  if (digits.length < 10) {
    return { valid: false, error: 'Telefone muito curto. Use formato: 5511999999999' };
  }

  // Máximo 15 dígitos (padrão internacional E.164)
  if (digits.length > 15) {
    return { valid: false, error: 'Telefone muito longo.' };
  }

  // Se começa com 55 (Brasil), valida DDD
  if (digits.startsWith('55') && digits.length >= 12) {
    const ddd = parseInt(digits.slice(2, 4), 10);
    if (ddd < 11 || ddd > 99) {
      return { valid: false, error: 'DDD inválido' };
    }
  }

  return { valid: true, digits };
}
