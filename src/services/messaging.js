import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { extname } from 'path';
import { log } from '../logger.js';
import * as evo from './evolution-api.js';

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

import * as wasender from './wasender.js';

// ================================================================
// WhatsApp Send (Evolution API padrao > WaSender pago)
// ================================================================
export async function sendWhatsApp(phone, message) {
  const cleanPhone = normalizeBRPhone(phone);
  if (!cleanPhone || cleanPhone.length < 10) {
    return { success: false, output: `Numero invalido: ${phone}` };
  }

  const instName = process.env.EVOLUTION_INSTANCE || 'principal';

  // WaSenderAPI (pago)
  if (wasender.isWaSenderEnabled()) {
    try {
      const r = await wasender.sendText(cleanPhone, message);
      if (r.success) {
        log.wa.info({ phone: cleanPhone }, 'WaSender enviado');
        return { success: true, output: `Mensagem enviada para ${phone}` };
      }
      log.wa.error({ error: r.error, phone: cleanPhone }, 'WaSender erro — tentando Evolution');
    } catch (e) {
      log.wa.error({ err: e.message }, 'WaSender erro — tentando Evolution');
    }
  }

  // Evolution API (padrao gratis)
  if (evo.isEvolutionEnabled()) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await evo.sendText(instName, cleanPhone, message);
        log.wa.info({ phone: cleanPhone, instance: instName }, 'Evolution API enviado');
        return { success: true, output: `Mensagem enviada para ${phone}` };
      } catch (e) {
        log.wa.error({ err: e.message, phone: cleanPhone, attempt }, 'Evolution API erro');
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
        else return { success: false, output: `Erro ao enviar apos 3 tentativas: ${e.message}` };
      }
    }
  }

  return { success: false, output: 'WhatsApp nao configurado. Configure a Evolution API ou WaSender no Setup.' };
}

export async function sendWhatsAppMedia(jid, filePath, caption) {
  const cleanPhone = jid.replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
  const instName = process.env.EVOLUTION_INSTANCE || 'principal';

  // WaSenderAPI
  if (wasender.isWaSenderEnabled()) {
    try {
      const result = await wasender.sendLocalFile(cleanPhone, filePath, caption);
      return result.success;
    } catch {}
  }

  // Evolution API
  if (evo.isEvolutionEnabled()) {
    try {
      const ext = extname(filePath).toLowerCase();
      // Converte arquivo local pra base64 data URI
      const buffer = readFileSync(filePath);
      const base64 = buffer.toString('base64');
      const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.pdf': 'application/pdf' };
      const mime = mimeMap[ext] || 'application/octet-stream';
      const dataUri = 'data:' + mime + ';base64,' + base64;

      if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
        await evo.sendImage(instName, cleanPhone, dataUri, caption || '');
      } else if (['.mp4', '.mov'].includes(ext)) {
        await evo.sendVideo(instName, cleanPhone, dataUri, caption || '');
      } else if (['.mp3', '.ogg', '.wav', '.opus'].includes(ext)) {
        await evo.sendAudio(instName, cleanPhone, dataUri);
      } else {
        await evo.sendDocument(instName, cleanPhone, dataUri, filePath.split('/').pop(), caption || '');
      }
      return true;
    } catch (e) {
      log.wa.error({ err: e.message }, 'Evolution API media erro');
      return false;
    }
  }

  return false;
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
