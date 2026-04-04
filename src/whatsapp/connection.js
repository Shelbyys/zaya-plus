import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { join } from 'path';
import { WA_DIR } from '../config.js';
import { waConnections } from '../state.js';
import { waLoadConfig, waSaveConfig } from './utils.js';
import { setupMessageHandler } from './handler.js';
import { log } from '../logger.js';

const PUPPETEER_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--no-first-run', '--no-zygote',
  '--disable-extensions',
];

export function createClient(name) {
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: name,
      dataPath: join(WA_DIR, 'wwebjs'),
    }),
    puppeteer: {
      headless: true,
      args: PUPPETEER_ARGS,
      protocolTimeout: 120_000, // 2min (evita "Runtime.callFunctionOn timed out")
    },
    restartOnAuthFail: true,
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/nicol4s0/nicol4s0/refs/heads/main/nicol4s0' },
  });

  return client;
}

export async function waConnect(name) {
  const config = waLoadConfig();
  const inst = config.instances[name];
  if (!inst) return;

  // WaSender: não precisa de conexão local (gerenciado pela API)
  if (inst.type === 'wasender') {
    waConnections[name] = { client: null, status: 'connected' };
    log.wa.info({ instance: name }, 'WaSender — conexão gerenciada pela API');
    return;
  }

  if (!waConnections[name]) waConnections[name] = { client: null, status: 'connecting' };
  waConnections[name].status = 'connecting';

  try {
    log.wa.info({ instance: name }, 'Conectando...');
    const client = createClient(name);

    client.on('qr', () => {
      log.wa.info({ instance: name }, 'QR gerado (auto-connect)');
    });

    client.on('ready', () => {
      waConnections[name].status = 'connected';
      waConnections[name].client = client;
      log.wa.info({ instance: name }, 'Conectado com sucesso!');
      setupMessageHandler(client, name);
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
      // Destroy client limpo (fecha Chrome)
      try { await client.destroy(); } catch {}
      waConnections[name].client = null;

      // Reconecta após 10 segundos (dá tempo do Chrome fechar)
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

    waConnections[name].client = client;
    await client.initialize();
  } catch (e) {
    log.wa.error({ instance: name, err: e.message }, 'Erro fatal na conexão');
    waConnections[name] = { client: null, status: 'error' };
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
