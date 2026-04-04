// ================================================================
// SCHEDULER — agendamentos e lembretes com ligação
// ================================================================
import { log } from '../logger.js';
import { makeCallWithZayaVoice, isTwilioEnabled } from './twilio.js';
import { sendText, isWaSenderEnabled } from './wasender.js';
import { io } from '../state.js';
import db from '../database.js';

// Cria tabela de agendamentos
db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    phone TEXT NOT NULL,
    notify_via TEXT DEFAULT 'call',
    schedule_at TEXT NOT NULL,
    repeat_rule TEXT,
    active INTEGER DEFAULT 1,
    executed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_schedules_at ON schedules(schedule_at);
`);

const stmts = {
  getPending: db.prepare(`SELECT * FROM schedules WHERE active = 1 AND executed = 0 AND schedule_at <= datetime('now') ORDER BY schedule_at`),
  getAll: db.prepare('SELECT * FROM schedules WHERE active = 1 ORDER BY schedule_at'),
  add: db.prepare('INSERT INTO schedules (title, message, phone, notify_via, schedule_at, repeat_rule) VALUES (?, ?, ?, ?, ?, ?)'),
  markDone: db.prepare('UPDATE schedules SET executed = 1 WHERE id = ?'),
  reschedule: db.prepare('UPDATE schedules SET schedule_at = ?, executed = 0 WHERE id = ?'),
  delete: db.prepare('DELETE FROM schedules WHERE id = ?'),
  deactivate: db.prepare('UPDATE schedules SET active = 0 WHERE id = ?'),
};

// ================================================================
// CRUD
// ================================================================
export function addSchedule(title, message, phone, notifyVia, scheduleAt, repeatRule = null) {
  const result = stmts.add.run(title, message, phone, notifyVia, scheduleAt, repeatRule);
  log.ai.info({ title, scheduleAt, notifyVia }, 'Agendamento criado');
  return result.lastInsertRowid;
}

export function listSchedules() {
  return stmts.getAll.all();
}

export function deleteSchedule(id) {
  stmts.delete.run(id);
}

export function deactivateSchedule(id) {
  stmts.deactivate.run(id);
}

// ================================================================
// EXECUTOR — roda a cada 30 segundos
// ================================================================
async function executePending() {
  const pending = stmts.getPending.all();
  if (pending.length === 0) return;

  for (const schedule of pending) {
    log.ai.info({ id: schedule.id, title: schedule.title }, 'Executando agendamento');

    try {
      // Notifica de acordo com o método escolhido
      switch (schedule.notify_via) {
        case 'call': {
          if (isTwilioEnabled()) {
            await makeCallWithZayaVoice(schedule.phone, schedule.message);
          } else {
            // Fallback: WhatsApp
            if (isWaSenderEnabled()) await sendText(schedule.phone, `🔔 *Lembrete:* ${schedule.message}`);
          }
          break;
        }
        case 'whatsapp': {
          if (isWaSenderEnabled()) await sendText(schedule.phone, `🔔 *Lembrete:* ${schedule.message}`);
          break;
        }
        case 'voice': {
          // Notifica via dashboard/voz
          io?.emit('incoming-notification', {
            type: 'reminder',
            title: schedule.title,
            text: schedule.message,
            phone: schedule.phone,
            timestamp: new Date().toISOString(),
          });
          break;
        }
        case 'all': {
          // Todos os métodos
          if (isTwilioEnabled()) await makeCallWithZayaVoice(schedule.phone, schedule.message);
          if (isWaSenderEnabled()) await sendText(schedule.phone, `🔔 *Lembrete:* ${schedule.message}`);
          io?.emit('incoming-notification', { type: 'reminder', title: schedule.title, text: schedule.message, phone: schedule.phone, timestamp: new Date().toISOString() });
          break;
        }
      }

      // Marca como executado
      stmts.markDone.run(schedule.id);

      // Se tem repetição, reagenda
      if (schedule.repeat_rule) {
        const nextDate = calculateNextDate(schedule.schedule_at, schedule.repeat_rule);
        if (nextDate) {
          stmts.reschedule.run(nextDate, schedule.id);
          log.ai.info({ id: schedule.id, next: nextDate }, 'Reagendado');
        }
      }
    } catch (e) {
      log.ai.error({ err: e.message, id: schedule.id }, 'Erro no agendamento');
    }
  }
}

function calculateNextDate(currentDate, rule) {
  const d = new Date(currentDate);
  switch (rule) {
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'hourly': d.setHours(d.getHours() + 1); break;
    default: return null;
  }
  // Manter horário local (não converter para UTC)
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ================================================================
// LEMBRETES DE EVENTOS DO CALENDÁRIO
// ================================================================
async function executeEventReminders() {
  try {
    const { calendarDB } = await import('./calendar.js');
    const config = (await import('../database.js')).getBotConfig();
    const pending = calendarDB.getPendingReminders();

    for (const event of pending) {
      const timeStr = event.all_day ? 'hoje' : event.start_at.slice(11, 16);
      const msg = `Lembrete: ${event.title} às ${timeStr}${event.location ? ' em ' + event.location : ''}`;

      log.ai.info({ id: event.id, title: event.title }, 'Lembrete de evento');

      const phone = config.adminNumbers?.[0] || '';

      switch (event.remind_via) {
        case 'call':
          if (isTwilioEnabled()) await makeCallWithZayaVoice(phone, msg);
          else if (isWaSenderEnabled()) await sendText(phone, `📅 *${msg}*`);
          break;
        case 'whatsapp':
          if (isWaSenderEnabled()) await sendText(phone, `📅 *${msg}*`);
          break;
        case 'voice':
          io?.emit('incoming-notification', { type: 'event_reminder', title: event.title, text: msg, timestamp: new Date().toISOString() });
          break;
        case 'all':
        default:
          if (isTwilioEnabled()) await makeCallWithZayaVoice(phone, msg);
          if (isWaSenderEnabled()) await sendText(phone, `📅 *${msg}*`);
          io?.emit('incoming-notification', { type: 'event_reminder', title: event.title, text: msg, timestamp: new Date().toISOString() });
          break;
      }

      calendarDB.markReminderSent(event.id);
    }
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro nos lembretes de eventos');
  }
}

// Inicia o loop
let schedulerInterval = null;
// ================================================================
// INSTAGRAM FOLLOWERS SCRAPE DIÁRIO
// ================================================================
// Horários de scrape: 8h, 11h, 14h, 17h, 20h
const IG_SCRAPE_HOURS = [8, 11, 14, 17, 20];
let igScrapesDoneToday = new Set();
let igScrapeCurrentDate = null;

async function scheduledIGScrape() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const hour = now.getHours();

  // Reset no novo dia
  if (igScrapeCurrentDate !== today) {
    igScrapeCurrentDate = today;
    igScrapesDoneToday = new Set();
  }

  // Verificar se está na hora de rodar
  const targetHour = IG_SCRAPE_HOURS.find(h => h === hour && !igScrapesDoneToday.has(h));
  if (!targetHour && targetHour !== 0) return;

  // Só roda nos primeiros 2 minutos da hora para não repetir
  if (now.getMinutes() > 2) return;

  try {
    const { scrapeIGFollowers } = await import('./ig-followers-scraper.js');
    igScrapesDoneToday.add(hour);
    log.ai.info({ hour }, 'Iniciando scrape agendado de seguidores IG');

    const igUser = process.env.META_IG_USERNAME || '';
    const igId = process.env.META_IG_ID || '';
    if (!igUser || !igId) { log.ai.info('IG scrape: META_IG_USERNAME ou META_IG_ID nao configurado'); return; }
    await scrapeIGFollowers(igUser, igId);

    log.ai.info({ hour, done: igScrapesDoneToday.size, total: IG_SCRAPE_HOURS.length }, 'Scrape agendado concluído');
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro no scrape agendado IG');
    igScrapesDoneToday.delete(hour); // Permite tentar novamente
  }
}

export function startScheduler() {
  if (schedulerInterval) return;
  schedulerInterval = setInterval(async () => {
    executePending();
    executeEventReminders();
    scheduledIGScrape();
    // Verificar se licença foi revogada/expirada
    try {
      const { periodicLicenseCheck } = await import('./license.js');
      periodicLicenseCheck();
    } catch(e) {}
  }, 30000);
  log.ai.info('Scheduler iniciado (30s interval)');
  executePending();
  executeEventReminders();
}
