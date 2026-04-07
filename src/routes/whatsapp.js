import { Router } from 'express';
import { existsSync, mkdirSync, rmSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import QRCode from 'qrcode';
import { WA_DIR, OUTBOX } from '../config.js';
import { waConnections } from '../state.js';
import { waLoadConfig, waSaveConfig } from '../whatsapp/utils.js';
import { normalizeBRPhone, sendWhatsApp } from '../services/messaging.js';
import { waConnect, createClient, syncAllContacts } from '../whatsapp/connection.js';
import { setupMessageHandler } from '../whatsapp/handler.js';
import { contactsDB } from '../database.js';
import { log } from '../logger.js';

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
router.post('/pair', async (req, res) => {
  const { name: rawName, phone, label } = req.body;
  if (!rawName || !phone) return res.status(400).json({ error: 'name e phone obrigatórios' });
  const name = rawName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const cleanPhone = normalizeBRPhone(phone);

  // Limpa instância anterior
  if (waConnections[name]?.client) {
    try { waConnections[name].client.end(); } catch {}
    delete waConnections[name];
  }
  const config = waLoadConfig();
  if (config.instances[name]) { delete config.instances[name]; waSaveConfig(config); }

  try {
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
router.get('/pair-qr', async (req, res) => {
  const { name: rawName, phone, label } = req.query;
  if (!rawName || !phone) return res.status(400).json({ error: 'name e phone obrigatórios' });
  const name = rawName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const cleanPhone = normalizeBRPhone(phone);

  // Limpa instância anterior
  if (waConnections[name]?.client) {
    try { waConnections[name].client.end(); } catch {}
    delete waConnections[name];
  }
  const config = waLoadConfig();
  if (config.instances[name]) { delete config.instances[name]; waSaveConfig(config); }

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
  req.on('close', () => { closed = true; });

  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': heartbeat\n\n');
    else clearInterval(heartbeat);
  }, 15_000);

  try {
    const sock = await createClient(name);
    waConnections[name] = { client: sock, status: 'connecting', handlerSetup: false };

    sock.ev.on('connection.update', async (update) => {
      const { connection, qr } = update;

      if (qr && !closed) {
        qrCount++;
        log.wa.info({ name, qrCount }, `QR #${qrCount} gerado`);
        try {
          const qrImage = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
          send('qr', { qr: qrImage, count: qrCount, maxCount: 15 });
        } catch {}

        if (qrCount >= 15) {
          send('timeout', { message: 'Muitas tentativas. Recarregue.' });
          clearInterval(heartbeat);
          try { sock.end(); } catch {}
          try { res.end(); } catch {}
        }
      }

      if (connection === 'open') {
        log.wa.info({ name, phone: cleanPhone }, 'Conectado via QR (Baileys)!');
        const cfg = waLoadConfig();
        cfg.instances[name] = { phone: cleanPhone, label: label || name, createdAt: new Date().toISOString(), active: true, type: 'local' };
        if (!cfg.defaultInstance) cfg.defaultInstance = name;
        waSaveConfig(cfg);
        waConnections[name].status = 'connected';
        setupMessageHandler(sock, name);
        waConnections[name].handlerSetup = true;
        send('connected', { name, phone: cleanPhone });
        clearInterval(heartbeat);
        try { res.end(); } catch {}
      }

      if (connection === 'close' && !closed) {
        send('error', { message: 'Conexão fechada' });
        clearInterval(heartbeat);
        try { res.end(); } catch {}
      }
    });

    // Timeout 3 minutos
    setTimeout(() => {
      if (!closed && !res.writableEnded) {
        send('timeout', { message: 'Timeout — tente novamente' });
        clearInterval(heartbeat);
        try { sock.end(); } catch {}
        try { res.end(); } catch {}
      }
    }, 180_000);
  } catch (e) {
    log.wa.error({ err: e.message, name }, 'Erro no QR pairing Baileys');
    send('error', { message: e.message });
    clearInterval(heartbeat);
    try { res.end(); } catch {}
  }
});

// ================================================================
// CONTACTS
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
  const authDir = join(WA_DIR, 'baileys', `session-${name}`);
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
    try { waConnections[req.params.name].client.end(); } catch {}
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
          sendWhatsApp(data.jid.replace('@c.us', '').replace('@s.whatsapp.net', ''), data.text);
          unlinkSync(OUTBOX);
        }
      } catch {}
    }
  }, 1000);
}

export default router;
