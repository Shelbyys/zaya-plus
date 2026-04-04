// ================================================================
// CALENDÁRIO — agenda completa com eventos, compromissos, reuniões
// ================================================================
import db from '../database.js';
import { log } from '../logger.js';

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'geral',
    location TEXT DEFAULT '',
    start_at TEXT NOT NULL,
    end_at TEXT,
    all_day INTEGER DEFAULT 0,
    repeat_rule TEXT,
    remind_before INTEGER DEFAULT 30,
    remind_via TEXT DEFAULT 'all',
    color TEXT DEFAULT '#f36600',
    participants TEXT DEFAULT '',
    status TEXT DEFAULT 'confirmed',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
  CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
`);

// Tabela de lembretes já enviados
db.exec(`
  CREATE TABLE IF NOT EXISTS event_reminders_sent (
    event_id INTEGER PRIMARY KEY,
    sent_at TEXT DEFAULT (datetime('now'))
  );
`);

// Categorias com cores
export const CATEGORIES = {
  reuniao:      { label: 'Reunião', color: '#6c5ce7' },
  compromisso:  { label: 'Compromisso', color: '#f36600' },
  pessoal:      { label: 'Pessoal', color: '#25d366' },
  saude:        { label: 'Saúde', color: '#ff4757' },
  financeiro:   { label: 'Financeiro', color: '#ffc048' },
  trabalho:     { label: 'Trabalho', color: '#3B82F6' },
  estudo:       { label: 'Estudo', color: '#a78bfa' },
  lazer:        { label: 'Lazer', color: '#06B6D4' },
  viagem:       { label: 'Viagem', color: '#f472b6' },
  aniversario:  { label: 'Aniversário', color: '#fb923c' },
  lembrete:     { label: 'Lembrete', color: '#94a3b8' },
  geral:        { label: 'Geral', color: '#f36600' },
};

// Prepared statements
const stmts = {
  getAll: db.prepare('SELECT * FROM events WHERE status != ? ORDER BY start_at'),
  getById: db.prepare('SELECT * FROM events WHERE id = ?'),
  getByDate: db.prepare("SELECT * FROM events WHERE date(start_at) = ? AND status != 'cancelled' ORDER BY start_at"),
  getByRange: db.prepare("SELECT * FROM events WHERE start_at >= ? AND start_at <= ? AND status != 'cancelled' ORDER BY start_at"),
  getToday: db.prepare("SELECT * FROM events WHERE date(start_at) = date('now', 'localtime') AND status != 'cancelled' ORDER BY start_at"),
  getTomorrow: db.prepare("SELECT * FROM events WHERE date(start_at) = date('now', '+1 day', 'localtime') AND status != 'cancelled' ORDER BY start_at"),
  getWeek: db.prepare("SELECT * FROM events WHERE start_at >= date('now', 'localtime') AND start_at <= date('now', '+7 days', 'localtime') AND status != 'cancelled' ORDER BY start_at"),
  getUpcoming: db.prepare("SELECT * FROM events WHERE start_at >= datetime('now', 'localtime') AND status != 'cancelled' ORDER BY start_at LIMIT ?"),
  getPendingReminders: db.prepare(`
    SELECT * FROM events
    WHERE status = 'confirmed'
    AND remind_before > 0
    AND datetime(start_at, '-' || remind_before || ' minutes') <= datetime('now', 'localtime')
    AND start_at > datetime('now', 'localtime')
    AND id NOT IN (SELECT event_id FROM event_reminders_sent)
    ORDER BY start_at
  `),
  add: db.prepare(`
    INSERT INTO events (title, description, category, location, start_at, end_at, all_day, repeat_rule, remind_before, remind_via, color, participants, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  update: db.prepare(`
    UPDATE events SET title=?, description=?, category=?, location=?, start_at=?, end_at=?, all_day=?, repeat_rule=?, remind_before=?, remind_via=?, color=?, participants=?, status=?, updated_at=datetime('now')
    WHERE id=?
  `),
  delete: db.prepare('DELETE FROM events WHERE id = ?'),
  cancel: db.prepare("UPDATE events SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?"),
  search: db.prepare("SELECT * FROM events WHERE (title LIKE ? OR description LIKE ?) AND status != 'cancelled' ORDER BY start_at DESC LIMIT 20"),
};

const markReminderSent = db.prepare('INSERT OR IGNORE INTO event_reminders_sent (event_id) VALUES (?)');

// ================================================================
// API
// ================================================================
export const calendarDB = {
  // CRUD
  add(event) {
    const cat = event.category || 'geral';
    const color = event.color || CATEGORIES[cat]?.color || '#f36600';
    const result = stmts.add.run(
      event.title, event.description || '', cat,
      event.location || '', event.start_at, event.end_at || null,
      event.all_day ? 1 : 0, event.repeat_rule || null,
      event.remind_before ?? 30, event.remind_via || 'all',
      color, event.participants || '', event.status || 'confirmed'
    );
    log.ai.info({ id: result.lastInsertRowid, title: event.title, start: event.start_at }, 'Evento criado');
    return result.lastInsertRowid;
  },

  update(id, event) {
    const existing = stmts.getById.get(id);
    if (!existing) return false;
    const merged = { ...existing, ...event };
    stmts.update.run(
      merged.title, merged.description, merged.category,
      merged.location, merged.start_at, merged.end_at,
      merged.all_day ? 1 : 0, merged.repeat_rule,
      merged.remind_before, merged.remind_via,
      merged.color, merged.participants, merged.status, id
    );
    return true;
  },

  delete(id) { stmts.delete.run(id); },
  cancel(id) { stmts.cancel.run(id); },
  getById(id) { return stmts.getById.get(id); },

  // Queries
  getAll() { return stmts.getAll.all('cancelled'); },
  getByDate(date) { return stmts.getByDate.all(date); },
  getByRange(start, end) { return stmts.getByRange.all(start, end); },
  getToday() { return stmts.getToday.all(); },
  getTomorrow() { return stmts.getTomorrow.all(); },
  getWeek() { return stmts.getWeek.all(); },
  getUpcoming(limit = 10) { return stmts.getUpcoming.all(limit); },
  search(query) { return stmts.search.all(`%${query}%`, `%${query}%`); },

  // Lembretes pendentes
  getPendingReminders() { return stmts.getPendingReminders.all(); },
  markReminderSent(eventId) { markReminderSent.run(eventId); },

  // Categorias
  getCategories() { return CATEGORIES; },

  // Resumo do dia para o prompt
  getDaySummary() {
    const today = this.getToday();
    const tomorrow = this.getTomorrow();
    if (today.length === 0 && tomorrow.length === 0) return '';

    let summary = '\n=== AGENDA DE HOJE ===\n';
    if (today.length > 0) {
      for (const e of today) {
        const time = e.all_day ? 'dia inteiro' : e.start_at.slice(11, 16);
        summary += `- ${time}: ${e.title}${e.location ? ' (' + e.location + ')' : ''}${e.category !== 'geral' ? ' [' + (CATEGORIES[e.category]?.label || e.category) + ']' : ''}\n`;
      }
    } else {
      summary += '- Nenhum compromisso hoje\n';
    }

    if (tomorrow.length > 0) {
      summary += '\nAMANHÃ:\n';
      for (const e of tomorrow) {
        const time = e.all_day ? 'dia inteiro' : e.start_at.slice(11, 16);
        summary += `- ${time}: ${e.title}${e.location ? ' (' + e.location + ')' : ''}\n`;
      }
    }

    return summary;
  },
};
