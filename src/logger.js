import pino from 'pino';
import { join } from 'path';
import { ROOT_DIR } from './config.js';

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDev ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
      messageFormat: '{msg}',
    },
  } : undefined,
  // Em produção, JSON para arquivo
  ...(!isDev ? {
    destination: pino.destination({
      dest: join(ROOT_DIR, 'zaya.log'),
      sync: false,
      mkdir: true,
    }),
  } : {}),
});

// Child loggers pré-configurados por módulo
export const log = {
  server: logger.child({ module: 'server' }),
  ai: logger.child({ module: 'ai' }),
  wa: logger.child({ module: 'whatsapp' }),
  research: logger.child({ module: 'research' }),
  media: logger.child({ module: 'media' }),
  api: logger.child({ module: 'api' }),
  db: logger.child({ module: 'db' }),
};

export default logger;
