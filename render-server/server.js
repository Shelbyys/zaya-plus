import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { checkPromos, startFlightMonitor } from './flight-monitor.js';

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

// ================================================================
// INSTALAÇÃO RÁPIDA — link curto pra mandar no WhatsApp
// GET /i/:token → página com comando pra copiar
// ================================================================
app.get('/i/:token', (req, res) => {
  const token = req.params.token;
  const cmdWin = 'curl -sL https://raw.githubusercontent.com/Shelbyys/zaya-plus/main/setup.ps1 -o %TEMP%\\zaya-setup.ps1 && powershell -ExecutionPolicy Bypass -File %TEMP%\\zaya-setup.ps1 -Token ' + token;
  const cmdMac = 'curl -sL https://raw.githubusercontent.com/Shelbyys/zaya-plus/main/setup.sh | bash -s ' + token;
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Instalar ZAYA PLUS</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0f;color:#eee;font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{max-width:600px;width:100%;background:#12121a;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px;text-align:center}
h1{font-size:1.5rem;margin-bottom:8px}p{color:#888;font-size:0.9rem;margin-bottom:24px}
.step{text-align:left;margin-bottom:20px}.step-title{font-size:0.75rem;font-weight:600;color:#6c5ce7;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px}
.cmd{background:#0a0a0f;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:14px;font-family:monospace;font-size:0.8rem;color:#00e676;word-break:break-all;cursor:pointer;position:relative;line-height:1.5}
.cmd:hover{border-color:#00e676}.copied{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#00e676;color:#000;padding:6px 16px;border-radius:8px;font-weight:700;font-size:0.85rem}
.btn{display:inline-block;background:linear-gradient(135deg,#6c5ce7,#8b5cf6);color:#fff;border:none;border-radius:10px;padding:10px 24px;font-size:0.85rem;font-weight:600;cursor:pointer;margin-top:6px}
.btn:hover{opacity:0.9}.or{color:#444;font-size:0.75rem;margin:12px 0}
</style></head><body><div class="card">
<h1>ZAYA PLUS</h1><p>Cole o comando no terminal e aperte Enter</p>
<div class="step"><div class="step-title">Windows (CMD)</div>
<div class="cmd" id="cmdWin" onclick="copyCmd('cmdWin')">${cmdWin}</div>
<button class="btn" onclick="copyCmd('cmdWin')">Copiar comando Windows</button></div>
<div class="or">ou</div>
<div class="step"><div class="step-title">Mac / Linux (Terminal)</div>
<div class="cmd" id="cmdMac" onclick="copyCmd('cmdMac')">${cmdMac}</div>
<button class="btn" onclick="copyCmd('cmdMac')">Copiar comando Mac</button></div>
<p style="margin-top:24px;font-size:0.75rem;color:#444">Token: ${token.slice(0,8)}...</p>
</div><script>
function copyCmd(id){var el=document.getElementById(id);navigator.clipboard.writeText(el.textContent).then(function(){
var d=document.createElement('div');d.className='copied';d.textContent='Copiado!';el.appendChild(d);setTimeout(function(){d.remove()},1500)});}
</script></body></html>`);
});

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
      // Permite reativar se hostname e platform batem (mesmo PC, fingerprint mudou por update)
      const savedMachine = record.machine_info || {};
      const sameHost = machine && savedMachine.hostname && machine.hostname === savedMachine.hostname;
      const samePlatform = machine && savedMachine.platform && machine.platform === savedMachine.platform;
      if (sameHost && samePlatform) {
        // Mesma máquina — atualiza fingerprint
        await sbUpdate(`token=eq.${encodeURIComponent(token)}`, {
          fingerprint, machine_info: machine || {},
          activated_at: new Date().toISOString()
        });
        return res.json({ valid: true, plan: record.plan, reactivated: true });
      }
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

// Verificar status (para check periódico) + notificação de update
app.get('/api/license/check/:token', async (req, res) => {
  try {
    const rows = await sbSelect(`token=eq.${encodeURIComponent(req.params.token)}&select=revoked,expires_at,plan`);
    if (!rows || rows.length === 0) return res.json({ valid: false });

    const r = rows[0];
    if (r.revoked) return res.json({ valid: false, reason: 'revoked' });
    if (r.expires_at && new Date(r.expires_at) < new Date()) return res.json({ valid: false, reason: 'expired' });

    // Inclui info de update se houver
    const result = { valid: true, plan: r.plan };
    if (_latestUpdate) {
      result.update = _latestUpdate;
    }
    return res.json(result);
  } catch (err) {
    res.status(500).json({ valid: false });
  }
});

// ================================================================
// UPDATE BROADCAST (admin define, clientes recebem no check periódico)
// ================================================================
let _latestUpdate = null;

app.post('/api/license/admin/broadcast-update', (req, res) => {
  const { password, message, version } = req.body;
  if (!checkAdmin(password)) return res.status(403).json({ error: 'Senha incorreta' });
  _latestUpdate = { message: message || 'Nova atualizacao disponivel!', version: version || Date.now().toString(), timestamp: new Date().toISOString() };
  res.json({ success: true, update: _latestUpdate });
});

app.delete('/api/license/admin/broadcast-update', (req, res) => {
  const { password } = req.body;
  if (!checkAdmin(password)) return res.status(403).json({ error: 'Senha incorreta' });
  _latestUpdate = null;
  res.json({ success: true, message: 'Broadcast removido' });
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

// Editar licença (nome, email, plano, validade)
app.post('/api/license/admin/update', async (req, res) => {
  try {
    if (!checkAdmin(req.body.password)) return res.status(401).json({ error: 'Senha invalida' });
    const { token, name, email, plan, expires_at } = req.body;
    if (!token) return res.status(400).json({ error: 'Token obrigatorio' });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (plan !== undefined) updates.plan = plan;
    if (expires_at !== undefined) updates.expires_at = expires_at;

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

    await sbUpdate(`token=eq.${encodeURIComponent(token)}`, updates);
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
// FLIGHT MONITOR — endpoints manuais
// ================================================================
app.get('/promos/check', async (req, res) => {
  try {
    const silent = req.query.silent === '1';
    const r = await checkPromos({ silent });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/promos/recent', async (req, res) => {
  if (!SB_URL || !SB_KEY) return res.status(503).json({ ok: false, error: 'supabase não configurado' });
  try {
    const r = await fetch(`${SB_URL}/rest/v1/promo_flights_seen?order=first_seen.desc&limit=20`, { headers: sbHeaders });
    const data = await r.json();
    res.json({ ok: true, count: data.length, promos: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ================================================================
// START
// ================================================================
app.listen(PORT, () => {
  console.log(`Zaya Plus Server online em http://localhost:${PORT}`);
  if (!SB_KEY) console.warn('AVISO: SUPABASE_KEY nao configurada!');
  if (!ADMIN_PASSWORD) console.warn('AVISO: LICENSE_ADMIN_PASSWORD nao configurada!');
  startFlightMonitor();
});
