import crypto from 'crypto';

// Socket.IO instance (set during startup)
export let io = null;
export function setIO(socketIO) { io = socketIO; }

// API Token
export const API_TOKEN = process.env.API_TOKEN || crypto.randomBytes(32).toString('hex');

// WhatsApp connections (whatsapp-web.js clients)
export const waConnections = {};

// Voice conversation history (dashboard/voz)
export const conversationHistory = [];

// WhatsApp sessions (login/logout do bot)
export const sessions = {};

// Video editing sessions
export const videoSessions = {};

// Message processing queue (per JID)
export const processingQueue = {};

// Mac location (updated periodically)
export const macLocation = { city: 'desconhecida', region: '', country: 'BR', loc: '', timezone: '' };

// AI client — Zaya IA (recria automaticamente quando a chave muda)
import OpenAI from 'openai';
let _openai = null;
let _lastKey = '';
let _lastUrl = '';

export function getOpenAI() {
  const key = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || 'sk-placeholder';
  const url = process.env.OPENAI_BASE_URL || '';
  if (!_openai || key !== _lastKey || url !== _lastUrl) {
    _openai = new OpenAI({
      apiKey: key,
      ...(url ? { baseURL: url } : {}),
    });
    _lastKey = key;
    _lastUrl = url;
  }
  return _openai;
}

// Compatibilidade: export openai como getter
export const openai = new Proxy({}, {
  get(_, prop) { return getOpenAI()[prop]; }
});
