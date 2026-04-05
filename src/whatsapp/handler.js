import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { ADMIN_NAME, SENHA, TMP_DIR, FFMPEG, AI_MODEL_MINI } from '../config.js';
import { videoSessions, processingQueue } from '../state.js';
import { openai } from '../state.js';
import { isAuthenticated, loginSession, logoutSession, sendWhatsApp } from '../services/messaging.js';
import { chatHistories, saveHistory, addToHistory } from '../services/chat-history.js';
import { processWithAI } from '../services/ai.js';
import { editVideo, startVideoSession, processVideoAnswer, buildInstruction, whisperTranscribe } from '../services/media.js';
import { exec } from 'child_process';
import { log } from '../logger.js';
import { getBotConfig, contactsDB } from '../database.js';
import { processarRespostaMissao } from '../services/missions.js';
import { verifyVoice, getVoiceIdStatus } from '../services/voice-id.js';

const PROCESSING_MSGS = ['Processando...', 'Pensando...', 'Analisando...', 'Um momento...', 'Trabalhando...', 'Consultando IA...'];
let msgIdx = 0;
function getProcessingMsg() { return PROCESSING_MSGS[msgIdx++ % PROCESSING_MSGS.length]; }

// Limpeza periódica do processingQueue (a cada 30min, remove entradas > 1h)
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

export function setupMessageHandler(client, instanceName) {
  log.wa.info({ instance: instanceName }, 'Message handler registrado');

  client.on('message', async (msg) => {
    try {
      const config = getBotConfig();

      // Validação de config
      if (!config || !Array.isArray(config.adminNumbers)) {
        log.wa.error('Bot config inválida ou adminNumbers não é array');
        return;
      }

      // Bot desativado
      if (!config.botActive) return;

      // Ignora mensagens próprias, broadcast, status
      if (msg.fromMe) return;
      if (msg.from === 'status@broadcast') return;

      // Grupos
      const isGroup = msg.from.endsWith('@g.us');
      if (isGroup && !config.replyGroups) return;
      if (!msg.from.endsWith('@c.us') && !isGroup) return;

      const jid = msg.from;
      const phone = jid.replace('@c.us', '').replace('@g.us', '');

      // Sync incremental do contato + detectar primeiro contato
      let isNewContact = false;
      try {
        const existing = contactsDB.getByJid(jid);
        const contact = await msg.getContact();
        if (contact) {
          const nome = contact.name || contact.pushname || contact.shortName || phone;
          if (!existing) isNewContact = true;
          contactsDB.upsert(nome, phone, jid);
        }
      } catch {}

      // Verifica se é admin
      const isAdmin = config.adminNumbers.some(n => phone === n || phone.endsWith(n));

      // Alerta de números monitorados
      if (config.watchNumbers?.length > 0 && !isAdmin) {
        const watched = config.watchNumbers.find(w => w.notify && (phone === w.numero || phone.endsWith(w.numero)));
        if (watched) {
          const body = msg.body || (msg.hasMedia ? `[${msg.type}]` : '[mensagem]');
          const alertMsg = `🔔 *ALERTA MONITORAMENTO*\n\n👤 *${watched.nome || phone}*\n📱 ${phone}\n💬 ${body.substring(0, 500)}`;
          log.wa.info({ phone, watchName: watched.nome }, 'Watched number detected');
          for (const adminNum of config.adminNumbers) {
            sendWhatsApp(adminNum, alertMsg).catch(e => log.wa.error({ err: e.message }, 'Watch alert failed'));
          }
        }
      }

      // Filtragem por modo de resposta
      if (config.replyMode === 'admin_only' && !isAdmin) {
        if (config.unauthorizedReply) {
          await client.sendMessage(jid, config.unauthorizedReply);
        }
        return;
      }

      if (config.replyMode === 'whitelist' && !isAdmin) {
        const inWhitelist = (config.whitelist || []).some(n => phone === n || phone.endsWith(n));
        if (!inWhitelist) {
          if (config.unauthorizedReply) {
            await client.sendMessage(jid, config.unauthorizedReply);
          }
          return;
        }
      }

      // Mensagem de boas-vindas para novos contatos
      if (isNewContact && config.welcomeMessage) {
        try { await client.sendMessage(jid, config.welcomeMessage); } catch {}
      }

      // Read receipts
      if (config.readReceipts) {
        try { await msg.getChat().then(c => c.sendSeen()); } catch {}
      }

      log.wa.info({ phone, type: msg.type, isAdmin, hasMedia: msg.hasMedia }, 'Message received');

      const text = msg.body || '';
      const hasVideo = msg.type === 'video';
      const hasAudio = msg.type === 'audio' || msg.type === 'ptt';
      const hasImage = msg.type === 'image';

      const sendText = async (txt) => {
        try { await client.sendMessage(jid, txt); } catch (e) { log.wa.error({ err: e.message, jid }, 'Send error'); }
      };

      const sendMedia = async (filePath, caption) => {
        try {
          const pkg = await import('whatsapp-web.js');
          const media = pkg.MessageMedia.fromFilePath(filePath);
          await client.sendMessage(jid, media, { caption: caption || '' });
        } catch (e) { log.wa.error({ err: e.message }, 'Send media error'); }
      };

      // Auto-login para admins
      if (isAdmin && config.autoLoginAdmin && !isAuthenticated(jid)) {
        loginSession(jid);
      }

      // ========== VÍDEO ==========
      if (hasVideo) {
        if (!config.editVideos) { await sendText('Edição de vídeo desativada.'); return; }
        if (!isAuthenticated(jid)) { await sendText('Faça login primeiro: /login <senha>'); return; }
        try {
          const media = await msg.downloadMedia();
          const buffer = Buffer.from(media.data, 'base64');
          const mimetype = media.mimetype || 'video/mp4';

          if (text && text.trim().length > 5) {
            await sendText(`Edição iniciada: "${text}"\nIsso pode levar alguns minutos...`);
            const result = await editVideo(buffer, mimetype, text, async (s) => sendText(s));
            if (result?.path) {
              await sendMedia(result.path, 'Vídeo editado!');
              try { unlinkSync(result.path); } catch {}
            } else {
              await sendText(`Erro na edição: ${result?.message || 'desconhecido'}`);
            }
          } else {
            const q = startVideoSession(jid, buffer, mimetype);
            await sendText(q);
          }
        } catch (e) { await sendText(`Erro ao processar vídeo: ${e.message}`); }
        return;
      }

      // ========== Questionário de vídeo ==========
      if (videoSessions[jid] && text) {
        if (/^(cancelar|sair|parar)$/i.test(text.trim())) {
          delete videoSessions[jid];
          await sendText('Edição cancelada.');
          return;
        }
        const result = processVideoAnswer(jid, text.trim());
        if (!result) { delete videoSessions[jid]; return; }
        if (!result.done) { await sendText(result.question); return; }

        const session = videoSessions[jid];
        const instruction = buildInstruction(result.answers);
        delete videoSessions[jid];

        await sendText(`Editando: ${instruction}\nProcessando...`);
        await enqueue(jid, async () => {
          const editResult = await editVideo(session.videoBuffer, session.mimetype, instruction, async (s) => sendText(s));
          if (editResult?.path) {
            await sendMedia(editResult.path, 'Vídeo editado!');
            try { unlinkSync(editResult.path); } catch {}
          } else {
            await sendText(`Erro: ${editResult?.message || 'desconhecido'}`);
          }
        });
        return;
      }

      // ========== ÁUDIO ==========
      if (hasAudio && !config.transcribeAudio) return;
      if (hasAudio) {
        await enqueue(jid, async () => {
          await sendText(getProcessingMsg());
          try {
            const media = await msg.downloadMedia();
            const buffer = Buffer.from(media.data, 'base64');
            const rawPath = join(TMP_DIR, `audio_${Date.now()}.ogg`);
            writeFileSync(rawPath, buffer);
            const wavPath = rawPath.replace('.ogg', '.wav');
            await new Promise((resolve, reject) => {
              exec(`${FFMPEG} -y -i "${rawPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`, { timeout: 30000 }, (err) => err ? reject(err) : resolve());
            });
            try { unlinkSync(rawPath); } catch {}
            const transcription = await whisperTranscribe(wavPath, 'json');
            const transcribedText = transcription?.text || '';
            if (!transcribedText) { try { unlinkSync(wavPath); } catch {} await sendText('Não consegui transcrever o áudio. Tente novamente.'); return; }
            log.wa.info({ text: transcribedText.slice(0, 80) }, 'Áudio transcrito');

            // Voice ID: verifica SEMPRE (inclusive admin)
            const vidStatus = await getVoiceIdStatus();
            if (vidStatus.ready) {
              const vr = await verifyVoice(wavPath);
              if (!vr.verified) {
                log.wa.info({ confidence: vr.confidence }, 'Voice ID: voz não reconhecida');
                try { unlinkSync(wavPath); } catch {}
                await sendText(`🔒 Voz não reconhecida. Apenas o ${ADMIN_NAME} pode interagir por áudio.`);
                return;
              }
              log.wa.info({ confidence: vr.confidence }, 'Voice ID: voz reconhecida ✓');
            }
            try { unlinkSync(wavPath); } catch {}

            const aiResult = await processWithAI(transcribedText, jid, isAdmin && isAuthenticated(jid));
            if (aiResult.text) await sendText(aiResult.text);
            for (const img of aiResult.images) {
              await sendMedia(img, 'Imagem gerada por IA');
              try { unlinkSync(img); } catch {}
            }
            if (aiResult.files && aiResult.files.length > 0) {
              for (const filePath of aiResult.files) {
                try {
                  const { existsSync } = await import('fs');
                  if (existsSync(filePath)) await sendMedia(filePath, 'Arquivo gerado pela Zaya');
                } catch (e) { log.wa.warn({ err: e.message }, 'Erro ao enviar arquivo via audio'); }
              }
            }
          } catch (e) { await sendText(`Erro na transcrição: ${e.message}`); }
        });
        return;
      }

      // ========== IMAGEM ==========
      if (hasImage && !config.analyzeImages) return;
      if (hasImage) {
        await enqueue(jid, async () => {
          await sendText(getProcessingMsg());
          try {
            const media = await msg.downloadMedia();
            const base64 = media.data;
            const mimetype = media.mimetype || 'image/jpeg';
            const caption = text || 'Descreva esta imagem em detalhes. Responda em português brasileiro.';

            const response = await openai.chat.completions.create({
              model: AI_MODEL_MINI, max_tokens: 1024,
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
          } catch (e) { await sendText(`Erro ao analisar imagem: ${e.message}`); }
        });
        return;
      }

      if (!text) return;

      // ========== MISSÃO AUTÔNOMA (intercepta respostas de leads) ==========
      try {
        const missaoResult = await processarRespostaMissao(phone, text);
        if (missaoResult) {
          log.wa.info({ phone, etapa: missaoResult.etapa }, 'Missão: resposta processada');
          return; // Resposta já foi enviada pelo módulo de missões
        }
      } catch (e) { log.wa.warn({ err: e.message }, 'Missão check falhou'); }

      // ========== COMANDOS ==========
      if (text.startsWith('/login')) {
        const pwd = text.slice(7).trim();
        if (!pwd) { await sendText('Use: /login <senha>'); return; }
        if (pwd === SENHA) {
          loginSession(jid);
          await sendText(`Bem-vindo ao ZAYA Bot, ${ADMIN_NAME}!\n\nBot ativo com IA, Vision, DALL-E 3, Whisper, Video, Claude Code, Chrome.\n\n/help para comandos`);
        } else {
          await sendText('Senha incorreta.');
        }
        return;
      }
      if (text === '/logout') { logoutSession(jid); await sendText('Sessão encerrada.'); return; }
      if (text === '/ping') { await sendText('Pong! Online.'); return; }
      if (text === '/help') {
        await sendText(`*ZAYA Bot*\n\n*Comandos:*\n/login <senha> — autenticar\n/logout — sair\n/ping — status\n/limpar — limpar histórico\n/help — esta mensagem\n\n*Funcionalidades:*\nConverse com IA (GPT-4o + tools)\nEnvie áudio - transcrição + IA\nEnvie foto - análise Vision\nEnvie vídeo - edição com IA\nPesquisas via Claude Code\nGerar imagens DALL-E 3\nChrome com perfil logado\nCofre de credenciais`);
        return;
      }
      if (text === '/limpar') { delete chatHistories[jid]; saveHistory(); await sendText('Histórico limpo!'); return; }

      if (!isAuthenticated(jid)) { await sendText('Faça login primeiro: /login <senha>'); return; }

      // ========== IA ==========
      await enqueue(jid, async () => {
        await sendText(getProcessingMsg());
        const result = await processWithAI(text, jid, true);
        if (result.text) await sendText(result.text);
        for (const img of result.images) {
          await sendMedia(img, 'Imagem gerada por IA');
          try { unlinkSync(img); } catch {}
        }
        // Envia arquivos gerados (slides, PDFs, etc)
        if (result.files && result.files.length > 0) {
          for (const filePath of result.files) {
            try {
              const { existsSync } = await import('fs');
              if (existsSync(filePath)) {
                await sendMedia(filePath, 'Arquivo gerado pela Zaya');
              }
            } catch (e) { log.wa.warn({ err: e.message }, 'Erro ao enviar arquivo'); }
          }
        }
      });
    } catch (e) {
      log.wa.error({ err: e.message, from: msg.from }, 'Erro no handler');
    }
  });
}
