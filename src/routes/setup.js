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
}

// ─── GET /status ────────────────────────────────────────────

router.get('/status', (req, res) => {
  try {
    const env = readEnv();
    const hasApiKey = !!(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY);
    const hasIdentity = !!env.ADMIN_NAME;
    const hasVoice = !!env.ELEVENLABS_API_KEY;
    const setupComplete = env.SETUP_COMPLETE === 'true';

    res.json({
      setupComplete,
      steps: {
        mind: hasApiKey,
        identity: hasIdentity,
        voice: hasVoice,
        modules: {
          whatsapp: !!env.WASENDER_API_KEY,
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

router.post('/save-identity', (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'name and phone are required' });
    }

    updateEnv({ ADMIN_NAME: name, ADMIN_NUMBER: phone });
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
  whatsapp: ['WASENDER_API_KEY', 'WASENDER_BASE_URL'],
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'TWILIO_NGROK_DOMAIN'],
  meta: ['FACEBOOK_ACCESS_TOKEN', 'META_PAGE_ID', 'META_IG_ID', 'META_AD_ACCOUNT_ID', 'IG_SESSION_ID'],
  supabase: ['SUPABASE_URL', 'SUPABASE_KEY'],
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

      default:
        return res.status(400).json({ success: false, error: `Unknown module: ${module}` });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── POST /complete ─────────────────────────────────────────

router.post('/complete', (req, res) => {
  try {
    updateEnv({ SETUP_COMPLETE: 'true' });

    // Recarregar .env no process.env para o servidor pegar as mudanças
    try {
      const envPath = join(ROOT_DIR, '.env');
      const content = require('fs').readFileSync(envPath, 'utf-8');
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

export default router;
