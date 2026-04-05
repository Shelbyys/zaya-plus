// ================================================================
// TWILIO VOICE — ligação conversacional com voz ElevenLabs
// ================================================================
import { Router } from 'express';
import { log } from '../logger.js';
import { openai } from '../state.js';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, AI_MODEL_MINI, ADMIN_NAME } from '../config.js';
import { settingsDB } from '../database.js';

let sb = null;
function getSb() { if (!sb && SUPABASE_URL && SUPABASE_KEY) sb = createClient(SUPABASE_URL, SUPABASE_KEY); return sb; }

const router = Router();

const callSessions = new Map();
function getSession(callSid) {
  if (!callSessions.has(callSid)) {
    callSessions.set(callSid, { history: [], startedAt: Date.now() });
  }
  return callSessions.get(callSid);
}

// Limpa sessões antigas
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of callSessions) {
    if (now - s.startedAt > 30 * 60 * 1000) callSessions.delete(sid);
  }
}, 5 * 60 * 1000);

function escXml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Cache de áudios gerados (evita gerar 2x)
const audioCache = new Map();

// Limpa cache a cada 10min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of audioCache) {
    if (now - v.ts > 10 * 60 * 1000) audioCache.delete(k);
  }
}, 5 * 60 * 1000);

// ================================================================
// GERAR ÁUDIO COM ELEVENLABS — salva local, serve via endpoint
// ================================================================
async function generateAudio(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) { log.ai.warn('ElevenLabs: sem API key'); return null; }

  const voiceId = settingsDB.get('elevenlabs_voice_id', process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL');

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.slice(0, 500),
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.35, similarity_boost: 0.85, style: 0.4, use_speaker_boost: true },
      }),
    });

    if (!res.ok) {
      log.ai.warn({ status: res.status }, 'ElevenLabs falhou');
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const id = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    audioCache.set(id, { buffer, ts: Date.now() });

    // URL pública do Render servindo o áudio
    const baseUrl = process.env.PUBLIC_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : 'http://localhost:3001');
    const audioUrl = `${baseUrl}/voice/audio/${id}`;
    log.ai.info({ id, size: buffer.length, url: audioUrl?.slice(0, 60) }, 'ElevenLabs áudio gerado');
    return audioUrl;
  } catch (e) {
    log.ai.warn({ err: e.message }, 'ElevenLabs erro');
    return null;
  }
}

// ================================================================
// GET /voice/audio/:id — Serve áudio gerado pelo ElevenLabs
// ================================================================
router.get('/audio/:id', (req, res) => {
  const cached = audioCache.get(req.params.id);
  if (!cached) { res.status(404).end(); return; }
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(cached.buffer);
});

// ================================================================
// TwiML — com áudio ElevenLabs ou fallback Polly
// ================================================================
function twimlWithAudioAndGather(audioUrl, fallbackText, callbackPath) {
  if (audioUrl) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="pt-BR" speechTimeout="auto" timeout="12" action="${callbackPath}" method="POST" enhanced="true" speechModel="phone_call">
    <Play>${audioUrl}</Play>
  </Gather>
  <Redirect method="POST">${callbackPath}?silence=true</Redirect>
</Response>`;
  }
  // Fallback: Polly
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="pt-BR" speechTimeout="auto" timeout="12" action="${callbackPath}" method="POST" enhanced="true" speechModel="phone_call">
    <Say language="pt-BR" voice="Polly.Camila">${escXml(fallbackText)}</Say>
  </Gather>
  <Redirect method="POST">${callbackPath}?silence=true</Redirect>
</Response>`;
}

function twimlPlayOrSay(audioUrl, text) {
  if (audioUrl) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Play>${audioUrl}</Play><Hangup/></Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say language="pt-BR" voice="Polly.Camila">${escXml(text)}</Say><Hangup/></Response>`;
}

// ================================================================
// POST /voice/start — Início da ligação
// ================================================================
router.post('/start', async (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const session = getSession(callSid);
  const initialMsg = req.query.msg || `Oi, aqui é a Zaya, assistente do ${ADMIN_NAME || 'nosso cliente'}. Como posso ajudar?`;
  session.history.push({ role: 'assistant', content: initialMsg });

  log.ai.info({ callSid, msg: initialMsg.slice(0, 60) }, 'Ligação iniciada');

  // Gera áudio com ElevenLabs
  const audioUrl = await generateAudio(initialMsg);

  res.type('text/xml');
  res.send(twimlWithAudioAndGather(audioUrl, initialMsg, '/voice/respond'));
});

// ================================================================
// POST /voice/respond — Recebe fala e responde
// ================================================================
router.post('/respond', async (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const speechResult = req.body.SpeechResult || '';
  const session = getSession(callSid);

  log.ai.info({ callSid, speech: speechResult.slice(0, 80) }, 'Fala recebida');

  if (!speechResult.trim()) {
    const isSilence = req.query.silence === 'true';
    const msg = isSilence ? 'Oi, ainda tá aí? Pode falar!' : 'Não ouvi, pode repetir?';
    const audioUrl = await generateAudio(msg);
    res.type('text/xml');
    res.send(twimlWithAudioAndGather(audioUrl, msg, '/voice/respond'));
    return;
  }

  // Despedida
  const bye = /\b(tchau|adeus|até mais|até logo|encerrar|desligar|bye|obrigad[oa]|valeu|falou)\b/i;
  if (bye.test(speechResult)) {
    session.history.push({ role: 'user', content: speechResult });
    session.history.push({ role: 'assistant', content: 'Tchau!' });
    // Salva histórico da ligação no Supabase
    await saveCallHistory(callSid, req.body.To || '', req.body.From || '', session);
    session._saved = true; // Marca como salvo
    const msg = 'Foi um prazer falar com você! Qualquer coisa, é só ligar. Tchau!';
    const audioUrl = await generateAudio(msg);
    res.type('text/xml');
    res.send(twimlPlayOrSay(audioUrl, msg));
    // Não deleta sessão aqui — deixa pro status callback ou cleanup
    return;
  }

  session.history.push({ role: 'user', content: speechResult });

  try {
    // GPT-4o-mini direto — rápido
    const messages = [
      { role: 'system', content: `Você é a Zaya, assistente pessoal do ${ADMIN_NAME || 'usuário'}. Está numa LIGAÇÃO TELEFÔNICA. Responda em 1-2 frases CURTAS e naturais. Portugues brasileiro natural. Seja simpatica, direta, fluida como uma pessoa real.` },
      ...session.history.slice(-10),
    ];

    const response = await openai.chat.completions.create({
      model: AI_MODEL_MINI, messages, max_tokens: 100, temperature: 0.7,
    });

    const reply = response.choices[0].message.content || 'Pode repetir?';
    const shortReply = reply.length > 200 ? reply.slice(0, 200) : reply;
    session.history.push({ role: 'assistant', content: shortReply });

    log.ai.info({ callSid, reply: shortReply.slice(0, 60) }, 'Resposta ligação');

    // Gera áudio com ElevenLabs (paralelo seria ideal, mas sequencial funciona)
    const audioUrl = await generateAudio(shortReply);

    res.type('text/xml');
    res.send(twimlWithAudioAndGather(audioUrl, shortReply, '/voice/respond'));
  } catch (e) {
    log.ai.error({ err: e.message, callSid }, 'Erro na ligação');
    const audioUrl = await generateAudio('Desculpa, pode repetir?');
    res.type('text/xml');
    res.send(twimlWithAudioAndGather(audioUrl, 'Desculpa, pode repetir?', '/voice/respond'));
  }
});

// ================================================================
// SALVAR HISTÓRICO DA LIGAÇÃO NO SUPABASE
// ================================================================
async function saveCallHistory(callSid, to, from, session) {
  const s = getSb();
  if (!s) return;
  try {
    const conversa = session.history.map(m => `${m.role === 'user' ? 'Pessoa' : 'Zaya'}: ${m.content}`).join('\n');
    await s.from('activity_log').insert({
      action: 'ligacao',
      details: {
        callSid,
        to, from,
        duracao_msgs: session.history.length,
        inicio: new Date(session.startedAt).toISOString(),
        fim: new Date().toISOString(),
        conversa: session.history,
        transcricao: conversa,
      },
      source: 'twilio',
    });
    log.ai.info({ callSid, msgs: session.history.length }, 'Histórico da ligação salvo no Supabase');
  } catch (e) {
    log.ai.warn({ err: e.message }, 'Erro ao salvar histórico da ligação');
  }
}

// ================================================================
// GET /voice/calls — Lista ligações com histórico
// ================================================================
router.get('/calls', async (req, res) => {
  const s = getSb();
  if (!s) { res.json([]); return; }
  try {
    const { data } = await s.from('activity_log')
      .select('details, created_at')
      .eq('action', 'ligacao')
      .order('created_at', { ascending: false })
      .limit(20);
    res.json(data || []);
  } catch (e) { res.json([]); }
});

// ================================================================
// POST /voice/status — Status da ligação
// ================================================================
router.post('/status', async (req, res) => {
  const { CallSid, CallStatus } = req.body;
  log.ai.info({ callSid: CallSid, status: CallStatus }, 'Status ligação');
  if (['completed', 'failed', 'no-answer'].includes(CallStatus)) {
    const session = callSessions.get(CallSid);
    // Salva se não foi salvo na despedida
    if (session && session.history.length > 1 && !session._saved) {
      await saveCallHistory(CallSid, req.body.To || '', req.body.From || '', session);
    }
    callSessions.delete(CallSid);
  }
  res.status(200).end();
});

export default router;
