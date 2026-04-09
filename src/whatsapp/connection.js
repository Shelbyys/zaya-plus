import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { join } from 'path';
import { writeFileSync, mkdirSync, existsSync, cpSync, rmSync, readdirSync } from 'fs';
import { WA_DIR, ROOT_DIR } from '../config.js';
import { waConnections } from '../state.js';
import { waLoadConfig, waSaveConfig } from './utils.js';
import { setupMessageHandler } from './handler.js';
import { log } from '../logger.js';
import { contactsDB } from '../database.js';
import { syncContactsBatchToSupabase, isSupabaseEnabled } from '../services/supabase.js';

// ================================================================
// SESSION MANAGEMENT — backup, restore, e limpeza
// ================================================================

const BACKUP_SUFFIX = '.bak';
const MAX_RECONNECT_ATTEMPTS = 10;
// Versão Baileys hardcoded como fallback quando API está fora
const BAILEYS_VERSION_FALLBACK = [2, 3000, 1015901307];

function getSessionPath(name) {
  return join(WA_DIR, 'baileys', `session-${name}`);
}

function getBackupPath(name) {
  return join(WA_DIR, 'baileys', `session-${name}${BACKUP_SUFFIX}`);
}

function backupSession(name) {
  const authDir = getSessionPath(name);
  const backupDir = getBackupPath(name);
  try {
    if (!existsSync(authDir)) return;
    const files = readdirSync(authDir);
    if (files.length < 2) return;
    if (existsSync(backupDir)) rmSync(backupDir, { recursive: true });
    cpSync(authDir, backupDir, { recursive: true });
    log.wa.info({ instance: name }, 'Backup da sessao criado');
  } catch (e) {
    log.wa.warn({ err: e.message, instance: name }, 'Falha ao criar backup da sessao');
  }
}

function restoreSession(name) {
  const authDir = getSessionPath(name);
  const backupDir = getBackupPath(name);
  try {
    if (!existsSync(backupDir)) return false;
    if (existsSync(authDir)) rmSync(authDir, { recursive: true });
    cpSync(backupDir, authDir, { recursive: true });
    log.wa.info({ instance: name }, 'Sessao restaurada do backup');
    return true;
  } catch (e) {
    log.wa.warn({ err: e.message, instance: name }, 'Falha ao restaurar backup da sessao');
    return false;
  }
}

// Limpa pasta de sessão — usado antes de um novo pareamento
export function cleanSession(name) {
  const authDir = getSessionPath(name);
  try {
    if (existsSync(authDir)) {
      rmSync(authDir, { recursive: true, force: true });
      log.wa.info({ instance: name }, 'Sessao removida para novo pareamento');
    }
  } catch (e) {
    log.wa.warn({ err: e.message, instance: name }, 'Falha ao limpar sessao');
  }
}

// Busca versão do Baileys com timeout e fallback
async function safeGetBaileysVersion() {
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 5000)
    );
    const result = await Promise.race([fetchLatestBaileysVersion(), timeout]);
    return result.version;
  } catch (e) {
    log.wa.warn({ err: e.message }, 'fetchLatestBaileysVersion falhou — usando fallback');
    return BAILEYS_VERSION_FALLBACK;
  }
}

// ================================================================
// HEALTH CHECK — detecta conexões zombie
// ================================================================

const HEALTH_CHECK_INTERVAL = 2 * 60 * 1000; // 2 minutos
const _healthIntervals = {};

function startHealthCheck(name) {
  stopHealthCheck(name);
  _healthIntervals[name] = setInterval(async () => {
    const conn = waConnections[name];
    if (!conn?.client || conn.status !== 'connected') return;
    try {
      // Tenta buscar status do próprio número como ping
      const state = conn.client.ws?.readyState;
      // WebSocket states: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
      if (state !== 1) {
        log.wa.warn({ instance: name, wsState: state }, 'Health check: WebSocket nao esta aberto — reconectando');
        conn.status = 'disconnected';
        stopHealthCheck(name);
        try { conn.client.end(); } catch {}
        waConnect(name);
      }
    } catch (e) {
      log.wa.warn({ instance: name, err: e.message }, 'Health check falhou');
    }
  }, HEALTH_CHECK_INTERVAL);
}

function stopHealthCheck(name) {
  if (_healthIntervals[name]) {
    clearInterval(_healthIntervals[name]);
    delete _healthIntervals[name];
  }
}

// ================================================================
// SYNC DEBOUNCE — evita sync repetido em reconexões rápidas
// ================================================================

const _lastSyncTime = {};
const SYNC_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutos

function shouldSync(name) {
  const now = Date.now();
  if (_lastSyncTime[name] && (now - _lastSyncTime[name]) < SYNC_DEBOUNCE_MS) {
    log.wa.info({ instance: name }, 'Sync ignorado (debounce — ultimo sync ha menos de 5min)');
    return false;
  }
  _lastSyncTime[name] = now;
  return true;
}

// Limpa estado interno da instância (usado ao deletar)
export function clearInstanceState(name) {
  delete _lastSyncTime[name];
  stopHealthCheck(name);
}

// ================================================================
// CREATE CLIENT
// ================================================================

export async function createClient(name) {
  const authDir = join(WA_DIR, 'baileys', `session-${name}`);
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await safeGetBaileysVersion();

  // Store simples para guardar contatos e chats
  const store = { contacts: {}, chats: {} };

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ['ZAYA Plus', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 500,
    connectTimeoutMs: 60000,
  });

  // Captura contatos e chats nos eventos do Baileys
  sock.ev.on('contacts.set', (data) => {
    const contacts = data?.contacts || data || [];
    if (Array.isArray(contacts)) {
      for (const c of contacts) { if (c.id) store.contacts[c.id] = c; }
    }
  });
  sock.ev.on('contacts.update', (updates) => {
    if (Array.isArray(updates)) {
      for (const u of updates) { if (u.id) store.contacts[u.id] = { ...store.contacts[u.id], ...u }; }
    }
  });
  sock.ev.on('chats.set', (data) => {
    const chats = data?.chats || data || [];
    if (Array.isArray(chats)) {
      for (const c of chats) { if (c.id) store.chats[c.id] = c; }
    }
  });
  sock.ev.on('chats.upsert', (chats) => {
    if (Array.isArray(chats)) {
      for (const c of chats) { if (c.id) store.chats[c.id] = c; }
    }
  });
  sock.store = store;

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
  stopHealthCheck(name);
  if (waConnections[name]?.client) {
    try { waConnections[name].client.end(); } catch {}
  }

  // Backup da sessão antes de reconectar
  backupSession(name);

  waConnections[name] = { client: null, status: 'connecting', handlerSetup: false, _retries: waConnections[name]?._retries || 0 };

  try {
    log.wa.info({ instance: name }, 'Conectando via Baileys...');
    const sock = await createClient(name);
    waConnections[name].client = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.wa.info({ instance: name }, 'QR Code gerado');
        waConnections[name].qr = qr;
      }

      if (connection === 'open') {
        waConnections[name].status = 'connected';
        waConnections[name].qr = null;
        waConnections[name]._retries = 0;
        waConnections[name]._restoredThisSession = false;
        log.wa.info({ instance: name }, 'Conectado com sucesso via Baileys!');

        // Inicia health check
        startHealthCheck(name);

        // Backup da sessão conectada (para ter backup válido)
        setTimeout(() => backupSession(name), 5000);

        // Registra handler apenas uma vez
        if (!waConnections[name].handlerSetup) {
          setupMessageHandler(sock, name);
          waConnections[name].handlerSetup = true;
        }

        // Sync contatos com debounce — espera 3s para o store popular
        setTimeout(() => {
          if (shouldSync(name)) {
            syncAllContacts(sock, name).catch(e => {
              log.wa.error({ err: e.message }, 'Erro sync contatos');
            });
          }
        }, 3000);
      }

      if (connection === 'close') {
        waConnections[name].status = 'disconnected';
        waConnections[name].handlerSetup = false;
        stopHealthCheck(name);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'desconhecido';
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        log.wa.warn({ instance: name, statusCode, reason, shouldReconnect }, 'Desconectado');

        if (shouldReconnect) {
          const retries = waConnections[name]._retries || 0;

          // Limite de reconexões
          if (retries >= MAX_RECONNECT_ATTEMPTS) {
            log.wa.error({ instance: name, retries }, 'Limite de reconexao atingido. Necessario parear novamente.');
            waConnections[name].status = 'needs_repairing';
            waConnections[name]._retries = 0;

            // Notifica dashboard
            try {
              const { io } = await import('../state.js');
              io?.emit('wa-needs-repair', { instance: name, reason: 'max_retries' });
            } catch {}
            return;
          }

          // Erro 515 = stream error (sessão corrompida ou mismatch de versão)
          // Restaura backup já na primeira ocorrência
          if (statusCode === 515 && !waConnections[name]._restoredThisSession) {
            log.wa.info({ instance: name }, 'Erro 515 detectado — restaurando sessao do backup...');
            if (restoreSession(name)) {
              waConnections[name]._restoredThisSession = true;
            }
          }

          const delay = Math.min(5000 * (retries + 1), 30000);
          waConnections[name]._retries = retries + 1;

          log.wa.info({ instance: name, delay, retry: retries + 1, maxRetries: MAX_RECONNECT_ATTEMPTS }, 'Reconectando...');
          setTimeout(() => waConnect(name), delay);
        } else {
          log.wa.info({ instance: name }, 'Logout — nao reconecta');
          waConnections[name]._retries = 0;
          waConnections[name].status = 'logged_out';
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

    // Atualização incremental de contatos (nome mudou, etc)
    sock.ev.on('contacts.update', (updates) => {
      if (!updates?.length) return;
      for (const u of updates) {
        if (!u.id || u.id.includes('@g.us') || u.id.includes('@broadcast')) continue;
        const nome = u.name || u.notify || u.id.split('@')[0];
        const telefone = u.id.split('@')[0];
        contactsDB.upsert(nome, telefone, u.id);
      }
      log.wa.info({ instance: name, count: updates.length }, 'Contatos atualizados incrementalmente');
    });

  } catch (e) {
    log.wa.error({ instance: name, err: e.message }, 'Erro fatal na conexão Baileys');
    waConnections[name] = { client: null, status: 'error', handlerSetup: false };
  }
}

export async function syncAllContacts(sock, name) {
  let total = 0;

  // 1. Contatos do store (se disponível)
  try {
    const store = sock.store;
    if (store?.contacts) {
      const contacts = Object.values(store.contacts);
      const agenda = contacts
        .filter(c => c.id && !c.id.includes('@g.us') && !c.id.includes('@broadcast'))
        .map(c => ({
          nome: c.name || c.notify || c.id.split('@')[0],
          telefone: c.id.split('@')[0],
          jid: c.id,
        }));

      for (const c of agenda) {
        contactsDB.upsert(c.nome, c.telefone, c.jid);
      }
      total += agenda.length;
    }
  } catch (e) {
    log.wa.warn({ err: e.message }, 'Sync store contacts falhou');
  }

  // 2. Puxa contatos de TODOS os chats existentes (pega quem já conversou)
  try {
    const chats = await sock.groupFetchAllParticipating().catch(() => ({}));
    // Chats 1:1 vêm do store, mas vamos garantir pegando dos chats ativos
    const store = sock.store;
    if (store?.chats) {
      const allChats = Object.values(store.chats);
      for (const chat of allChats) {
        const id = chat.id || chat.jid;
        if (!id || id.includes('@g.us') || id.includes('@broadcast')) continue;
        const phone = id.split('@')[0];
        if (phone.length >= 8) {
          const nome = chat.name || chat.pushname || chat.notify || phone;
          contactsDB.upsert(nome, phone, id);
          total++;
        }
      }
    }
  } catch (e) {
    log.wa.warn({ err: e.message }, 'Sync chat contacts falhou');
  }

  // 3. Salva JSON atualizado com TODOS os contatos do banco
  try {
    const allContacts = contactsDB.getAll();
    const dataDir = join(ROOT_DIR, 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'contatos.json'),
      JSON.stringify(allContacts.sort((a, b) => (a.nome || '').localeCompare(b.nome || '')), null, 2),
      'utf-8'
    );
  } catch {}

  // 4. Sync tudo pro Supabase (se habilitado)
  if (isSupabaseEnabled()) {
    try {
      const allContacts = contactsDB.getAll();
      const formatted = allContacts.map(c => ({ nome: c.nome, telefone: c.telefone, jid: c.jid }));
      const result = await syncContactsBatchToSupabase(formatted);
      log.wa.info({ synced: result.synced, errors: result.errors }, 'Contatos sincronizados com Supabase');
    } catch (e) {
      log.wa.warn({ err: e.message }, 'Sync Supabase contacts falhou');
    }
  }

  log.wa.info({ instance: name, total }, 'Sync completo de contatos');
}

export { backupSession, restoreSession, startHealthCheck, stopHealthCheck };
// cleanSession já é exportado como `export function` acima

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
