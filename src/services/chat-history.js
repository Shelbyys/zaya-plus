import { chatDB } from '../database.js';
import { log } from '../logger.js';
import { syncChatMessage } from './supabase.js';

// Compatibilidade: chatHistories como proxy que lê do SQLite
export const chatHistories = new Proxy({}, {
  get(_, jid) {
    if (typeof jid === 'symbol') return undefined;
    return chatDB.getHistory(jid);
  },
  set(_, jid, value) {
    // Usado apenas pelo handler para limpar: delete chatHistories[jid]
    return true;
  },
  deleteProperty(_, jid) {
    chatDB.deleteChat(jid);
    return true;
  },
  ownKeys() {
    return chatDB.listChats().map(c => c.jid);
  },
  has(_, jid) {
    return chatDB.getHistory(jid).length > 0;
  },
  getOwnPropertyDescriptor(_, jid) {
    return { configurable: true, enumerable: true, value: chatDB.getHistory(jid) };
  },
});

export function getChatHistory(jid) {
  return chatDB.getHistory(jid);
}

export function addToHistory(jid, role, content) {
  chatDB.addMessage(jid, role, content);
  syncChatMessage(jid, role, content); // async, não bloqueia
}

export function saveHistory() {
  // No-op: SQLite persiste automaticamente
}

export function loadHistory() {
  const chats = chatDB.listChats();
  log.db.info({ count: chats.length }, 'Histórico SQLite carregado');
}
