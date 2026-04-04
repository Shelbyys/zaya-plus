// ================================================================
// TWILIO — ligações telefônicas com voz da Zaya
// ================================================================
import twilio from 'twilio';
import { log } from '../logger.js';
import { settingsDB } from '../database.js';
import { PORT } from '../config.js';

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';

let client = null;

function getClient() {
  if (!client && ACCOUNT_SID && AUTH_TOKEN) {
    client = twilio(ACCOUNT_SID, AUTH_TOKEN);
  }
  return client;
}

export function isTwilioEnabled() {
  return !!(ACCOUNT_SID && AUTH_TOKEN && TWILIO_NUMBER);
}

// ================================================================
// LIGAÇÃO SIMPLES — só fala a mensagem e desliga
// ================================================================
export async function makeSimpleCall(toNumber, message) {
  const c = getClient();
  if (!c) return { success: false, error: 'Twilio não configurado' };

  const to = formatPhone(toNumber);
  try {
    const twiml = `<Response><Say language="pt-BR" voice="Polly.Camila">${escapeXml(message)}</Say></Response>`;
    const call = await c.calls.create({ to, from: TWILIO_NUMBER, twiml });
    log.ai.info({ to, callSid: call.sid, mode: 'mensagem' }, 'Ligação simples');
    return { success: true, callSid: call.sid, to, message: `Ligando para ${to} (só mensagem)...` };
  } catch (e) {
    log.ai.error({ err: e.message, to }, 'Erro na ligação simples');
    return { success: false, error: e.message };
  }
}

// ================================================================
// LIGAÇÃO CONVERSACIONAL — Zaya conversa por telefone
// ================================================================
export async function makeCall(toNumber, message) {
  const c = getClient();
  if (!c) return { success: false, error: 'Twilio não configurado. Defina TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN e TWILIO_PHONE_NUMBER no .env' };

  const to = formatPhone(toNumber);
  try {
    // URL pública para webhooks (ngrok, tunnel, ou domínio)
    const baseUrl = process.env.PUBLIC_URL || `https://${process.env.NGROK_DOMAIN || ''}`;

    if (baseUrl && baseUrl !== 'https://') {
      // Modo conversacional — Zaya conversa com a pessoa
      const voiceUrl = `${baseUrl}/voice/start?msg=${encodeURIComponent(message)}`;
      const statusUrl = `${baseUrl}/voice/status`;

      const call = await c.calls.create({
        to,
        from: TWILIO_NUMBER,
        url: voiceUrl,
        statusCallback: statusUrl,
        statusCallbackEvent: ['completed', 'failed', 'no-answer'],
      });

      log.ai.info({ to, callSid: call.sid, mode: 'conversacional' }, 'Ligação conversacional iniciada');
      return { success: true, callSid: call.sid, to, message: `Ligando para ${to} (modo conversa)...` };
    }

    // Fallback: sem URL pública, usa TwiML inline (só fala e desliga)
    const twiml = `<Response><Say language="pt-BR" voice="Polly.Camila">${escapeXml(message)}</Say></Response>`;
    const call = await c.calls.create({ to, from: TWILIO_NUMBER, twiml });

    log.ai.info({ to, callSid: call.sid, mode: 'twiml' }, 'Ligação simples iniciada');
    return { success: true, callSid: call.sid, to, message: `Ligando para ${to}...` };
  } catch (e) {
    log.ai.error({ err: e.message, to }, 'Erro na ligação');
    return { success: false, error: e.message };
  }
}

// ================================================================
// FAZER LIGAÇÃO COM ÁUDIO ELEVENLABS (voz da Zaya)
// ================================================================
export async function makeCallWithZayaVoice(toNumber, message) {
  const c = getClient();
  if (!c) return { success: false, error: 'Twilio não configurado' };

  const to = formatPhone(toNumber);
  try {
    // Gera áudio com ElevenLabs
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      // Fallback para TTS do Twilio
      return makeCall(toNumber, message);
    }

    const voiceId = settingsDB.get('elevenlabs_voice_id', process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL');

    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: message.slice(0, 2000),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.4 },
      }),
    });

    if (!ttsRes.ok) {
      log.ai.warn('ElevenLabs falhou, usando Twilio TTS');
      return makeCall(toNumber, message);
    }

    // Salva o áudio e faz upload para URL pública
    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
    const { writeFileSync, unlinkSync } = await import('fs');
    const { join } = await import('path');
    const audioPath = join('/tmp', `zaya-call-${Date.now()}.mp3`);
    writeFileSync(audioPath, audioBuffer);

    // Upload via WaSender (tem endpoint de upload que gera URL pública)
    const { uploadMedia } = await import('./wasender.js');
    const base64 = `data:audio/mpeg;base64,${audioBuffer.toString('base64')}`;
    const upload = await uploadMedia(base64, 'audio/mpeg');

    let audioUrl = '';
    if (upload.success && upload.data?.publicUrl) {
      audioUrl = upload.data.publicUrl;
    }

    try { unlinkSync(audioPath); } catch {}

    // Sempre usa modo conversacional (a voz ElevenLabs era só pra msg one-shot)
    // Agora a Zaya conversa de verdade por telefone
    return makeCall(toNumber, message);
  } catch (e) {
    log.ai.error({ err: e.message, to }, 'Erro na ligação Zaya');
    return { success: false, error: e.message };
  }
}

// ================================================================
// HELPERS
// ================================================================
function formatPhone(phone) {
  let p = phone.replace(/\D/g, '');
  if (!p.startsWith('+')) p = '+' + p;
  if (!p.startsWith('+55') && p.length <= 12) p = '+55' + p.replace(/^\+/, '');
  return p;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
