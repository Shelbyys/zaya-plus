// ================================================================
// ALERTS SERVICE — Monitoramento de preços, moedas, crypto, clima
// ================================================================
import db from '../database.js';
import { log } from '../logger.js';
import { sendWhatsApp } from './messaging.js';
import { io } from '../state.js';
import { ADMIN_NUMBER } from '../config.js';

// ================================================================
// SCHEMA
// ================================================================
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'custom',
      target TEXT NOT NULL,
      condition TEXT NOT NULL DEFAULT 'above',
      threshold REAL,
      current_value REAL,
      phone TEXT,
      notify_via TEXT DEFAULT 'whatsapp',
      active INTEGER DEFAULT 1,
      triggered INTEGER DEFAULT 0,
      check_interval_min INTEGER DEFAULT 5,
      last_check TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
} catch {}

// ================================================================
// COORDENADAS para clima
// ================================================================
const WEATHER_LOCATIONS = {
  ubatuba:    { lat: -23.4336, lon: -45.0838, name: 'Ubatuba' },
  aracaju:    { lat: -10.9091, lon: -37.0677, name: 'Aracaju' },
  sao_paulo:  { lat: -23.5505, lon: -46.6333, name: 'São Paulo' },
  rio:        { lat: -22.9068, lon: -43.1729, name: 'Rio de Janeiro' },
  salvador:   { lat: -12.9714, lon: -38.5124, name: 'Salvador' },
  brasilia:   { lat: -15.7975, lon: -47.8919, name: 'Brasília' },
  curitiba:   { lat: -25.4284, lon: -49.2733, name: 'Curitiba' },
  florianopolis: { lat: -27.5954, lon: -48.5480, name: 'Florianópolis' },
  belo_horizonte: { lat: -19.9167, lon: -43.9345, name: 'Belo Horizonte' },
  recife:     { lat: -8.0476, lon: -34.8770, name: 'Recife' },
  fortaleza:  { lat: -3.7172, lon: -38.5433, name: 'Fortaleza' },
  manaus:     { lat: -3.1190, lon: -60.0217, name: 'Manaus' },
};

// ================================================================
// FETCH FUNCTIONS (APIs gratuitas — sem chave necessária)
// ================================================================
async function fetchCurrency(target) {
  try {
    const pair = target.toUpperCase() === 'EUR' ? 'EUR-BRL' : 'USD-BRL';
    const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${pair}`);
    const data = await res.json();
    return parseFloat(data[pair.replace('-', '')]?.bid) || null;
  } catch { return null; }
}

async function fetchCrypto(target) {
  try {
    const id = target.toLowerCase();
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=brl`);
    const data = await res.json();
    return data[id]?.brl || null;
  } catch { return null; }
}

async function fetchStock(target) {
  try {
    const res = await fetch(`https://brapi.dev/api/quote/${target.toUpperCase()}?token=demo`);
    const data = await res.json();
    return data.results?.[0]?.regularMarketPrice || null;
  } catch { return null; }
}

async function fetchWeather(target) {
  try {
    const key = target.toLowerCase().replace(/clima[_ ]?|tempo[_ ]?/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_');
    const loc = WEATHER_LOCATIONS[key] || WEATHER_LOCATIONS.sao_paulo;
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,rain,weathercode`);
    const data = await res.json();
    return data.current?.temperature_2m || null;
  } catch { return null; }
}

async function resolveValue(alert) {
  switch (alert.type) {
    case 'moeda': return fetchCurrency(alert.target);
    case 'crypto': return fetchCrypto(alert.target);
    case 'acao': return fetchStock(alert.target);
    case 'clima': return fetchWeather(alert.target);
    default: {
      const t = alert.target.toLowerCase();
      if (['usd', 'eur', 'dolar', 'dólar', 'euro'].includes(t)) return fetchCurrency(t);
      if (['bitcoin', 'ethereum', 'btc', 'eth'].includes(t)) return fetchCrypto(t === 'btc' ? 'bitcoin' : t === 'eth' ? 'ethereum' : t);
      if (t.match(/^[a-z]{4}\d{1,2}$/i)) return fetchStock(t);
      return null;
    }
  }
}

function checkCondition(condition, value, threshold) {
  if (value === null || value === undefined) return false;
  switch (condition) {
    case 'above': case 'acima': return value >= threshold;
    case 'below': case 'abaixo': return value <= threshold;
    case 'equals': case 'igual': return Math.abs(value - threshold) < (threshold * 0.005);
    default: return false;
  }
}

async function notifyAlert(alert, value) {
  const condMap = { above: 'acima de', acima: 'acima de', below: 'abaixo de', abaixo: 'abaixo de', equals: 'igual a', igual: 'igual a' };
  const msg = `🚨 ALERTA: ${alert.title}\n${alert.target} está ${condMap[alert.condition] || alert.condition} ${alert.threshold}!\nValor atual: ${typeof value === 'number' ? value.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : value}`;

  io?.emit('zaya-proactive', { text: msg, tipo: 'alerta', alertId: alert.id });

  try {
    const phone = alert.phone || ADMIN_NUMBER;
    if (alert.notify_via === 'whatsapp' || alert.notify_via === 'all') {
      await sendWhatsApp(phone, msg);
    }
  } catch {}
}

// ================================================================
// CRUD
// ================================================================
export function createAlert({ title, type = 'custom', target, condition = 'above', threshold, phone, notify_via = 'whatsapp', check_interval_min = 5 }) {
  if (!title || !target) throw new Error('title e target são obrigatórios');

  // Auto-detect type
  const t = target.toLowerCase();
  if (type === 'custom') {
    if (['usd', 'eur', 'dolar', 'dólar', 'euro'].includes(t)) type = 'moeda';
    else if (['bitcoin', 'ethereum', 'btc', 'eth'].includes(t)) type = 'crypto';
    else if (t.match(/^[a-z]{4}\d{1,2}$/i)) type = 'acao';
    else if (t.includes('clima') || t.includes('tempo') || WEATHER_LOCATIONS[t]) type = 'clima';
  }

  const stmt = db.prepare('INSERT INTO alerts (title, type, target, condition, threshold, phone, notify_via, check_interval_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const result = stmt.run(title, type, target, condition, threshold, phone || ADMIN_NUMBER, notify_via, check_interval_min);
  log.ai.info({ id: result.lastInsertRowid, title, target }, 'Alerta criado');
  return { id: result.lastInsertRowid, title, type, target, condition, threshold };
}

export function listAlerts(activeOnly = true) {
  return db.prepare(`SELECT * FROM alerts ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY created_at DESC`).all();
}

export function deleteAlert(id) {
  const r = db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
  return r.changes > 0 ? { id, deleted: true } : null;
}

export function resetAlert(id) {
  db.prepare('UPDATE alerts SET triggered = 0, active = 1, current_value = NULL WHERE id = ?').run(id);
  return { id, reset: true };
}

export async function checkAlertNow(id) {
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  if (!alert) return null;
  const value = await resolveValue(alert);
  if (value !== null && typeof value === 'number') {
    db.prepare('UPDATE alerts SET current_value = ?, last_check = datetime("now") WHERE id = ?').run(value, id);
  }
  return { ...alert, current_value: value, would_trigger: checkCondition(alert.condition, value, alert.threshold) };
}

// ================================================================
// MONITOR LOOP
// ================================================================
const activeTimers = new Map();

async function checkAlert(alert) {
  try {
    const value = await resolveValue(alert);
    if (value === null) return;
    const num = typeof value === 'number' ? value : parseFloat(value);
    if (!isNaN(num)) db.prepare('UPDATE alerts SET current_value = ?, last_check = datetime("now") WHERE id = ?').run(num, alert.id);
    if (checkCondition(alert.condition, num, alert.threshold)) {
      db.prepare('UPDATE alerts SET triggered = 1, active = 0 WHERE id = ?').run(alert.id);
      await notifyAlert(alert, num);
      const timer = activeTimers.get(alert.id);
      if (timer) { clearInterval(timer); activeTimers.delete(alert.id); }
    }
  } catch {}
}

export function startAlertMonitor() {
  for (const [, timer] of activeTimers) clearInterval(timer);
  activeTimers.clear();

  const alerts = listAlerts(true);
  if (alerts.length === 0) return;
  log.ai.info({ count: alerts.length }, 'Monitor de alertas iniciado');

  for (const alert of alerts) {
    if (alert.triggered) continue;
    checkAlert(alert);
    const timer = setInterval(() => {
      const fresh = db.prepare('SELECT * FROM alerts WHERE id = ? AND active = 1 AND triggered = 0').get(alert.id);
      if (!fresh) { clearInterval(timer); activeTimers.delete(alert.id); return; }
      checkAlert(fresh);
    }, (alert.check_interval_min || 5) * 60 * 1000);
    activeTimers.set(alert.id, timer);
  }
}

// Detecta novos alertas a cada 60s
setInterval(() => {
  const alerts = listAlerts(true);
  for (const alert of alerts) {
    if (alert.triggered || activeTimers.has(alert.id)) continue;
    checkAlert(alert);
    const timer = setInterval(() => {
      const fresh = db.prepare('SELECT * FROM alerts WHERE id = ? AND active = 1 AND triggered = 0').get(alert.id);
      if (!fresh) { clearInterval(timer); activeTimers.delete(alert.id); return; }
      checkAlert(fresh);
    }, (alert.check_interval_min || 5) * 60 * 1000);
    activeTimers.set(alert.id, timer);
  }
}, 60000);

export default { createAlert, listAlerts, deleteAlert, resetAlert, checkAlertNow, startAlertMonitor };
