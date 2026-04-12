// ================================================================
// VOICE STREAM — WebSocket handler para Twilio Media Streams
// Integra com Smart Turn v3.2 para detecção de fim de turno
// Agora com multi-provider: STT, TTS, VAD inteligentes
// ================================================================
import { WebSocketServer } from 'ws';
import { log } from '../logger.js';
import { openai } from '../state.js';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, AI_MODEL_MINI, ADMIN_NUMBER } from '../config.js';
import { settingsDB } from '../database.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import twilio from 'twilio';
import { transcribe, speak, detectVoice } from './providers/index.js';

// ================================================================
// CONSTANTES
// ================================================================
const SMART_TURN_URL = 'http://127.0.0.1:3002/predict';
const SILENCE_THRESHOLD = 200;       // RMS abaixo disso = silêncio
const SILENCE_DURATION_MS = 2000;    // 2s de silêncio para verificar turno
const MIN_AUDIO_CHUNKS = 10;         // Mínimo de chunks antes de analisar
const SAMPLE_RATE = 8000;            // mulaw 8kHz do Twilio
const TMP_DIR = '/tmp/whatsapp-bot';

// ================================================================
// SESSÕES DE STREAM (compartilha com twilio-voice.js via callSid)
// ================================================================
const streamSessions = new Map();

// Limpa sessões antigas (30min)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of streamSessions) {
    if (now - s.startedAt > 30 * 60 * 1000) streamSessions.delete(id);
  }
}, 5 * 60 * 1000);

// ================================================================
// SUPABASE
// ================================================================
let sb = null;
function getSb() { if (!sb && SUPABASE_URL && SUPABASE_KEY) sb = createClient(SUPABASE_URL, SUPABASE_KEY); return sb; }

// ================================================================
// CACHE DE ÁUDIOS (compartilhado — importado pelo twilio-voice.js)
// ================================================================
export const audioCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of audioCache) {
    if (now - v.ts > 10 * 60 * 1000) audioCache.delete(k);
  }
}, 5 * 60 * 1000);

// ================================================================
// GERAR ÁUDIO — Multi-provider TTS (ElevenLabs, Edge TTS, Kokoro, OpenAI)
// Smart Select escolhe o melhor provider para o contexto de ligação
// ================================================================
export async function generateAudioStream(text) {
  try {
    const result = await speak(text.slice(0, 500), {
      context: { mode: null, situation: 'realtime_call' }, // ligação = prioriza velocidade
    });

    if (!result.audioBuffer) {
      log.ai.warn('TTS provider retornou sem áudio');
      return null;
    }

    const buffer = Buffer.isBuffer(result.audioBuffer) ? result.audioBuffer : Buffer.from(result.audioBuffer);
    const id = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    audioCache.set(id, { buffer, ts: Date.now() });

    const baseUrl = process.env.PUBLIC_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : 'https://zaya-assistente.onrender.com');
    const audioUrl = `${baseUrl}/voice/audio/${id}`;
    log.ai.info({ id, size: buffer.length, provider: result._provider }, 'TTS áudio gerado (stream)');
    return audioUrl;
  } catch (e) {
    log.ai.warn({ err: e.message }, 'TTS provider falhou (stream)');

    // Fallback direto para ElevenLabs (caso providers system esteja offline)
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) return null;
      const voiceId = settingsDB.get('elevenlabs_voice_id', process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL');
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 500), model_id: 'eleven_v3', voice_settings: { stability: 0.3, similarity_boost: 0.75, style: 0.55, use_speaker_boost: true } }),
      });
      if (!res.ok) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      const id = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      audioCache.set(id, { buffer, ts: Date.now() });
      const baseUrl = process.env.PUBLIC_URL || 'https://zaya-assistente.onrender.com';
      return `${baseUrl}/voice/audio/${id}`;
    } catch { return null; }
  }
}

// ================================================================
// CONVERTER MULAW BASE64 → LINEAR PCM (Int16)
// ================================================================
const MULAW_DECODE_TABLE = new Int16Array(256);
(function buildMulawTable() {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xFF;
    let sign = (mu & 0x80) ? -1 : 1;
    mu = mu & 0x7F;
    let exponent = (mu >> 4) & 0x07;
    let mantissa = mu & 0x0F;
    let sample = ((mantissa << 1) + 33) << (exponent + 2);
    sample = sign * (sample - 132);
    MULAW_DECODE_TABLE[i] = sample;
  }
})();

function decodeMulaw(base64Payload) {
  const muBytes = Buffer.from(base64Payload, 'base64');
  const pcm = new Int16Array(muBytes.length);
  for (let i = 0; i < muBytes.length; i++) {
    pcm[i] = MULAW_DECODE_TABLE[muBytes[i]];
  }
  return pcm;
}

// ================================================================
// CALCULAR RMS (Root Mean Square) — energia do áudio
// ================================================================
function calculateRMS(pcmSamples) {
  if (!pcmSamples || pcmSamples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcmSamples.length; i++) {
    sum += pcmSamples[i] * pcmSamples[i];
  }
  return Math.sqrt(sum / pcmSamples.length);
}

// ================================================================
// CONVERTER PCM BUFFER → WAV FILE (para Whisper)
// ================================================================
function pcmToWav(pcmBuffers, sampleRate = 8000) {
  // Concatenar todos os buffers PCM Int16
  let totalSamples = 0;
  for (const buf of pcmBuffers) totalSamples += buf.length;

  const pcmData = new Int16Array(totalSamples);
  let offset = 0;
  for (const buf of pcmBuffers) {
    pcmData.set(buf, offset);
    offset += buf.length;
  }

  const byteLength = pcmData.length * 2;
  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + byteLength, 4);
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);         // chunk size
  header.writeUInt16LE(1, 20);          // PCM format
  header.writeUInt16LE(1, 22);          // mono
  header.writeUInt32LE(sampleRate, 24); // sample rate
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);          // block align
  header.writeUInt16LE(16, 34);         // bits per sample

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(byteLength, 40);

  const pcmBytes = Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
  return Buffer.concat([header, pcmBytes]);
}

// ================================================================
// TRANSCREVER ÁUDIO — Multi-provider STT
// ================================================================
async function transcribeAudio(wavBuffer) {
  try {
    const result = await transcribe(wavBuffer, {
      language: 'pt',
      format: 'wav',
      context: { mode: null, situation: 'realtime_call' }, // ligação = prioriza velocidade
    });

    if (result.text) {
      log.ai.info({ text: result.text.slice(0, 80), provider: result._provider, elapsed: result._elapsed }, 'STT transcreveu (stream)');
      return result.text;
    }
    return '';
  } catch (e) {
    log.ai.warn({ err: e.message }, 'STT provider falhou (stream)');

    // Fallback direto para OpenAI Whisper API
    try {
      if (!process.env.OPENAI_API_KEY) return '';
      const fileBlob = new Blob([wavBuffer], { type: 'audio/wav' });
      const fd = new FormData();
      fd.append('file', fileBlob, 'voice_stream.wav');
      fd.append('model', 'whisper-1');
      fd.append('language', 'pt');
      fd.append('response_format', 'json');
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: fd,
      });
      if (r.ok) { const data = await r.json(); return data.text || ''; }
      return '';
    } catch { return ''; }
  }
}

// ================================================================
// CHAMAR SMART TURN — verifica se o turno de fala está completo
// ================================================================
async function checkSmartTurn(wavBuffer) {
  try {
    const base64Audio = wavBuffer.toString('base64');
    const resp = await fetch(SMART_TURN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: base64Audio,
        sample_rate: SAMPLE_RATE,
        format: 'wav',
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (resp.ok) {
      const data = await resp.json();
      log.ai.debug({ turn_complete: data.turn_complete, confidence: data.confidence }, 'Smart Turn resultado');
      return data;
    }
    log.ai.warn({ status: resp.status }, 'Smart Turn falhou');
    return { turn_complete: true, confidence: 0.5 }; // fallback: assume completo
  } catch (e) {
    log.ai.debug({ err: e.message }, 'Smart Turn indisponível — fallback silence-only');
    return { turn_complete: true, confidence: 0.5 }; // fallback
  }
}

// ================================================================
// PROCESSAR COM AI (mesmo sistema prompt do /respond)
// ================================================================
async function processWithAI(text, session) {
  let context = '';
  try {
    const s = getSb();
    if (s) {
      const [eventsRes, msgsRes] = await Promise.race([
        Promise.all([
          s.from('activity_log').select('details').eq('action', 'evento').order('created_at', { ascending: false }).limit(3),
          s.from('wa_inbox').select('push_name,message_body').eq('status', 'processed').eq('is_group', false).gte('received_at', new Date(Date.now() - 3600000).toISOString()).order('received_at', { ascending: false }).limit(3),
        ]),
        new Promise((resolve) => setTimeout(() => resolve([{ data: null }, { data: null }]), 3000)),
      ]);
      if (eventsRes.data?.length) context += `\nEVENTOS: ${eventsRes.data.map(e => (e.details?.titulo || '')).filter(Boolean).join(', ')}`;
      if (msgsRes.data?.length) context += `\nMSGS RECENTES: ${msgsRes.data.map(m => `${m.push_name}: ${(m.message_body || '').slice(0, 30)}`).join('; ')}`;
    }
  } catch {}

  const systemPrompt = `Você é a Zaya, assistente pessoal do Sr. Alisson. Está numa LIGAÇÃO TELEFÔNICA.

REGRAS:
- Responda em 1-2 frases CURTAS e naturais. Fale como pessoa real.
- Português brasileiro com jeitinho sergipano (varie gírias: oxente, vixe, massa, eita).
- Você é uma CENTRAL DE INFORMAÇÕES: agenda, compromissos, mensagens, contatos, projetos, memórias, pesquisas.
- Você SABE sobre a vida do Sr. Alisson — use o contexto abaixo.
- Você NÃO executa tarefas no Mac (não roda comandos, não edita arquivos, não faz deploy).
- Se pedirem para EXECUTAR algo, diga que por ligação só informa — pra executar, use o WhatsApp ou o dashboard.
- Pode responder sobre: agenda do dia, quem mandou mensagem, status de projetos, informações pessoais, previsão do tempo, notícias, dúvidas gerais.

DATA/HORA: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
${context}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.history.slice(-10),
  ];

  const response = await openai.chat.completions.create({
    model: AI_MODEL_MINI, messages, max_tokens: 150, temperature: 0.7,
  });

  const reply = response.choices[0].message.content || 'Pode repetir?';
  return reply.length > 250 ? reply.slice(0, 250) : reply;
}

// ================================================================
// REDIRECIONAR LIGAÇÃO COM TwiML (para tocar áudio e voltar ao stream)
// ================================================================
async function redirectCallWithAudio(callSid, audioUrl, fallbackText) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    log.ai.warn('Twilio: sem credenciais para redirect');
    return;
  }

  const baseUrl = process.env.PUBLIC_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : 'https://zaya-assistente.onrender.com');
  const streamUrl = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/voice-stream';

  let playPart;
  if (audioUrl) {
    playPart = `<Play>${audioUrl}</Play>`;
  } else {
    playPart = `<Say language="pt-BR" voice="Polly.Camila">${escXml(fallbackText)}</Say>`;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${playPart}
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="callSid" value="${callSid}" />
    </Stream>
  </Connect>
</Response>`;

  try {
    const client = twilio(accountSid, authToken);
    await client.calls(callSid).update({
      twiml: twiml,
    });
    log.ai.info({ callSid }, 'Call redirecionada com áudio + stream');
  } catch (e) {
    log.ai.error({ err: e.message, callSid }, 'Erro ao redirecionar call');
  }
}

function escXml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ================================================================
// SALVAR HISTÓRICO DA LIGAÇÃO
// ================================================================
async function saveCallHistory(callSid, session) {
  const s = getSb();
  if (!s) return;
  try {
    const conversa = session.history.map(m => `${m.role === 'user' ? 'Pessoa' : 'Zaya'}: ${m.content}`).join('\n');
    await s.from('activity_log').insert({
      action: 'ligacao',
      details: {
        callSid,
        to: session.to || '',
        from: session.from || '',
        duracao_msgs: session.history.length,
        inicio: new Date(session.startedAt).toISOString(),
        fim: new Date().toISOString(),
        conversa: session.history,
        transcricao: conversa,
        mode: 'media-stream',
      },
      source: 'twilio',
    });
    log.ai.info({ callSid, msgs: session.history.length }, 'Histórico da ligação (stream) salvo');
  } catch (e) {
    log.ai.warn({ err: e.message }, 'Erro ao salvar histórico (stream)');
  }
}

// ================================================================
// SETUP WEBSOCKET SERVER para /voice-stream
// ================================================================
export function setupVoiceStreamWS(server) {
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade para /voice-stream
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/voice-stream') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Não interfere com Socket.IO (ele faz seu próprio upgrade em /socket.io/)
  });

  wss.on('connection', (ws, request) => {
    log.ai.info('Voice Stream: WebSocket conectado');

    let streamSid = null;
    let callSid = null;
    let session = null;

    // Buffers de áudio
    let pcmChunks = [];
    let chunkCount = 0;
    let silenceStart = null;
    let isSpeaking = false;
    let isProcessing = false;
    let lastActivityTime = Date.now();

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.event) {
          case 'connected':
            log.ai.info('Voice Stream: connected event');
            break;

          case 'start':
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;

            // Pegar callSid do parameter customizado (se enviado via TwiML)
            if (msg.start.customParameters?.callSid) {
              callSid = msg.start.customParameters.callSid;
            }

            log.ai.info({ streamSid, callSid }, 'Voice Stream: start event');

            // Buscar ou criar sessão (compartilhada com twilio-voice.js)
            if (!streamSessions.has(callSid)) {
              streamSessions.set(callSid, {
                history: [],
                startedAt: Date.now(),
                authenticated: true, // Se chegou aqui, já foi autenticado
                from: '',
                to: '',
              });
            }
            session = streamSessions.get(callSid);
            pcmChunks = [];
            chunkCount = 0;
            silenceStart = null;
            isSpeaking = false;
            isProcessing = false;
            break;

          case 'media':
            if (!session || isProcessing) break;
            lastActivityTime = Date.now();

            // Decodificar mulaw → PCM
            const pcm = decodeMulaw(msg.media.payload);
            const rms = calculateRMS(pcm);
            chunkCount++;

            if (rms > SILENCE_THRESHOLD) {
              // Pessoa está falando
              isSpeaking = true;
              silenceStart = null;
              pcmChunks.push(pcm);
            } else if (isSpeaking) {
              // Silêncio após fala — continua coletando
              pcmChunks.push(pcm);

              if (!silenceStart) {
                silenceStart = Date.now();
              }

              const silenceDuration = Date.now() - silenceStart;

              // Após SILENCE_DURATION_MS de silêncio, verifica Smart Turn
              if (silenceDuration >= SILENCE_DURATION_MS && pcmChunks.length >= MIN_AUDIO_CHUNKS) {
                isProcessing = true;

                // Converter para WAV
                const wavBuffer = pcmToWav(pcmChunks, SAMPLE_RATE);

                // Verificar Smart Turn
                const turnResult = await checkSmartTurn(wavBuffer);

                if (turnResult.turn_complete) {
                  log.ai.info({ callSid, chunks: pcmChunks.length, confidence: turnResult.confidence }, 'Turno completo — processando');

                  // Transcrever com Whisper
                  const transcript = await transcribeAudio(wavBuffer);

                  if (transcript && transcript.trim()) {
                    log.ai.info({ callSid, text: transcript.slice(0, 80) }, 'Transcrição recebida');

                    // Verificar despedida
                    const bye = /\b(tchau|adeus|até mais|até logo|encerrar|desligar|bye|obrigad[oa]|valeu|falou)\b/i;
                    if (bye.test(transcript)) {
                      session.history.push({ role: 'user', content: transcript });
                      const farewell = 'Foi um prazer falar com você! Qualquer coisa, é só ligar. Tchau!';
                      session.history.push({ role: 'assistant', content: farewell });
                      await saveCallHistory(callSid, session);

                      // Tocar despedida e desligar
                      let audioUrl = null;
                      try {
                        audioUrl = await Promise.race([
                          generateAudioStream(farewell),
                          new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
                        ]);
                      } catch {}

                      await hangupCallWithMessage(callSid, audioUrl, farewell);
                      break;
                    }

                    // Adicionar ao histórico
                    session.history.push({ role: 'user', content: transcript });

                    // Processar com AI
                    try {
                      const reply = await processWithAI(transcript, session);
                      session.history.push({ role: 'assistant', content: reply });
                      log.ai.info({ callSid, reply: reply.slice(0, 60) }, 'Resposta gerada (stream)');

                      // Gerar áudio ElevenLabs com timeout
                      let audioUrl = null;
                      try {
                        audioUrl = await Promise.race([
                          generateAudioStream(reply),
                          new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
                        ]);
                      } catch {}

                      // Redirecionar a call para tocar áudio e voltar ao stream
                      await redirectCallWithAudio(callSid, audioUrl, reply);
                    } catch (e) {
                      log.ai.error({ err: e.message, callSid }, 'Erro ao processar fala (stream)');
                      await redirectCallWithAudio(callSid, null, 'Desculpa, pode repetir?');
                    }
                  } else {
                    log.ai.debug({ callSid }, 'Transcrição vazia — ignorando');
                  }

                  // Resetar buffer
                  pcmChunks = [];
                  chunkCount = 0;
                  silenceStart = null;
                  isSpeaking = false;
                }

                isProcessing = false;
              }
            }
            break;

          case 'stop':
            log.ai.info({ streamSid, callSid }, 'Voice Stream: stop event');

            // Salvar se tinha histórico e não foi salvo
            if (session && session.history.length > 1 && !session._saved) {
              await saveCallHistory(callSid, session);
              session._saved = true;
            }
            break;

          default:
            break;
        }
      } catch (e) {
        log.ai.error({ err: e.message }, 'Voice Stream: erro ao processar mensagem');
      }
    });

    ws.on('close', () => {
      log.ai.info({ streamSid, callSid }, 'Voice Stream: WebSocket desconectado');
    });

    ws.on('error', (err) => {
      log.ai.error({ err: err.message, streamSid }, 'Voice Stream: WebSocket erro');
    });
  });

  log.ai.info('Voice Stream WebSocket handler configurado em /voice-stream');
  return wss;
}

// ================================================================
// DESLIGAR CALL COM MENSAGEM FINAL
// ================================================================
async function hangupCallWithMessage(callSid, audioUrl, fallbackText) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return;

  let playPart;
  if (audioUrl) {
    playPart = `<Play>${audioUrl}</Play>`;
  } else {
    playPart = `<Say language="pt-BR" voice="Polly.Camila">${escXml(fallbackText)}</Say>`;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${playPart}
  <Hangup/>
</Response>`;

  try {
    const client = twilio(accountSid, authToken);
    await client.calls(callSid).update({ twiml });
    log.ai.info({ callSid }, 'Call encerrada com mensagem');
  } catch (e) {
    log.ai.error({ err: e.message, callSid }, 'Erro ao encerrar call');
  }
}

// ================================================================
// EXPORTAR MAP de sessões para uso pelo twilio-voice.js
// ================================================================
export { streamSessions };
