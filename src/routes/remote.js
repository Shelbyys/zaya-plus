import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { API_TOKEN } from '../state.js';
import { log } from '../logger.js';
import { executeRemoteCommandDirect } from '../services/remote.js';

const router = Router();

// ================================================================
// SUPABASE CLIENT
// ================================================================
let supabase = null;

function getSupabase() {
  if (!supabase && SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return supabase;
}

// ================================================================
// AUTH MIDDLEWARE (all remote routes require API_TOKEN)
// ================================================================
function requireToken(req, res, next) {
  // Localhost bypass (não em produção)
  const isProduction = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_HOSTNAME);
  if (!isProduction) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) return next();
  }
  // Aceita token via header, query, body ou cookie
  const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(c=>{const [k,...v]=c.trim().split('=');return [k,v.join('=')];}));
  const token = req.headers['x-api-token'] || req.query.token || req.body?.auth_token || cookies.api_token;
  if (token === API_TOKEN) return next();
  return res.status(401).json({ error: 'Token invalido' });
}

router.use(requireToken);

// ================================================================
// POST /command — Create a new remote command
// ================================================================
router.post('/command', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: 'Supabase nao configurado' });

  const { type, payload, timeout_ms } = req.body;
  if (!type) return res.status(400).json({ error: 'Campo "type" obrigatorio' });

  const validTypes = ['shell', 'screenshot', 'clipboard', 'open_app', 'open_url', 'file_read', 'file_list', 'notification', 'ai_task', 'heartbeat'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Tipo invalido. Validos: ${validTypes.join(', ')}` });
  }

  try {
    const commandPayload = { ...(payload || {}) };
    if (timeout_ms) commandPayload.timeout_ms = timeout_ms;

    const { data, error } = await sb.from('remote_commands').insert({
      type,
      payload: commandPayload,
      status: 'pending',
      auth_token: API_TOKEN,
    }).select('id, status, created_at').single();

    if (error) {
      log.db.error({ err: error.message }, 'Erro ao criar comando remoto');
      return res.status(500).json({ error: error.message });
    }

    log.db.info({ id: data.id, type }, 'Comando remoto criado');
    res.json({ id: data.id, status: data.status, created_at: data.created_at });
  } catch (e) {
    log.db.error({ err: e.message }, 'Erro ao criar comando remoto');
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// GET /command/:id — Check command status/result
// ================================================================
router.get('/command/:id', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: 'Supabase nao configurado' });

  try {
    const { data, error } = await sb
      .from('remote_commands')
      .select('id, type, status, result, payload, created_at, started_at, completed_at')
      .eq('id', req.params.id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Comando nao encontrado' });
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// GET /status — Check if local server is alive
// ================================================================
router.get('/status', async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: 'Supabase nao configurado' });

  try {
    const { data, error } = await sb
      .from('remote_commands')
      .select('created_at, result')
      .eq('type', 'heartbeat')
      .eq('status', 'done')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.json({ local_online: false, last_seen: null });
    }

    const lastSeen = new Date(data.created_at);
    const ageMs = Date.now() - lastSeen.getTime();
    // Consider online if heartbeat is less than 60s old
    const localOnline = ageMs < 60000;

    res.json({
      local_online: localOnline,
      last_seen: data.created_at,
      age_seconds: Math.round(ageMs / 1000),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// POST /quick — Create command + wait for result (up to 15s)
// ================================================================
router.post('/quick', async (req, res) => {
  const { type, payload, timeout_ms } = req.body;
  if (!type) return res.status(400).json({ error: 'Campo "type" obrigatorio' });

  const isLocal = !process.env.RENDER;

  // If running locally, execute directly (no Supabase roundtrip)
  if (isLocal) {
    try {
      const result = await executeRemoteCommandDirect(type, payload || {});
      return res.json({ id: 'local', type, status: 'done', result });
    } catch (e) {
      return res.status(500).json({ id: 'local', type, status: 'error', result: { error: e.message } });
    }
  }

  // On Render: create command in Supabase and poll for result
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: 'Supabase nao configurado' });

  try {
    const commandPayload = { ...(payload || {}) };
    if (timeout_ms) commandPayload.timeout_ms = timeout_ms;

    const { data: cmd, error: insertErr } = await sb.from('remote_commands').insert({
      type,
      payload: commandPayload,
      status: 'pending',
      auth_token: API_TOKEN,
    }).select('id').single();

    if (insertErr) return res.status(500).json({ error: insertErr.message });

    const cmdId = cmd.id;
    const maxWait = 15000;
    const pollMs = 500;
    const startTime = Date.now();

    // Poll for result
    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollMs));

      const { data: result, error: fetchErr } = await sb
        .from('remote_commands')
        .select('id, type, status, result, completed_at')
        .eq('id', cmdId)
        .single();

      if (fetchErr) continue;

      if (result.status === 'done' || result.status === 'error' || result.status === 'rejected') {
        return res.json(result);
      }
    }

    // Timeout — return pending
    res.json({ pending: true, id: cmdId, type, message: 'Comando ainda em execucao. Consulte GET /api/remote/command/' + cmdId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
