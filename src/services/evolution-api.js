// ================================================================
// EVOLUTION API — Cliente para WhatsApp via Evolution API v2
// Mais estavel que Baileys, auto-reconexao, webhooks nativos
// ================================================================
import { log } from '../logger.js';

const EVOLUTION_URL = () => process.env.EVOLUTION_API_URL || '';
const EVOLUTION_KEY = () => process.env.EVOLUTION_API_KEY || '';

export function isEvolutionEnabled() {
  return !!(EVOLUTION_URL() && EVOLUTION_KEY());
}

async function evoFetch(path, method = 'GET', body = null) {
  const url = EVOLUTION_URL().replace(/\/$/, '') + path;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': EVOLUTION_KEY(),
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const r = await fetch(url, opts);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error('Evolution API ' + r.status + ': ' + text.slice(0, 200));
  }
  return r.json();
}

// ================================================================
// INSTANCIAS
// ================================================================

export async function createInstance(instanceName, webhookUrl) {
  return evoFetch('/instance/create', 'POST', {
    instanceName,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    rejectCall: true,
    alwaysOnline: true,
    readMessages: true,
    syncFullHistory: false,
    webhook: {
      url: webhookUrl,
      byEvents: true,
      base64: false,
      events: [
        'MESSAGES_UPSERT',
        'CONNECTION_UPDATE',
        'QRCODE_UPDATED',
        'CONTACTS_UPDATE',
        'CONTACTS_UPSERT',
      ],
    },
  });
}

export async function connectQR(instanceName) {
  return evoFetch('/instance/connect/' + instanceName);
}

export async function connectPairingCode(instanceName, phone) {
  return evoFetch('/instance/connect/' + instanceName + '?number=' + phone);
}

export async function getConnectionState(instanceName) {
  try {
    const data = await evoFetch('/instance/connectionState/' + instanceName);
    return data?.instance?.state || 'close';
  } catch {
    return 'close';
  }
}

export async function fetchInstances() {
  try {
    return await evoFetch('/instance/fetchInstances');
  } catch { return []; }
}

export async function restartInstance(instanceName) {
  return evoFetch('/instance/restart/' + instanceName, 'PUT');
}

export async function logoutInstance(instanceName) {
  return evoFetch('/instance/logout/' + instanceName, 'DELETE');
}

export async function deleteInstance(instanceName) {
  return evoFetch('/instance/delete/' + instanceName, 'DELETE');
}

// ================================================================
// MENSAGENS
// ================================================================

export async function sendText(instanceName, number, text) {
  const clean = number.replace(/\D/g, '');
  return evoFetch('/message/sendText/' + instanceName, 'POST', {
    number: clean,
    text,
    delay: 1200,
  });
}

export async function sendImage(instanceName, number, mediaUrl, caption = '') {
  return evoFetch('/message/sendMedia/' + instanceName, 'POST', {
    number: number.replace(/\D/g, ''),
    mediatype: 'image',
    mimetype: 'image/png',
    caption,
    media: mediaUrl,
  });
}

export async function sendVideo(instanceName, number, mediaUrl, caption = '') {
  return evoFetch('/message/sendMedia/' + instanceName, 'POST', {
    number: number.replace(/\D/g, ''),
    mediatype: 'video',
    mimetype: 'video/mp4',
    caption,
    media: mediaUrl,
  });
}

export async function sendAudio(instanceName, number, audioUrl) {
  return evoFetch('/message/sendWhatsAppAudio/' + instanceName, 'POST', {
    number: number.replace(/\D/g, ''),
    audio: audioUrl,
    delay: 1200,
  });
}

export async function sendDocument(instanceName, number, docUrl, fileName, caption = '') {
  return evoFetch('/message/sendMedia/' + instanceName, 'POST', {
    number: number.replace(/\D/g, ''),
    mediatype: 'document',
    mimetype: 'application/octet-stream',
    caption,
    media: docUrl,
    fileName,
  });
}

// ================================================================
// CONTATOS
// ================================================================

export async function getContacts(instanceName) {
  try {
    return await evoFetch('/chat/contacts/' + instanceName, 'POST', {});
  } catch { return []; }
}

export async function checkNumber(instanceName, phone) {
  try {
    const data = await evoFetch('/chat/whatsappNumbers/' + instanceName, 'POST', {
      numbers: [phone.replace(/\D/g, '')],
    });
    return data;
  } catch { return null; }
}

// ================================================================
// WEBHOOK
// ================================================================

export async function setWebhook(instanceName, url) {
  return evoFetch('/webhook/set/' + instanceName, 'POST', {
    url,
    webhook_by_events: true,
    webhook_base64: false,
    events: [
      'MESSAGES_UPSERT',
      'MESSAGES_UPDATE',
      'CONNECTION_UPDATE',
      'CONTACTS_UPDATE',
      'CONTACTS_UPSERT',
      'QRCODE_UPDATED',
    ],
  });
}
