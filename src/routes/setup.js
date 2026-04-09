import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { ROOT_DIR } from '../config.js';

const router = Router();
const ENV_PATH = path.join(ROOT_DIR, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT_DIR, '.env.example');

// ─── Helpers ────────────────────────────────────────────────

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  const obj = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    obj[key] = value;
  }
  return obj;
}

function writeEnv(obj) {
  // Preserve comments and structure from existing file
  if (!fs.existsSync(ENV_PATH)) {
    // No existing file — write flat key=value
    const content = Object.entries(obj)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';
    fs.writeFileSync(ENV_PATH, content, 'utf-8');
    return;
  }

  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  const remaining = { ...obj };
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(line);
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx === -1) {
      result.push(line);
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    if (key in remaining) {
      result.push(`${key}=${remaining[key]}`);
      delete remaining[key];
    } else {
      result.push(line);
    }
  }

  // Append any new keys not already in the file
  for (const [k, v] of Object.entries(remaining)) {
    result.push(`${k}=${v}`);
  }

  fs.writeFileSync(ENV_PATH, result.join('\n'), 'utf-8');
}

function updateEnv(updates) {
  const current = readEnv();
  const merged = { ...current, ...updates };
  writeEnv(merged);
  // Atualiza process.env em memória para efeito imediato
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && v !== null) process.env[k] = v;
  }
}

// ─── GET /status ────────────────────────────────────────────

function maskKey(val) {
  if (!val || val.length < 8) return val ? '***' : '';
  return val.slice(0, 4) + '...' + val.slice(-4);
}

router.get('/status', (req, res) => {
  try {
    const env = readEnv();
    const hasApiKey = !!(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY);
    const hasIdentity = !!env.ADMIN_NAME;
    const hasVoice = !!env.ELEVENLABS_API_KEY;
    const setupComplete = env.SETUP_COMPLETE === 'true';

    // Valores mascarados para edição no frontend
    const masked = {
      ai_provider: env.ANTHROPIC_API_KEY ? 'anthropic' : (env.OPENAI_BASE_URL?.includes('groq') ? 'groq' : 'openai'),
      ai_key: maskKey(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY),
      ai_baseUrl: env.OPENAI_BASE_URL || '',
      identity_name: env.ADMIN_NAME || '',
      identity_phone: env.ADMIN_NUMBER || '',
      elevenlabs_key: maskKey(env.ELEVENLABS_API_KEY),
      elevenlabs_voice: env.ELEVENLABS_VOICE_ID || '',
      twilio_sid: maskKey(env.TWILIO_ACCOUNT_SID),
      twilio_token: maskKey(env.TWILIO_AUTH_TOKEN),
      twilio_phone: env.TWILIO_PHONE_NUMBER || '',
      twilio_ngrok: env.TWILIO_NGROK_DOMAIN || '',
      meta_token: maskKey(env.FACEBOOK_ACCESS_TOKEN),
      meta_page: env.META_PAGE_ID || '',
      meta_ig: env.META_IG_ID || '',
      meta_ad: env.META_AD_ACCOUNT_ID || '',
      supabase_url: env.SUPABASE_URL || '',
      supabase_key: maskKey(env.SUPABASE_KEY),
      firecrawl_key: maskKey(env.FIRECRAWL_API_KEY),
      google_ai_key: maskKey(env.GOOGLE_AI_STUDIO_KEY),
      freepik_key: maskKey(env.FREEPIK_API_KEY),
    };

    res.json({
      setupComplete,
      masked,
      steps: {
        mind: hasApiKey,
        identity: hasIdentity,
        voice: hasVoice,
        modules: {
          whatsapp: !!(env.WASENDER_API_KEY || env.WHATSAPP_LOCAL === 'true' || true),
          twilio: !!env.TWILIO_ACCOUNT_SID,
          meta: !!env.FACEBOOK_ACCESS_TOKEN,
          supabase: !!env.SUPABASE_URL,
          firecrawl: !!env.FIRECRAWL_API_KEY,
          google_ai: !!env.GOOGLE_AI_STUDIO_KEY,
          freepik: !!env.FREEPIK_API_KEY,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /validate-key ─────────────────────────────────────

router.post('/validate-key', async (req, res) => {
  try {
    const { provider, key, baseUrl } = req.body;
    if (!provider || !key) {
      return res.status(400).json({ valid: false, error: 'provider and key are required' });
    }

    if (provider === 'openai' || provider === 'groq') {
      const url = baseUrl
        ? `${baseUrl.replace(/\/$/, '')}/chat/completions`
        : 'https://api.openai.com/v1/chat/completions';

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: provider === 'groq' ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return res.json({ valid: false, error: err.error?.message || `HTTP ${response.status}` });
      }

      const data = await response.json();
      return res.json({ valid: true, model: data.model });
    }

    if (provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return res.json({ valid: false, error: err.error?.message || `HTTP ${response.status}` });
      }

      const data = await response.json();
      return res.json({ valid: true, model: data.model });
    }

    return res.status(400).json({ valid: false, error: `Unknown provider: ${provider}` });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// ─── POST /save-mind ────────────────────────────────────────

router.post('/save-mind', (req, res) => {
  try {
    const { provider, key, baseUrl, model, modelMini } = req.body;
    if (!provider || !key) {
      return res.status(400).json({ error: 'provider and key are required' });
    }

    const updates = {};

    if (provider === 'anthropic') {
      updates.ANTHROPIC_API_KEY = key;
    } else if (provider === 'huggingface') {
      updates.OPENAI_API_KEY = key;
      updates.OPENAI_BASE_URL = 'https://router.huggingface.co/v1';
      updates.HUGGINGFACE_API_KEY = key;
      if (!model) updates.AI_MODEL = 'deepseek-ai/DeepSeek-V3-0324';
      if (!modelMini) updates.AI_MODEL_MINI = 'meta-llama/Llama-3.3-70B-Instruct';
    } else {
      updates.OPENAI_API_KEY = key;
      if (baseUrl) updates.OPENAI_BASE_URL = baseUrl;
    }

    if (model) updates.AI_MODEL = model;
    if (modelMini) updates.AI_MODEL_MINI = modelMini;

    updateEnv(updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /save-identity ────────────────────────────────────

router.post('/save-identity', async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const updates = { ADMIN_NAME: name, ZAYA_CALL_NAME: name };
    if (phone) updates.ADMIN_NUMBER = phone;
    updateEnv(updates);

    // Salvar callName no botConfig tambem
    try {
      const { getBotConfig, saveBotConfig } = await import('../database.js');
      const cfg = getBotConfig();
      cfg.callName = name;
      saveBotConfig(cfg);
    } catch {}

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /save-voice ───────────────────────────────────────

router.post('/save-voice', async (req, res) => {
  try {
    const { provider, key, voiceId } = req.body;

    if (provider === 'none') {
      updateEnv({ ELEVENLABS_API_KEY: '', ELEVENLABS_VOICE_ID: '' });
      return res.json({ success: true });
    }

    if (provider === 'elevenlabs') {
      if (!key) return res.status(400).json({ error: 'key is required for elevenlabs' });

      // Validate key
      const response = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': key },
      });

      if (!response.ok) {
        return res.status(400).json({ error: 'Invalid ElevenLabs API key' });
      }

      const data = await response.json();
      const voices = (data.voices || []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        preview_url: v.preview_url,
      }));

      updateEnv({
        ELEVENLABS_API_KEY: key,
        ELEVENLABS_VOICE_ID: voiceId || '',
      });

      return res.json({ success: true, voices });
    }

    res.status(400).json({ error: `Unknown voice provider: ${provider}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /validate-elevenlabs ──────────────────────────────

router.post('/validate-elevenlabs', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ valid: false, error: 'key is required' });

    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
    });

    if (!response.ok) {
      return res.json({ valid: false, voices: [], error: `HTTP ${response.status}` });
    }

    const data = await response.json();
    const voices = (data.voices || []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      preview_url: v.preview_url,
    }));

    res.json({ valid: true, voices });
  } catch (err) {
    res.status(500).json({ valid: false, voices: [], error: err.message });
  }
});

// ─── POST /save-module ──────────────────────────────────────

const MODULE_ENV_MAP = {
  personality: ['ZAYA_CALL_NAME', 'ZAYA_STYLE', 'ZAYA_ACCENT', 'ZAYA_USER_PROFESSION', 'ZAYA_USER_EXPECTATIONS'],
  voice: ['TTS_PROVIDER', 'OPENAI_TTS_VOICE', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'KOKORO_VOICE'],
  stt: ['STT_PROVIDER'],
  images: ['IMAGE_PROVIDER', 'HUGGINGFACE_API_KEY', 'HF_TOKEN'],
  whatsapp: ['WASENDER_API_KEY', 'WASENDER_BASE_URL'],
  twilio: ['VOICE_PROVIDER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'TWILIO_NGROK_DOMAIN', 'PLIVO_AUTH_ID', 'PLIVO_AUTH_TOKEN', 'PLIVO_PHONE_NUMBER', 'TELNYX_API_KEY', 'TELNYX_PHONE_NUMBER', 'TELNYX_CONNECTION_ID', 'VONAGE_API_KEY', 'VONAGE_API_SECRET', 'VONAGE_APPLICATION_ID', 'VONAGE_PHONE_NUMBER'],
  meta: ['FACEBOOK_ACCESS_TOKEN', 'META_PAGE_ID', 'META_IG_ID', 'META_AD_ACCOUNT_ID', 'IG_SESSION_ID'],
  supabase: ['SUPABASE_URL', 'SUPABASE_KEY'],
  evolution: ['EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE'],
  firecrawl: ['FIRECRAWL_API_KEY'],
  google_ai: ['GOOGLE_AI_STUDIO_KEY'],
  freepik: ['FREEPIK_API_KEY'],
};

router.post('/save-module', (req, res) => {
  try {
    const { module, config } = req.body;
    if (!module || !config) {
      return res.status(400).json({ error: 'module and config are required' });
    }

    const allowed = MODULE_ENV_MAP[module];
    if (!allowed) {
      return res.status(400).json({ error: `Unknown module: ${module}` });
    }

    const updates = {};
    for (const [key, value] of Object.entries(config)) {
      if (allowed.includes(key)) {
        updates[key] = value;
      }
    }

    updateEnv(updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /test-module ──────────────────────────────────────

router.post('/test-module', async (req, res) => {
  try {
    const { module, config } = req.body;
    if (!module || !config) {
      return res.status(400).json({ success: false, error: 'module and config are required' });
    }

    switch (module) {
      case 'whatsapp': {
        const baseUrl = (config.WASENDER_BASE_URL || 'https://www.wasenderapi.com/api').replace(/\/$/, '');
        const response = await fetch(`${baseUrl}/getGroups`, {
          headers: { Authorization: `Bearer ${config.WASENDER_API_KEY}` },
        });
        if (!response.ok) throw new Error(`WaSender API returned ${response.status}`);
        return res.json({ success: true });
      }

      case 'meta': {
        const response = await fetch(
          `https://graph.facebook.com/v19.0/me?access_token=${config.FACEBOOK_ACCESS_TOKEN}`
        );
        if (!response.ok) throw new Error(`Meta API returned ${response.status}`);
        return res.json({ success: true });
      }

      case 'twilio': {
        const auth = Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64');
        const response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}.json`,
          { headers: { Authorization: `Basic ${auth}` } }
        );
        if (!response.ok) throw new Error(`Twilio API returned ${response.status}`);
        return res.json({ success: true });
      }

      case 'supabase': {
        const response = await fetch(`${config.SUPABASE_URL}/rest/v1/`, {
          headers: {
            apikey: config.SUPABASE_KEY,
            Authorization: `Bearer ${config.SUPABASE_KEY}`,
          },
        });
        if (!response.ok) throw new Error(`Supabase API returned ${response.status}`);
        return res.json({ success: true });
      }

      case 'firecrawl': {
        const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.FIRECRAWL_API_KEY}`,
          },
          body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'], onlyMainContent: true }),
        });
        if (!response.ok) throw new Error(`Firecrawl API returned ${response.status}`);
        return res.json({ success: true });
      }

      case 'google_ai': {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${config.GOOGLE_AI_STUDIO_KEY}`
        );
        if (!response.ok) throw new Error(`Google AI API returned ${response.status}`);
        return res.json({ success: true });
      }

      case 'freepik': {
        const response = await fetch('https://api.freepik.com/v1/ai/text-to-image', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-freepik-api-key': config.FREEPIK_API_KEY,
          },
          body: JSON.stringify({ prompt: 'test', num_images: 1 }),
        });
        // 402 means key is valid but no credits — still a valid connection
        if (!response.ok && response.status !== 402) {
          throw new Error(`Freepik API returned ${response.status}`);
        }
        return res.json({ success: true });
      }

      case 'evolution': {
        const evoUrl = (config.EVOLUTION_API_URL || '').replace(/\/$/, '');
        const response = await fetch(evoUrl + '/instance/fetchInstances', {
          headers: { 'apikey': config.EVOLUTION_API_KEY },
        });
        if (!response.ok) throw new Error('Evolution API retornou ' + response.status);
        return res.json({ success: true });
      }

      case 'mind': {
        let testUrl, testHeaders;
        if (config.provider === 'anthropic') {
          testUrl = 'https://api.anthropic.com/v1/models';
          testHeaders = { 'x-api-key': config.key, 'anthropic-version': '2023-06-01' };
        } else {
          const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
          testUrl = baseUrl + '/models';
          testHeaders = { 'Authorization': 'Bearer ' + config.key };
        }
        const response = await fetch(testUrl, { headers: testHeaders });
        if (!response.ok) throw new Error('Chave invalida (status ' + response.status + ')');
        return res.json({ success: true });
      }

      default:
        return res.status(400).json({ success: false, error: `Unknown module: ${module}` });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── POST /create-tables (Supabase) ─────────────────────────

router.post('/create-tables', async (req, res) => {
  try {
    // Recarrega .env pra pegar SUPABASE_URL e SUPABASE_KEY recém-salvos
    try {
      const envPath = join(ROOT_DIR, '.env');
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) process.env[match[1].trim()] = match[2].trim();
      });
    } catch {}

    const { createSupabaseTables } = await import('../services/supabase.js');
    const result = await createSupabaseTables();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /complete ─────────────────────────────────────────

router.post('/complete', (req, res) => {
  try {
    updateEnv({ SETUP_COMPLETE: 'true' });

    // Recarregar .env no process.env para o servidor pegar as mudanças
    try {
      const envPath = join(ROOT_DIR, '.env');
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) process.env[match[1].trim()] = match[2].trim();
      });
    } catch(e) {}

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /env-template ──────────────────────────────────────

router.get('/env-template', (req, res) => {
  try {
    if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
      return res.status(404).json({ error: '.env.example not found' });
    }
    const content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /version ──────────────────────────────────────────

router.get('/version', async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    const cwd = ROOT_DIR;
    const commit = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();
    let tag = '';
    try { tag = execSync('git describe --tags --abbrev=0 HEAD 2>/dev/null', { cwd, encoding: 'utf-8' }).trim(); } catch {}
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    res.json({ version: tag || pkg.version, commit: commit.slice(0, 7), package: pkg.version });
  } catch (e) {
    res.json({ version: 'unknown', error: e.message });
  }
});

// ─── GET /changelog ────────────────────────────────────────

router.get('/changelog', async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    const cwd = ROOT_DIR;
    const limit = parseInt(req.query.limit) || 20;

    // Pega commits com tags
    const gitLog = execSync(`git log --oneline --no-decorate -${limit}`, { cwd, encoding: 'utf-8', timeout: 10000 }).trim();
    const commits = gitLog.split('\n').filter(Boolean).map(l => {
      const [hash, ...msg] = l.split(' ');
      return { hash: hash.slice(0, 7), msg: msg.join(' ') };
    });

    // Pega todas as tags com datas
    let tags = [];
    try {
      const tagLog = execSync('git tag -l --sort=-version:refname --format="%(refname:short)|%(creatordate:short)"', { cwd, encoding: 'utf-8', timeout: 10000 }).trim();
      tags = tagLog.split('\n').filter(Boolean).map(l => {
        const [name, date] = l.split('|');
        return { name, date };
      });
    } catch {}

    res.json({ commits, tags });
  } catch (e) {
    res.json({ commits: [], tags: [], error: e.message });
  }
});

// ─── GET /check-update ─────────────────────────────────────

let _lastNotifiedUpdate = '';

router.get('/check-update', async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    const cwd = ROOT_DIR;

    // Busca commits remotos sem baixar
    try { execSync('git fetch origin main --quiet', { cwd, timeout: 15000, stdio: 'pipe' }); } catch {}

    const local = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();
    const remote = execSync('git rev-parse origin/main', { cwd, encoding: 'utf-8' }).trim();

    if (local === remote) {
      return res.json({ hasUpdate: false, current: local.slice(0, 7) });
    }

    // Pega resumo dos commits novos
    let commits = [];
    try {
      const gitLog = execSync(`git log ${local}..${remote} --oneline --no-decorate -10`, { cwd, encoding: 'utf-8' }).trim();
      commits = gitLog.split('\n').filter(Boolean).map(l => {
        const [hash, ...msg] = l.split(' ');
        return { hash: hash.slice(0, 7), msg: msg.join(' ') };
      });
    } catch {}

    // Verifica se há tags (versionamento semântico)
    let latestTag = '';
    try {
      latestTag = execSync('git describe --tags --abbrev=0 origin/main 2>/dev/null', { cwd, encoding: 'utf-8' }).trim();
    } catch {}

    // Notifica TODOS os dashboards conectados via Socket.IO (uma vez por versão)
    if (remote !== _lastNotifiedUpdate && commits.length > 0) {
      _lastNotifiedUpdate = remote;
      try {
        const { io } = await import('../state.js');
        const resumo = commits.slice(0, 3).map(c => c.msg).join(', ');
        io?.emit('zaya-proactive', {
          text: `Nova atualizacao disponivel! ${commits.length} mudanca(s): ${resumo}. Clique em ATUALIZAR AGORA no topo da tela.`,
          tipo: 'update',
          timestamp: new Date().toISOString()
        });

        // Notifica admin via WhatsApp
        try {
          const { sendWhatsApp } = await import('../services/messaging.js');
          const { ADMIN_JID } = await import('../config.js');
          if (ADMIN_JID) {
            const msg = `*ZAYA PLUS — Atualizacao Disponivel*\n\n${latestTag ? `Versao: ${latestTag}\n` : ''}${commits.length} nova(s) mudanca(s):\n${commits.slice(0, 5).map(c => `• ${c.msg}`).join('\n')}\n\nAbra a Zaya e clique em ATUALIZAR AGORA, ou rode:\n\`cd ~/zaya-plus && git pull && npm start\``;
            await sendWhatsApp(ADMIN_JID, msg);
          }
        } catch {}
      } catch {}
    }

    res.json({
      hasUpdate: true,
      current: local.slice(0, 7),
      latest: remote.slice(0, 7),
      latestTag,
      commits,
      count: commits.length,
    });
  } catch (e) {
    res.json({ hasUpdate: false, error: e.message });
  }
});

// ─── Helpers: safe update + cross-platform restart ─────────

function backupCriticalFiles(cwd) {
  const backupDir = path.join(cwd, '.update-backup');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const filesToBackup = ['.env', '.license', '.machine-id', 'zaya.db', 'credentials.vault'];
  const backed = [];
  for (const f of filesToBackup) {
    const src = path.join(cwd, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(backupDir, f));
      backed.push(f);
    }
  }

  // Backup whatsapp sessions
  const waDir = path.join(cwd, 'whatsapp-sessions');
  const waBackup = path.join(backupDir, 'whatsapp-sessions');
  if (fs.existsSync(waDir)) {
    if (fs.existsSync(waBackup)) fs.rmSync(waBackup, { recursive: true });
    fs.cpSync(waDir, waBackup, { recursive: true });
    backed.push('whatsapp-sessions/');
  }

  return { backupDir, backed };
}

function restoreCriticalFiles(cwd) {
  const backupDir = path.join(cwd, '.update-backup');
  if (!fs.existsSync(backupDir)) return [];

  const restored = [];
  const files = ['.env', '.license', '.machine-id', 'zaya.db', 'credentials.vault'];
  for (const f of files) {
    const src = path.join(backupDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(cwd, f));
      restored.push(f);
    }
  }

  // Restore whatsapp sessions
  const waBackup = path.join(backupDir, 'whatsapp-sessions');
  const waDir = path.join(cwd, 'whatsapp-sessions');
  if (fs.existsSync(waBackup)) {
    fs.cpSync(waBackup, waDir, { recursive: true });
    restored.push('whatsapp-sessions/');
  }

  return restored;
}

async function crossPlatformRestart(cwd) {
  const isWin = process.platform === 'win32';
  const port = process.env.PORT || 3001;

  const { spawn } = await import('child_process');

  if (isWin) {
    // Windows: usa cmd para reiniciar
    const script = `ping -n 3 127.0.0.1 >nul && cd /d "${cwd}" && node server.js`;
    const child = spawn('cmd', ['/c', script], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  } else {
    // Unix: mata porta e reinicia
    const script = [
      'sleep 2',
      `lsof -ti:${port} 2>/dev/null | xargs kill 2>/dev/null || true`,
      'sleep 1',
      `cd "${cwd}" && node server.js`,
    ].join(' && ');
    const child = spawn('bash', ['-c', script], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  }

  setTimeout(() => process.exit(0), 500);
}

// ─── POST /update (safe) ──────────────────────────────────

router.post('/update', async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    const cwd = ROOT_DIR;

    // 1. Salva commit atual para rollback
    const currentCommit = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();
    const rollbackFile = path.join(cwd, '.update-rollback');
    fs.writeFileSync(rollbackFile, JSON.stringify({
      commit: currentCommit,
      date: new Date().toISOString(),
    }), 'utf-8');

    // 2. Backup de arquivos criticos
    const { backupDir, backed } = backupCriticalFiles(cwd);

    res.json({
      started: true,
      message: 'Atualizando com backup de seguranca...',
      backed,
      rollbackCommit: currentCommit.slice(0, 7),
    });

    setTimeout(async () => {
      try {
        // 3. Stash local changes (se houver)
        try { execSync('git stash --include-untracked', { cwd, timeout: 15000, stdio: 'pipe' }); } catch {}

        // 4. Pull das atualizações
        execSync('git fetch origin main', { cwd, timeout: 30000, stdio: 'pipe' });
        execSync('git reset --hard origin/main', { cwd, timeout: 15000, stdio: 'pipe' });

        // 5. Restaura arquivos criticos
        const restored = restoreCriticalFiles(cwd);
        console.log('Update: arquivos restaurados:', restored.join(', '));

        // 6. Instala dependencias
        execSync('npm install --production --silent', { cwd, timeout: 120000, stdio: 'pipe' });

        console.log('Update concluido! Reiniciando servidor...');

        // 7. Restart cross-platform
        await crossPlatformRestart(cwd);
      } catch (err) {
        console.error('Update falhou:', err.message);
        // Tenta rollback
        try {
          execSync(`git reset --hard ${currentCommit}`, { cwd, timeout: 15000, stdio: 'pipe' });
          restoreCriticalFiles(cwd);
          console.log('Rollback automatico realizado para', currentCommit.slice(0, 7));
        } catch (rbErr) {
          console.error('Rollback tambem falhou:', rbErr.message);
        }
      }
    }, 500);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /rollback ──────────────────────────────────────

router.post('/rollback', async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    const cwd = ROOT_DIR;
    const rollbackFile = path.join(cwd, '.update-rollback');

    if (!fs.existsSync(rollbackFile)) {
      return res.status(404).json({ error: 'Nenhum ponto de rollback encontrado. So funciona apos um update.' });
    }

    const rollbackData = JSON.parse(fs.readFileSync(rollbackFile, 'utf-8'));
    const targetCommit = rollbackData.commit;

    // Backup antes do rollback
    backupCriticalFiles(cwd);

    // Rollback
    execSync(`git reset --hard ${targetCommit}`, { cwd, timeout: 15000, stdio: 'pipe' });
    restoreCriticalFiles(cwd);
    execSync('npm install --production --silent', { cwd, timeout: 120000, stdio: 'pipe' });

    // Remove rollback file (não pode fazer rollback do rollback)
    fs.unlinkSync(rollbackFile);

    res.json({
      success: true,
      message: `Rollback para ${targetCommit.slice(0, 7)} (${rollbackData.date})`,
      commit: targetCommit.slice(0, 7),
    });

    // Restart
    setTimeout(async () => await crossPlatformRestart(cwd), 1000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


export default router;
