import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ROOT_DIR } from './config.js';
import { log } from './logger.js';

const DB_PATH = join(ROOT_DIR, 'zaya.db');

const db = new Database(DB_PATH);

// Performance: WAL mode + pragmas
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ================================================================
// SCHEMA
// ================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chat_jid ON chat_messages(jid);
  CREATE INDEX IF NOT EXISTS idx_chat_jid_id ON chat_messages(jid, id);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT,
    type TEXT DEFAULT 'pesquisa',
    file_path TEXT,
    file_name TEXT,
    download_url TEXT,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    telefone TEXT,
    jid TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_nome ON contacts(nome COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_jid ON contacts(jid);

  CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT DEFAULT 'conversation',
    importance INTEGER DEFAULT 5,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_memories_cat ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);

  CREATE TABLE IF NOT EXISTS chat_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_archive_jid ON chat_archive(jid);
  CREATE INDEX IF NOT EXISTS idx_archive_created ON chat_archive(created_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ================================================================
// MIGRAÇÃO DOS JSONs EXISTENTES
// ================================================================
function hasMigration(name) {
  return db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name);
}

function markMigration(name) {
  db.prepare('INSERT INTO migrations (name) VALUES (?)').run(name);
}

// Migrar chat-history.json
if (!hasMigration('chat_history_json')) {
  const historyFile = join(ROOT_DIR, 'chat-history.json');
  if (existsSync(historyFile)) {
    try {
      const data = JSON.parse(readFileSync(historyFile, 'utf-8'));
      const insert = db.prepare('INSERT INTO chat_messages (jid, role, content) VALUES (?, ?, ?)');
      const tx = db.transaction(() => {
        for (const [jid, msgs] of Object.entries(data)) {
          for (const msg of msgs) {
            insert.run(jid, msg.role, msg.content);
          }
        }
      });
      tx();
      log.db.info(`[DB] Migrado chat-history.json (${Object.keys(data).length} conversas)`);
    } catch (e) {
      log.db.error('[DB] Erro migrando chat-history:', e.message);
    }
  }
  markMigration('chat_history_json');
}

// Migrar messages.json
if (!hasMigration('messages_json')) {
  const msgsFile = join(ROOT_DIR, 'messages.json');
  if (existsSync(msgsFile)) {
    try {
      const data = JSON.parse(readFileSync(msgsFile, 'utf-8'));
      const insert = db.prepare(`
        INSERT OR IGNORE INTO messages (id, title, content, type, file_path, file_name, download_url, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction(() => {
        for (const msg of data) {
          const createdAt = msg.timestamp || (msg.date && msg.time
            ? parseDate(msg.date, msg.time)
            : new Date().toISOString());
          insert.run(
            msg.id, msg.title || '', msg.content || '',
            msg.type || 'pesquisa', msg.filePath || null, msg.fileName || null,
            msg.downloadUrl || null, msg.source || null, createdAt
          );
        }
      });
      tx();
      log.db.info(`[DB] Migrado messages.json (${data.length} mensagens)`);
    } catch (e) {
      log.db.error('[DB] Erro migrando messages:', e.message);
    }
  }
  markMigration('messages_json');
}

// Migrar contatos.json
if (!hasMigration('contacts_json')) {
  const contactsFile = join(ROOT_DIR, 'contatos.json');
  if (existsSync(contactsFile)) {
    try {
      const data = JSON.parse(readFileSync(contactsFile, 'utf-8'));
      const insert = db.prepare('INSERT INTO contacts (nome, telefone, jid) VALUES (?, ?, ?)');
      const tx = db.transaction(() => {
        for (const c of data) {
          insert.run(c.nome, c.telefone || '', c.jid || '');
        }
      });
      tx();
      log.db.info(`[DB] Migrado contatos.json (${data.length} contatos)`);
    } catch (e) {
      log.db.error('[DB] Erro migrando contatos:', e.message);
    }
  }
  markMigration('contacts_json');
}

function parseDate(dateStr, timeStr) {
  // "31/03/2026" + "15:54" → ISO
  try {
    const [d, m, y] = dateStr.split('/');
    return `${y}-${m}-${d}T${timeStr || '00:00'}:00.000Z`;
  } catch {
    return new Date().toISOString();
  }
}

// ================================================================
// CHAT HISTORY QUERIES
// ================================================================
const MAX_HISTORY = 50;

const stmts = {
  getChat: db.prepare('SELECT role, content FROM chat_messages WHERE jid = ? ORDER BY id DESC LIMIT ?'),
  addChat: db.prepare('INSERT INTO chat_messages (jid, role, content) VALUES (?, ?, ?)'),
  deleteChat: db.prepare('DELETE FROM chat_messages WHERE jid = ?'),
  listChats: db.prepare(`
    SELECT jid, COUNT(*) as count,
      (SELECT content FROM chat_messages c2 WHERE c2.jid = c1.jid ORDER BY c2.id DESC LIMIT 1) as lastMessage
    FROM chat_messages c1 GROUP BY jid
  `),
  countChat: db.prepare('SELECT COUNT(*) as n FROM chat_messages WHERE jid = ?'),
  trimChat: db.prepare(`
    DELETE FROM chat_messages WHERE jid = ? AND id NOT IN (
      SELECT id FROM chat_messages WHERE jid = ? ORDER BY id DESC LIMIT ?
    )
  `),

  // Messages
  getMessages: db.prepare('SELECT * FROM messages ORDER BY created_at DESC'),
  getMessagesLimit: db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  addMessage: db.prepare(`
    INSERT INTO messages (id, title, content, type, file_path, file_name, download_url, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),

  // Contacts
  getContacts: db.prepare('SELECT * FROM contacts ORDER BY nome'),
  searchContacts: db.prepare('SELECT * FROM contacts WHERE nome LIKE ? OR telefone LIKE ? ORDER BY nome'),
  upsertContact: db.prepare('INSERT INTO contacts (nome, telefone, jid) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET nome = excluded.nome, telefone = excluded.telefone'),
  getContactByJid: db.prepare('SELECT * FROM contacts WHERE jid = ?'),

  // Settings
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),

  // Memories
  getAllMemories: db.prepare('SELECT * FROM memories ORDER BY importance DESC, updated_at DESC'),
  getMemoriesByCat: db.prepare('SELECT * FROM memories WHERE category = ? ORDER BY importance DESC'),
  searchMemories: db.prepare('SELECT * FROM memories WHERE content LIKE ? ORDER BY importance DESC LIMIT 20'),
  addMemory: db.prepare('INSERT INTO memories (category, content, source, importance) VALUES (?, ?, ?, ?)'),
  updateMemory: db.prepare('UPDATE memories SET content = ?, updated_at = datetime(\'now\') WHERE id = ?'),
  deleteMemory: db.prepare('DELETE FROM memories WHERE id = ?'),
  countMemories: db.prepare('SELECT COUNT(*) as n FROM memories'),

  // Chat Archive (histórico completo, sem limite)
  addArchive: db.prepare('INSERT INTO chat_archive (jid, role, content) VALUES (?, ?, ?)'),
  getRecentArchive: db.prepare('SELECT role, content, created_at FROM chat_archive WHERE jid = ? ORDER BY id DESC LIMIT ?'),
  searchArchive: db.prepare('SELECT role, content, created_at FROM chat_archive WHERE content LIKE ? ORDER BY id DESC LIMIT 20'),
};

// ================================================================
// EXPORTED API
// ================================================================
export const chatDB = {
  getHistory(jid) {
    const rows = stmts.getChat.all(jid, MAX_HISTORY);
    return rows.reverse(); // oldest first
  },

  addMessage(jid, role, content) {
    stmts.addChat.run(jid, role, content);
    // Trim para manter max N mensagens por JID
    const { n } = stmts.countChat.get(jid);
    if (n > MAX_HISTORY) {
      stmts.trimChat.run(jid, jid, MAX_HISTORY);
    }
  },

  deleteChat(jid) {
    stmts.deleteChat.run(jid);
  },

  listChats() {
    return stmts.listChats.all().map(r => ({
      jid: r.jid,
      lastMessage: (r.lastMessage || '').slice(0, 100),
      count: r.count,
    }));
  },
};

export const messagesDB = {
  getAll() {
    return stmts.getMessages.all().map(formatMessage);
  },

  getPage(limit = 50, offset = 0) {
    return stmts.getMessagesLimit.all(limit, offset).map(formatMessage);
  },

  add(msg) {
    const createdAt = msg.timestamp || msg.created_at || new Date().toISOString();
    stmts.addMessage.run(
      msg.id, msg.title || '', msg.content || '',
      msg.type || 'pesquisa', msg.filePath || null, msg.fileName || null,
      msg.downloadUrl || null, msg.source || null, createdAt
    );
  },

  delete(id) {
    stmts.deleteMessage.run(id);
  },
};

export const contactsDB = {
  getAll() {
    return stmts.getContacts.all();
  },

  search(query) {
    const q = `%${query}%`;
    return stmts.searchContacts.all(q, q);
  },

  upsert(nome, telefone, jid) {
    if (!jid) return;
    stmts.upsertContact.run(nome, telefone, jid);
  },

  getByJid(jid) {
    return stmts.getContactByJid.get(jid);
  },

  syncFromWhatsApp(contacts) {
    let synced = 0, failed = 0;
    const tx = db.transaction((list) => {
      for (const c of list) {
        try {
          if (!c.id?.user) { failed++; continue; }
          const nome = c.name || c.pushname || c.shortName || c.id.user;
          const phone = c.id.user;
          const jid = c.id._serialized;
          stmts.upsertContact.run(nome, phone, jid);
          synced++;
        } catch { failed++; }
      }
    });
    tx(contacts);
    return { synced, failed };
  },
};

export const memoriesDB = {
  getAll() {
    return stmts.getAllMemories.all();
  },

  getByCategory(category) {
    return stmts.getMemoriesByCat.all(category);
  },

  search(query) {
    return stmts.searchMemories.all(`%${query}%`);
  },

  add(category, content, source = 'conversation', importance = 5) {
    return stmts.addMemory.run(category, content, source, importance);
  },

  update(id, content) {
    stmts.updateMemory.run(content, id);
  },

  delete(id) {
    stmts.deleteMemory.run(id);
  },

  count() {
    return stmts.countMemories.get().n;
  },

  // Retorna memórias formatadas para o system prompt
  getForPrompt() {
    const memories = stmts.getAllMemories.all();
    if (memories.length === 0) return '';

    const grouped = {};
    for (const m of memories) {
      if (!grouped[m.category]) grouped[m.category] = [];
      grouped[m.category].push(m.content);
    }

    let text = '\n=== MEMÓRIAS SOBRE O USUÁRIO ===\n';
    const labels = {
      personal: 'Dados Pessoais',
      preference: 'Preferências',
      work: 'Trabalho/Projetos',
      relationship: 'Pessoas/Relacionamentos',
      routine: 'Rotina/Hábitos',
      opinion: 'Opiniões/Gostos',
      goal: 'Objetivos/Metas',
      health: 'Saúde',
      finance: 'Finanças',
      other: 'Outros',
    };

    for (const [cat, items] of Object.entries(grouped)) {
      text += `\n${labels[cat] || cat}:\n`;
      for (const item of items) {
        text += `- ${item}\n`;
      }
    }

    text += '\nUse essas informações para ser mais pessoal e relevante. Nunca repita essas info pro usuário a não ser que ele pergunte.\n';
    return text;
  },
};

export const archiveDB = {
  add(jid, role, content) {
    stmts.addArchive.run(jid, role, content);
  },

  getRecent(jid, limit = 50) {
    return stmts.getRecentArchive.all(jid, limit).reverse();
  },

  search(query) {
    return stmts.searchArchive.all(`%${query}%`);
  },
};

export const settingsDB = {
  get(key, defaultValue = null) {
    const row = stmts.getSetting.get(key);
    return row ? row.value : defaultValue;
  },

  getJSON(key, defaultValue = null) {
    const row = stmts.getSetting.get(key);
    if (!row) return defaultValue;
    try { return JSON.parse(row.value); } catch { return defaultValue; }
  },

  set(key, value) {
    stmts.setSetting.run(key, String(value));
  },

  setJSON(key, value) {
    stmts.setSetting.run(key, JSON.stringify(value));
  },
};

// ================================================================
// BOT CONFIG (defaults)
// ================================================================
const DEFAULT_BOT_CONFIG = {
  // Quem pode usar o bot
  adminNumbers: ['5511936189388'],

  // Modo de resposta: 'admin_only' | 'whitelist' | 'everyone'
  replyMode: 'admin_only',

  // Lista de contatos que o bot responde (quando replyMode = 'whitelist')
  whitelist: [],

  // Bot ativo (responde mensagens)
  botActive: true,

  // Resposta automática para não-autorizados (vazio = ignora)
  unauthorizedReply: '',

  // Responder em grupos
  replyGroups: false,

  // Auto-login (pula /login para admins)
  autoLoginAdmin: true,

  // Mensagem de boas-vindas ao conectar
  welcomeMessage: '',

  // Nome do bot
  botName: 'ZAYA',

  // Modelo IA para WhatsApp
  aiModel: process.env.AI_MODEL || 'gpt-4o',

  // Max tokens na resposta
  maxTokens: 1024,

  // Ler recibos (marcar como lido)
  readReceipts: true,

  // Responder áudios com transcrição
  transcribeAudio: true,

  // Analisar imagens com Vision
  analyzeImages: true,

  // Editar vídeos
  editVideos: true,

  // Notificações: números que ao enviar mensagem, avisa o admin
  // { numero: '5511999...', nome: 'Fulano', notify: true }
  watchNumbers: [],

  // Como notificar: 'voice' (fala na Zaya), 'whatsapp' (manda pro admin), 'both'
  watchNotifyMode: 'both',

  // Personalidade / Identidade
  callName: '',
  style: 'amigavel',
  accent: 'neutro',
  userProfession: '',
  userExpectations: '',
};

export function getBotConfig() {
  try {
    const saved = settingsDB.getJSON('bot_config', null);
    return { ...DEFAULT_BOT_CONFIG, ...saved };
  } catch {
    return { ...DEFAULT_BOT_CONFIG };
  }
}

export function saveBotConfig(config) {
  settingsDB.setJSON('bot_config', config);
}

export function updateBotConfig(partial) {
  const current = getBotConfig();
  const updated = { ...current, ...partial };
  saveBotConfig(updated);
  return updated;
}

function formatMessage(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    type: row.type,
    filePath: row.file_path,
    fileName: row.file_name,
    downloadUrl: row.download_url,
    source: row.source,
    time: row.created_at ? new Date(row.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '',
    date: row.created_at ? new Date(row.created_at).toLocaleDateString('pt-BR') : '',
    timestamp: row.created_at,
  };
}

// Graceful shutdown
process.on('exit', () => db.close());

export default db;
