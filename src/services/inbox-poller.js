// ================================================================
// INBOX POLLER — busca mensagens pendentes no Supabase e processa
// Substitui o webhook direto — URL permanente via Edge Function
// ================================================================
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, ADMIN_NUMBER, ADMIN_NAME, SENHA } from '../config.js';
import { log } from '../logger.js';
import { getBotConfig } from '../database.js';
import { io as getIO } from '../state.js';
import { processWithAI } from './ai.js';
import { sendText, sendLocalFile, sendAudio, uploadMedia, isWaSenderEnabled, decryptMedia } from './wasender.js';
import { isAuthenticated, loginSession, logoutSession } from './messaging.js';
import { openai } from '../state.js';
import { unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TMP_DIR } from '../config.js';
import { settingsDB } from '../database.js';

let supabase = null;
let polling = false;
let pollInterval = null;

function getSupabase() {
  if (!supabase && SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return supabase;
}

// ================================================================
// TTS — voz da Zaya via ElevenLabs
// ================================================================
async function sendVoiceReply(phone, text) {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) { await sendText(phone, text); return; }

    const voiceId = settingsDB.get('elevenlabs_voice_id', process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL');

    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.slice(0, 2000),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.4 },
      }),
    });

    if (!ttsRes.ok) {
      await sendText(phone, text);
      return;
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
    const base64 = `data:audio/mpeg;base64,${audioBuffer.toString('base64')}`;
    const upload = await uploadMedia(base64, 'audio/mpeg');

    if (upload.success && upload.data?.publicUrl) {
      await sendAudio(phone, upload.data.publicUrl);
    } else {
      await sendText(phone, text);
    }
  } catch (e) {
    log.wa.error({ err: e.message }, 'Inbox poller TTS error');
    await sendText(phone, text);
  }
}

// ================================================================
// PROCESSAR UMA MENSAGEM
// ================================================================
async function processInboxMessage(msg) {
  const { id, phone, jid, message_body: text, message_type: msgType, push_name, media_url, is_group } = msg;
  const sb = getSupabase();

  // Já marcado como processed no pollOnce (batch)
  const config = getBotConfig();
  const isAdmin = config.adminNumbers.some(n => phone === n || phone.endsWith(n));

  // ================================================================
  // MENÇÃO EM GRUPO — avisa mesmo com bot desativado (sem voz aqui, agrupado no pollOnce)
  // ================================================================
  if (is_group && text) {
    const adminMentioned = config.adminNumbers.some(n => {
      return text.includes('@' + n) || text.includes('@' + n.slice(-8));
    });
    const nameMention = ADMIN_NAME && text.toLowerCase().includes(ADMIN_NAME.toLowerCase().split(' ')[0].toLowerCase());

    if (adminMentioned || nameMention) {
      const groupName = jid?.split('@')[0] || 'grupo';

      log.wa.info({ senderName: push_name, groupName }, 'Mencionado em grupo (poller)');

      const ioInstance = getIO;
      ioInstance?.emit('incoming-notification', {
        type: 'group_mention',
        title: `${push_name || phone} te marcou no grupo ${groupName}`,
        text: (text || '').slice(0, 200),
        phone, senderName: push_name, groupName,
        timestamp: new Date().toISOString(),
      });

      if (config.watchNotifyMode === 'whatsapp' || config.watchNotifyMode === 'both') {
        for (const adminNum of config.adminNumbers) {
          sendText(adminNum, `📌 *${push_name || phone}* te marcou no grupo *${groupName}*:\n\n${(text || '').slice(0, 300)}`).catch(() => {});
        }
      }
    }
  }

  // ================================================================
  // NÚMEROS MONITORADOS — avisa mesmo com bot desativado (sem voz aqui, agrupado no pollOnce)
  // ================================================================
  if (config.watchNumbers?.length > 0) {
    const watched = config.watchNumbers.find(w => w.notify && (phone === w.numero || phone.endsWith(w.numero)));
    if (watched) {
      log.wa.info({ phone, nome: watched.nome }, 'Número monitorado (poller)');

      const ioInstance = getIO;
      ioInstance?.emit('incoming-notification', {
        type: 'watched',
        title: `${watched.nome || phone} enviou mensagem`,
        text: (text || '[mídia]').slice(0, 200),
        phone,
        nome: watched.nome,
        askToRead: true,
        timestamp: new Date().toISOString(),
      });

      if (config.watchNotifyMode === 'whatsapp' || config.watchNotifyMode === 'both') {
        for (const adminNum of config.adminNumbers) {
          if (adminNum !== phone) {
            sendText(adminNum, `📩 *${watched.nome || phone}* enviou:\n\n${text || '[mídia]'}`).catch(() => {});
          }
        }
      }
    }
  }

  // ================================================================
  // BOT DESATIVADO — para aqui (monitoramento já foi feito acima)
  // ================================================================
  if (!config.botActive) return;

  // Filtragem
  if (config.replyMode === 'admin_only' && !isAdmin) {
    if (config.unauthorizedReply) await sendText(phone, config.unauthorizedReply);
    return;
  }

  // ================================================================
  // COMANDOS — funcionam antes do login
  // ================================================================
  if (text?.startsWith('/login')) {
    const pwd = text.slice(7).trim();
    if (pwd === SENHA) {
      loginSession(jid);
      await sendText(phone, `Bem-vindo, ${ADMIN_NAME}! Zaya pronta para suas ordens.`);
    } else {
      await sendText(phone, 'Senha incorreta.');
    }
    return;
  }
  if (text === '/logout') { logoutSession(jid); await sendText(phone, 'Sessão encerrada.'); return; }
  if (text === '/ping') { await sendText(phone, 'Pong! Online.'); return; }
  if (text === '/help') { await sendText(phone, `*ZAYA Bot*\n/login <senha> — ativar bot\n/logout — desativar\n/ping /limpar /help`); return; }
  if (text === '/limpar') { await sendText(phone, 'Histórico limpo!'); return; }

  // ================================================================
  // AUTENTICAÇÃO — só responde após /login
  // ================================================================
  if (isAdmin && config.autoLoginAdmin && !isAuthenticated(jid)) {
    loginSession(jid);
  }

  if (!isAuthenticated(jid)) {
    if (text && text.length > 0 && !text.startsWith('/')) {
      await sendText(phone, `Olá! Para usar a Zaya, faça login:\n\n*/login <senha>*\n\nDigite /help para mais info.`);
    }
    return;
  }

  loginSession(jid); // renova sessão
  log.wa.info({ phone, type: msgType, isAdmin, text: (text || '').slice(0, 80) }, 'Inbox processing');

  try {
    // Áudio
    if (msgType === 'audio') {
      await sendText(phone, '🎧 Transcrevendo áudio...');
      try {
        let audioBuffer = null;

        // 1. Tenta media_url direto (se existir)
        if (media_url) {
          const audioRes = await fetch(media_url);
          if (audioRes.ok) audioBuffer = Buffer.from(await audioRes.arrayBuffer());
        }

        // 2. Fallback: decrypt-media via WaSender API
        if (!audioBuffer && msg.raw_payload) {
          const rawMsg = msg.raw_payload?.data?.messages || msg.raw_payload?.data;
          if (rawMsg) {
            log.wa.info('Áudio: usando decrypt-media do WaSender');
            const decResult = await decryptMedia(rawMsg);
            log.wa.info({ success: decResult.success, dataKeys: Object.keys(decResult.data || {}), url: decResult.data?.publicUrl?.slice(0, 80) }, 'decrypt-media resultado');
            const audioUrl = decResult.data?.publicUrl || decResult.data?.url;
            if (decResult.success && audioUrl) {
              log.wa.info({ audioUrl: audioUrl.slice(0, 80) }, 'Baixando áudio...');
              const audioRes = await fetch(audioUrl);
              log.wa.info({ status: audioRes.status, size: audioRes.headers?.get('content-length') }, 'Áudio baixado');
              if (audioRes.ok) audioBuffer = Buffer.from(await audioRes.arrayBuffer());
            } else {
              log.wa.error({ error: decResult.error, data: JSON.stringify(decResult.data)?.slice(0, 200) }, 'decrypt-media falhou');
            }
          }
        }

        if (!audioBuffer || audioBuffer.length < 1000) {
          await sendText(phone, 'Não consegui acessar o áudio. Tente enviar como texto.');
          return;
        }

        const audioPath = join(TMP_DIR, `wa_audio_${Date.now()}.ogg`);
        writeFileSync(audioPath, audioBuffer);

        const { createReadStream } = await import('fs');
        const transcription = await openai.audio.transcriptions.create({
          file: createReadStream(audioPath),
          model: 'whisper-1',
          language: 'pt',
        });
        try { unlinkSync(audioPath); } catch {}

        const transcribed = (transcription.text || '').trim();
        log.wa.info({ transcribed: transcribed.slice(0, 100), bufferSize: audioBuffer.length }, 'Áudio transcrito');
        if (transcribed) {
          await sendText(phone, `📝 _${transcribed}_`);
          const result = await processWithAI(transcribed, jid, isAdmin);
          log.wa.info({ response: (result.text || '').slice(0, 100) }, 'IA respondeu áudio');
          if (result.text) {
            if (isAdmin) await sendVoiceReply(phone, result.text);
            else await sendText(phone, result.text);
          }
        } else {
          await sendText(phone, 'Não entendi o áudio. Pode repetir?');
        }
      } catch (e) {
        log.wa.error({ err: e.message }, 'Erro processando áudio');
        await sendText(phone, `Erro no áudio: ${e.message}`);
      }
    }

    // Texto normal
    else if (text && text.length > 0) {
      // NÃO envia "Pensando..." — evita rate limit do WaSender (1 msg/5s)
      const result = await processWithAI(text, jid, isAdmin);
      if (result.text) {
        await sendText(phone, result.text);
        // Espera 5s entre mensagens (rate limit WaSender)
        if (result.images?.length > 0) await new Promise(r => setTimeout(r, 5500));
      }
      for (const img of result.images) {
        await sendLocalFile(phone, img, 'Imagem gerada por IA');
        try { unlinkSync(img); } catch {}
        await new Promise(r => setTimeout(r, 5500));
      }
    }

  } catch (e) {
    log.wa.error({ err: e.message, phone }, 'Inbox process error');
  }
}

// ================================================================
// POLL LOOP — busca mensagens pendentes a cada 3 segundos
// ================================================================
async function pollOnce() {
  if (polling) return;
  polling = true;

  try {
    const sb = getSupabase();
    if (!sb) { polling = false; return; }

    // Marca eventos não-received como processed (status updates, etc.)
    await sb.from('wa_inbox')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('status', 'pending')
      .not('event', 'ilike', '%received%');

    const { data: messages, error } = await sb
      .from('wa_inbox')
      .select('*')
      .eq('status', 'pending')
      .ilike('event', '%received%')
      .order('received_at', { ascending: true })
      .limit(5);

    if (error) {
      log.wa.error({ err: error.message }, 'Inbox poll error');
      polling = false;
      return;
    }

    if (messages && messages.length > 0) {
      // ============================================================
      // MARCA TODAS como processed IMEDIATAMENTE (evita reprocessar)
      // ============================================================
      const ids = messages.map(m => m.id);
      await sb.from('wa_inbox').update({ status: 'processed', processed_at: new Date().toISOString() }).in('id', ids);

      // ============================================================
      // DEDUPLICAÇÃO — remove mensagens duplicadas (mesmo phone+texto)
      // ============================================================
      const seen = new Set();
      const unique = [];
      for (const msg of messages) {
        // Ignora mensagens vazias ou newsletters
        if (!msg.phone || msg.jid?.includes('@newsletter')) continue;
        const key = `${msg.phone}:${msg.message_body || ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(msg);
        }
      }

      if (unique.length === 0) { polling = false; return; }
      log.wa.info({ total: messages.length, unique: unique.length }, 'Inbox: mensagens pendentes');

      // ============================================================
      // AGRUPA notificações por remetente monitorado ANTES de processar
      // ============================================================
      const config = getBotConfig();
      const watchedSummary = {}; // { nome: { count, lastText } }
      const groupMentions = []; // [{ senderName, groupName, text }]

      for (const msg of unique) {
        const phone = msg.phone || '';
        const text = msg.message_body || '';
        const isGroup = msg.is_group;

        // Checa monitorado
        if (config.watchNumbers?.length > 0) {
          const watched = config.watchNumbers.find(w => w.notify && (phone === w.numero || phone.endsWith(w.numero)));
          if (watched) {
            const nome = watched.nome || phone;
            if (!watchedSummary[nome]) watchedSummary[nome] = { count: 0, lastText: '' };
            watchedSummary[nome].count++;
            watchedSummary[nome].lastText = text || '[mídia]';
          }
        }

        // Checa menção em grupo
        if (isGroup && text) {
          const adminMentioned = config.adminNumbers.some(n => text.includes('@' + n) || text.includes('@' + n.slice(-8)));
          const nameMention = ADMIN_NAME && text.toLowerCase().includes(ADMIN_NAME.toLowerCase().split(' ')[0].toLowerCase());
          if (adminMentioned || nameMention) {
            groupMentions.push({
              senderName: msg.push_name || phone,
              groupName: (msg.jid || '').split('@')[0] || 'grupo',
              text,
            });
          }
        }
      }

      // ============================================================
      // NOTIFICAÇÃO POR VOZ — uma única, agrupada
      // ============================================================
      const nomes = Object.keys(watchedSummary);
      if (nomes.length > 0) {
        let voiceText;
        if (nomes.length === 1) {
          const nome = nomes[0];
          const info = watchedSummary[nome];
          if (info.count === 1) {
            voiceText = `${nome} enviou mensagem. Quer que eu leia?`;
          } else {
            voiceText = `${nome} enviou ${info.count} mensagens. Quer que eu leia?`;
          }
        } else {
          // Múltiplas pessoas
          const lista = nomes.map(n => {
            const c = watchedSummary[n].count;
            return c > 1 ? `${n} com ${c} mensagens` : n;
          });
          const ultimo = lista.pop();
          voiceText = `${lista.join(', ')} e ${ultimo} mandaram mensagem. Quer que eu leia?`;
        }

        // Notificação via Socket.IO → navegador cuida da voz
        log.wa.info({ voiceText }, 'Notificação enviada ao dashboard');
      }

      // Menções em grupo — já emitidas via Socket.IO no processInboxMessage

      // ============================================================
      // AGRUPA mensagens do mesmo remetente e processa como contexto único
      // ============================================================
      const byPhone = {};
      for (const msg of unique) {
        const ph = msg.phone || 'unknown';
        if (!byPhone[ph]) byPhone[ph] = [];
        byPhone[ph].push(msg);
      }

      for (const [ph, msgs] of Object.entries(byPhone)) {
        if (msgs.length === 1) {
          // Mensagem única — processa normal
          await processInboxMessage(msgs[0]);
        } else {
          // Múltiplas mensagens do mesmo remetente — junta textos
          const textos = msgs
            .map(m => m.message_body || '')
            .filter(t => t.length > 0);
          const combined = textos.join('\n');

          // Processa a primeira com o texto combinado (todas já marcadas como processed)
          const merged = { ...msgs[0], message_body: combined || msgs[0].message_body };
          log.wa.info({ phone: ph, count: msgs.length, combined: combined.slice(0, 100) }, 'Mensagens agrupadas');
          await processInboxMessage(merged);
        }
        // Rate limit entre remetentes
        if (Object.keys(byPhone).length > 1) await new Promise(r => setTimeout(r, 6000));
      }
    }
  } catch (e) {
    log.wa.error({ err: e.message }, 'Inbox poll error');
  }

  polling = false;
}

export function startInboxPoller() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    log.wa.warn('Supabase não configurado — inbox poller desativado');
    return;
  }

  log.wa.info('Inbox poller iniciado (3s interval)');
  pollInterval = setInterval(pollOnce, 3000);
  // Poll imediato
  pollOnce();
}

export function stopInboxPoller() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
