// ================================================================
// VONAGE (Nexmo) — ligações telefônicas
// Docs: https://developer.vonage.com/en/voice/voice-api/overview
// ================================================================
import { log } from '../logger.js';

const API_KEY = process.env.VONAGE_API_KEY || '';
const API_SECRET = process.env.VONAGE_API_SECRET || '';
const APP_ID = process.env.VONAGE_APPLICATION_ID || '';
const PRIVATE_KEY = process.env.VONAGE_PRIVATE_KEY || '';
const VONAGE_NUMBER = process.env.VONAGE_PHONE_NUMBER || '';
const BASE_API = 'https://api.nexmo.com/v1';

export function isVonageEnabled() {
  return !!(API_KEY && API_SECRET && VONAGE_NUMBER);
}

function getJwt() {
  // Vonage usa JWT para Voice API — simplificado com API key/secret para REST
  return Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
}

export async function makeSimpleCall(toNumber, message) {
  if (!isVonageEnabled()) return { success: false, error: 'Vonage não configurado' };

  const to = formatPhone(toNumber);
  const baseUrl = process.env.PUBLIC_URL || '';

  try {
    // Vonage Voice API usa NCCO (Nexmo Call Control Objects)
    const ncco = baseUrl
      ? undefined  // Usa answer_url
      : [
          { action: 'talk', text: message, language: 'pt-BR', style: 1 },
        ];

    const body = {
      to: [{ type: 'phone', number: to.replace('+', '') }],
      from: { type: 'phone', number: VONAGE_NUMBER.replace('+', '') },
    };

    if (baseUrl) {
      body.answer_url = [`${baseUrl}/voice/start?msg=${encodeURIComponent(message)}`];
      body.answer_method = 'POST';
      body.event_url = [`${baseUrl}/voice/status`];
      body.event_method = 'POST';
    } else {
      body.ncco = ncco;
    }

    const res = await fetch(`${BASE_API}/calls`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${getJwt()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Vonage ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = await res.json();
    const callId = data.uuid || data.conversation_uuid || '';
    log.ai.info({ to, callId }, 'Vonage ligação iniciada');
    return { success: true, callSid: callId, to, message: `Ligando para ${to}...` };
  } catch (e) {
    log.ai.error({ err: e.message, to }, 'Erro Vonage');
    return { success: false, error: e.message };
  }
}

export async function makeCall(toNumber, message) {
  return makeSimpleCall(toNumber, message);
}

// Gera NCCO (Nexmo Call Control Objects) para conversa
export function generateNcco(audioUrl, fallbackText, callbackPath) {
  const baseUrl = process.env.PUBLIC_URL || '';
  const actions = [];

  if (audioUrl) {
    actions.push({ action: 'stream', streamUrl: [audioUrl] });
  } else {
    actions.push({ action: 'talk', text: fallbackText, language: 'pt-BR', style: 1 });
  }

  actions.push({
    action: 'input',
    type: ['speech'],
    speech: {
      language: 'pt-BR',
      endOnSilence: 3,
      maxDuration: 12,
    },
    eventUrl: [`${baseUrl}${callbackPath}`],
    eventMethod: 'POST',
  });

  return actions;
}

export function generateNccoHangup(audioUrl, text) {
  if (audioUrl) {
    return [
      { action: 'stream', streamUrl: [audioUrl] },
    ];
  }
  return [
    { action: 'talk', text, language: 'pt-BR', style: 1 },
  ];
}

// Extrai fala do webhook Vonage
export function extractSpeech(body) {
  const speech = body.speech?.results?.[0]?.text || '';
  return speech;
}

export function extractCallId(body) {
  return body.uuid || body.conversation_uuid || 'unknown';
}

function formatPhone(phone) {
  let p = phone.replace(/\D/g, '');
  if (!p.startsWith('+')) p = '+' + p;
  if (!p.startsWith('+55') && p.length <= 12) p = '+55' + p.replace(/^\+/, '');
  return p;
}
