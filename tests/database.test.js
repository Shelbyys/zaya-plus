import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync } from 'fs';

const DB_PATH = join(tmpdir(), `zaya-test-${Date.now()}.db`);
let db;

// Recria schema mínimo para testes (sem importar database.js que depende de config)
function setupTestDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_chat_jid ON chat_messages(jid);

    CREATE TABLE messages (
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

    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      telefone TEXT,
      jid TEXT
    );
    CREATE INDEX idx_contacts_nome ON contacts(nome COLLATE NOCASE);
  `);
}

beforeAll(() => setupTestDB());
afterAll(() => {
  db.close();
  try { unlinkSync(DB_PATH); } catch {}
  try { unlinkSync(DB_PATH + '-wal'); } catch {}
  try { unlinkSync(DB_PATH + '-shm'); } catch {}
});

describe('Chat Messages', () => {
  it('deve inserir e buscar mensagens de chat', () => {
    const insert = db.prepare('INSERT INTO chat_messages (jid, role, content) VALUES (?, ?, ?)');
    insert.run('5511999@s.whatsapp.net', 'user', 'Oi Zaya');
    insert.run('5511999@s.whatsapp.net', 'assistant', 'Oi! Tudo bem?');
    insert.run('5511888@s.whatsapp.net', 'user', 'Outro chat');

    const msgs = db.prepare('SELECT * FROM chat_messages WHERE jid = ? ORDER BY id').all('5511999@s.whatsapp.net');
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('Oi Zaya');
    expect(msgs[1].role).toBe('assistant');
  });

  it('deve listar JIDs únicos com contagem', () => {
    const chats = db.prepare(`
      SELECT jid, COUNT(*) as count FROM chat_messages GROUP BY jid
    `).all();
    expect(chats).toHaveLength(2);
    expect(chats.find(c => c.jid === '5511999@s.whatsapp.net').count).toBe(2);
  });

  it('deve deletar chat por JID', () => {
    db.prepare('DELETE FROM chat_messages WHERE jid = ?').run('5511888@s.whatsapp.net');
    const remaining = db.prepare('SELECT COUNT(*) as n FROM chat_messages').get();
    expect(remaining.n).toBe(2);
  });

  it('deve respeitar limite de mensagens (trim)', () => {
    const MAX = 5;
    const jid = 'trim-test@s.whatsapp.net';
    const insert = db.prepare('INSERT INTO chat_messages (jid, role, content) VALUES (?, ?, ?)');

    for (let i = 0; i < 10; i++) {
      insert.run(jid, 'user', `msg ${i}`);
    }

    // Trim: mantém apenas as últimas MAX
    db.prepare(`
      DELETE FROM chat_messages WHERE jid = ? AND id NOT IN (
        SELECT id FROM chat_messages WHERE jid = ? ORDER BY id DESC LIMIT ?
      )
    `).run(jid, jid, MAX);

    const msgs = db.prepare('SELECT content FROM chat_messages WHERE jid = ? ORDER BY id').all(jid);
    expect(msgs).toHaveLength(MAX);
    expect(msgs[0].content).toBe('msg 5'); // as primeiras 5 foram removidas
  });
});

describe('Messages (pesquisas/slides)', () => {
  it('deve inserir e buscar mensagens', () => {
    const insert = db.prepare(`
      INSERT INTO messages (id, title, content, type) VALUES (?, ?, ?, ?)
    `);
    insert.run('msg_001', 'Pesquisa: IA', 'Conteúdo sobre IA...', 'pesquisa');
    insert.run('msg_002', 'Slides: Marketing', 'Slides gerados', 'file');

    const all = db.prepare('SELECT * FROM messages ORDER BY created_at DESC').all();
    expect(all).toHaveLength(2);
  });

  it('deve deletar mensagem por ID', () => {
    db.prepare('DELETE FROM messages WHERE id = ?').run('msg_001');
    const remaining = db.prepare('SELECT COUNT(*) as n FROM messages').get();
    expect(remaining.n).toBe(1);
  });

  it('deve ignorar duplicatas (INSERT OR IGNORE)', () => {
    db.prepare('INSERT OR IGNORE INTO messages (id, title, content) VALUES (?, ?, ?)').run('msg_002', 'Dup', 'Dup');
    const count = db.prepare('SELECT COUNT(*) as n FROM messages').get();
    expect(count.n).toBe(1); // não duplicou
  });
});

describe('Contacts', () => {
  beforeAll(() => {
    const insert = db.prepare('INSERT INTO contacts (nome, telefone, jid) VALUES (?, ?, ?)');
    insert.run('Maria Silva', '5511999990001', '5511999990001@s.whatsapp.net');
    insert.run('João Santos', '5511999990002', '5511999990002@s.whatsapp.net');
    insert.run('Ana Maria Costa', '5511999990003', '5511999990003@s.whatsapp.net');
    insert.run('Carlos Eduardo', '5511999990004', '5511999990004@s.whatsapp.net');
  });

  it('deve listar todos os contatos', () => {
    const all = db.prepare('SELECT * FROM contacts ORDER BY nome').all();
    expect(all).toHaveLength(4);
    expect(all[0].nome).toBe('Ana Maria Costa');
  });

  it('deve buscar contatos por nome (case insensitive)', () => {
    const results = db.prepare('SELECT * FROM contacts WHERE nome LIKE ?').all('%maria%');
    expect(results).toHaveLength(2); // Maria Silva + Ana Maria Costa
  });

  it('deve buscar parcial', () => {
    const results = db.prepare('SELECT * FROM contacts WHERE nome LIKE ?').all('%carlos%');
    expect(results).toHaveLength(1);
    expect(results[0].telefone).toBe('5511999990004');
  });

  it('deve retornar vazio para busca sem resultado', () => {
    const results = db.prepare('SELECT * FROM contacts WHERE nome LIKE ?').all('%inexistente%');
    expect(results).toHaveLength(0);
  });
});
