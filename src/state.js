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

// AI client — Zaya IA (ou OpenAI fallback)
import OpenAI from 'openai';
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'sk-placeholder',
  ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
});
