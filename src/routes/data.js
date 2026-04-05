import { Router } from 'express';
import crypto from 'crypto';
import { chatDB, messagesDB, contactsDB, memoriesDB, getBotConfig, updateBotConfig } from '../database.js';
import { loadVault, saveVault } from '../services/vault.js';
import { syncAllToSupabase, getSupabaseStatus, isSupabaseEnabled } from '../services/supabase.js';
import { startScreenMonitor, stopScreenMonitor, gerarRelatorioTela, getMonitorStatus } from '../services/screen-monitor.js';
import { startMeeting, endMeeting, getMeetingStatus, addMeetingChunk, isMeetingActive } from '../services/meeting.js';
import { ADMIN_NAME, META_ACCESS_TOKEN } from '../config.js';

const router = Router();

// ================================================================
// PUBLIC CONFIG — retorna config publica para o frontend
// ================================================================
router.get('/public-config', (req, res) => {
  // Reler .env em tempo real para pegar valores salvos pelo setup
  let name = ADMIN_NAME;
  let metaToken = META_ACCESS_TOKEN;
  try {
    const { readFileSync } = require('fs');
    const { join } = require('path');
    const content = readFileSync(join(process.cwd(), '.env'), 'utf-8');
    content.split('\n').forEach(line => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m) {
        if (m[1].trim() === 'ADMIN_NAME' && m[2].trim()) name = m[2].trim();
        if (m[1].trim() === 'FACEBOOK_ACCESS_TOKEN' && m[2].trim()) metaToken = m[2].trim();
      }
    });
  } catch {}
  res.json({ adminName: name, metaAccessToken: metaToken });
});

// ================================================================
// SCREEN MONITOR
// ================================================================
router.post('/monitor/start', (req, res) => {
  const r = startScreenMonitor(req.body?.intervalo || 5);
  res.json(r);
});
router.post('/monitor/stop', (req, res) => {
  const r = stopScreenMonitor();
  res.json(r);
});
router.get('/monitor/status', (req, res) => {
  res.json(getMonitorStatus());
});

// MEETING
router.post('/meeting/start', (req, res) => { res.json(startMeeting(req.body?.titulo)); });
router.post('/meeting/end', async (req, res) => { res.json(await endMeeting()); });
router.get('/meeting/status', (req, res) => { res.json(getMeetingStatus()); });
router.get('/meeting/active', (req, res) => { res.json({ active: isMeetingActive() }); });
router.post('/meeting/chunk', async (req, res) => {
  const chunk = await addMeetingChunk(req.body?.text);
  res.json({ ok: !!chunk, chunk });
});
router.get('/monitor/relatorio', async (req, res) => {
  const r = await gerarRelatorioTela(req.query.periodo || 'hoje');
  res.json({ relatorio: r });
});

// ================================================================
// CONTACTS
// ================================================================
router.get('/contacts', (req, res) => {
  const q = (req.query.q || '').trim();
  res.json(q ? contactsDB.search(q) : contactsDB.getAll());
});

// ================================================================
// MESSAGES
// ================================================================
router.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  res.json(messagesDB.getPage(limit, offset));
});

router.post('/messages', (req, res) => {
  try {
    messagesDB.add(req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/messages/:id', (req, res) => {
  messagesDB.delete(req.params.id);
  res.json({ ok: true });
});

// ================================================================
// CHAT HISTORY
// ================================================================
router.get('/chats', (req, res) => {
  res.json(chatDB.listChats());
});

router.get('/chats/:jid', (req, res) => {
  res.json(chatDB.getHistory(req.params.jid));
});

router.delete('/chats/:jid', (req, res) => {
  chatDB.deleteChat(req.params.jid);
  res.json({ ok: true });
});

// ================================================================
// CREDENTIALS VAULT
// ================================================================
router.get('/credentials', (req, res) => {
  const creds = loadVault();
  res.json(creds.map(c => ({ ...c, password: c.password.slice(0, 2) + '***' })));
});

router.post('/credentials', (req, res) => {
  const creds = loadVault();
  creds.push({ id: crypto.randomUUID(), ...req.body, createdAt: new Date().toISOString() });
  saveVault(creds);
  res.json({ ok: true });
});

router.put('/credentials/:id', (req, res) => {
  const creds = loadVault();
  const idx = creds.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  creds[idx] = { ...creds[idx], ...req.body };
  saveVault(creds);
  res.json({ ok: true });
});

router.delete('/credentials/:id', (req, res) => {
  let creds = loadVault();
  creds = creds.filter(c => c.id !== req.params.id);
  saveVault(creds);
  res.json({ ok: true });
});

// ================================================================
// SUPABASE SYNC
// ================================================================
router.get('/supabase/status', async (req, res) => {
  const status = await getSupabaseStatus();
  res.json(status);
});

router.post('/supabase/sync', async (req, res) => {
  if (!isSupabaseEnabled()) return res.json({ error: 'Supabase não configurado. Defina SUPABASE_URL e SUPABASE_KEY no .env' });
  const result = await syncAllToSupabase();
  res.json(result);
});

// ================================================================
// BOT CONFIG
// ================================================================
router.get('/bot/config', (req, res) => {
  res.json(getBotConfig());
});

router.put('/bot/config', (req, res) => {
  const updated = updateBotConfig(req.body);
  res.json(updated);
});

// ================================================================
// MEMORIES
// ================================================================
router.get('/memories', (req, res) => {
  const q = req.query.q;
  res.json(q ? memoriesDB.search(q) : memoriesDB.getAll());
});

router.post('/memories', (req, res) => {
  const { category, content, importance } = req.body;
  if (!category || !content) return res.status(400).json({ error: 'category e content obrigatórios' });
  memoriesDB.add(category, content, 'manual', importance || 5);
  res.json({ ok: true, total: memoriesDB.count() });
});

router.delete('/memories/:id', (req, res) => {
  memoriesDB.delete(parseInt(req.params.id));
  res.json({ ok: true });
});

// ================================================================
// API BILLING / SALDOS
// ================================================================
router.get('/billing', async (req, res) => {
  const results = {};

  // ZAYA IA / OpenAI
  try {
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const isZaya = baseUrl.includes('zaya');
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.AI_MODEL || 'gpt-4o', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
    const label = isZaya ? 'zaya' : 'openai';
    if (r.ok) {
      const d = await r.json();
      const provider = d.provider || (isZaya ? 'groq' : 'openai');
      const model = d.model || 'gpt-4o';
      results[label] = { status: 'ok', detail: `${provider.toUpperCase()} — ${model}` };
    } else {
      const d = await r.json().catch(() => ({}));
      results[label] = { status: 'erro', detail: d.error?.message || `HTTP ${r.status}` };
    }
  } catch (e) { results[process.env.OPENAI_BASE_URL?.includes('zaya') ? 'zaya' : 'openai'] = { status: 'erro', detail: e.message }; }

  // Anthropic
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
    if (r.ok) results.anthropic = { status: 'ok', detail: 'Funcionando' };
    else {
      const d = await r.json();
      results.anthropic = { status: 'erro', detail: d.error?.message || `HTTP ${r.status}` };
    }
  } catch (e) { results.anthropic = { status: 'erro', detail: e.message }; }

  // ElevenLabs
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    });
    if (r.ok) {
      const d = await r.json();
      const sub = d.subscription || {};
      const used = sub.character_count || 0;
      const limit = sub.character_limit || 0;
      const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
      results.elevenlabs = { status: pct >= 95 ? 'baixo' : 'ok', detail: `${used.toLocaleString()} / ${limit.toLocaleString()} chars (${pct}%)`, used, limit, pct };
    } else {
      // Tenta verificar com uma chamada simples
      const r2 = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
      results.elevenlabs = r2.ok ? { status: 'ok', detail: 'Funcionando (saldo não disponível)' } : { status: 'erro', detail: `HTTP ${r.status}` };
    }
  } catch (e) { results.elevenlabs = { status: 'erro', detail: e.message }; }

  // Firecrawl
  try {
    // Testa com uma chamada simples
    const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'], onlyMainContent: true }),
    });
    if (r.ok || r.status === 402) {
      const d = await r.json().catch(() => ({}));
      if (r.status === 402) results.firecrawl = { status: 'baixo', detail: 'Sem créditos' };
      else results.firecrawl = { status: 'ok', detail: 'Funcionando' };
    } else {
      results.firecrawl = { status: 'erro', detail: `HTTP ${r.status}` };
    }
  } catch (e) { results.firecrawl = { status: 'erro', detail: e.message }; }

  // Supabase (sempre ok se conectado)
  try {
    const { getSupabase } = await import('../services/supabase.js');
    const sb = getSupabase();
    if (sb) {
      const { count } = await sb.from('activity_log').select('*', { count: 'exact', head: true });
      results.supabase = { status: 'ok', detail: `Conectado (${count || 0} logs)` };
    } else {
      results.supabase = { status: 'erro', detail: 'Não configurado' };
    }
  } catch (e) { results.supabase = { status: 'erro', detail: e.message }; }

  // Twilio
  if (process.env.TWILIO_ACCOUNT_SID) {
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Balance.json`, {
        headers: { 'Authorization': 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64') },
      });
      if (r.ok) {
        const d = await r.json();
        const bal = parseFloat(d.balance || 0).toFixed(2);
        results.twilio = { status: parseFloat(bal) < 1 ? 'baixo' : 'ok', detail: `$${bal} ${d.currency || 'USD'}`, balance: bal };
      } else { results.twilio = { status: 'erro', detail: `HTTP ${r.status}` }; }
    } catch (e) { results.twilio = { status: 'erro', detail: e.message }; }
  }

  // Google AI (Nano Banana + Veo 3)
  if (process.env.GOOGLE_AI_STUDIO_KEY) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_AI_STUDIO_KEY}`);
      if (r.ok) {
        const d = await r.json();
        const hasVeo = d.models?.some(m => m.name.includes('veo'));
        const hasNano = d.models?.some(m => m.name.includes('nano-banana') || m.name.includes('image'));
        results.google_ai = { status: 'ok', detail: `Conectado (${d.models?.length || 0} modelos${hasVeo ? ', Veo3' : ''}${hasNano ? ', NanoBanana' : ''})` };
      } else {
        const d = await r.json().catch(() => ({}));
        results.google_ai = { status: 'erro', detail: d.error?.message?.slice(0, 100) || `HTTP ${r.status}` };
      }
    } catch (e) { results.google_ai = { status: 'erro', detail: e.message }; }
  }

  res.json(results);
});

// ================================================================
// INSTAGRAM FOLLOWERS SCRAPER
// ================================================================
import { scrapeIGFollowers, scrapeAllProfiles, getFollowersHistory, getFollowersSummary } from '../services/ig-followers-scraper.js';

// Executar scrape de um perfil
router.post('/ig-followers/scrape', async (req, res) => {
  try {
    const { username, id } = req.body;
    if (!username) return res.status(400).json({ error: 'username obrigatório' });
    const result = await scrapeIGFollowers(username, id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Executar scrape de todos os perfis
router.post('/ig-followers/scrape-all', async (req, res) => {
  try {
    const { profiles } = req.body;
    if (!profiles?.length) return res.status(400).json({ error: 'profiles obrigatório' });
    const results = await scrapeAllProfiles(profiles);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Buscar histórico de um perfil
router.get('/ig-followers/history/:username', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await getFollowersHistory(req.params.username, days);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Buscar resumo de todos
router.get('/ig-followers/summary', async (req, res) => {
  try {
    const data = await getFollowersSummary();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
