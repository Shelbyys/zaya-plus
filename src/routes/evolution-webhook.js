// ================================================================
// EVOLUTION API — Webhook handler
// Recebe eventos de mensagens, conexao, contatos
// ================================================================
import { Router } from 'express';
import { log } from '../logger.js';
import { contactsDB } from '../database.js';
import { syncContactToSupabase, saveToWaInbox } from '../services/supabase.js';
import { processWithAI, traduzirErroAPI } from '../services/ai.js';
import { isAuthenticated, loginSession } from '../services/messaging.js';
import { getChatHistory, addToHistory } from '../services/chat-history.js';
import { getBotConfig } from '../database.js';
import { ADMIN_NAME, SENHA } from '../config.js';
import { io } from '../state.js';
import * as evo from '../services/evolution-api.js';

const router = Router();

router.post('/', async (req, res) => {
  res.status(200).json({ received: true });

  const { event, instance, data } = req.body;
  if (!event || !data) return;

  const instName = instance || 'evolution';

  try {
    switch (event) {
      case 'CONNECTION_UPDATE':
        log.wa.info({ instance: instName, state: data.state }, 'Evolution: conexao');
        io?.emit('wa-status', { instance: instName, status: data.state === 'open' ? 'connected' : 'disconnected' });
        break;

      case 'QRCODE_UPDATED':
        log.wa.info({ instance: instName }, 'Evolution: QR atualizado');
        io?.emit('evo-qr', { instance: instName, base64: data.qrcode?.base64 || data.base64 });
        break;

      case 'CONTACTS_UPSERT':
      case 'CONTACTS_UPDATE': {
        const contacts = Array.isArray(data) ? data : [data];
        for (const c of contacts) {
          if (!c.id || c.id.includes('@g.us')) continue;
          const phone = c.id.split('@')[0];
          const nome = c.pushName || c.profileName || c.name || phone;
          contactsDB.upsert(nome, phone, c.id);
          syncContactToSupabase(nome, phone, c.id);
        }
        log.wa.info({ instance: instName, count: contacts.length }, 'Evolution: contatos sync');
        break;
      }

      case 'MESSAGES_UPSERT': {
        await handleMessage(instName, data);
        break;
      }
    }
  } catch (e) {
    log.wa.error({ err: e.message, event }, 'Evolution webhook error');
  }
});

// ================================================================
// MESSAGE HANDLER
// ================================================================
async function handleMessage(instName, msg) {
  if (!msg?.key) return;
  if (msg.key.fromMe) return;
  if (msg.key.remoteJid === 'status@broadcast') return;

  const config = getBotConfig();
  if (!config?.botActive) return;

  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  if (isGroup && !config.replyGroups) return;

  const phone = jid.split('@')[0];
  const pushName = msg.pushName || phone;

  // Sync contato
  contactsDB.upsert(pushName, phone, jid);
  syncContactToSupabase(pushName, phone, jid);

  // Extrair texto
  const text = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.imageMessage?.caption
    || msg.message?.videoMessage?.caption
    || '';

  const hasAudio = !!msg.message?.audioMessage;
  const hasImage = !!msg.message?.imageMessage;
  const hasVideo = !!msg.message?.videoMessage;
  const msgType = hasAudio ? 'audio' : hasImage ? 'image' : hasVideo ? 'video' : 'text';

  // Salva no Supabase
  saveToWaInbox(phone, pushName, text || '[' + msgType + ']', msgType, false, false);

  // Verifica admin
  const isAdmin = (config.adminNumbers || []).some(n => phone === n || phone.endsWith(n));

  // Notifica dashboard
  io?.emit('incoming-notification', {
    phone, pushName, text: text || '[' + msgType + ']', type: msgType,
    isAdmin, timestamp: new Date().toISOString(),
  });

  // Filtro de resposta
  if (config.replyMode === 'admin_only' && !isAdmin) {
    if (config.unauthorizedReply) await evo.sendText(instName, phone, config.unauthorizedReply);
    return;
  }

  // Auto-login admin
  if (isAdmin && config.autoLoginAdmin) loginSession(jid);

  if (!text) return;

  // Comandos
  if (text.startsWith('/login')) {
    const pwd = text.slice(7).trim();
    if (pwd === SENHA) {
      loginSession(jid);
      await evo.sendText(instName, phone, 'Bem-vindo ao ZAYA Bot, ' + ADMIN_NAME + '!\n\n/help para comandos');
    } else {
      await evo.sendText(instName, phone, 'Senha incorreta.');
    }
    return;
  }
  if (text === '/logout') { await evo.sendText(instName, phone, 'Sessao encerrada.'); return; }
  if (text === '/ping') { await evo.sendText(instName, phone, 'Pong! Online.'); return; }
  if (text === '/help') {
    await evo.sendText(instName, phone, '*ZAYA Bot*\n\n/login <senha> — autenticar\n/logout — sair\n/ping — status\n/help — comandos');
    return;
  }

  if (!isAuthenticated(jid)) {
    await evo.sendText(instName, phone, 'Faca login primeiro: /login <senha>');
    return;
  }

  // IA
  try {
    await evo.sendText(instName, phone, 'Processando...');
    const result = await processWithAI(text, jid, true);
    if (result.text) await evo.sendText(instName, phone, result.text);
    for (const img of (result.images || [])) {
      try { await evo.sendImage(instName, phone, img); } catch {}
    }
  } catch (e) {
    await evo.sendText(instName, phone, traduzirErroAPI(e.message));
  }
}

export default router;
