import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { extname } from 'path';
import { waConnections } from '../state.js';
import { waLoadConfig } from '../whatsapp/utils.js';
import { log } from '../logger.js';

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
  // DDDs válidos no Brasil: 11-19 (SP), 21-28 (RJ/ES), 31-38 (MG), 41-46 (PR),
  // 47-49 (SC), 51-55 (RS), 61-69 (Centro-Oeste/Norte), 71-79 (BA/SE), 81-89 (NE), 91-99 (Norte)
  const VALID_DDDS = new Set([
    11,12,13,14,15,16,17,18,19, 21,22,24,27,28,
    31,32,33,34,35,37,38, 41,42,43,44,45,46,
    47,48,49, 51,53,54,55, 61,62,63,64,65,66,67,68,69,
    71,73,74,75,77,79, 81,82,83,84,85,86,87,88,89,
    91,92,93,94,95,96,97,98,99
  ]);
  if (p.startsWith('55') && p.length === 12) {
    const ddd = parseInt(p.slice(2, 4));
    if (VALID_DDDS.has(ddd)) {
      p = p.slice(0, 4) + '9' + p.slice(4);
      log.wa.debug({ from: phone, to: p }, 'Número corrigido (adicionado 9)');
    }
  }
  return p;
}

export { waLoadConfig };

import * as wasender from './wasender.js';
import * as evo from './evolution-api.js';

// ================================================================
// WhatsApp Send (Evolution API > WaSenderAPI > Baileys)
// ================================================================
export async function sendWhatsApp(phone, message) {
  const cleanPhone = normalizeBRPhone(phone);
  if (!cleanPhone || cleanPhone.length < 10) {
    return { success: false, output: `Numero invalido: ${phone}` };
  }

  // Evolution API (preferencial — mais estavel)
  if (evo.isEvolutionEnabled()) {
    try {
      const instName = process.env.EVOLUTION_INSTANCE || 'principal';
      await evo.sendText(instName, cleanPhone, message);
      log.wa.info({ phone: cleanPhone }, 'Evolution API enviado');
      return { success: true, output: `Mensagem enviada para ${phone}` };
    } catch (e) {
      log.wa.error({ error: e.message, phone: cleanPhone }, 'Evolution API erro — tentando fallback');
      // Cai pro proximo provedor
    }
  }

  // WaSenderAPI
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

  // Fallback: Baileys (local)
  const jid = cleanPhone + '@s.whatsapp.net';
  const config = waLoadConfig();
  let name = config.defaultInstance;

  // Se não tem default, tenta a primeira instância conectada
  if (!name || !waConnections[name]?.client || waConnections[name]?.status !== 'connected') {
    const connected = Object.entries(waConnections).find(([, c]) => c.status === 'connected' && c.client);
    if (connected) {
      name = connected[0];
      log.wa.info({ instance: name }, 'Usando instância conectada (não-default)');
    }
  }

  if (name && waConnections[name]?.status === 'connected' && waConnections[name]?.client) {
    // Retry: tenta 3x com delay crescente
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await waConnections[name].client.sendMessage(jid, { text: message });
        log.wa.info({ jid, instance: name }, 'WA Baileys enviado');
        return { success: true, output: `Mensagem enviada para ${phone}` };
      } catch (e) {
        log.wa.error({ err: e.message, jid, instance: name, attempt }, 'WA Baileys erro');
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          // Se desconectou, tenta outra instancia
          if (waConnections[name]?.status !== 'connected') {
            const other = Object.entries(waConnections).find(([k, c]) => k !== name && c.status === 'connected' && c.client);
            if (other) { name = other[0]; log.wa.info({ instance: name }, 'Trocando para outra instancia'); }
          }
        } else {
          return { success: false, output: `Erro ao enviar apos 3 tentativas: ${e.message}` };
        }
      }
    }
  }

  log.wa.warn({ defaultInstance: config.defaultInstance, connections: Object.keys(waConnections) }, 'Nenhuma instância conectada');
  return { success: false, output: 'Nenhuma instância WhatsApp conectada. Conecte pelo painel WhatsApp primeiro.' };
}

export async function sendWhatsAppMedia(jid, filePath, caption) {
  const cleanPhone = jid.replace('@c.us', '').replace('@s.whatsapp.net', '');

  // WaSenderAPI (preferencial)
  if (wasender.isWaSenderEnabled()) {
    const result = await wasender.sendLocalFile(cleanPhone, filePath, caption);
    return result.success;
  }

  // Fallback: Baileys
  const config = waLoadConfig();
  const name = config.defaultInstance || Object.keys(waConnections).find(k => waConnections[k]?.status === 'connected');
  if (!name || !waConnections[name]?.client) return false;

  try {
    const { readFileSync } = await import('fs');
    const { extname } = await import('path');
    const buffer = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const chatJid = jid.includes('@') ? jid : jid + '@s.whatsapp.net';

    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
      await waConnections[name].client.sendMessage(chatJid, { image: buffer, caption: caption || '' });
    } else if (['.mp4', '.mov'].includes(ext)) {
      await waConnections[name].client.sendMessage(chatJid, { video: buffer, caption: caption || '' });
    } else {
      await waConnections[name].client.sendMessage(chatJid, { document: buffer, fileName: filePath.split('/').pop(), caption: caption || '' });
    }
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
