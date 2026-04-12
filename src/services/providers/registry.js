// ================================================================
// PROVIDER REGISTRY — Sistema central multi-provider inteligente
// A Zaya escolhe automaticamente o melhor provider baseado no contexto
// ================================================================
import { settingsDB } from '../../database.js';
import { log } from '../../logger.js';

// ================================================================
// PROVIDER STORE — todos os providers registrados
// ================================================================
const providers = new Map(); // key: 'type:id' → provider object
const healthCache = new Map(); // key: 'type:id' → { ok, checkedAt, latencyMs }

// ================================================================
// MODOS DE SELEÇÃO
// ================================================================
export const MODES = {
  quality: { label: 'Qualidade Máxima', weightQuality: 0.8, weightSpeed: 0.1, weightCost: 0.1 },
  balanced: { label: 'Equilibrado', weightQuality: 0.4, weightSpeed: 0.3, weightCost: 0.3 },
  fast: { label: 'Mais Rápido', weightQuality: 0.1, weightSpeed: 0.8, weightCost: 0.1 },
  free: { label: 'Só Gratuito (Local)', weightQuality: 0.5, weightSpeed: 0.5, weightCost: 0.0, onlyFree: true },
};

// ================================================================
// CONTEXTOS DE USO
// ================================================================
export const CONTEXTS = {
  realtime_call: { label: 'Ligação em tempo real', speedBonus: 3, qualityPenalty: 0 },
  whatsapp_voice: { label: 'Áudio WhatsApp', speedBonus: 1, qualityPenalty: 0 },
  whatsapp_text: { label: 'Texto WhatsApp', speedBonus: 0, qualityPenalty: 0 },
  background: { label: 'Tarefa em background', speedBonus: -2, qualityPenalty: 0 },
  dashboard: { label: 'Dashboard/Voz', speedBonus: 1, qualityPenalty: 0 },
};

// ================================================================
// REGISTRAR PROVIDER
// ================================================================
export function registerProvider(provider) {
  const key = `${provider.type}:${provider.id}`;

  // Validação mínima
  if (!provider.id || !provider.type || !provider.name) {
    throw new Error(`Provider inválido: falta id, type ou name`);
  }

  // Defaults
  const p = {
    quality: 5,
    speed: 5,
    cost: 'free',       // 'free' | 'paid'
    local: true,        // roda local?
    requires: null,     // env var necessária (ex: 'OPENAI_API_KEY')
    available: false,   // health check pendente
    enabled: true,      // habilitado pelo usuário?
    ...provider,
    // Funções obrigatórias
    execute: provider.execute,     // (input, options) => result
    healthCheck: provider.healthCheck || (() => ({ ok: true })),
  };

  providers.set(key, p);
  log.ai.info({ provider: key, quality: p.quality, speed: p.speed, cost: p.cost }, 'Provider registrado');
  return p;
}

// ================================================================
// HEALTH CHECK — verificar se provider está disponível
// ================================================================
export async function checkHealth(type, id) {
  const key = `${type}:${id}`;
  const p = providers.get(key);
  if (!p) return { ok: false, error: 'Provider não encontrado' };

  // Verifica env var
  if (p.requires && !process.env[p.requires]) {
    p.available = false;
    healthCache.set(key, { ok: false, checkedAt: Date.now(), error: `Falta ${p.requires}` });
    return { ok: false, error: `Variável ${p.requires} não configurada` };
  }

  try {
    const start = Date.now();
    const result = await Promise.race([
      p.healthCheck(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    const latencyMs = Date.now() - start;

    p.available = result.ok !== false;
    healthCache.set(key, { ok: p.available, checkedAt: Date.now(), latencyMs, ...result });

    log.ai.debug({ provider: key, ok: p.available, latencyMs }, 'Health check');
    return { ok: p.available, latencyMs, ...result };
  } catch (e) {
    p.available = false;
    healthCache.set(key, { ok: false, checkedAt: Date.now(), error: e.message });
    return { ok: false, error: e.message };
  }
}

// ================================================================
// HEALTH CHECK ALL — verifica todos os providers
// ================================================================
export async function checkAllHealth() {
  const results = {};
  const checks = [];

  for (const [key, p] of providers) {
    checks.push(
      checkHealth(p.type, p.id).then(r => { results[key] = r; })
    );
  }

  await Promise.allSettled(checks);
  return results;
}

// ================================================================
// SMART SELECT — escolhe o melhor provider para o contexto
// ================================================================
export function selectProvider(type, context = {}) {
  const mode = context.mode || getDefaultMode();
  const situation = context.situation || 'whatsapp_text';
  const modeConfig = MODES[mode] || MODES.balanced;
  const ctxConfig = CONTEXTS[situation] || CONTEXTS.whatsapp_text;

  // 1. Filtrar providers do tipo correto
  const candidates = [];
  for (const [key, p] of providers) {
    if (p.type !== type) continue;
    if (!p.enabled) continue;

    // Verificar preferência do usuário (override)
    const userPref = getUserPreference(type);
    if (userPref && userPref === p.id) {
      // Usuário escolheu este provider — usar se disponível
      if (p.available) return p;
    }

    // Mode 'free' — só providers locais/gratuitos
    if (modeConfig.onlyFree && p.cost !== 'free') continue;

    // Provider precisa estar disponível
    if (!p.available) continue;

    candidates.push(p);
  }

  if (candidates.length === 0) {
    // Fallback: tenta qualquer provider disponível do tipo, ignorando mode
    for (const [key, p] of providers) {
      if (p.type === type && p.available && p.enabled) return p;
    }
    return null;
  }

  if (candidates.length === 1) return candidates[0];

  // 2. Scoring
  const scored = candidates.map(p => {
    const qualityScore = p.quality * modeConfig.weightQuality;
    const speedScore = (p.speed + ctxConfig.speedBonus) * modeConfig.weightSpeed;
    const costScore = (p.cost === 'free' ? 10 : 3) * modeConfig.weightCost;
    const total = qualityScore + speedScore + costScore;

    return { provider: p, score: total };
  });

  // 3. Ordenar por score
  scored.sort((a, b) => b.score - a.score);

  const winner = scored[0].provider;
  log.ai.debug({
    type, mode, situation,
    winner: winner.id,
    score: scored[0].score.toFixed(2),
    candidates: scored.map(s => `${s.provider.id}(${s.score.toFixed(1)})`).join(', '),
  }, 'Smart Select');

  return winner;
}

// ================================================================
// EXECUTAR COM FALLBACK — tenta provider selecionado, cai pro próximo se falhar
// ================================================================
export async function executeWithFallback(type, input, options = {}) {
  const context = options.context || {};
  const maxRetries = options.maxRetries || 2;

  // Tenta providers em ordem de score
  const tried = new Set();
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const provider = selectProvider(type, { ...context, exclude: tried });
    if (!provider) break;

    tried.add(provider.id);

    try {
      const start = Date.now();
      const result = await provider.execute(input, options);
      const elapsed = Date.now() - start;

      // Salvar estatística
      recordStat(type, provider.id, elapsed, true);

      log.ai.info({
        type, provider: provider.id, elapsed,
        mode: context.mode || getDefaultMode(),
      }, 'Provider executou com sucesso');

      return {
        ...result,
        _provider: provider.id,
        _providerName: provider.name,
        _elapsed: elapsed,
        _mode: context.mode || getDefaultMode(),
      };
    } catch (e) {
      lastError = e;
      recordStat(type, provider.id, 0, false);
      log.ai.warn({ type, provider: provider.id, err: e.message, attempt }, 'Provider falhou, tentando próximo...');

      // Marca como indisponível temporariamente
      provider.available = false;
      setTimeout(() => { provider.available = true; }, 60000); // re-habilita em 1min
    }
  }

  throw lastError || new Error(`Nenhum provider disponível para ${type}`);
}

// ================================================================
// CONFIGURAÇÃO DO USUÁRIO
// ================================================================
function getDefaultMode() {
  return settingsDB.get('provider_mode', 'balanced');
}

export function setDefaultMode(mode) {
  if (!MODES[mode]) throw new Error(`Modo inválido: ${mode}. Use: ${Object.keys(MODES).join(', ')}`);
  settingsDB.set('provider_mode', mode);
  log.ai.info({ mode }, 'Modo de provider alterado');
}

function getUserPreference(type) {
  return settingsDB.get(`provider_pref_${type}`, null);
}

export function setUserPreference(type, providerId) {
  settingsDB.set(`provider_pref_${type}`, providerId);
  log.ai.info({ type, provider: providerId }, 'Preferência de provider salva');
}

export function clearUserPreference(type) {
  settingsDB.set(`provider_pref_${type}`, '');
}

// ================================================================
// ESTATÍSTICAS DE USO
// ================================================================
const stats = new Map(); // key → { calls, totalMs, errors }

function recordStat(type, id, ms, success) {
  const key = `${type}:${id}`;
  if (!stats.has(key)) stats.set(key, { calls: 0, totalMs: 0, errors: 0 });
  const s = stats.get(key);
  s.calls++;
  s.totalMs += ms;
  if (!success) s.errors++;
}

// ================================================================
// LISTAR PROVIDERS
// ================================================================
export function listProviders(type = null) {
  const result = [];
  for (const [key, p] of providers) {
    if (type && p.type !== type) continue;

    const health = healthCache.get(key);
    const stat = stats.get(key);

    result.push({
      id: p.id,
      type: p.type,
      name: p.name,
      quality: p.quality,
      speed: p.speed,
      cost: p.cost,
      local: p.local,
      available: p.available,
      enabled: p.enabled,
      requires: p.requires,
      description: p.description || '',
      health: health ? { ok: health.ok, latencyMs: health.latencyMs, checkedAt: health.checkedAt } : null,
      stats: stat ? { calls: stat.calls, avgMs: Math.round(stat.totalMs / stat.calls), errors: stat.errors } : null,
      isPreferred: getUserPreference(p.type) === p.id,
    });
  }
  return result;
}

// ================================================================
// HABILITAR / DESABILITAR PROVIDER
// ================================================================
export function enableProvider(type, id, enabled = true) {
  const key = `${type}:${id}`;
  const p = providers.get(key);
  if (!p) throw new Error(`Provider ${key} não encontrado`);
  p.enabled = enabled;
  settingsDB.set(`provider_enabled_${key}`, enabled ? '1' : '0');
  log.ai.info({ provider: key, enabled }, 'Provider ' + (enabled ? 'habilitado' : 'desabilitado'));
  return p;
}

// ================================================================
// CARREGAR ESTADOS SALVOS
// ================================================================
export function loadSavedStates() {
  for (const [key, p] of providers) {
    const saved = settingsDB.get(`provider_enabled_${key}`);
    if (saved !== null) {
      p.enabled = saved === '1';
    }
  }
}

// ================================================================
// EXPLICAR SELEÇÃO — Zaya pode dizer POR QUE escolheu aquele provider
// ================================================================
export function explainSelection(type, context = {}) {
  const mode = context.mode || getDefaultMode();
  const situation = context.situation || 'whatsapp_text';
  const modeConfig = MODES[mode] || MODES.balanced;
  const ctxConfig = CONTEXTS[situation] || {};

  const provider = selectProvider(type, context);
  if (!provider) return 'Nenhum provider disponível.';

  const reasons = [];
  if (mode === 'quality') reasons.push('modo qualidade máxima');
  if (mode === 'fast') reasons.push('modo velocidade');
  if (mode === 'free') reasons.push('modo gratuito (só local)');
  if (situation === 'realtime_call') reasons.push('ligação em tempo real (priorizando velocidade)');
  if (provider.cost === 'free') reasons.push('provider gratuito/local');
  if (provider.cost === 'paid') reasons.push('provider via API (pago, maior qualidade)');

  const stat = stats.get(`${type}:${provider.id}`);
  if (stat && stat.calls > 0) {
    reasons.push(`média de ${Math.round(stat.totalMs / stat.calls)}ms por chamada`);
  }

  return {
    provider: provider.id,
    name: provider.name,
    reason: `Escolhi ${provider.name} porque: ${reasons.join(', ')}.`,
    quality: provider.quality,
    speed: provider.speed,
    cost: provider.cost,
  };
}

// ================================================================
// RESUMO PARA O PROMPT DA ZAYA
// ================================================================
export function getProviderSummaryForPrompt() {
  const mode = getDefaultMode();
  const types = new Set();
  for (const p of providers.values()) types.add(p.type);

  let text = `\n=== PROVIDERS DISPONÍVEIS (modo: ${mode}) ===\n`;
  for (const type of types) {
    const list = listProviders(type);
    const available = list.filter(p => p.available && p.enabled);
    text += `${type.toUpperCase()}: ${available.map(p => `${p.name}(q:${p.quality}/v:${p.speed}/${p.cost})`).join(', ') || 'nenhum'}\n`;
  }
  return text;
}

export default {
  registerProvider,
  selectProvider,
  executeWithFallback,
  checkHealth,
  checkAllHealth,
  listProviders,
  enableProvider,
  setDefaultMode,
  setUserPreference,
  clearUserPreference,
  explainSelection,
  getProviderSummaryForPrompt,
  loadSavedStates,
  MODES,
  CONTEXTS,
};
