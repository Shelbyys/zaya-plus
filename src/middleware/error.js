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
// P12: detecta se é rota /api (JSON) ou HTML (browser) e responde apropriadamente
export function errorHandler(err, req, res, next) {
  log.api.error({
    err: { message: err.message, stack: err.stack },
    method: req.method,
    path: req.path,
  }, `Unhandled error: ${err.message}`);

  if (res.headersSent) return next(err);

  // Detecta se é rota de API ou HTML
  const isApi = req.path.startsWith('/api') || req.path.startsWith('/webhook') || req.headers.accept?.includes('application/json');
  const showStack = process.env.NODE_ENV !== 'production';

  if (isApi) {
    return res.status(500).json({
      error: 'Erro interno do servidor',
      message: showStack ? err.message : undefined,
    });
  }

  // Página HTML de erro pra browsers
  res.status(500).type('html').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZAYA — Erro</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0b09;color:#f0ece4;font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.box{background:rgba(0,0,0,0.5);border:1px solid rgba(243,102,0,0.2);border-radius:12px;padding:40px;max-width:540px;text-align:center}
h1{color:#f36600;font-family:'Space Mono',monospace;letter-spacing:6px;margin-bottom:8px}
p{color:rgba(240,236,228,0.6);margin-bottom:20px;font-size:14px}
code{display:block;background:rgba(0,0,0,0.5);padding:14px;border-radius:6px;color:#ff8833;font-size:12px;margin-top:16px;text-align:left;overflow-x:auto;word-break:break-all}
a{color:#f36600;text-decoration:none;font-size:12px;letter-spacing:2px;margin-top:20px;display:inline-block}
</style>
</head>
<body>
<div class="box">
<h1>ZAYA</h1>
<p>Algo deu errado ao processar essa rota.</p>
${showStack ? `<code>${escapeHtml(err.message)}</code>` : ''}
<a href="/">← Voltar pro inicio</a>
</div>
</body>
</html>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
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
