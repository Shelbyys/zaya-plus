import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ================================================================
// SUPABASE CONFIG
// ================================================================
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_KEY || '';
const ADMIN_PASSWORD = process.env.LICENSE_ADMIN_PASSWORD || '';
const TABLE = 'licenses';

const sbHeaders = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json'
};

async function sbSelect(filter) {
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?${filter}`, { headers: sbHeaders });
  if (!r.ok) throw new Error(`DB error: ${r.status}`);
  return r.json();
}

async function sbInsert(body) {
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}`, {
    method: 'POST', headers: { ...sbHeaders, 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`DB error: ${r.status}`);
  return r.json();
}

async function sbUpdate(filter, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?${filter}`, {
    method: 'PATCH', headers: { ...sbHeaders, 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`DB error: ${r.status}`);
  return r.json();
}

// ================================================================
// MIDDLEWARE
// ================================================================
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// CORS para o cliente local validar licença
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ================================================================
// ROTAS PUBLICAS (cliente usa para validar)
// ================================================================

// Validar token
app.post('/api/license/validate', async (req, res) => {
  try {
    const { token, fingerprint, machine } = req.body;
    if (!token) return res.status(400).json({ valid: false, error: 'Token obrigatorio' });

    const rows = await sbSelect(`token=eq.${encodeURIComponent(token)}&select=*`);
    if (!rows || rows.length === 0) return res.json({ valid: false, error: 'Token invalido' });

    const record = rows[0];

    if (record.revoked) return res.json({ valid: false, error: 'Licenca revogada' });
    if (record.expires_at && new Date(record.expires_at) < new Date()) return res.json({ valid: false, error: 'Licenca expirada' });
    if (record.activated && record.fingerprint && record.fingerprint !== fingerprint) {
      return res.json({ valid: false, error: 'Token ja ativado em outro computador' });
    }

    // Primeira ativação
    if (!record.activated && fingerprint) {
      await sbUpdate(`token=eq.${encodeURIComponent(token)}`, {
        fingerprint, activated: true,
        activated_at: new Date().toISOString(),
        machine_info: machine || {}
      });
      return res.json({ valid: true, plan: record.plan, activated: true });
    }

    return res.json({ valid: true, plan: record.plan });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// Verificar status (para check periódico)
app.get('/api/license/check/:token', async (req, res) => {
  try {
    const rows = await sbSelect(`token=eq.${encodeURIComponent(req.params.token)}&select=revoked,expires_at,plan`);
    if (!rows || rows.length === 0) return res.json({ valid: false });

    const r = rows[0];
    if (r.revoked) return res.json({ valid: false, reason: 'revoked' });
    if (r.expires_at && new Date(r.expires_at) < new Date()) return res.json({ valid: false, reason: 'expired' });

    return res.json({ valid: true, plan: r.plan });
  } catch (err) {
    res.status(500).json({ valid: false });
  }
});

// ================================================================
// ROTAS ADMIN (protegidas por senha)
// ================================================================

function checkAdmin(password) {
  if (!ADMIN_PASSWORD) return false;
  return password === ADMIN_PASSWORD;
}

// Gerar licença
app.post('/api/license/admin/generate', async (req, res) => {
  try {
    if (!ADMIN_PASSWORD) return res.status(403).json({ error: 'ADMIN_PASSWORD nao configurada' });
    const { plan, email, name, password } = req.body;
    if (!checkAdmin(password)) return res.status(401).json({ error: 'Senha invalida' });
    if (!plan || !email || !name) return res.status(400).json({ error: 'plan, email, name obrigatorios' });

    const token = crypto.randomUUID();
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);

    await sbInsert({ token, plan, email, name, activated: false, revoked: false, expires_at: expires.toISOString() });

    res.json({ token, plan, expires_at: expires.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gerar licença TRIAL (com tempo limitado)
app.post('/api/license/admin/generate-trial', async (req, res) => {
  try {
    if (!checkAdmin(req.body.password)) return res.status(401).json({ error: 'Senha invalida' });
    const { plan, email, name, hours, minutes } = req.body;
    if (!email || !name) return res.status(400).json({ error: 'email e name obrigatorios' });

    const token = 'TRIAL-' + crypto.randomUUID().slice(0, 18).toUpperCase();
    const totalMs = ((parseInt(hours) || 0) * 60 + (parseInt(minutes) || 0)) * 60 * 1000;
    if (totalMs <= 0) return res.status(400).json({ error: 'Defina pelo menos 1 minuto' });

    const expires = new Date(Date.now() + totalMs);

    await sbInsert({
      token, plan: plan || 'enterprise', email, name,
      activated: false, revoked: false,
      expires_at: expires.toISOString(),
      machine_info: { trial: true, duration_ms: totalMs }
    });

    res.json({ token, plan: plan || 'enterprise', expires_at: expires.toISOString(), trial: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar licenças
app.get('/api/license/admin/list', async (req, res) => {
  try {
    if (!checkAdmin(req.query.password)) return res.status(401).json({ error: 'Senha invalida' });
    const data = await sbSelect('select=*&order=created_at.desc');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revogar licença
app.post('/api/license/admin/revoke', async (req, res) => {
  try {
    if (!checkAdmin(req.body.password)) return res.status(401).json({ error: 'Senha invalida' });
    await sbUpdate(`token=eq.${encodeURIComponent(req.body.token)}`, {
      revoked: true, revoked_at: new Date().toISOString()
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Desativar (permitir reativar)
app.post('/api/license/admin/deactivate', async (req, res) => {
  try {
    if (!checkAdmin(req.body.password)) return res.status(401).json({ error: 'Senha invalida' });
    await sbUpdate(`token=eq.${encodeURIComponent(req.body.token)}`, {
      activated: false, fingerprint: null, machine_info: {}
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// HOME → Landing page
// ================================================================
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'landing.html'));
});

// ================================================================
// START
// ================================================================
app.listen(PORT, () => {
  console.log(`Zaya Plus Server online em http://localhost:${PORT}`);
  if (!SB_KEY) console.warn('AVISO: SUPABASE_KEY nao configurada!');
  if (!ADMIN_PASSWORD) console.warn('AVISO: LICENSE_ADMIN_PASSWORD nao configurada!');
});
