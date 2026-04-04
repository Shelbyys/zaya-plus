// ================================================================
// WaSenderAPI — integração WhatsApp via API REST
// Docs: https://wasenderapi.com/docs
// Sem Chrome, sem Puppeteer, sem QR local — tudo na nuvem
// ================================================================
import { log } from '../logger.js';

const BASE_URL = process.env.WASENDER_BASE_URL || 'https://www.wasenderapi.com/api';
const SESSION_KEY = process.env.WASENDER_API_KEY || '';
const PAT = process.env.WASENDER_PAT || '';

function headers(token = SESSION_KEY) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function apiCall(endpoint, method = 'GET', body = null, token = SESSION_KEY) {
  const opts = { method, headers: headers(token) };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${endpoint}`, opts);
  const data = await res.json();

  // Rate limit 429 — espera 6s e tenta de novo (1x)
  if (res.status === 429) {
    log.wa.warn({ endpoint }, 'WaSender rate limit — aguardando 6s...');
    await new Promise(r => setTimeout(r, 6000));
    const res2 = await fetch(`${BASE_URL}${endpoint}`, opts);
    const data2 = await res2.json();
    if (!res2.ok || data2.success === false) {
      const msg2 = data2.message || data2.errors || `HTTP ${res2.status}`;
      log.wa.error({ endpoint, status: res2.status, error: msg2 }, 'WaSender API error (retry)');
      return { success: false, error: msg2 };
    }
    return { success: true, data: data2.data || data2 };
  }

  if (!res.ok || data.success === false) {
    const msg = data.message || data.errors || `HTTP ${res.status}`;
    log.wa.error({ endpoint, status: res.status, error: msg }, 'WaSender API error');
    return { success: false, error: msg };
  }

  return { success: true, data: data.data || data };
}

// ================================================================
// ENVIO DE MENSAGENS
// ================================================================

// Enviar texto
export async function sendText(to, text) {
  return apiCall('/send-message', 'POST', { to, text });
}

// Enviar imagem (URL pública)
export async function sendImage(to, imageUrl, caption = '') {
  return apiCall('/send-message', 'POST', { to, imageUrl, text: caption || undefined });
}

// Enviar vídeo (URL pública)
export async function sendVideo(to, videoUrl, caption = '') {
  return apiCall('/send-message', 'POST', { to, videoUrl, text: caption || undefined });
}

// Enviar áudio/voz (URL pública)
export async function sendAudio(to, audioUrl) {
  return apiCall('/send-message', 'POST', { to, audioUrl });
}

// Enviar documento (URL pública)
export async function sendDocument(to, documentUrl, fileName = '', caption = '') {
  return apiCall('/send-message', 'POST', {
    to, documentUrl,
    fileName: fileName || undefined,
    text: caption || undefined,
  });
}

// Upload de mídia (base64 → URL pública temporária 24h)
export async function uploadMedia(base64Data, mimetype) {
  return apiCall('/upload', 'POST', { base64: base64Data, mimetype });
}

// Enviar arquivo local (base64) como imagem/vídeo/doc
export async function sendLocalFile(to, filePath, caption = '') {
  const { readFileSync } = await import('fs');
  const { extname } = await import('path');

  const buffer = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  const mimetype = mimeMap[ext] || 'application/octet-stream';
  const base64 = `data:${mimetype};base64,${buffer.toString('base64')}`;

  // Upload primeiro
  const upload = await uploadMedia(base64, mimetype);
  if (!upload.success) return upload;

  const url = upload.data.publicUrl;
  const isImage = mimetype.startsWith('image/');
  const isVideo = mimetype.startsWith('video/');
  const isAudio = mimetype.startsWith('audio/');

  if (isImage) return sendImage(to, url, caption);
  if (isVideo) return sendVideo(to, url, caption);
  if (isAudio) return sendAudio(to, url);
  return sendDocument(to, url, filePath.split('/').pop(), caption);
}

// ================================================================
// DECRYPT MEDIA — baixa mídia criptografada do WhatsApp
// ================================================================
export async function decryptMedia(rawMessage) {
  // rawMessage = raw_payload.data.messages (o objeto da mensagem inteira)
  const body = {
    data: {
      messages: rawMessage,
    },
  };
  return apiCall('/decrypt-media', 'POST', body);
}

// ================================================================
// STATUS DA SESSÃO
// ================================================================
export async function getSessionStatus() {
  return apiCall('/status');
}

// ================================================================
// GERENCIAMENTO DE SESSÕES (usa PAT)
// ================================================================
export async function listSessions() {
  return apiCall('/whatsapp-sessions', 'GET', null, PAT);
}

export async function getSession(id) {
  return apiCall(`/whatsapp-sessions/${id}`, 'GET', null, PAT);
}

export async function getQRCode(id) {
  return apiCall(`/whatsapp-sessions/${id}/qrcode`, 'GET', null, PAT);
}

export async function connectSession(id) {
  return apiCall(`/whatsapp-sessions/${id}/connect`, 'POST', null, PAT);
}

export async function disconnectSession(id) {
  return apiCall(`/whatsapp-sessions/${id}/disconnect`, 'POST', null, PAT);
}

export async function restartSession(id) {
  return apiCall(`/whatsapp-sessions/${id}/restart`, 'POST', null, PAT);
}

// ================================================================
// VERIFICAÇÃO
// ================================================================
export function isWaSenderEnabled() {
  return !!(SESSION_KEY);
}

export function isWaSenderPATEnabled() {
  return !!(PAT);
}
