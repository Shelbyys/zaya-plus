// ================================================================
// WHATSAPP CLOUD API — Meta Business API (sem WaSender)
// Usa a Cloud API oficial do Meta para enviar/receber mensagens
// ================================================================
import { log } from '../logger.js';
import { readFileSync } from 'fs';
import { extname, basename } from 'path';

const WABA_ID = process.env.WHATSAPP_WABA_ID || '1506482697558392';
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '1111348328718461';
const WA_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const GRAPH = 'https://graph.facebook.com/v21.0';

export function isCloudAPIEnabled() {
  return !!(WA_TOKEN && PHONE_ID);
}

// ================================================================
// ENVIAR MENSAGEM DE TEXTO
// ================================================================
export async function sendTextMessage(to, text) {
  const phone = formatPhone(to);
  try {
    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: text },
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    log.wa.info({ to: phone, msgId: d.messages?.[0]?.id }, 'Cloud API: texto enviado');
    return { success: true, messageId: d.messages?.[0]?.id };
  } catch (e) {
    log.wa.error({ err: e.message, to: phone }, 'Cloud API: erro enviar texto');
    return { success: false, error: e.message };
  }
}

// ================================================================
// UPLOAD DE MÍDIA
// ================================================================
export async function uploadMedia(filePath) {
  const ext = extname(filePath).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf', '.doc': 'application/msword',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';

  try {
    const fileData = readFileSync(filePath);
    const blob = new Blob([fileData], { type: mimeType });
    const fd = new FormData();
    fd.append('file', blob, basename(filePath));
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', mimeType);

    const r = await fetch(`${GRAPH}/${PHONE_ID}/media`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
      body: fd,
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    log.wa.info({ mediaId: d.id, file: basename(filePath) }, 'Cloud API: mídia uploaded');
    return { success: true, mediaId: d.id };
  } catch (e) {
    log.wa.error({ err: e.message }, 'Cloud API: erro upload mídia');
    return { success: false, error: e.message };
  }
}

// ================================================================
// ENVIAR IMAGEM
// ================================================================
export async function sendImage(to, filePath, caption = '') {
  const phone = formatPhone(to);
  // Upload primeiro
  const upload = await uploadMedia(filePath);
  if (!upload.success) return upload;

  try {
    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'image',
        image: { id: upload.mediaId, caption: caption || undefined },
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    log.wa.info({ to: phone }, 'Cloud API: imagem enviada');
    return { success: true, messageId: d.messages?.[0]?.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// ENVIAR VÍDEO
// ================================================================
export async function sendVideo(to, filePath, caption = '') {
  const phone = formatPhone(to);
  const upload = await uploadMedia(filePath);
  if (!upload.success) return upload;

  try {
    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'video',
        video: { id: upload.mediaId, caption: caption || undefined },
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    log.wa.info({ to: phone }, 'Cloud API: vídeo enviado');
    return { success: true, messageId: d.messages?.[0]?.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// ENVIAR ÁUDIO
// ================================================================
export async function sendAudio(to, filePath) {
  const phone = formatPhone(to);
  const upload = await uploadMedia(filePath);
  if (!upload.success) return upload;

  try {
    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'audio',
        audio: { id: upload.mediaId },
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return { success: true, messageId: d.messages?.[0]?.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// ENVIAR DOCUMENTO
// ================================================================
export async function sendDocument(to, filePath, caption = '') {
  const phone = formatPhone(to);
  const upload = await uploadMedia(filePath);
  if (!upload.success) return upload;

  try {
    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'document',
        document: { id: upload.mediaId, filename: basename(filePath), caption: caption || undefined },
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return { success: true, messageId: d.messages?.[0]?.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// ENVIAR TEMPLATE (mensagens fora da janela de 24h)
// ================================================================
export async function sendTemplate(to, templateName, language = 'en_US', components = []) {
  const phone = formatPhone(to);
  try {
    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'template',
        template: { name: templateName, language: { code: language }, components },
      }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return { success: true, messageId: d.messages?.[0]?.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// ENVIAR MÍDIA (auto-detecta tipo)
// ================================================================
export async function sendMediaAuto(to, filePath, caption = '') {
  const ext = extname(filePath).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return sendImage(to, filePath, caption);
  if (['.mp4', '.mov'].includes(ext)) return sendVideo(to, filePath, caption);
  if (['.mp3', '.ogg', '.wav'].includes(ext)) return sendAudio(to, filePath);
  return sendDocument(to, filePath, caption);
}

// ================================================================
// MARCAR COMO LIDO
// ================================================================
export async function markAsRead(messageId) {
  try {
    await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    });
    return true;
  } catch { return false; }
}

// ================================================================
// HELPERS
// ================================================================
function formatPhone(phone) {
  let p = (phone || '').replace(/\D/g, '');
  if (p.startsWith('55') && p.length === 12) p = p.slice(0, 4) + '9' + p.slice(4);
  if (!p.startsWith('55') && p.length <= 11) p = '55' + p;
  return p;
}
