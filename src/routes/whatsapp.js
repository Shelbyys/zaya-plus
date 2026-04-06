import { Router } from 'express';
import { existsSync, mkdirSync, rmSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import QRCode from 'qrcode';
import { WA_DIR, OUTBOX } from '../config.js';
import { waConnections } from '../state.js';
import { waLoadConfig, waSaveConfig } from '../whatsapp/utils.js';
import { normalizeBRPhone, sendWhatsApp } from '../services/messaging.js';
import { waConnect, createClient } from '../whatsapp/connection.js';
import { setupMessageHandler } from '../whatsapp/handler.js';
import { log } from '../logger.js';

// Mata processos Chrome órfãos de uma sessão específica
function killOrphanChrome(sessionName) {
  const sessionDir = join(WA_DIR, 'wwebjs', `session-${sessionName}`);
  try {
    // Remove o lock file do Chrome se existir
    const lockFile = join(sessionDir, 'SingletonLock');
    if (existsSync(lockFile)) unlinkSync(lockFile);
  } catch {}
  try {
    // Mata processos chrome que usam esse userDataDir
    if (process.platform === 'darwin' || process.platform === 'linux') {
      execSync(`pkill -f "userDataDir=${sessionDir.replace(/\//g, '.')}" 2>/dev/null || true`, { timeout: 5000, stdio: 'pipe' });
      execSync(`pkill -f "${sessionDir}" 2>/dev/null || true`, { timeout: 5000, stdio: 'pipe' });
    }
  } catch {}
}

const router = Router();

// ================================================================
// INSTANCES
// ================================================================
router.get('/instances', async (req, res) => {
  const config = waLoadConfig();
  const instances = [];

  for (const [name, inst] of Object.entries(config.instances)) {
    let status = waConnections[name]?.status || 'offline';

    // WaSender: checa status via API
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
// PAIRING VIA CÓDIGO NUMÉRICO
// ================================================================
router.post('/pair', async (req, res) => {
  const { name: rawName, phone, label } = req.body;
  if (!rawName || !phone) return res.status(400).json({ error: 'name e phone obrigatórios' });
  const name = rawName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const config = waLoadConfig();
  // Se instância já existe, permite re-conectar (limpeza feita abaixo)
  const cleanPhone = normalizeBRPhone(phone);

  // Limpa qualquer Chrome órfão / instância anterior com esse nome
  if (waConnections[name]?.client) {
    try { waConnections[name].client.removeAllListeners(); await waConnections[name].client.destroy(); } catch {}
    delete waConnections[name];
  }
  killOrphanChrome(name);
  // Remove da config se já existia (permite re-tentar)
  if (config.instances[name]) {
    delete config.instances[name];
    waSaveConfig(config);
  }

  let client;

  try {
    client = createClient(name);

    client.on('ready', () => {
      log.wa.info({ name, phone: cleanPhone }, 'PAREADO COM SUCESSO via código!');
      const config = waLoadConfig();
      config.instances[name] = { phone: cleanPhone, label: label || name, createdAt: new Date().toISOString(), active: true, type: 'local' };
      if (!config.defaultInstance) config.defaultInstance = name;
      waSaveConfig(config);
      waConnections[name] = { client, status: 'connected', handlerSetup: true };
      setupMessageHandler(client, name);
      if (!res.headersSent) res.json({ success: true, paired: true });
    });

    client.on('auth_failure', (msg) => {
      log.wa.error({ name, err: msg }, 'Auth falhou');
      if (!res.headersSent) res.status(500).json({ error: 'Falha na autenticação: ' + msg });
    });

    client.on('disconnected', (reason) => {
      log.wa.warn({ name, reason }, 'Desconectado durante pairing');
      if (!res.headersSent) res.status(500).json({ error: 'Desconectado: ' + reason });
    });

    // Espera o QR event para saber que está pronto, depois pede o código
    client.on('qr', async () => {
      if (res.headersSent) return;
      try {
        log.wa.info({ name, phone: cleanPhone }, 'Solicitando código de pareamento');
        const code = await client.requestPairingCode(cleanPhone);
        log.wa.info({ name, code }, 'Código gerado');
        if (!res.headersSent) res.json({ success: true, code });
      } catch (err) {
        log.wa.error({ err: err.message, name }, 'Erro ao gerar código');
        if (!res.headersSent) res.status(500).json({ error: err.message });
      }
    });

    await client.initialize();

    // Timeout 2 minutos
    setTimeout(() => {
      if (!res.headersSent) {
        try { client.removeAllListeners(); client.destroy(); } catch {}
        res.json({ success: false, message: 'Timeout — tente novamente' });
      }
    }, 120_000);
  } catch (e) {
    if (client) try { client.removeAllListeners(); client.destroy(); } catch {}
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ================================================================
// PAIRING VIA QR CODE (SSE streaming)
// ================================================================
router.get('/pair-qr', async (req, res) => {
  const { name: rawName, phone, label } = req.query;
  if (!rawName || !phone) return res.status(400).json({ error: 'name e phone obrigatórios' });
  const name = rawName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const config = waLoadConfig();
  // Se instância já existe, permite re-conectar (limpeza feita abaixo)
  const cleanPhone = normalizeBRPhone(phone);

  // Limpa Chrome órfão / instância anterior
  if (waConnections[name]?.client) {
    try { waConnections[name].client.removeAllListeners(); await waConnections[name].client.destroy(); } catch {}
    delete waConnections[name];
  }
  killOrphanChrome(name);
  if (config.instances[name]) {
    delete config.instances[name];
    waSaveConfig(config);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    if (!closed && !res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  let closed = false;
  let qrCount = 0;
  let client;
  req.on('close', () => { closed = true; });

  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': heartbeat\n\n');
    else clearInterval(heartbeat);
  }, 15_000);

  try {
    client = createClient(name);

    client.on('qr', async (qr) => {
      if (closed) return;
      qrCount++;
      log.wa.info({ name, qrCount }, `QR #${qrCount} gerado`);
      try {
        const qrImage = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
        send('qr', { qr: qrImage, count: qrCount, maxCount: 15 });
      } catch {}

      if (qrCount >= 15) {
        send('timeout', { message: 'Muitas tentativas. Recarregue.' });
        clearInterval(heartbeat);
        try { client.removeAllListeners(); client.destroy(); } catch {}
        try { res.end(); } catch {}
      }
    });

    client.on('ready', () => {
      log.wa.info({ name, phone: cleanPhone }, 'Conectado via QR!');
      const config = waLoadConfig();
      config.instances[name] = { phone: cleanPhone, label: label || name, createdAt: new Date().toISOString(), active: true, type: 'local' };
      if (!config.defaultInstance) config.defaultInstance = name;
      waSaveConfig(config);
      waConnections[name] = { client, status: 'connected', handlerSetup: true };
      setupMessageHandler(client, name);
      send('connected', { name, phone: cleanPhone });
      clearInterval(heartbeat);
      try { res.end(); } catch {}
    });

    client.on('auth_failure', (msg) => {
      log.wa.error({ name, err: msg }, 'QR auth falhou');
      send('error', { message: 'Falha na autenticação: ' + msg });
      clearInterval(heartbeat);
      try { client.removeAllListeners(); client.destroy(); } catch {}
      try { res.end(); } catch {}
    });

    client.on('disconnected', (reason) => {
      if (!closed && !res.writableEnded) {
        send('error', { message: 'Desconectado: ' + reason });
        clearInterval(heartbeat);
        try { res.end(); } catch {}
      }
    });

    await client.initialize();

    // Timeout 3 minutos
    setTimeout(() => {
      if (!closed && !res.writableEnded) {
        send('timeout', { message: 'Timeout — tente novamente' });
        clearInterval(heartbeat);
        try { client.removeAllListeners(); client.destroy(); } catch {}
        try { res.end(); } catch {}
      }
    }, 180_000);
  } catch (e) {
    log.wa.error({ err: e.message, name }, 'Erro no QR pairing');
    if (client) try { client.removeAllListeners(); client.destroy(); } catch {}
    send('error', { message: e.message });
    clearInterval(heartbeat);
    try { res.end(); } catch {}
  }
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
    const chatId = jid.includes('@') ? jid : jid + '@c.us';
    await conn.client.sendMessage(chatId, message);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================================================================
// CONTATOS
// ================================================================
router.get('/contacts', async (req, res) => {
  try {
    const { contactsDB } = await import('../database.js');
    const all = contactsDB.getAll();
    res.json({ contacts: all, count: all.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/contacts/sync', async (req, res) => {
  try {
    const config = waLoadConfig();
    const instName = req.body?.instance || config.defaultInstance;
    const conn = instName && waConnections[instName];
    if (!conn?.client || conn.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não conectado' });
    }

    const contacts = await conn.client.getContacts();
    const { contactsDB } = await import('../database.js');
    const result = contactsDB.syncFromWhatsApp(contacts);

    // Salva arquivo JSON local legível
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');
    const { ROOT_DIR } = await import('../config.js');
    const agenda = contacts
      .filter(c => c.id?.user && c.isMyContact)
      .map(c => ({
        nome: c.name || c.pushname || c.shortName || c.id.user,
        telefone: c.id.user,
        pushname: c.pushname || '',
        isGroup: c.isGroup || false,
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome));

    const filePath = join(ROOT_DIR, 'data', 'contatos.json');
    writeFileSync(filePath, JSON.stringify(agenda, null, 2), 'utf-8');

    log.wa.info({ synced: result.synced, file: agenda.length }, 'Contatos sincronizados + arquivo salvo');
    res.json({ success: true, synced: result.synced, failed: result.failed, file: agenda.length, path: 'data/contatos.json' });
  } catch (e) {
    log.wa.error({ err: e.message }, 'Erro sync contatos');
    res.status(500).json({ error: e.message });
  }
});

router.delete('/instances/:name', async (req, res) => {
  const name = req.params.name;
  const config = waLoadConfig();
  if (!config.instances[name]) return res.status(404).json({ error: 'Não encontrada' });
  if (waConnections[name]?.client) {
    try {
      waConnections[name].client.removeAllListeners();
      await waConnections[name].client.destroy();
    } catch {}
  }
  delete waConnections[name];
  // Limpa auth
  const authDir = join(WA_DIR, 'wwebjs', `session-${name}`);
  if (existsSync(authDir)) rmSync(authDir, { recursive: true });
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
    try {
      waConnections[req.params.name].client.removeAllListeners();
      await waConnections[req.params.name].client.destroy();
    } catch {}
  }
  await waConnect(req.params.name);
  res.json({ ok: true, status: waConnections[req.params.name]?.status });
});

// Outbox monitor
export function startOutboxMonitor() {
  setInterval(() => {
    if (existsSync(OUTBOX)) {
      try {
        const data = JSON.parse(readFileSync(OUTBOX, 'utf-8'));
        if (data.text && data.jid) {
          sendWhatsApp(data.jid.replace('@c.us', ''), data.text);
          unlinkSync(OUTBOX);
        }
      } catch {}
    }
  }, 1000);
}

export default router;
