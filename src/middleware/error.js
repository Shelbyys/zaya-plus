import { log } from '../logger.js';

// Request logging middleware
export function requestLogger(req, res, next) {
  const start = Date.now();
  const originalEnd = res.end;

  res.end = function (...args) {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    // Só loga rotas /api (ignora static files e socket.io)
    if (req.path.startsWith('/api')) {
      log.api[level]({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: `${duration}ms`,
      }, `${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }

    originalEnd.apply(res, args);
  };

  next();
}

// Express error handler (deve ser o último middleware)
export function errorHandler(err, req, res, next) {
  log.api.error({
    err: { message: err.message, stack: err.stack },
    method: req.method,
    path: req.path,
  }, `Unhandled error: ${err.message}`);

  if (res.headersSent) return next(err);

  res.status(500).json({
    error: 'Erro interno do servidor',
    message: process.env.NODE_ENV !== 'production' ? err.message : undefined,
  });
}

// Process-level error handlers
export function setupProcessHandlers() {
  process.on('uncaughtException', (err) => {
    log.server.fatal({ err: { message: err.message, stack: err.stack } }, `Uncaught exception: ${err.message}`);
    // Dá tempo para o log ser escrito
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    log.server.error({ err: { message: msg, stack } }, `Unhandled rejection: ${msg}`);
  });
}
