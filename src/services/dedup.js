// ================================================================
// DEDUP — Sistema central de deduplicação de mensagens
// Todos os handlers (wwebjs, webhook, inbox-poller) consultam aqui
// antes de processar uma mensagem.
//
// v2: Adicionado timestamp check, cooldown por telefone, hash robusto
// ================================================================
import { log } from '../logger.js';

// Set de mensagens já processadas (msgId ou phone:hash)
const processed = new Map(); // key → timestamp
const MAX_ENTRIES = 5000;
const TTL = 5 * 60 * 1000; // 5 minutos (reduzido de 10)

// Cooldown por telefone (evita processar msgs rápidas demais)
const phoneCooldown = new Map(); // phone → timestamp da última msg processada
const COOLDOWN_MS = 1500; // 1.5s entre msgs do mesmo remetente

// Limpa entradas antigas a cada 2 min
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, ts] of processed) {
    if (now - ts > TTL) { processed.delete(key); cleaned++; }
  }
  for (const [phone, ts] of phoneCooldown) {
    if (now - ts > 30000) phoneCooldown.delete(phone);
  }
  if (cleaned > 0) log.wa.debug({ cleaned, remaining: processed.size }, 'Dedup cleanup');
}, 2 * 60 * 1000);

/**
 * Hash robusto do texto (FNV-1a 32-bit)
 */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Gera uma chave de dedup para a mensagem
 */
function makeKey(msgId, phone, text) {
  if (msgId && msgId.length > 5) return `id:${msgId}`;
  const cleanPhone = (phone || '').replace(/@.*$/, '').replace(/\D/g, '');
  const hash = fnv1a((text || '').slice(0, 200));
  return `ph:${cleanPhone}:${hash}`;
}

/**
 * Normaliza telefone para comparações
 */
function normalizePhone(phone) {
  return (phone || '').replace(/@.*$/, '').replace(/\D/g, '');
}

/**
 * Verifica se a mensagem já foi processada.
 * Se não foi, marca como processada e retorna false.
 * Se já foi, retorna true (é duplicata).
 *
 * @param {string} msgId - ID único da mensagem (WhatsApp msg ID)
 * @param {string} phone - Número do remetente
 * @param {string} text - Texto da mensagem
 * @param {string} source - Quem está processando ('handler', 'webhook', 'poller')
 * @returns {boolean} true se é duplicata (já processada), false se é nova
 */
export function isDuplicate(msgId, phone, text, source = '') {
  const key = makeKey(msgId, phone, text);

  if (processed.has(key)) {
    log.wa.info({ key: key.slice(0, 40), source, phone }, 'DEDUP: duplicata bloqueada');
    return true;
  }

  // Marca como processada
  processed.set(key, Date.now());

  // Evita crescimento infinito
  if (processed.size > MAX_ENTRIES) {
    const oldest = processed.keys().next().value;
    processed.delete(oldest);
  }

  return false;
}

/**
 * Verifica se a mensagem é muito antiga para processar.
 * @param {number} msgTimestamp - Timestamp da mensagem em SEGUNDOS (WhatsApp usa segundos)
 * @param {number} maxAgeMs - Idade máxima em ms (padrão: 60s)
 * @returns {boolean} true se é muito antiga
 */
export function isTooOld(msgTimestamp, maxAgeMs = 60000) {
  if (!msgTimestamp) return false; // sem timestamp = processa
  const msgMs = msgTimestamp * 1000; // converte para ms
  const age = Date.now() - msgMs;
  if (age > maxAgeMs) {
    log.wa.info({ age: Math.round(age / 1000) + 's', maxAge: maxAgeMs / 1000 + 's' }, 'DEDUP: mensagem antiga ignorada');
    return true;
  }
  return false;
}

/**
 * Verifica cooldown por telefone.
 * Evita processar múltiplas mensagens em sequência rápida do mesmo remetente.
 * @returns {boolean} true se está em cooldown (deve aguardar)
 */
export function isInCooldown(phone) {
  const norm = normalizePhone(phone);
  const last = phoneCooldown.get(norm);
  if (last && Date.now() - last < COOLDOWN_MS) {
    return true;
  }
  phoneCooldown.set(norm, Date.now());
  return false;
}

/**
 * Força marcar uma mensagem como processada (sem verificar)
 */
export function markProcessed(msgId, phone, text) {
  const key = makeKey(msgId, phone, text);
  processed.set(key, Date.now());
}

/**
 * Stats para debug
 */
export function dedupStats() {
  return { entries: processed.size, maxEntries: MAX_ENTRIES, ttlMs: TTL, cooldownMs: COOLDOWN_MS };
}
