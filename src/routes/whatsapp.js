import { Router } from 'express';
import { existsSync, mkdirSync, rmSync, readFileSync, unlinkSync, writeFileSync, readdirSync, createReadStream } from 'fs';
import { join, basename } from 'path';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import QRCode from 'qrcode';
import { WA_DIR, OUTBOX } from '../config.js';
import { waConnections } from '../state.js';
import { waLoadConfig, waSaveConfig, withInstanceLock, validatePhone } from '../whatsapp/utils.js';
import { normalizeBRPhone, sendWhatsApp } from '../services/messaging.js';
import { waConnect, createClient, syncAllContacts, backupSession, restoreSession, cleanSession, clearInstanceState } from '../whatsapp/connection.js';
import { setupMessageHandler } from '../whatsapp/handler.js';
import { contactsDB } from '../database.js';
import { log } from '../logger.js';

// ================================================================
// PAIRING CONSTANTS — unificado entre front e back
// ================================================================
const PAIR_TIMEOUT_MS = 120_000; // 2 minutos (unificado)
const PAIR_MAX_QR = 10;          // 10 QRs antes de fechar
const PAIR_HEARTBEAT_MS = 10_000; // 10s de heartbeat

// ================================================================
// RATE LIMITING — protege rotas de pareamento contra spam
// ================================================================
const _pairAttempts = {};
const PAIR_RATE_WINDOW = 60_000; // 1 minuto
const PAIR_RATE_MAX = 5;         // max 5 tentativas por minuto por IP

function pairRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();

  if (!_pairAttempts[ip]) _pairAttempts[ip] = [];
  // Remove tentativas antigas
  _pairAttempts[ip] = _pairAttempts[ip].filter(t => now - t < PAIR_RATE_WINDOW);

  if (_pairAttempts[ip].length >= PAIR_RATE_MAX) {
    return res.status(429).json({
      error: 'Muitas tentativas. Aguarde 1 minuto.',
      retryAfter: Math.ceil((PAIR_RATE_WINDOW - (now - _pairAttempts[ip][0])) / 1000),
    });
  }

  _pairAttempts[ip].push(now);
  next();
}

// Cleanup periódico de IPs antigos (evita memory leak)
setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(_pairAttempts)) {
    _pairAttempts[ip] = _pairAttempts[ip].filter(t => now - t < PAIR_RATE_WINDOW);
    if (_pairAttempts[ip].length === 0) delete _pairAttempts[ip];
  }
}, 60_000);

const router = Router();

// ================================================================
// INSTANCES
// ================================================================
router.get('/instances', async (req, res) => {
  const config = waLoadConfig();
  const instances = [];

  for (const [name, inst] of Object.entries(config.instances)) {
    let status = waConnections[name]?.status || 'offline';

    if (inst.type === 'wasender') {
      try {
        const { isWaSenderEnabled, getSessionStatus } = await import('../services/wasender.js');
        if (isWaSenderEnabled()) {
          const r = await getSessionStatus();
          status = r.success ? (r.data?.status || 'connected') : 'error';
        }
      } catch { status = 'error'; }
    }

    instances.push({
      name, phone: inst.phone, label: inst.label, active: inst.active,
      type: inst.type || 'local',
      isDefault: config.defaultInstance === name,
      status,
    });
  }

  res.json({ instances, defaultInstance: config.defaultInstance });
});

// ================================================================
// CONTACTS SYNC
// ================================================================
router.get('/contacts', (req, res) => {
  const q = (req.query.q || '').trim();
  const contacts = q ? contactsDB.search(q) : contactsDB.getAll();
  res.json({ total: contacts.length, contacts });
});

router.post('/sync-contacts', async (req, res) => {
  try {
    const connected = Object.entries(waConnections).find(([, c]) => c.status === 'connected' && c.client);
    if (!connected) return res.status(400).json({ error: 'Nenhuma instancia conectada' });
    const [instName, conn] = connected;
    await syncAllContacts(conn.client, instName);
    const total = contactsDB.getAll().length;
    res.json({ success: true, total, message: `${total} contatos sincronizados` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// PAIRING VIA CÓDIGO NUMÉRICO (Baileys)
// ================================================================
router.post('/pair', pairRateLimit, async (req, res) => {
  const { name: rawName, phone, label } = req.body;
  if (!rawName || !phone) return res.status(400).json({ error: 'name e phone obrigatórios' });

  // Validação de phone (F6)
  const phoneCheck = validatePhone(phone);
  if (!phoneCheck.valid) return res.status(400).json({ error: phoneCheck.error });

  const name = rawName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const cleanPhone = normalizeBRPhone(phone);

  try {
    // F5/F14: Lock por instância
    await withInstanceLock(name, async () => {
      // Limpa instância anterior
      if (waConnections[name]?.client) {
        try { waConnections[name].client.end(); } catch {}
        delete waConnections[name];
      }
      const config = waLoadConfig();
      if (config.instances[name]) { delete config.instances[name]; waSaveConfig(config); }

      // F1: Limpa pasta de sessão antes de criar novo cliente
      cleanSession(name);
    });

    const sock = await createClient(name);
    waConnections[name] = { client: sock, status: 'connecting', handlerSetup: false };

    let responded = false;
    let wsReady = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection } = update;

      // WebSocket abriu — agora pode pedir pairing code
      if (connection === 'open' || update.receivedPendingNotifications) {
        wsReady = true;
      }

      if (connection === 'open') {
        const cfg = waLoadConfig();
        cfg.instances[name] = { phone: cleanPhone, label: label || name, createdAt: new Date().toISOString(), active: true, type: 'local' };
        if (!cfg.defaultInstance) cfg.defaultInstance = name;
        waSaveConfig(cfg);
        waConnections[name].status = 'connected';
        if (!waConnections[name].handlerSetup) {
          setupMessageHandler(sock, name);
          waConnections[name].handlerSetup = true;
        }
        log.wa.info({ name }, 'Pareamento concluido — conectado!');
      }

      if (connection === 'close' && !responded) {
        responded = true;
        if (!res.headersSent) res.status(500).json({ error: 'Conexao fechada. Tente novamente.' });
      }
    });

    // Espera o WebSocket ficar pronto (max 15s)
    for (let i = 0; i < 30; i++) {
      if (wsReady || responded) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (responded) return;

    // Solicita codigo de pareamento
    try {
      const code = await sock.requestPairingCode(cleanPhone);
      log.wa.info({ name, code }, 'Codigo de pareamento gerado');
      if (!responded && !res.headersSent) {
        responded = true;
        res.json({ success: true, code: code.toUpperCase() });
      }
    } catch (err) {
      log.wa.error({ err: err.message }, 'Erro ao gerar codigo de pareamento');
      if (!responded && !res.headersSent) {
        responded = true;
        res.status(500).json({ error: 'Erro ao gerar codigo: ' + err.message });
      }
    }

    // Timeout geral
    setTimeout(() => {
      if (!responded) {
        responded = true;
        try { sock.end(); } catch {}
        if (!res.headersSent) res.json({ success: false, message: 'Timeout — tente novamente' });
      }
    }, 120_000);
  } catch (e) {
    log.wa.error({ err: e.message }, 'Erro fatal no pair');
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ================================================================
// PAIRING VIA QR CODE (SSE streaming com Baileys)
// ================================================================
router.get('/pair-qr', pairRateLimit, async (req, res) => {
  const { name: rawName, phone, label } = req.query;
  if (!rawName || !phone) return res.status(400).json({ error: 'name e phone obrigatórios' });

  // Validação de phone (F6)
  const phoneCheck = validatePhone(phone);
  if (!phoneCheck.valid) return res.status(400).json({ error: phoneCheck.error });

  const name = rawName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const cleanPhone = normalizeBRPhone(phone);

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  let qrCount = 0;
  let currentSock = null;
  let heartbeat = null;
  let mainTimeout = null;

  const send = (event, data) => {
    if (!closed && !res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  const cleanup = (reason = 'unknown') => {
    if (closed) return;
    closed = true;
    log.wa.info({ name, reason }, 'SSE cleanup');
    if (heartbeat) clearInterval(heartbeat);
    if (mainTimeout) clearTimeout(mainTimeout);
    // F3: Mata o socket Baileys para liberar recursos
    if (currentSock) {
      try { currentSock.end(); } catch {}
      try { currentSock.ev?.removeAllListeners?.(); } catch {}
    }
    try { res.end(); } catch {}
  };

  // F3: Quando o cliente fecha a conexão SSE (refresh, fechar aba), mata tudo
  req.on('close', () => cleanup('client_closed'));
  req.on('error', () => cleanup('client_error'));

  // Heartbeat mais frequente (F19)
  heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': heartbeat\n\n');
  }, PAIR_HEARTBEAT_MS);

  try {
    // F5/F14: Lock por instância — impede pareamento simultâneo
    await withInstanceLock(name, async () => {
      // Limpa instância anterior (cliente + state)
      if (waConnections[name]?.client) {
        try { waConnections[name].client.end(); } catch {}
        delete waConnections[name];
      }

      // Remove do config
      const config = waLoadConfig();
      if (config.instances[name]) { delete config.instances[name]; waSaveConfig(config); }

      // F1: LIMPA A PASTA DE SESSÃO antes de criar cliente novo
      // Isso garante que o Baileys gera QR fresco em vez de usar credenciais antigas
      cleanSession(name);

      log.wa.info({ name }, 'Criando nova sessao para pareamento');
      const sock = await createClient(name);
      currentSock = sock;
      waConnections[name] = { client: sock, status: 'connecting', handlerSetup: false };

      sock.ev.on('connection.update', async (update) => {
        const { connection, qr, isNewLogin, receivedPendingNotifications } = update;

        if (qr && !closed) {
          qrCount++;
          log.wa.info({ name, qrCount }, `QR #${qrCount} gerado`);
          try {
            const qrImage = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
            send('qr', { qr: qrImage, count: qrCount, maxCount: PAIR_MAX_QR });
          } catch {}

          if (qrCount >= PAIR_MAX_QR) {
            send('timeout', { message: 'Muitas tentativas. Recarregue a pagina.' });
            cleanup('max_qr');
          }
        }

        // F10: feedback "conectando..." quando o usuário escaneia o QR
        if (isNewLogin && !closed) {
          log.wa.info({ name }, 'QR escaneado — conectando...');
          send('scanning', { message: 'QR escaneado! Conectando...' });
        }

        if (connection === 'connecting' && qrCount > 0 && !closed) {
          send('scanning', { message: 'Finalizando conexao...' });
        }

        if (connection === 'open') {
          log.wa.info({ name, phone: cleanPhone }, 'Conectado via QR (Baileys)!');
          const cfg = waLoadConfig();
          cfg.instances[name] = {
            phone: cleanPhone,
            label: label || name,
            createdAt: new Date().toISOString(),
            active: true,
            type: 'local',
          };
          if (!cfg.defaultInstance) cfg.defaultInstance = name;
          waSaveConfig(cfg);
          waConnections[name].status = 'connected';

          // F13: Guard contra duplo setupMessageHandler
          if (!waConnections[name].handlerSetup) {
            setupMessageHandler(sock, name);
            waConnections[name].handlerSetup = true;
          }

          send('connected', { name, phone: cleanPhone });
          // Não mata o socket aqui — ele vira a conexão persistente
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (mainTimeout) clearTimeout(mainTimeout);
          try { res.end(); } catch {}
        }

        if (connection === 'close' && !closed) {
          const err = update.lastDisconnect?.error;
          const code = err?.output?.statusCode;
          log.wa.warn({ name, code, msg: err?.message }, 'Conexao fechada durante pareamento');
          send('error', { message: 'Conexao fechada', code });
          cleanup('connection_close');
        }
      });

      // Timeout unificado (F2)
      mainTimeout = setTimeout(() => {
        if (!closed) {
          send('timeout', { message: 'Timeout — tente novamente' });
          cleanup('timeout');
        }
      }, PAIR_TIMEOUT_MS);
    });
  } catch (e) {
    log.wa.error({ err: e.message, name }, 'Erro no QR pairing Baileys');
    send('error', { message: e.message });
    cleanup('exception');
  }
});

// ================================================================
// CONTACTS (rota unificada — busca por query ou retorna todos)
// ================================================================

router.post('/contacts/sync', async (req, res) => {
  try {
    const config = waLoadConfig();
    const instName = req.body?.instance || config.defaultInstance;
    const conn = instName && waConnections[instName];
    if (!conn?.client || conn.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }
    res.json({ success: true, message: 'Sync será feito automaticamente quando o WhatsApp conectar.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// SEND / DELETE / DEFAULT / RECONNECT
// ================================================================
router.post('/send', async (req, res) => {
  const { instance, jid, message } = req.body;
  if (!jid || !message) return res.status(400).json({ error: 'jid e message obrigatórios' });
  const config = waLoadConfig();
  const name = instance || config.defaultInstance;
  const conn = waConnections[name];
  if (!conn?.client || conn.status !== 'connected') return res.status(400).json({ error: 'Não conectado' });
  try {
    const chatJid = jid.includes('@') ? jid : jid + '@s.whatsapp.net';
    await conn.client.sendMessage(chatJid, { text: message });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/instances/:name', async (req, res) => {
  const name = req.params.name;
  const config = waLoadConfig();
  if (!config.instances[name]) return res.status(404).json({ error: 'Não encontrada' });
  if (waConnections[name]?.client) {
    try { waConnections[name].client.end(); } catch {}
  }
  delete waConnections[name];
  // F17: Limpa estado interno (debounce sync, health check)
  clearInstanceState(name);

  const authDir = join(WA_DIR, 'baileys', `session-${name}`);
  if (existsSync(authDir)) rmSync(authDir, { recursive: true });
  // Limpa backup também
  const backupDir = join(WA_DIR, 'baileys', `session-${name}.bak`);
  if (existsSync(backupDir)) rmSync(backupDir, { recursive: true });

  delete config.instances[name];
  if (config.defaultInstance === name) config.defaultInstance = Object.keys(config.instances)[0] || null;
  waSaveConfig(config);
  res.json({ ok: true });
});

router.post('/default/:name', (req, res) => {
  const config = waLoadConfig();
  if (!config.instances[req.params.name]) return res.status(404).json({ error: 'Não encontrada' });
  config.defaultInstance = req.params.name;
  waSaveConfig(config);
  res.json({ ok: true });
});

router.post('/reconnect/:name', async (req, res) => {
  if (waConnections[req.params.name]?.client) {
    try { waConnections[req.params.name].client.end(); } catch {}
  }
  await waConnect(req.params.name);
  res.json({ ok: true, status: waConnections[req.params.name]?.status });
});

// ================================================================
// EXPORT SESSION — download da sessão para migrar entre máquinas
// ================================================================
router.get('/export/:name', async (req, res) => {
  const name = req.params.name;
  const config = waLoadConfig();
  if (!config.instances[name]) return res.status(404).json({ error: 'Instância não encontrada' });

  const authDir = join(WA_DIR, 'baileys', `session-${name}`);
  if (!existsSync(authDir)) return res.status(404).json({ error: 'Sessão não encontrada' });

  try {
    // Cria um JSON com todos os arquivos da sessão
    const files = readdirSync(authDir);
    const sessionData = {
      instance: name,
      config: config.instances[name],
      exportedAt: new Date().toISOString(),
      files: {},
    };

    for (const file of files) {
      const filePath = join(authDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        sessionData.files[file] = content;
      } catch {
        // Arquivo binário — codifica em base64
        const content = readFileSync(filePath);
        sessionData.files[file] = { base64: content.toString('base64') };
      }
    }

    const exportJson = JSON.stringify(sessionData);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="zaya-wa-session-${name}.json"`);
    res.send(exportJson);

    log.wa.info({ instance: name, files: files.length }, 'Sessão exportada');
  } catch (e) {
    log.wa.error({ err: e.message, instance: name }, 'Erro ao exportar sessão');
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// IMPORT SESSION — restaurar sessão de outra máquina
// ================================================================
router.post('/import', async (req, res) => {
  try {
    const sessionData = req.body;
    if (!sessionData?.instance || !sessionData?.files) {
      return res.status(400).json({ error: 'Dados de sessão inválidos. Envie o JSON exportado.' });
    }

    const name = sessionData.instance;

    // Desconecta instância existente
    if (waConnections[name]?.client) {
      try { waConnections[name].client.end(); } catch {}
      delete waConnections[name];
    }

    // Cria diretório da sessão
    const authDir = join(WA_DIR, 'baileys', `session-${name}`);
    if (existsSync(authDir)) rmSync(authDir, { recursive: true });
    mkdirSync(authDir, { recursive: true });

    // Restaura arquivos
    let restored = 0;
    for (const [fileName, content] of Object.entries(sessionData.files)) {
      const filePath = join(authDir, fileName);
      if (typeof content === 'string') {
        writeFileSync(filePath, content, 'utf-8');
      } else if (content?.base64) {
        writeFileSync(filePath, Buffer.from(content.base64, 'base64'));
      }
      restored++;
    }

    // Salva config da instância
    const config = waLoadConfig();
    config.instances[name] = sessionData.config || {
      phone: '',
      label: name,
      createdAt: new Date().toISOString(),
      active: true,
      type: 'local',
    };
    if (!config.defaultInstance) config.defaultInstance = name;
    waSaveConfig(config);

    log.wa.info({ instance: name, files: restored }, 'Sessão importada');

    // Tenta conectar
    await waConnect(name);

    res.json({
      success: true,
      instance: name,
      files: restored,
      status: waConnections[name]?.status || 'connecting',
    });
  } catch (e) {
    log.wa.error({ err: e.message }, 'Erro ao importar sessão');
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// RESET RETRIES — permite reconectar após limite atingido
// ================================================================
router.post('/reset-retries/:name', (req, res) => {
  const name = req.params.name;
  if (waConnections[name]) {
    waConnections[name]._retries = 0;
    if (waConnections[name].status === 'needs_repairing') {
      waConnections[name].status = 'disconnected';
    }
    res.json({ ok: true, message: 'Retries resetados. Use /reconnect para tentar novamente.' });
  } else {
    res.status(404).json({ error: 'Instância não encontrada' });
  }
});

// ================================================================
// DEBUG — status detalhado de uma instância
// ================================================================
router.get('/instances/:name/debug', (req, res) => {
  const name = req.params.name;
  const config = waLoadConfig();
  const inst = config.instances[name];
  if (!inst) return res.status(404).json({ error: 'Instância não encontrada' });

  const conn = waConnections[name] || {};
  const authDir = join(WA_DIR, 'baileys', `session-${name}`);
  const backupDir = join(WA_DIR, 'baileys', `session-${name}.bak`);

  let sessionSize = 0;
  let sessionFiles = 0;
  try {
    if (existsSync(authDir)) {
      const files = readdirSync(authDir);
      sessionFiles = files.length;
      for (const f of files) {
        try {
          const stat = readFileSync(join(authDir, f)).length;
          sessionSize += stat;
        } catch {}
      }
    }
  } catch {}

  res.json({
    name,
    config: inst,
    connection: {
      status: conn.status || 'offline',
      retries: conn._retries || 0,
      handlerSetup: conn.handlerSetup || false,
      hasQr: !!conn.qr,
      wsReadyState: conn.client?.ws?.readyState ?? null,
      restoredThisSession: conn._restoredThisSession || false,
    },
    session: {
      path: authDir,
      files: sessionFiles,
      sizeBytes: sessionSize,
      hasBackup: existsSync(backupDir),
    },
  });
});

// Outbox monitor
export function startOutboxMonitor() {
  setInterval(() => {
    if (existsSync(OUTBOX)) {
      try {
        const data = JSON.parse(readFileSync(OUTBOX, 'utf-8'));
        if (data.text && data.jid) {
          sendWhatsApp(data.jid.replace('@c.us', '').replace('@s.whatsapp.net', ''), data.text);
          unlinkSync(OUTBOX);
        }
      } catch {}
    }
  }, 1000);
}

export default router;
