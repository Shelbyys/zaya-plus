// ================================================================
// PLIVO — ligações telefônicas
// Docs: https://www.plivo.com/docs/voice/
// ================================================================
import { log } from '../logger.js';

const AUTH_ID = process.env.PLIVO_AUTH_ID || '';
const AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN || '';
const PLIVO_NUMBER = process.env.PLIVO_PHONE_NUMBER || '';
const BASE_API = 'https://api.plivo.com/v1';

function authHeader() {
  return 'Basic ' + Buffer.from(`${AUTH_ID}:${AUTH_TOKEN}`).toString('base64');
}

export function isPlivoEnabled() {
  return !!(AUTH_ID && AUTH_TOKEN && PLIVO_NUMBER);
}

export async function makeSimpleCall(toNumber, message) {
  if (!isPlivoEnabled()) return { success: false, error: 'Plivo não configurado' };

  const to = formatPhone(toNumber);
  try {
    // Plivo usa XML similar ao TwiML
    const answerXml = `<Response><Speak language="pt-BR">${escapeXml(message)}</Speak><Hangup/></Response>`;

    // Criar Answer URL inline via data URI não é suportado, usar answer_url com webhook
    const baseUrl = process.env.PUBLIC_URL || '';
    if (baseUrl) {
      const res = await fetch(`${BASE_API}/Account/${AUTH_ID}/Call/`, {
        method: 'POST',
        headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: PLIVO_NUMBER,
          to,
          answer_url: `${baseUrl}/voice/start?msg=${encodeURIComponent(message)}`,
          answer_method: 'POST',
          hangup_url: `${baseUrl}/voice/status`,
          hangup_method: 'POST',
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Plivo ${res.status}: ${err.slice(0, 200)}`);
      }

      const data = await res.json();
      log.ai.info({ to, callUuid: data.request_uuid, mode: 'conversacional' }, 'Plivo ligação iniciada');
      return { success: true, callSid: data.request_uuid, to, message: `Ligando para ${to}...` };
    }

    return { success: false, error: 'PUBLIC_URL necessário para ligações Plivo' };
  } catch (e) {
    log.ai.error({ err: e.message, to }, 'Erro Plivo');
    return { success: false, error: e.message };
  }
}

export async function makeCall(toNumber, message) {
  return makeSimpleCall(toNumber, message);
}

// Gera XML de resposta no formato Plivo
export function generatePlivoXml(audioUrl, fallbackText, callbackPath) {
  if (audioUrl) {
    return `<Response>
  <GetInput action="${callbackPath}" method="POST" inputType="speech" language="pt-BR" speechEndTimeout="3000" executionTimeout="12000">
    <Play>${audioUrl}</Play>
  </GetInput>
  <Redirect method="POST">${callbackPath}?silence=true</Redirect>
</Response>`;
  }
  return `<Response>
  <GetInput action="${callbackPath}" method="POST" inputType="speech" language="pt-BR" speechEndTimeout="3000" executionTimeout="12000">
    <Speak language="pt-BR">${escapeXml(fallbackText)}</Speak>
  </GetInput>
  <Redirect method="POST">${callbackPath}?silence=true</Redirect>
</Response>`;
}

export function generatePlivoHangupXml(audioUrl, text) {
  if (audioUrl) {
    return `<Response><Play>${audioUrl}</Play><Hangup/></Response>`;
  }
  return `<Response><Speak language="pt-BR">${escapeXml(text)}</Speak><Hangup/></Response>`;
}

// Extrai fala do webhook Plivo
export function extractSpeech(body) {
  return body.Speech || body.UnstableSpeech || '';
}

// Extrai callSid equivalente
export function extractCallId(body) {
  return body.CallUUID || body.CallSid || 'unknown';
}

function formatPhone(phone) {
  let p = phone.replace(/\D/g, '');
  if (!p.startsWith('+')) p = '+' + p;
  if (!p.startsWith('+55') && p.length <= 12) p = '+55' + p.replace(/^\+/, '');
  return p;
}

function escapeXml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
