// ================================================================
// TELNYX — ligações telefônicas
// Docs: https://developers.telnyx.com/docs/voice/programmable-voice
// ================================================================
import { log } from '../logger.js';

const API_KEY = process.env.TELNYX_API_KEY || '';
const TELNYX_NUMBER = process.env.TELNYX_PHONE_NUMBER || '';
const CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || '';
const BASE_API = 'https://api.telnyx.com/v2';

export function isTelnyxEnabled() {
  return !!(API_KEY && TELNYX_NUMBER);
}

export async function makeSimpleCall(toNumber, message) {
  if (!isTelnyxEnabled()) return { success: false, error: 'Telnyx não configurado' };

  const to = formatPhone(toNumber);
  const baseUrl = process.env.PUBLIC_URL || '';

  try {
    const body = {
      to,
      from: TELNYX_NUMBER,
      webhook_url: baseUrl ? `${baseUrl}/voice/start?msg=${encodeURIComponent(message)}` : undefined,
      webhook_url_method: 'POST',
      answering_machine_detection: 'detect',
    };
    if (CONNECTION_ID) body.connection_id = CONNECTION_ID;

    const res = await fetch(`${BASE_API}/calls`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telnyx ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = await res.json();
    const callId = data.data?.call_control_id || data.data?.call_session_id || '';
    log.ai.info({ to, callId }, 'Telnyx ligação iniciada');
    return { success: true, callSid: callId, to, message: `Ligando para ${to}...` };
  } catch (e) {
    log.ai.error({ err: e.message, to }, 'Erro Telnyx');
    return { success: false, error: e.message };
  }
}

export async function makeCall(toNumber, message) {
  return makeSimpleCall(toNumber, message);
}

// Comandos de controle de chamada Telnyx
export async function speakInCall(callControlId, text) {
  try {
    await fetch(`${BASE_API}/calls/${callControlId}/actions/speak`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: text,
        language: 'pt-BR',
        voice: 'female',
      }),
    });
  } catch (e) {
    log.ai.warn({ err: e.message }, 'Telnyx speak erro');
  }
}

export async function playAudioInCall(callControlId, audioUrl) {
  try {
    await fetch(`${BASE_API}/calls/${callControlId}/actions/playback_start`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl }),
    });
  } catch (e) {
    log.ai.warn({ err: e.message }, 'Telnyx play erro');
  }
}

export async function gatherSpeechInCall(callControlId, callbackUrl) {
  try {
    await fetch(`${BASE_API}/calls/${callControlId}/actions/gather`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'speech',
        language: 'pt-BR',
        maximum_timeout_ms: 12000,
        inter_digit_timeout_ms: 3000,
      }),
    });
  } catch (e) {
    log.ai.warn({ err: e.message }, 'Telnyx gather erro');
  }
}

export async function hangupCall(callControlId) {
  try {
    await fetch(`${BASE_API}/calls/${callControlId}/actions/hangup`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    log.ai.warn({ err: e.message }, 'Telnyx hangup erro');
  }
}

// Extrai fala do webhook Telnyx
export function extractSpeech(body) {
  const payload = body.data?.payload || body.payload || {};
  return payload.speech?.result || payload.transcription || '';
}

export function extractCallId(body) {
  const payload = body.data?.payload || body.payload || {};
  return payload.call_control_id || payload.call_session_id || 'unknown';
}

function formatPhone(phone) {
  let p = phone.replace(/\D/g, '');
  if (!p.startsWith('+')) p = '+' + p;
  if (!p.startsWith('+55') && p.length <= 12) p = '+55' + p.replace(/^\+/, '');
  return p;
}
