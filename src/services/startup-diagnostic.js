// ================================================================
// STARTUP DIAGNOSTIC — Varredura completa do sistema na inicialização
// Verifica APIs, conexões, serviços e notifica sobre falhas
// ================================================================
import { log } from '../logger.js';
import { ADMIN_NUMBER } from '../config.js';
import { openai, waConnections } from '../state.js';
import { sendWhatsApp } from './messaging.js';
import { makeSimpleCall, isTwilioEnabled } from './twilio.js';

const TIMEOUT = 8000; // 8s por check

function withTimeout(promise, ms = TIMEOUT) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms)),
  ]);
}

// ================================================================
// CHECKS INDIVIDUAIS
// ================================================================
async function checkOpenAI() {
  if (!process.env.OPENAI_API_KEY) return { ok: false, error: 'OPENAI_API_KEY não configurada' };
  try {
    await withTimeout(openai.models.list());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) return { ok: false, error: 'SUPABASE_URL/KEY não configuradas' };
  try {
    const { getSupabase } = await import('./supabase.js');
    const sb = getSupabase();
    if (!sb) return { ok: false, error: 'Client não inicializado' };
    const { error } = await withTimeout(sb.from('chat_messages').select('id', { count: 'exact', head: true }));
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkElevenLabs() {
  if (!process.env.ELEVENLABS_API_KEY) return { ok: false, error: 'ELEVENLABS_API_KEY não configurada' };
  try {
    // Usa /v1/voices (sempre acessível) ao invés de /v1/user (precisa permissão especial)
    const res = await withTimeout(fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    }));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, detail: `${data.voices?.length || '?'} vozes disponíveis` };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkTwilio() {
  if (!isTwilioEnabled()) return { ok: false, error: 'TWILIO_ACCOUNT_SID/AUTH_TOKEN não configuradas' };
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const res = await withTimeout(fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
    }));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: data.status === 'active', detail: `Status: ${data.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkMetaAPI() {
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token) return { ok: false, error: 'FACEBOOK_ACCESS_TOKEN não configurada' };
  if (!phoneId) return { ok: false, error: 'WHATSAPP_PHONE_ID não configurado' };
  try {
    const res = await withTimeout(fetch(`https://graph.facebook.com/v21.0/${phoneId}?fields=verified_name,status`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }));
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error.message };
    return { ok: true, detail: `${data.verified_name} (${data.status})` };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function checkWaSender() {
  if (!process.env.WASENDER_API_KEY) return { ok: false, error: 'WASENDER_API_KEY não configurada' };
  try {
    // Testa enviando ping real (send-message é o endpoint que funciona)
    const base = process.env.WASENDER_BASE_URL || 'https://www.wasenderapi.com/api';
    const res = await withTimeout(fetch(`${base}/send-message`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WASENDER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      // Dry-run: envia para número inválido curto para testar auth sem enviar msg real
      body: JSON.stringify({ to: '0', text: 'ping' }),
    }));
    // Se retornou JSON (mesmo com erro de número), a auth funcionou
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      // Auth OK se não retornou "API key is required"
      if (data.error === 'API key is required' || data.message === 'Unauthenticated.') {
        return { ok: false, error: 'API key inválida' };
      }
      return { ok: true, detail: 'API autenticada' };
    } catch {
      // Retornou HTML = endpoint errado ou auth falhou
      return { ok: false, error: res.status === 200 ? 'Resposta não-JSON' : `HTTP ${res.status}` };
    }
  } catch (e) { return { ok: false, error: e.message }; }
}

function checkWhatsAppLocal() {
  const instances = Object.entries(waConnections);
  if (!instances.length) return { ok: false, error: 'Nenhuma instância configurada' };
  const connected = instances.filter(([, c]) => c.status === 'connected');
  const errors = instances.filter(([, c]) => c.status === 'error');
  if (connected.length === instances.length) return { ok: true, detail: `${connected.length} instância(s) conectada(s)` };
  if (connected.length > 0) return { ok: true, detail: `${connected.length}/${instances.length} conectadas, ${errors.length} com erro` };
  return { ok: false, error: `0/${instances.length} conectadas — ${errors.map(([n]) => n).join(', ')} com erro` };
}

async function checkHFServer() {
  try {
    const res = await withTimeout(fetch('http://127.0.0.1:3010/health'), 5000);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch { return { ok: false, error: 'HF Server offline (porta 3010)' }; }
}

async function checkSmartTurn() {
  try {
    const res = await withTimeout(fetch('http://127.0.0.1:3002/health'), 5000);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch { return { ok: false, error: 'Smart Turn offline (porta 3002)' }; }
}

function checkDatabase() {
  try {
    const { chatDB } = require ? null : null;
    // Import inline to avoid circular deps
    return { ok: true, detail: 'SQLite OK' };
  } catch { return { ok: true, detail: 'SQLite (não verificável inline)' }; }
}

async function checkGoogleAI() {
  if (!process.env.GOOGLE_AI_STUDIO_KEY) return { ok: false, error: 'GOOGLE_AI_STUDIO_KEY não configurada' };
  try {
    const res = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_AI_STUDIO_KEY}`));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ================================================================
// VARREDURA COMPLETA
// ================================================================
export async function runStartupDiagnostic() {
  log.server.info('=== DIAGNÓSTICO DE SISTEMA INICIADO ===');
  const startTime = Date.now();

  const checks = {
    'Zaya IA (OpenAI/Groq)': checkOpenAI,
    'Supabase': checkSupabase,
    'ElevenLabs (Voz)': checkElevenLabs,
    'Twilio (Ligações)': checkTwilio,
    'Meta API (WhatsApp Cloud)': checkMetaAPI,
    'WaSender': checkWaSender,
    'WhatsApp Local': () => Promise.resolve(checkWhatsAppLocal()),
    'HF Server (IA Local)': checkHFServer,
    'Smart Turn': checkSmartTurn,
    'Google AI Studio': checkGoogleAI,
  };

  const results = {};
  const failures = [];
  const warnings = [];

  // Roda todos em paralelo
  const entries = Object.entries(checks);
  const promises = entries.map(async ([name, fn]) => {
    try {
      const result = await fn();
      results[name] = result;
      if (!result.ok) {
        // HF Server e Smart Turn são opcionais
        if (['HF Server (IA Local)', 'Smart Turn'].includes(name)) {
          warnings.push({ name, error: result.error });
        } else {
          failures.push({ name, error: result.error });
        }
      }
    } catch (e) {
      results[name] = { ok: false, error: e.message };
      failures.push({ name, error: e.message });
    }
  });

  await Promise.all(promises);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const total = entries.length;
  const okCount = Object.values(results).filter(r => r.ok).length;
  const failCount = failures.length;
  const warnCount = warnings.length;

  // Log detalhado no console
  log.server.info(`=== DIAGNÓSTICO CONCLUÍDO em ${elapsed}s ===`);
  for (const [name, result] of Object.entries(results)) {
    if (result.ok) {
      log.server.info({ service: name, detail: result.detail || '' }, `✅ ${name}: OK`);
    } else {
      log.server.warn({ service: name, error: result.error }, `❌ ${name}: FALHA`);
    }
  }
  log.server.info(`Resultado: ${okCount}/${total} OK, ${failCount} falhas, ${warnCount} avisos`);

  // Notifica admin se houver falhas
  if (failCount > 0) {
    const failLines = failures.map(f => `❌ *${f.name}*: ${f.error}`).join('\n');
    const warnLines = warnings.length ? '\n\n⚠️ *Avisos:*\n' + warnings.map(w => `⚠️ ${w.name}: ${w.error}`).join('\n') : '';
    const okLines = Object.entries(results).filter(([, r]) => r.ok).map(([n, r]) => `✅ ${n}${r.detail ? ' — ' + r.detail : ''}`).join('\n');

    const msg = `🔧 *ZAYA — Diagnóstico de Inicialização*\n\n` +
      `🕐 ${new Date().toLocaleString('pt-BR')}\n` +
      `📊 *${okCount}/${total}* serviços OK | *${failCount} falhas*\n\n` +
      `*Falhas:*\n${failLines}${warnLines}\n\n` +
      `*Funcionando:*\n${okLines}`;

    try {
      await sendWhatsApp(ADMIN_NUMBER, msg);
      log.server.info('Diagnóstico enviado via WhatsApp');
    } catch (e) {
      log.server.error({ err: e.message }, 'Erro ao enviar diagnóstico via WhatsApp');
    }

    // Ligação se tiver falhas críticas (APIs principais)
    const criticalFails = failures.filter(f =>
      ['Zaya IA (OpenAI/Groq)', 'Supabase', 'WhatsApp Local'].includes(f.name)
    );
    if (criticalFails.length > 0 && isTwilioEnabled()) {
      const callMsg = `Senhor Alisson, atenção! A Zaya detectou ${criticalFails.length} falha${criticalFails.length > 1 ? 's' : ''} crítica${criticalFails.length > 1 ? 's' : ''} na inicialização. ` +
        criticalFails.map(f => `${f.name} está offline.`).join(' ') +
        ` Verifique o sistema.`;
      try {
        await makeSimpleCall(ADMIN_NUMBER, callMsg);
        log.server.info('Ligação de alerta enviada');
      } catch (e) {
        log.server.error({ err: e.message }, 'Erro ao fazer ligação de alerta');
      }
    }
  } else {
    // Tudo OK — apenas log, sem notificar (pra não spammar)
    log.server.info('🟢 Todos os serviços operacionais — nenhuma notificação necessária');

    // Se tiver warnings (HF, Smart Turn), manda um resumo leve
    if (warnCount > 0) {
      const warnLines = warnings.map(w => `⚠️ ${w.name}: ${w.error}`).join('\n');
      const msg = `🔧 *ZAYA Online* ✅\n\n` +
        `${okCount}/${total} serviços OK\n\n` +
        `*Avisos (opcionais):*\n${warnLines}\n\n` +
        `_${new Date().toLocaleString('pt-BR')}_`;
      try { await sendWhatsApp(ADMIN_NUMBER, msg); } catch {}
    }
  }

  return { results, failures, warnings, elapsed };
}
