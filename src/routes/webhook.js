// ================================================================
// WEBHOOK — recebe mensagens do WaSenderAPI
// ================================================================
import { Router } from 'express';
import { log } from '../logger.js';
import { getBotConfig, settingsDB } from '../database.js';
import { processWithAI } from '../services/ai.js';
import { sendText, sendLocalFile, sendAudio, uploadMedia, isWaSenderEnabled } from '../services/wasender.js';
import { isAuthenticated, loginSession, logoutSession } from '../services/messaging.js';
import { chatHistories, saveHistory, addToHistory } from '../services/chat-history.js';
import { openai, io as getIO } from '../state.js';
import { ADMIN_NAME, SENHA, ADMIN_NUMBER, TMP_DIR } from '../config.js';
import { unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const router = Router();

const PROCESSING_MSGS = ['Processando...', 'Pensando...', 'Analisando...', 'Um momento...'];
let msgIdx = 0;
function getProcessingMsg() { return PROCESSING_MSGS[msgIdx++ % PROCESSING_MSGS.length]; }

// ================================================================
// TTS — converte texto em áudio via ElevenLabs e envia no WhatsApp
// ================================================================
async function sendVoiceReply(phone, text) {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) { await sendText(phone, text); return; } // fallback texto

    const voiceId = settingsDB.get('elevenlabs_voice_id', process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL');

    // Gera áudio
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
      log.wa.error({ status: ttsRes.status }, 'ElevenLabs TTS falhou');
      await sendText(phone, text); // fallback texto
      return;
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
    const audioPath = join(TMP_DIR, `voice_${Date.now()}.mp3`);
    writeFileSync(audioPath, audioBuffer);

    // Upload e envia como áudio
    const base64 = `data:audio/mpeg;base64,${audioBuffer.toString('base64')}`;
    const upload = await uploadMedia(base64, 'audio/mpeg');

    if (upload.success && upload.data?.publicUrl) {
      await sendAudio(phone, upload.data.publicUrl);
    } else {
      // Fallback: envia como arquivo local
      await sendLocalFile(phone, audioPath, '');
    }

    try { unlinkSync(audioPath); } catch {}
  } catch (e) {
    log.wa.error({ err: e.message }, 'Erro no TTS/áudio');
    await sendText(phone, text); // fallback texto
  }
}

// ================================================================
// FILA DE MENSAGENS PENDENTES (para ler quando o usuário quiser)
// ================================================================
const pendingMessages = [];

// API para o frontend consultar mensagens pendentes
router.get('/whatsapp/pending', (req, res) => {
  res.json(pendingMessages);
});

router.delete('/whatsapp/pending', (req, res) => {
  pendingMessages.length = 0;
  res.json({ ok: true });
});

router.delete('/whatsapp/pending/:index', (req, res) => {
  const idx = parseInt(req.params.index);
  if (idx >= 0 && idx < pendingMessages.length) {
    pendingMessages.splice(idx, 1);
  }
  res.json({ ok: true });
});

// ================================================================
// WEBHOOK ENDPOINT
// ================================================================
router.post('/whatsapp', async (req, res) => {
  res.status(200).json({ ok: true });

  // LOG COMPLETO do que o WaSender envia
  log.wa.info({ body: JSON.stringify(req.body).slice(0, 2000) }, 'WEBHOOK RAW');

  if (!isWaSenderEnabled()) return;

  try {
    const { event, data } = req.body;
    if (!event || !data) { log.wa.warn('Webhook sem event/data'); return; }
    if (!event.includes('received')) { log.wa.debug({ event }, 'Evento ignorado (não é received)'); return; }

    const msg = data.messages || data.message || data;
    if (!msg) { log.wa.warn('Webhook sem messages'); return; }
    if (msg.key?.fromMe) { log.wa.debug('Ignorando fromMe'); return; }

    const phone = msg.key?.cleanedSenderPn || msg.key?.remoteJid?.replace('@s.whatsapp.net', '').replace('@g.us', '') || msg.from || msg.sender || '';
    if (!phone) { log.wa.warn('Webhook sem phone'); return; }

    const jid = msg.key?.remoteJid || phone + '@c.us';
    const text = msg.messageBody || msg.body || msg.text || msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const msgType = getMessageType(msg);
    const isGroup = jid.endsWith('@g.us') || event.includes('group');
    const senderName = msg.pushName || msg.key?.senderPn || phone;

    log.wa.info({ phone, text: text.slice(0, 100), msgType, event }, 'Webhook parsed');

    const config = getBotConfig();

    // ================================================================
    // MENÇÃO EM GRUPO — avisa quando marcarem o usuário
    // ================================================================
    if (isGroup && text) {
      // Detecta menção: @numero, @nome do admin, ou palavras-chave
      const adminMentioned = config.adminNumbers.some(n => {
        return text.includes('@' + n) || text.includes('@' + n.slice(-8));
      });
      // Também detecta menção por nome
      const nameMention = ADMIN_NAME && text.toLowerCase().includes(ADMIN_NAME.toLowerCase().split(' ')[0].toLowerCase());

      if (adminMentioned || nameMention) {
        const groupName = msg.key?.remoteJid?.split('@')[0] || 'grupo';
        const notif = {
          type: 'group_mention',
          phone,
          senderName,
          groupName,
          text: text.slice(0, 500),
          timestamp: new Date().toISOString(),
        };

        pendingMessages.push(notif);
        log.wa.info({ senderName, groupName }, 'Mencionado em grupo');

        // Emite para o dashboard/voz
        const ioInstance = getIO;
        ioInstance?.emit('incoming-notification', {
          type: 'group_mention',
          title: `${senderName} te marcou no grupo ${groupName}`,
          text: text.slice(0, 200),
          phone, senderName, groupName,
          timestamp: notif.timestamp,
        });

        // Notifica via WhatsApp
        if (config.watchNotifyMode === 'whatsapp' || config.watchNotifyMode === 'both') {
          for (const adminNum of config.adminNumbers) {
            sendText(adminNum, `📌 *${senderName}* te marcou no grupo *${groupName}*:\n\n${text.slice(0, 300)}`).catch(() => {});
          }
        }
      }

      // Não processa grupo como bot (a menos que replyGroups esteja ativo)
      if (!config.replyGroups) return;
    }

    // ================================================================
    // NÚMEROS MONITORADOS — avisa e guarda mensagem
    // ================================================================
    if (config.watchNumbers?.length > 0) {
      const watched = config.watchNumbers.find(w => w.notify && (phone === w.numero || phone.endsWith(w.numero)));
      if (watched) {
        const notif = {
          type: 'watched',
          phone,
          nome: watched.nome || phone,
          text: text || '[mídia]',
          timestamp: new Date().toISOString(),
        };

        pendingMessages.push(notif);
        log.wa.info({ phone, nome: watched.nome }, 'Número monitorado');

        // Emite para dashboard/voz — pergunta se quer ler
        const ioInstance = getIO;
        ioInstance?.emit('incoming-notification', {
          type: 'watched',
          title: `${watched.nome || phone} enviou mensagem`,
          text: text?.slice(0, 200) || '[mídia]',
          phone,
          nome: watched.nome,
          askToRead: true,
          timestamp: notif.timestamp,
        });

        // Notifica admin via WhatsApp
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
    // BOT IA — responde mensagens
    // ================================================================
    if (!config.botActive) return;

    const isAdmin = config.adminNumbers.some(n => phone === n || phone.endsWith(n));

    // Filtragem
    if (config.replyMode === 'admin_only' && !isAdmin) {
      if (config.unauthorizedReply) await sendText(phone, config.unauthorizedReply);
      return;
    }
    if (config.replyMode === 'whitelist' && !isAdmin) {
      const inWhitelist = config.whitelist.some(n => phone === n || phone.endsWith(n));
      if (!inWhitelist) {
        if (config.unauthorizedReply) await sendText(phone, config.unauthorizedReply);
        return;
      }
    }

    if (isAdmin && config.autoLoginAdmin && !isAuthenticated(jid)) {
      loginSession(jid);
    }

    log.wa.info({ phone, type: msgType, isAdmin, event }, 'Webhook message');

    // Comandos
    if (text.startsWith('/login')) {
      const pwd = text.slice(7).trim();
      if (pwd === SENHA) { loginSession(jid); await sendText(phone, `Bem-vindo ao ZAYA Bot, ${ADMIN_NAME}!`); }
      else await sendText(phone, 'Senha incorreta.');
      return;
    }
    if (text === '/logout') { logoutSession(jid); await sendText(phone, 'Sessão encerrada.'); return; }
    if (text === '/ping') { await sendText(phone, 'Pong! Online.'); return; }
    if (text === '/help') { await sendText(phone, `*ZAYA Bot*\n/login /logout /ping /limpar /help\n\nEnvie texto, áudio, imagem ou vídeo!`); return; }
    if (text === '/limpar') { delete chatHistories[jid]; saveHistory(); await sendText(phone, 'Histórico limpo!'); return; }

    if (!isAuthenticated(jid)) { await sendText(phone, 'Faça login: /login <senha>'); return; }
    loginSession(jid);

    // IA — admin recebe áudio se mandou áudio, texto se mandou texto
    const isAudioMsg = msgType === 'audio' || msgType === 'ptt';
    const respondWithAudio = isAdmin && isAudioMsg;

    // ========== ÁUDIO RECEBIDO — transcreve + IA + responde em áudio ==========
    if (isAudioMsg) {
      if (!config.transcribeAudio) return;

      await sendText(phone, '🎧 Transcrevendo áudio...');
      log.wa.info({ phone }, 'Áudio recebido, transcrevendo...');

      try {
        // Tenta pegar o áudio do webhook data
        let audioBuffer = null;
        const audioMsg = msg.message?.audioMessage || msg.message?.pttMessage;

        // WaSender pode enviar mediaUrl ou base64 no webhook
        if (msg.mediaUrl || msg.media?.url) {
          const mediaUrl = msg.mediaUrl || msg.media?.url;
          log.wa.info({ mediaUrl: mediaUrl?.slice(0, 80) }, 'Baixando áudio de URL');
          const audioRes = await fetch(mediaUrl);
          if (audioRes.ok) audioBuffer = Buffer.from(await audioRes.arrayBuffer());
        }

        if (!audioBuffer && (msg.media?.base64 || msg.base64)) {
          const b64 = msg.media?.base64 || msg.base64;
          audioBuffer = Buffer.from(b64, 'base64');
        }

        // Se não tem áudio no webhook, avisa
        if (!audioBuffer || audioBuffer.length < 1000) {
          // Fallback: se tem texto junto (caption do áudio), processa como texto
          if (text && text.length > 0) {
            const result = await processWithAI(text, jid, isAdmin);
            if (result.text) await sendVoiceReply(phone, result.text);
            return;
          }
          await sendText(phone, 'Não consegui acessar o áudio. Tente enviar como mensagem de texto.');
          return;
        }

        // Salva temporariamente
        const audioPath = join(TMP_DIR, `wa_audio_${Date.now()}.ogg`);
        writeFileSync(audioPath, audioBuffer);

        // Transcreve com OpenAI Whisper API
        const { createReadStream } = await import('fs');
        const transcription = await openai.audio.transcriptions.create({
          file: createReadStream(audioPath),
          model: 'whisper-1',
          language: 'pt',
        });
        try { unlinkSync(audioPath); } catch {}

        const transcribedText = (transcription.text || '').trim();
        log.wa.info({ phone, text: transcribedText.slice(0, 100) }, 'Áudio transcrito');

        if (!transcribedText) {
          await sendText(phone, 'Não consegui entender o áudio. Pode repetir?');
          return;
        }

        // Mostra transcrição
        await sendText(phone, `📝 _${transcribedText}_`);

        // Processa com IA
        const result = await processWithAI(transcribedText, jid, isAdmin);

        if (result.text) {
          // Admin recebe resposta em áudio
          if (isAdmin) {
            await sendVoiceReply(phone, result.text);
          } else {
            await sendText(phone, result.text);
          }
        }

        for (const img of result.images) {
          await sendLocalFile(phone, img, 'Imagem gerada por IA');
          try { unlinkSync(img); } catch {}
        }
      } catch (e) {
        log.wa.error({ err: e.message, phone }, 'Erro processando áudio');
        await sendText(phone, `Erro ao processar áudio: ${e.message}`);
      }
      return;
    }

    // ========== TEXTO — processa normalmente ==========
    if (text && text.length > 0) {
      // NÃO envia "Pensando..." — rate limit WaSender (1 msg/5s)
      const result = await processWithAI(text, jid, isAdmin);
      if (result.text) {
        await sendText(phone, result.text);
      }
      for (const img of result.images) {
        await sendLocalFile(phone, img, 'Imagem gerada por IA');
        try { unlinkSync(img); } catch {}
      }
    }
  } catch (e) {
    log.wa.error({ err: e.message }, 'Webhook error');
  }
});

// ================================================================
// STATUS DO WASENDER
// ================================================================
router.get('/whatsapp/status', async (req, res) => {
  if (!isWaSenderEnabled()) return res.json({ enabled: false });
  const { getSessionStatus } = await import('../services/wasender.js');
  const status = await getSessionStatus();
  res.json({ enabled: true, ...status });
});

function getMessageType(msg) {
  if (msg.message?.imageMessage) return 'image';
  if (msg.message?.videoMessage) return 'video';
  if (msg.message?.audioMessage) return 'audio';
  if (msg.message?.pttMessage) return 'ptt';
  if (msg.message?.documentMessage) return 'document';
  // WaSenderAPI pode enviar tipo de várias formas
  const t = (msg.type || msg.messageType || '').toLowerCase();
  if (t === 'audio' || t === 'ptt' || t === 'voice') return 'audio';
  if (t === 'image' || t === 'photo') return 'image';
  if (t === 'video') return 'video';
  if (t === 'document' || t === 'file') return 'document';
  // Detecta por mediaUrl/mimetype
  if (msg.mediaUrl || msg.media?.url) {
    const mime = (msg.mimetype || msg.media?.mimetype || '').toLowerCase();
    if (mime.includes('audio') || mime.includes('ogg') || mime.includes('opus')) return 'audio';
    if (mime.includes('image')) return 'image';
    if (mime.includes('video')) return 'video';
  }
  return 'text';
}

// ================================================================
// ENVIAR COMANDO VIA API (alternativa quando webhook não funciona)
// POST /webhook/wa-command { text: "mensagem", phone: "5511..." }
// ================================================================
router.post('/wa-command', async (req, res) => {
  const { text, phone: reqPhone } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const phone = (reqPhone || ADMIN_NUMBER).replace(/\D/g, '');
  const jid = phone + '@c.us';

  log.wa.info({ phone, text: text.slice(0, 100) }, 'WA Command via API');

  // Auto-login
  if (!isAuthenticated(jid)) loginSession(jid);

  try {
    await sendText(phone, getProcessingMsg());
    const result = await processWithAI(text, jid, true);

    if (result.text) {
      await sendVoiceReply(phone, result.text);
    }

    for (const img of result.images) {
      await sendLocalFile(phone, img, 'Imagem gerada por IA');
      try { unlinkSync(img); } catch {}
    }

    res.json({ success: true, response: result.text, images: result.images?.length || 0 });
  } catch (e) {
    log.wa.error({ err: e.message }, 'WA Command error');
    res.status(500).json({ error: e.message });
  }
});

export default router;
