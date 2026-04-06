import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { join } from 'path';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { WA_DIR, ROOT_DIR, CHROME_PATH } from '../config.js';
import { waConnections } from '../state.js';
import { waLoadConfig, waSaveConfig } from './utils.js';
import { setupMessageHandler } from './handler.js';
import { log } from '../logger.js';
import { contactsDB } from '../database.js';
import { syncContactsBatchToSupabase, isSupabaseEnabled } from '../services/supabase.js';

const PUPPETEER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--no-first-run', '--no-zygote',
  '--disable-extensions',
];

export function createClient(name) {
  log.wa.info({ chrome: CHROME_PATH, instance: name }, 'Criando client WA');
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: name,
      dataPath: join(WA_DIR, 'wwebjs'),
    }),
    puppeteer: {
      headless: true,
      args: PUPPETEER_ARGS,
      protocolTimeout: 120_000,
      executablePath: CHROME_PATH,
    },
    restartOnAuthFail: true,
    webVersionCache: { type: 'none' },
  });

  return client;
}

export async function waConnect(name) {
  const config = waLoadConfig();
  const inst = config.instances[name];
  if (!inst) return;

  // WaSender: não precisa de conexão local (gerenciado pela API)
  if (inst.type === 'wasender') {
    waConnections[name] = { client: null, status: 'connected', handlerSetup: false };
    log.wa.info({ instance: name }, 'WaSender — conexão gerenciada pela API');
    return;
  }

  // Limpa client anterior se existir (evita memory leak de listeners)
  if (waConnections[name]?.client) {
    try {
      waConnections[name].client.removeAllListeners();
      await waConnections[name].client.destroy();
    } catch {}
  }

  waConnections[name] = { client: null, status: 'connecting', handlerSetup: false };

  try {
    log.wa.info({ instance: name }, 'Conectando...');
    const client = createClient(name);

    client.on('qr', () => {
      log.wa.info({ instance: name }, 'QR gerado (auto-connect)');
    });

    client.on('ready', async () => {
      waConnections[name].status = 'connected';
      waConnections[name].client = client;
      log.wa.info({ instance: name }, 'Conectado com sucesso!');

      // Registra handler apenas uma vez
      if (!waConnections[name].handlerSetup) {
        setupMessageHandler(client, name);
        waConnections[name].handlerSetup = true;
      }

      // Sync contatos do WhatsApp para o banco local + arquivo JSON
      try {
        const contacts = await client.getContacts();
        const result = contactsDB.syncFromWhatsApp(contacts);

        // Salva arquivo data/contatos.json
        const dataDir = join(ROOT_DIR, 'data');
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
        const agenda = contacts
          .filter(c => c.id?.user && (c.isMyContact || c.name || c.pushname))
          .map(c => ({
            nome: c.name || c.pushname || c.shortName || c.id.user,
            telefone: c.id.user,
            pushname: c.pushname || '',
          }))
          .sort((a, b) => a.nome.localeCompare(b.nome));
        writeFileSync(join(dataDir, 'contatos.json'), JSON.stringify(agenda, null, 2), 'utf-8');

        // Sync batch para Supabase (lotes de 500)
        if (isSupabaseEnabled()) {
          syncContactsBatchToSupabase(agenda).then(r => {
            log.wa.info({ instance: name, synced: r.synced, errors: r.errors }, 'Contatos sincronizados com Supabase');
          }).catch(e => {
            log.wa.warn({ err: e.message }, 'Erro sync batch Supabase');
          });
        }

        log.wa.info({ instance: name, synced: result.synced, file: agenda.length }, 'Contatos sincronizados + arquivo salvo');
      } catch (e) {
        log.wa.error({ instance: name, err: e.message }, 'Erro ao sincronizar contatos');
      }
    });

    client.on('authenticated', () => {
      log.wa.info({ instance: name }, 'Autenticado');
    });

    client.on('auth_failure', (msg) => {
      log.wa.error({ instance: name, err: msg }, 'Falha na autenticação');
      waConnections[name].status = 'auth_failed';
    });

    client.on('disconnected', async (reason) => {
      log.wa.warn({ instance: name, reason }, 'Desconectado');
      waConnections[name].status = 'disconnected';
      waConnections[name].handlerSetup = false;

      // Remove todos os listeners antes de destruir (evita memory leak)
      client.removeAllListeners();
      try { await client.destroy(); } catch {}
      waConnections[name].client = null;

      // Reconecta após 10 segundos
      if (reason !== 'LOGOUT') {
        setTimeout(() => {
          log.wa.info({ instance: name }, 'Reconectando...');
          waConnect(name);
        }, 10000);
      }
    });

    client.on('change_state', (state) => {
      log.wa.debug({ instance: name, state }, 'Estado mudou');
    });

    // Inicializa com timeout de 60s
    await Promise.race([
      client.initialize(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ao inicializar Chrome (60s)')), 60000)),
    ]);
  } catch (e) {
    log.wa.error({ instance: name, err: e.message }, 'Erro fatal na conexão');
    waConnections[name] = { client: null, status: 'error', handlerSetup: false };
  }
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
