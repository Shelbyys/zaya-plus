import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import { join, resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync } from 'fs';

import { PORT } from './src/config.js';
import { API_TOKEN, setIO, macLocation, waConnections } from './src/state.js';
import { log } from './src/logger.js';
import { requestLogger, errorHandler, setupProcessHandlers } from './src/middleware/error.js';
import { securityHeaders, loginLimiter, apiLimiter, chatLimiter, securityChecks } from './src/middleware/security.js';

// ================================================================
// PROCESS ERROR HANDLERS + SECURITY CHECKS
// ================================================================
setupProcessHandlers();
securityChecks();

// ================================================================
// EXPRESS + SOCKET.IO SETUP
// ================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new SocketIO(server);

setIO(io);

// ================================================================
// MIDDLEWARE GLOBAL
// ================================================================
app.use(securityHeaders);
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(requestLogger);

// Protege páginas HTML — licença + acesso externo
app.use((req, res, next) => {
  // Só protege páginas HTML (não API, não assets)
  if (!req.path.endsWith('.html') && req.path !== '/' && req.path !== '/index.html') return next();

  // license.html, admin.html, onboarding.html — sempre acessíveis
  if (req.path === '/license.html' || req.path === '/admin.html' || req.path === '/onboarding.html' || req.path === '/settings.html' || req.path === '/whatsapp.html') return next();

  // Página de login — sempre acessível
  if (req.path === '/login') return next();

  // Todas as outras páginas HTML exigem licença ativa
  if (!isLicensed()) return res.redirect('/license.html');

  // Local: libera direto
  const ip = req.ip || req.connection?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.includes('::ffff:192.168.') || ip.includes('::ffff:10.')) return next();

  // Verifica cookie de autenticação
  const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(c=>{const [k,...v]=c.trim().split('=');return [k,v.join('=')];}));
  if (cookies.api_token === API_TOKEN) return next();

  // Redireciona pra login
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZAYA — Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0b09;color:#f0ece4;font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.box{background:rgba(0,0,0,0.5);border:1px solid rgba(243,102,0,0.2);border-radius:12px;padding:40px;width:340px;text-align:center}
h1{font-family:'Space Mono',monospace;font-size:28px;letter-spacing:8px;color:#f36600;margin-bottom:8px}
p{font-size:12px;color:rgba(240,236,228,0.4);margin-bottom:24px;letter-spacing:2px}
input{width:100%;background:rgba(0,0,0,0.6);border:1px solid rgba(240,236,228,0.15);color:#f0ece4;padding:14px;border-radius:6px;font-size:14px;text-align:center;letter-spacing:2px;outline:none;margin-bottom:16px}
input:focus{border-color:#f36600;box-shadow:0 0 10px rgba(243,102,0,0.15)}
button{width:100%;padding:14px;background:#f36600;color:#000;border:none;border-radius:6px;font-family:'Space Mono',monospace;font-size:12px;letter-spacing:3px;cursor:pointer;font-weight:700}
button:hover{background:#ff8833}
.err{color:#ff4444;font-size:11px;margin-top:8px;display:none}
.dot{width:8px;height:8px;border-radius:50%;background:#f36600;display:inline-block;margin-bottom:20px;box-shadow:0 0 10px #f36600}
</style></head><body>
<div class="box">
<div class="dot"></div>
<h1>ZAYA</h1>
<p>AUTENTICAÇÃO NECESSÁRIA</p>
<form onsubmit="return doLogin()">
<input type="password" id="pwd" placeholder="SENHA" autofocus>
<button type="submit">ENTRAR</button>
</form>
<div class="err" id="err">Senha incorreta</div>
</div>
<script>
async function doLogin(){
  const pwd=document.getElementById('pwd').value;
  const r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})});
  const d=await r.json();
  if(d.success){
    document.cookie='api_token='+d.token+';path=/;max-age=86400;SameSite=Strict';
    location.reload();
  }else{
    document.getElementById('err').style.display='block';
    document.getElementById('pwd').value='';
  }
  return false;
}
</script></body></html>`);
});

// ================================================================
// SETUP WIZARD — redireciona se não configurado
// ================================================================
import { readFileSync } from 'fs';

function isSetupNeeded() {
  // Reler .env a cada check pois o setup wizard escreve nele em runtime
  try {
    const envContent = readFileSync(join(__dirname, '.env'), 'utf-8');
    const envVars = {};
    envContent.split('\n').forEach(line => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) envVars[match[1].trim()] = match[2].trim();
    });
    if (envVars.SETUP_COMPLETE === 'true') return false;
    const key = envVars.OPENAI_API_KEY || envVars.ANTHROPIC_API_KEY || '';
    const name = envVars.ADMIN_NAME || '';
    return !key || !name;
  } catch {
    return true;
  }
}

app.get('/', (req, res, next) => {
  // 1. Sem licença → página de licença
  if (!isLicensed()) return res.redirect('/license.html');
  // 2. Sem setup → setup wizard
  if (isSetupNeeded()) return res.redirect('/setup.html');
  next();
});

app.get('/index.html', (req, res) => {
  if (!isLicensed()) return res.redirect('/license.html');
  if (isSetupNeeded()) return res.redirect('/setup.html');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.use(express.static(join(__dirname, 'public')));

// Serve arquivos gerados (slides, vídeos, etc) de /tmp/
app.get('/files/*', (req, res) => {
  const safePath = resolve('/tmp', req.params[0]);
  if (!safePath.startsWith('/tmp/')) return res.status(403).send('Acesso negado');
  // existsSync e extname importados no topo
  if (!existsSync(safePath)) return res.status(404).send('Arquivo não encontrado');
  const mimes = {'.html':'text/html','.pdf':'application/pdf','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.mp4':'video/mp4','.mp3':'audio/mpeg','.jpg':'image/jpeg','.png':'image/png'};
  const ext = extname(safePath).toLowerCase();
  res.set('Content-Type', mimes[ext] || 'application/octet-stream');
  res.sendFile(safePath);
});

// ================================================================
// AUTENTICAÇÃO
// ================================================================
log.server.info({ token: API_TOKEN.slice(0, 8) + '...' }, 'API Token gerado');

function apiAuth(req, res, next) {
  if (req.path === '/' || req.path.startsWith('/socket.io')) return next();
  // Token via header, query ou cookie
  const cookies = Object.fromEntries((req.headers.cookie||'').split(';').map(c=>{const [k,...v]=c.trim().split('=');return [k,v.join('=')];}));
  const token = req.headers['x-api-token'] || req.query.token || cookies.api_token;
  if (token === API_TOKEN) return next();
  // Localhost bypass
  const ip = req.ip || req.connection?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost') return next();
  // Referer da mesma origem (frontend servido pelo mesmo servidor)
  const referer = req.headers.referer || req.headers.origin || '';
  const host = req.headers.host || '';
  if (referer && (referer.includes(host) || referer.includes('localhost') || referer.includes('192.168.') || referer.includes('10.0.') || referer.includes('onrender.com'))) return next();
  // Acesso via rede local (IP privado)
  if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.') || ip.includes('::ffff:192.168.') || ip.includes('::ffff:10.')) return next();
  return res.status(401).json({ error: 'Não autorizado. Envie header X-Api-Token.' });
}

app.use('/api', apiLimiter);
app.use('/api', apiAuth);

app.post('/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  const SENHA = process.env.BOT_PASSWORD || 'admin';
  if (password === SENHA) {
    res.setHeader('Set-Cookie', `api_token=${API_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Secure`);
    log.server.info('Login bem-sucedido via dashboard');
    res.json({ success: true, token: API_TOKEN });
  } else {
    log.server.warn({ ip: req.ip }, 'Tentativa de login com senha incorreta');
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

// ================================================================
// ROTAS
// ================================================================
import chatRoutes from './src/routes/chat.js';
import mediaRoutes from './src/routes/media.js';
import dataRoutes from './src/routes/data.js';
import whatsappRoutes, { startOutboxMonitor } from './src/routes/whatsapp.js';
import webhookRoutes from './src/routes/webhook.js';
import calendarRoutes from './src/routes/calendar.js';

import twilioVoiceRoutes from './src/routes/twilio-voice.js';
import setupRoutes from './src/routes/setup.js';
import licenseRoutes from './src/routes/license.js';
import { isLicensed } from './src/services/license.js';

// License + Setup routes (sem auth para funcionar na primeira vez)
app.use('/api/license', licenseRoutes);
app.use('/api/setup', setupRoutes);

// Integrity protection
import { verifyIntegrity, isIntegrityValid } from './src/services/integrity.js';

// License guard — bloqueia TODOS os /api/* (exceto license e setup) sem licença ativa
function licenseGuard(req, res, next) {
  // Integrity check — arquivos criticos nao foram modificados
  if (!isIntegrityValid()) {
    return res.status(403).json({ error: 'Integridade do sistema comprometida' });
  }
  // License check
  if (!isLicensed()) {
    return res.status(401).json({ error: 'Licenca nao ativada' });
  }
  // Redundant check: read .license directly
  try {
    const lf = join(__dirname, '.license');
    if (!existsSync(lf)) return res.status(401).json({ error: 'Licenca nao ativada' });
    const d = JSON.parse(readFileSync(lf, 'utf-8'));
    if (!d.signature || !d.fingerprint || !d.token) return res.status(401).json({ error: 'Licenca invalida' });
  } catch {
    return res.status(401).json({ error: 'Licenca corrompida' });
  }
  // Periodic integrity verification
  verifyIntegrity();
  next();
}
app.use('/api', licenseGuard);

app.use('/api/chat', chatLimiter);
app.use('/api/vision', chatLimiter);
app.use('/api', chatRoutes);
app.use('/api', mediaRoutes);
app.use('/api', dataRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/webhook', webhookRoutes);
app.use('/api/calendar', calendarRoutes);

app.use('/voice', twilioVoiceRoutes);

// Error handler (DEVE ser o último)
app.use(errorHandler);

// ================================================================
// SOCKET.IO
// ================================================================
let dashboardConnected = false;
io.on('connection', () => {
  if (!dashboardConnected) {
    log.server.info('Dashboard conectado');
    dashboardConnected = true;
  }
});

// ================================================================
// LOCALIZAÇÃO (atualiza periodicamente)
// ================================================================
async function updateLocation() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch('https://ipinfo.io/json', { signal: controller.signal });
    clearTimeout(timeout);
    const d = await r.json();
    Object.assign(macLocation, { city: d.city || '', region: d.region || '', country: d.country || 'BR', loc: d.loc || '', timezone: d.timezone || '' });
    log.server.info({ city: macLocation.city, region: macLocation.region }, 'Localização atualizada');
  } catch (e) {
    log.server.debug({ err: e.message }, 'Localização indisponível (offline ou sem acesso)');
  }
}

// Não bloqueia startup — roda em background
updateLocation().catch(() => {});
setInterval(updateLocation, 30 * 60 * 1000);

// ================================================================
// STARTUP
// ================================================================
import { waAutoConnect } from './src/whatsapp/connection.js';
import { initSupabaseTables, syncAllToSupabase, isSupabaseEnabled } from './src/services/supabase.js';
import { startScheduler } from './src/services/scheduler.js';
import { startInboxPoller } from './src/services/inbox-poller.js';
import { startProactiveMonitor } from './src/services/proactive.js';
import { startAlertMonitor } from './src/services/alerts.js';
import { startFolderWatcher } from './src/services/folder-watcher.js';

server.listen(PORT, '0.0.0.0', async () => {
  log.server.info(`Iniciando ZAYA PLUS...`);
  startOutboxMonitor();
  startScheduler();
  startInboxPoller();
  startProactiveMonitor();
  startAlertMonitor();
  startFolderWatcher();
  await waAutoConnect();

  // Supabase: init + sync em background
  if (isSupabaseEnabled()) {
    initSupabaseTables().then(() => syncAllToSupabase());
  }

  // Banner final — aparece DEPOIS de tudo inicializar
  setTimeout(() => {
    console.log('');
    console.log('  \x1b[35m\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log('');
    console.log('  \x1b[35m\x1b[1m  ZAYA PLUS\x1b[0m  \x1b[32m● ONLINE\x1b[0m');
    console.log('');
    console.log('  \x1b[36m  Acesse no navegador:\x1b[0m');
    console.log('  \x1b[36m\x1b[1m  http://localhost:' + PORT + '\x1b[0m');
    console.log('');
    console.log('  \x1b[35m\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log('');
  }, 3000);
});

async function gracefulShutdown() {
  log.server.info('Encerrando gracefully...');
  for (const [name, conn] of Object.entries(waConnections)) {
    if (conn.client) {
      try {
        log.wa.info({ instance: name }, 'Salvando sessão e fechando Chrome...');
        await conn.client.destroy();
      } catch {}
    }
  }
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
