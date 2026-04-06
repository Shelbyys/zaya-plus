import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { join } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { WA_DIR, ROOT_DIR } from '../config.js';
import { waConnections } from '../state.js';
import { waLoadConfig, waSaveConfig } from './utils.js';
import { setupMessageHandler } from './handler.js';
import { log } from '../logger.js';
import { contactsDB } from '../database.js';
import { syncContactsBatchToSupabase, isSupabaseEnabled } from '../services/supabase.js';

export async function createClient(name) {
  const authDir = join(WA_DIR, 'baileys', `session-${name}`);
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['ZAYA Plus', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  // Salva credenciais quando atualizam
  sock.ev.on('creds.update', saveCreds);

  return sock;
}

export async function waConnect(name) {
  const config = waLoadConfig();
  const inst = config.instances[name];
  if (!inst) return;

  // WaSender: não precisa de conexão local
  if (inst.type === 'wasender') {
    waConnections[name] = { client: null, status: 'connected', handlerSetup: false };
    log.wa.info({ instance: name }, 'WaSender — conexão gerenciada pela API');
    return;
  }

  // Limpa conexão anterior
  if (waConnections[name]?.client) {
    try { waConnections[name].client.end(); } catch {}
  }

  waConnections[name] = { client: null, status: 'connecting', handlerSetup: false };

  try {
    log.wa.info({ instance: name }, 'Conectando via Baileys...');
    const sock = await createClient(name);
    waConnections[name].client = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.wa.info({ instance: name }, 'QR Code gerado');
        // QR é emitido pelo evento — usado pelo pairing endpoint
        waConnections[name].qr = qr;
      }

      if (connection === 'open') {
        waConnections[name].status = 'connected';
        waConnections[name].qr = null;
        log.wa.info({ instance: name }, 'Conectado com sucesso via Baileys!');

        // Registra handler apenas uma vez
        if (!waConnections[name].handlerSetup) {
          setupMessageHandler(sock, name);
          waConnections[name].handlerSetup = true;
        }

        // Sync contatos
        syncContacts(sock, name).catch(e => {
          log.wa.error({ err: e.message }, 'Erro sync contatos');
        });
      }

      if (connection === 'close') {
        waConnections[name].status = 'disconnected';
        waConnections[name].handlerSetup = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        log.wa.warn({ instance: name, statusCode, shouldReconnect }, 'Desconectado');

        if (shouldReconnect) {
          setTimeout(() => {
            log.wa.info({ instance: name }, 'Reconectando...');
            waConnect(name);
          }, 5000);
        } else {
          log.wa.info({ instance: name }, 'Logout — não reconecta');
        }
      }
    });

    // Detectar contatos
    sock.ev.on('contacts.set', ({ contacts: waContacts }) => {
      if (waContacts?.length > 0) {
        log.wa.info({ instance: name, count: waContacts.length }, 'Contatos recebidos do WhatsApp');
        const agenda = waContacts
          .filter(c => c.id && !c.id.includes('@g.us'))
          .map(c => ({
            nome: c.name || c.notify || c.id.split('@')[0],
            telefone: c.id.split('@')[0],
            jid: c.id,
          }));

        // Salva no SQLite
        for (const c of agenda) {
          contactsDB.upsert(c.nome, c.telefone, c.jid);
        }

        // Salva arquivo JSON
        const dataDir = join(ROOT_DIR, 'data');
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, 'contatos.json'), JSON.stringify(agenda.sort((a, b) => a.nome.localeCompare(b.nome)), null, 2), 'utf-8');

        // Supabase batch
        if (isSupabaseEnabled()) {
          syncContactsBatchToSupabase(agenda).catch(() => {});
        }

        log.wa.info({ instance: name, saved: agenda.length }, 'Contatos sincronizados');
      }
    });

  } catch (e) {
    log.wa.error({ instance: name, err: e.message }, 'Erro fatal na conexão Baileys');
    waConnections[name] = { client: null, status: 'error', handlerSetup: false };
  }
}

async function syncContacts(sock, name) {
  try {
    const store = sock.store;
    if (!store?.contacts) return;

    const contacts = Object.values(store.contacts);
    const agenda = contacts
      .filter(c => c.id && !c.id.includes('@g.us'))
      .map(c => ({
        nome: c.name || c.notify || c.id.split('@')[0],
        telefone: c.id.split('@')[0],
        jid: c.id,
      }));

    for (const c of agenda) {
      contactsDB.upsert(c.nome, c.telefone, c.jid);
    }

    log.wa.info({ instance: name, count: agenda.length }, 'Contatos synced do store');
  } catch {}
}

export async function waAutoConnect() {
  const config = waLoadConfig();
  const instances = Object.entries(config.instances).filter(([, inst]) => inst.active);
  if (instances.length === 0) {
    log.wa.info('Nenhuma instância para conectar');
    return;
  }

  for (const [name] of instances) {
    log.wa.info({ instance: name }, 'Auto-conectando');
    await waConnect(name);
  }
}
