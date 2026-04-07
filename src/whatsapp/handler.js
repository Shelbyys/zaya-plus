import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { ADMIN_NAME, SENHA, TMP_DIR, FFMPEG, AI_MODEL_MINI } from '../config.js';
import { videoSessions, processingQueue } from '../state.js';
import { openai } from '../state.js';
import { isAuthenticated, loginSession, logoutSession, sendWhatsApp } from '../services/messaging.js';
import { chatHistories, saveHistory, addToHistory } from '../services/chat-history.js';
import { processWithAI, traduzirErroAPI } from '../services/ai.js';
import { editVideo, startVideoSession, processVideoAnswer, buildInstruction, whisperTranscribe } from '../services/media.js';
import { exec } from 'child_process';
import { log } from '../logger.js';
import { getBotConfig, contactsDB } from '../database.js';
import { processarRespostaMissao } from '../services/missions.js';
import { verifyVoice, getVoiceIdStatus } from '../services/voice-id.js';
import { syncContactToSupabase, saveToWaInbox } from '../services/supabase.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

const PROCESSING_MSGS = ['Processando...', 'Pensando...', 'Analisando...', 'Um momento...', 'Trabalhando...', 'Consultando IA...'];
let msgIdx = 0;
function getProcessingMsg() { return PROCESSING_MSGS[msgIdx++ % PROCESSING_MSGS.length]; }

// Limpeza periódica do processingQueue
setInterval(() => {
  const now = Date.now();
  for (const jid of Object.keys(processingQueue)) {
    if (processingQueue[jid]._lastActivity && now - processingQueue[jid]._lastActivity > 3600000) {
      delete processingQueue[jid];
    }
  }
}, 1800000);

async function enqueue(jid, fn) {
  if (!processingQueue[jid]) processingQueue[jid] = Promise.resolve();
  processingQueue[jid] = processingQueue[jid].then(fn).catch(e => log.wa.error({ err: e.message }, 'Queue error'));
  processingQueue[jid]._lastActivity = Date.now();
  return processingQueue[jid];
}

export function setupMessageHandler(sock, instanceName) {
  log.wa.info({ instance: instanceName }, 'Message handler registrado (Baileys)');

  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;

    for (const msg of msgs) {
      try {
        const config = getBotConfig();
        if (!config || !Array.isArray(config.adminNumbers)) return;
        if (!config.botActive) return;

        // Ignora mensagens próprias e status
        if (msg.key.fromMe) return;
        if (msg.key.remoteJid === 'status@broadcast') return;

        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        if (isGroup && !config.replyGroups) return;
        if (!jid.endsWith('@s.whatsapp.net') && !isGroup) return;

        const phone = jid.split('@')[0];
        const pushName = msg.pushName || phone;

        // Sync incremental do contato
        let isNewContact = false;
        try {
          const existing = contactsDB.getByJid(jid);
          if (!existing) isNewContact = true;
          contactsDB.upsert(pushName, phone, jid);
          syncContactToSupabase(pushName, phone, jid);
        } catch {}

        // Extrair texto da mensagem
        const text = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || msg.message?.videoMessage?.caption
          || '';

        const hasAudio = !!(msg.message?.audioMessage);
        const hasImage = !!(msg.message?.imageMessage);
        const hasVideo = !!(msg.message?.videoMessage);
        const msgType = hasAudio ? 'audio' : hasImage ? 'image' : hasVideo ? 'video' : 'text';

        // Salva no Supabase
        const msgBody = text || (msg.message ? `[${msgType}]` : '');
        saveToWaInbox(phone, pushName, msgBody, msgType, false, true);

        // Verifica se é admin
        const isAdmin = config.adminNumbers.some(n => phone === n || phone.endsWith(n));

        // Alerta de números monitorados
        if (config.watchNumbers?.length > 0 && !isAdmin) {
          const watched = config.watchNumbers.find(w => w.notify && (phone === w.numero || phone.endsWith(w.numero)));
          if (watched) {
            const body = text || `[${msgType}]`;
            const alertMsg = `🔔 *ALERTA MONITORAMENTO*\n\n👤 *${watched.nome || phone}*\n📱 ${phone}\n💬 ${body.substring(0, 500)}`;
            for (const adminNum of config.adminNumbers) {
              sendWhatsApp(adminNum, alertMsg).catch(() => {});
            }
          }
        }

        // Filtragem por modo de resposta
        if (config.replyMode === 'admin_only' && !isAdmin) {
          if (config.unauthorizedReply) await sock.sendMessage(jid, { text: config.unauthorizedReply });
          return;
        }
        if (config.replyMode === 'whitelist' && !isAdmin) {
          const inWhitelist = (config.whitelist || []).some(n => phone === n || phone.endsWith(n));
          if (!inWhitelist) {
            if (config.unauthorizedReply) await sock.sendMessage(jid, { text: config.unauthorizedReply });
            return;
          }
        }

        // Welcome message
        if (isNewContact && config.welcomeMessage) {
          try { await sock.sendMessage(jid, { text: config.welcomeMessage }); } catch {}
        }

        // Read receipts
        if (config.readReceipts) {
          try { await sock.readMessages([msg.key]); } catch {}
        }

        log.wa.info({ phone, type: msgType, isAdmin, pushName }, 'Message received (Baileys)');

        const sendText = async (txt) => {
          try { await sock.sendMessage(jid, { text: txt }); } catch (e) { log.wa.error({ err: e.message, jid }, 'Send error'); }
        };

        const sendMedia = async (filePath, caption) => {
          try {
            const { readFileSync } = await import('fs');
            const { extname } = await import('path');
            const buffer = readFileSync(filePath);
            const ext = extname(filePath).toLowerCase();
            if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
              await sock.sendMessage(jid, { image: buffer, caption: caption || '' });
            } else if (['.mp4', '.mov', '.avi'].includes(ext)) {
              await sock.sendMessage(jid, { video: buffer, caption: caption || '' });
            } else {
              await sock.sendMessage(jid, { document: buffer, fileName: filePath.split('/').pop(), caption: caption || '' });
            }
          } catch (e) { log.wa.error({ err: e.message }, 'Send media error'); }
        };

        // Auto-login para admins
        if (isAdmin && config.autoLoginAdmin && !isAuthenticated(jid)) {
          loginSession(jid);
        }

        // ========== ÁUDIO ==========
        if (hasAudio && !config.transcribeAudio) return;
        if (hasAudio) {
          await enqueue(jid, async () => {
            await sendText(getProcessingMsg());
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const rawPath = join(TMP_DIR, `audio_${Date.now()}.ogg`);
              writeFileSync(rawPath, buffer);
              const wavPath = rawPath.replace('.ogg', '.wav');
              await new Promise((resolve, reject) => {
                exec(`${FFMPEG} -y -i "${rawPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`, { timeout: 30000 }, (err) => err ? reject(err) : resolve());
              });
              try { unlinkSync(rawPath); } catch {}
              const transcription = await whisperTranscribe(wavPath, 'json');
              const transcribedText = transcription?.text || '';
              if (!transcribedText) { try { unlinkSync(wavPath); } catch {} await sendText('Não consegui transcrever o áudio.'); return; }

              const vidStatus = await getVoiceIdStatus();
              if (vidStatus.ready) {
                const vr = await verifyVoice(wavPath);
                if (!vr.verified) {
                  try { unlinkSync(wavPath); } catch {}
                  await sendText(`🔒 Voz não reconhecida. Apenas o ${ADMIN_NAME} pode interagir por áudio.`);
                  return;
                }
              }
              try { unlinkSync(wavPath); } catch {}

              const aiResult = await processWithAI(transcribedText, jid, isAdmin && isAuthenticated(jid));
              if (aiResult.text) await sendText(aiResult.text);
              for (const img of aiResult.images) { await sendMedia(img); try { unlinkSync(img); } catch {} }
            } catch (e) { await sendText(traduzirErroAPI(e.message)); }
          });
          return;
        }

        // ========== IMAGEM ==========
        if (hasImage && !config.analyzeImages) return;
        if (hasImage) {
          await enqueue(jid, async () => {
            await sendText(getProcessingMsg());
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              const base64 = buffer.toString('base64');
              const mimetype = msg.message.imageMessage.mimetype || 'image/jpeg';
              const caption = text || 'Descreva esta imagem em detalhes. Responda em português brasileiro.';

              const response = await openai.chat.completions.create({
                model: AI_MODEL_MINI, max_tokens: getBotConfig().maxTokens || 1024,
                messages: [
                  { role: 'system', content: `Assistente visual no WhatsApp do ${ADMIN_NAME}. Português brasileiro, conciso.` },
                  { role: 'user', content: [
                    { type: 'text', text: caption },
                    { type: 'image_url', image_url: { url: `data:${mimetype};base64,${base64}` } },
                  ] },
                ],
              });

              const analysis = response.choices[0].message.content;
              addToHistory(jid, 'user', `[Imagem${text ? ': ' + text : ''}]`);
              addToHistory(jid, 'assistant', analysis);
              await sendText(analysis);
            } catch (e) { await sendText(traduzirErroAPI(e.message)); }
          });
          return;
        }

        if (!text) return;

        // ========== MISSÃO AUTÔNOMA ==========
        try {
          const missaoResult = await processarRespostaMissao(phone, text);
          if (missaoResult) return;
        } catch {}

        // ========== COMANDOS ==========
        if (text.startsWith('/login')) {
          const pwd = text.slice(7).trim();
          if (!pwd) { await sendText('Use: /login <senha>'); return; }
          if (pwd === SENHA) {
            loginSession(jid);
            await sendText(`Bem-vindo ao ZAYA Bot, ${ADMIN_NAME}!\n\n/help para comandos`);
          } else { await sendText('Senha incorreta.'); }
          return;
        }
        if (text === '/logout') { logoutSession(jid); await sendText('Sessão encerrada.'); return; }
        if (text === '/ping') { await sendText('Pong! Online.'); return; }
        if (text === '/help') {
          await sendText(`*ZAYA Bot*\n\n/login <senha> — autenticar\n/logout — sair\n/ping — status\n/limpar — limpar histórico\n/help — esta mensagem\n\nConverse com IA, envie áudio, foto ou vídeo.`);
          return;
        }
        if (text === '/limpar') { delete chatHistories[jid]; saveHistory(); await sendText('Histórico limpo!'); return; }

        if (!isAuthenticated(jid)) { await sendText('Faça login primeiro: /login <senha>'); return; }

        // ========== IA ==========
        await enqueue(jid, async () => {
          await sendText(getProcessingMsg());
          const result = await processWithAI(text, jid, true);
          if (result.text) await sendText(result.text);
          for (const img of result.images) { await sendMedia(img); try { unlinkSync(img); } catch {} }
          if (result.files?.length > 0) {
            for (const filePath of result.files) {
              try { const { existsSync } = await import('fs'); if (existsSync(filePath)) await sendMedia(filePath); } catch {}
            }
          }
        });
      } catch (e) {
        log.wa.error({ err: e.message, from: msg.key?.remoteJid }, 'Erro no handler Baileys');
      }
    }
  });
}
