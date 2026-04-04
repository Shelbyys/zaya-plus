import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { log } from '../logger.js';

// ================================================================
// HELMET — headers de segurança
// ================================================================
export const securityHeaders = helmet({
  contentSecurityPolicy: false, // desativa CSP pra não quebrar o frontend
  crossOriginEmbedderPolicy: false,
});

// ================================================================
// RATE LIMITING
// ================================================================

// Login: máximo 5 tentativas por IP a cada 15 minutos
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    log.server.warn({ ip: req.ip }, 'Rate limit atingido: login');
    res.status(options.statusCode).json(options.message);
  },
});

// API geral: 100 requests por minuto por IP
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Limite de requests atingido. Aguarde 1 minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Não limita WebSocket polling e assets estáticos
    if (req.path.startsWith('/socket.io')) return true;
    return false;
  },
});

// Chat: máximo 20 requests por minuto (cada chat é caro — API OpenAI)
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Muitos requests de chat. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ================================================================
// EXEC SANITIZATION
// ================================================================
const EXEC_BLOCKED = [
  /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r)\b/i,  // rm -rf, rm -f, rm -fr
  /\brm\s+.*[\/~]/i,                         // rm com paths absolutos
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkill\s+-9\s+1\b/,                       // kill -9 1 (init)
  /\b(chmod|chown)\s+.*\s+\//i,              // chmod/chown em paths raiz
  /\bcurl\b.*\|\s*(bash|sh|zsh)\b/i,         // curl pipe to shell
  /\bwget\b.*\|\s*(bash|sh|zsh)\b/i,
  />\s*\/etc\//i,                              // redirect para /etc
  />\s*\/System\//i,                           // redirect para /System
  /\blaunchctl\b/i,                           // manipulação de daemons
  /\bnohup\b.*&/i,                            // processos persistentes em background
  /\beval\b/i,                                // eval de código
];

export function sanitizeCommand(cmd) {
  for (const pattern of EXEC_BLOCKED) {
    if (pattern.test(cmd)) {
      log.server.warn({ cmd: cmd.slice(0, 100) }, 'Comando bloqueado por segurança');
      return { allowed: false, reason: 'Comando bloqueado por segurança.' };
    }
  }
  return { allowed: true };
}

// ================================================================
// STARTUP SECURITY CHECKS
// ================================================================
export function securityChecks() {
  const senha = process.env.BOT_PASSWORD || 'admin';
  if (senha === 'admin') {
    log.server.warn('AVISO: BOT_PASSWORD está com o valor padrão "admin". Altere no .env para maior segurança!');
  }
  if (!process.env.OPENAI_API_KEY) {
    log.server.warn('AVISO: OPENAI_API_KEY não configurada');
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    log.server.warn('AVISO: ELEVENLABS_API_KEY não configurada (TTS desabilitado)');
  }
}
