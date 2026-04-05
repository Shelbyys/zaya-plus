import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { extname } from 'path';
import { waConnections } from '../state.js';
import { waLoadConfig } from '../whatsapp/utils.js';
import { log } from '../logger.js';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;

// ================================================================
// WhatsApp utils
// ================================================================
export function normalizeJid(jid) {
  if (jid.endsWith('@c.us')) return jid.replace('@c.us', '@s.whatsapp.net');
  if (!jid.includes('@')) return jid + '@s.whatsapp.net';
  return jid;
}

export function normalizeBRPhone(phone) {
  let p = phone.replace(/\D/g, '');
  if (!p.startsWith('55') && p.length <= 11) {
    p = '55' + p;
  }
  // Celular BR: 55 + DDD(2) + 9 + número(8) = 13 dígitos
  // Se tem 12 dígitos (falta o 9) e DDD é válido (11-99), adiciona o 9
  if (p.startsWith('55') && p.length === 12) {
    const ddd = parseInt(p.slice(2, 4));
    if (ddd >= 11 && ddd <= 99) {
      p = p.slice(0, 4) + '9' + p.slice(4);
      log.wa.debug({ from: phone, to: p }, 'Número corrigido (adicionado 9)');
    }
  }
  return p;
}

export { waLoadConfig };

import * as wasender from './wasender.js';

// ================================================================
// WhatsApp Send (WaSenderAPI primeiro, fallback para wwebjs)
// ================================================================
export async function sendWhatsApp(phone, message) {
  const cleanPhone = normalizeBRPhone(phone);
  if (!cleanPhone || cleanPhone.length < 10) {
    return { success: false, output: `Numero invalido: ${phone}` };
  }

  // WaSenderAPI (preferencial — sem Chrome)
  if (wasender.isWaSenderEnabled()) {
    try {
      const r = await wasender.sendText(cleanPhone, message);
      if (r.success) {
        log.wa.info({ phone: cleanPhone }, 'WaSender enviado');
        return { success: true, output: `Mensagem enviada para ${phone}` };
      } else {
        log.wa.error({ error: r.error, phone: cleanPhone }, 'WaSender erro');
        return { success: false, output: `Erro WaSender: ${r.error}` };
      }
    } catch (e) {
      log.wa.error({ err: e.message }, 'WaSender erro');
      return { success: false, output: `Erro: ${e.message}` };
    }
  }

  // Fallback: whatsapp-web.js (local)
  const chatId = cleanPhone + '@c.us';
  const config = waLoadConfig();
  const name = config.defaultInstance;

  if (name && waConnections[name]?.status === 'connected' && waConnections[name]?.client) {
    try {
      await waConnections[name].client.sendMessage(chatId, message);
      log.wa.info({ chatId }, 'WA local enviado');
      return { success: true, output: `Mensagem enviada para ${phone}` };
    } catch (e) {
      log.wa.error({ err: e.message, chatId }, 'WA local erro');
      return { success: false, output: `Erro: ${e.message}` };
    }
  }

  return { success: false, output: 'Nenhuma instância WhatsApp conectada' };
}

export async function sendWhatsAppMedia(jid, filePath, caption) {
  const cleanPhone = jid.replace('@c.us', '').replace('@s.whatsapp.net', '');

  // WaSenderAPI (preferencial)
  if (wasender.isWaSenderEnabled()) {
    const result = await wasender.sendLocalFile(cleanPhone, filePath, caption);
    return result.success;
  }

  // Fallback: whatsapp-web.js
  const config = waLoadConfig();
  const name = config.defaultInstance;
  if (!name || !waConnections[name]?.client) return false;

  try {
    const chatId = jid.includes('@') ? jid : jid + '@c.us';
    const media = MessageMedia.fromFilePath(filePath);
    await waConnections[name].client.sendMessage(chatId, media, { caption: caption || '' });
    return true;
  } catch (e) {
    log.wa.error({ err: e.message }, 'Erro enviando mídia');
    return false;
  }
}

// ================================================================
// iMessage Send
// ================================================================
export function sendIMessage(phone, message) {
  const cleanPhone = phone.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    return { success: false, output: `Número inválido: ${phone}` };
  }
  const formattedPhone = cleanPhone.startsWith('+') ? cleanPhone : '+' + cleanPhone;

  try {
    const escapedMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${formattedPhone}" of targetService
  send "${escapedMsg}" to targetBuddy
end tell`;
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15000 });
    log.ai.info({ phone: formattedPhone }, 'iMessage enviado');
    return { success: true, output: `Mensagem enviada via iMessage para ${formattedPhone}` };
  } catch (e) {
    log.ai.error({ err: e.message }, 'iMessage erro');
    try {
      const encodedMsg = encodeURIComponent(message);
      execSync(`open "imessage://${formattedPhone}?body=${encodedMsg}"`, { timeout: 5000 });
      return { success: true, output: `iMessage aberto para ${formattedPhone} (via URI)` };
    } catch (e2) {
      return { success: false, output: `Erro ao enviar iMessage: ${e.message}` };
    }
  }
}

// ================================================================
// Sessions (WhatsApp bot login/logout)
// ================================================================
import { sessions } from '../state.js';
import { SESSION_TIMEOUT } from '../config.js';

export function isAuthenticated(jid) {
  const s = sessions[jid];
  if (!s) return false;
  if (Date.now() > s.expira) { delete sessions[jid]; return false; }
  return true;
}

const _sessionWarnings = {}; // { jid: timeoutId }

export function loginSession(jid) {
  sessions[jid] = { autenticado: true, expira: Date.now() + SESSION_TIMEOUT };

  // Cancela aviso anterior se existir
  if (_sessionWarnings[jid]) {
    clearTimeout(_sessionWarnings[jid]);
    delete _sessionWarnings[jid];
  }

  // Agenda aviso 5 min antes de expirar
  const warningMs = SESSION_TIMEOUT - (5 * 60 * 1000);
  if (warningMs > 0) {
    _sessionWarnings[jid] = setTimeout(async () => {
      // Verifica se ainda está autenticado
      if (sessions[jid] && Date.now() < sessions[jid].expira) {
        const phone = jid.replace('@c.us', '').replace('@s.whatsapp.net', '');
        try {
          const { sendText } = await import('./wasender.js');
          await sendText(phone, '⏳ *Aviso:* Sua sessão expira em *5 minutos*. Envie qualquer mensagem para renovar ou faça /login novamente.');
        } catch (e) {}
      }
      delete _sessionWarnings[jid];
    }, warningMs);
  }
}

export function logoutSession(jid) {
  if (_sessionWarnings[jid]) {
    clearTimeout(_sessionWarnings[jid]);
    delete _sessionWarnings[jid];
  }
  delete sessions[jid];
}
