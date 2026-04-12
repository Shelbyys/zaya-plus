import { exec } from 'child_process';
import { readFile, readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { SUPABASE_URL, SUPABASE_KEY, TMP_DIR } from '../config.js';
import { API_TOKEN } from '../state.js';
import { log } from '../logger.js';
import { uploadToStorage } from './supabase.js';

// Token determinístico (hash da senha) — aceito além do API_TOKEN local
// Isso permite que o Render (que usa hash) envie comandos pro Local (que usa .env)
const SENHA = process.env.BOT_PASSWORD || '';
const HASH_TOKEN = SENHA ? crypto.createHash('sha256').update('zaya-token-' + SENHA).digest('hex') : '';

function isValidToken(token) {
  if (!token) return false;
  if (token === API_TOKEN) return true;
  if (HASH_TOKEN && token === HASH_TOKEN) return true;
  return false;
}

// ================================================================
// SUPABASE CLIENT (dedicado para remote commands)
// ================================================================
let supabase = null;

function getSupabase() {
  if (!supabase && SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return supabase;
}

// ================================================================
// REMOTE COMMAND POLLER
// ================================================================
let pollInterval = null;
let heartbeatInterval = null;

const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;

// ================================================================
// TABLE INITIALIZATION
// ================================================================
async function ensureRemoteTable() {
  const sb = getSupabase();
  if (!sb) return;

  try {
    // Test if table exists by querying it
    const { error } = await sb.from('remote_commands').select('id').limit(1);
    if (error && error.code === '42P01') {
      // Table doesn't exist - try to create via RPC
      log.db.warn('Tabela remote_commands nao existe. Criando via SQL...');
      const { error: rpcErr } = await sb.rpc('exec_sql', {
        query: `
          CREATE TABLE IF NOT EXISTS remote_commands (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            type text NOT NULL,
            payload jsonb DEFAULT '{}',
            status text DEFAULT 'pending',
            result jsonb,
            auth_token text,
            created_at timestamptz DEFAULT now(),
            started_at timestamptz,
            completed_at timestamptz
          );
          CREATE INDEX IF NOT EXISTS idx_remote_pending ON remote_commands(status) WHERE status = 'pending';
        `
      });
      if (rpcErr) {
        log.db.warn({ err: rpcErr.message }, 'Nao foi possivel criar tabela remote_commands via RPC. Crie manualmente no Supabase Dashboard:\n\nCREATE TABLE IF NOT EXISTS remote_commands (\n  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,\n  type text NOT NULL,\n  payload jsonb DEFAULT \'{}\',\n  status text DEFAULT \'pending\',\n  result jsonb,\n  auth_token text,\n  created_at timestamptz DEFAULT now(),\n  started_at timestamptz,\n  completed_at timestamptz\n);\nCREATE INDEX IF NOT EXISTS idx_remote_pending ON remote_commands(status) WHERE status = \'pending\';');
      } else {
        log.db.info('Tabela remote_commands criada com sucesso');
      }
    } else if (error) {
      log.db.error({ err: error.message }, 'Erro ao verificar tabela remote_commands');
    } else {
      log.db.info('Tabela remote_commands OK');
    }
  } catch (e) {
    log.db.error({ err: e.message }, 'Erro ao inicializar tabela remote_commands');
  }
}

// ================================================================
// COMMAND EXECUTORS
// ================================================================

async function executeShell(payload) {
  const comando = payload.comando || payload.command || '';
  const timeout = payload.timeout;
  if (!comando) return { error: 'Comando nao informado' };

  return new Promise((resolve) => {
    exec(comando, {
      timeout: timeout || 30000,
      maxBuffer: 5 * 1024 * 1024,
      shell: process.env.SHELL || '/bin/bash',
      cwd: process.env.HOME || '/tmp',
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: err.message, stderr: stderr?.slice(0, 2000), stdout: stdout?.slice(0, 2000) });
      } else {
        resolve({ success: true, stdout: stdout?.slice(0, 10000) || '', stderr: stderr?.slice(0, 2000) || '' });
      }
    });
  });
}

async function executeScreenshot(payload) {
  const filename = `screenshot_${Date.now()}.png`;
  const filepath = join(TMP_DIR, filename);

  return new Promise(async (resolve) => {
    exec(`screencapture -x "${filepath}"`, { timeout: 10000 }, async (err) => {
      if (err) {
        resolve({ success: false, error: err.message });
        return;
      }
      try {
        // Upload to Supabase Storage
        const uploaded = await uploadToStorage(filepath, 'zaya-files', 'screenshots');
        resolve({ success: true, url: uploaded.publicUrl, path: filepath, filename });
      } catch (uploadErr) {
        // Return local path if upload fails
        resolve({ success: true, path: filepath, filename, uploadError: uploadErr.message });
      }
    });
  });
}

async function executeClipboard() {
  return new Promise((resolve) => {
    exec('pbpaste', { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true, content: stdout || '(clipboard vazio)' });
      }
    });
  });
}

async function executeOpenApp(payload) {
  const { app_name } = payload;
  if (!app_name) return { error: 'Nome do app nao informado' };

  return new Promise((resolve) => {
    exec(`open -a "${app_name}"`, { timeout: 10000 }, (err) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true, message: `App "${app_name}" aberto` });
      }
    });
  });
}

async function executeOpenUrl(payload) {
  const { url } = payload;
  if (!url) return { error: 'URL nao informada' };

  return new Promise((resolve) => {
    exec(`open -a "Google Chrome" "${url}"`, { timeout: 10000 }, (err) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true, message: `URL "${url}" aberta no Chrome` });
      }
    });
  });
}

async function executeFileRead(payload) {
  const { path: filePath, encoding } = payload;
  if (!filePath) return { error: 'Caminho do arquivo nao informado' };

  try {
    const content = await readFile(filePath, encoding || 'utf-8');
    // Limit content to 50KB
    const truncated = content.length > 50000;
    return {
      success: true,
      content: truncated ? content.slice(0, 50000) : content,
      truncated,
      size: content.length,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function executeFileList(payload) {
  const { path: dirPath, recursive } = payload;
  if (!dirPath) return { error: 'Caminho do diretorio nao informado' };

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries.slice(0, 200)) {
      try {
        const fullPath = join(dirPath, entry.name);
        const stats = await stat(fullPath);
        files.push({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: stats.size,
          modified: stats.mtime.toISOString(),
        });
      } catch {
        files.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' });
      }
    }
    return { success: true, files, total: entries.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function executeNotification(payload) {
  const { title, message } = payload;
  const t = title || 'Zaya';
  const m = message || 'Notificacao';

  return new Promise((resolve) => {
    const script = `display notification "${m.replace(/"/g, '\\"')}" with title "${t.replace(/"/g, '\\"')}"`;
    exec(`osascript -e '${script}'`, { timeout: 5000 }, (err) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true, message: 'Notificacao exibida' });
      }
    });
  });
}

async function executeAiTask(payload) {
  const { prompt } = payload;
  if (!prompt) return { error: 'Prompt nao informado' };

  try {
    // Dynamic import to avoid circular dependency
    const { processVoiceChat } = await import('./ai.js');
    const result = await processVoiceChat(prompt);
    return { success: true, response: result?.text || result || '(sem resposta)' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// COMMAND DISPATCHER
// ================================================================
async function executeCommand(type, payload) {
  switch (type) {
    case 'shell': return executeShell(payload);
    case 'screenshot': return executeScreenshot(payload);
    case 'clipboard': return executeClipboard();
    case 'open_app': return executeOpenApp(payload);
    case 'open_url': return executeOpenUrl(payload);
    case 'file_read': return executeFileRead(payload);
    case 'file_list': return executeFileList(payload);
    case 'notification': return executeNotification(payload);
    case 'ai_task': return executeAiTask(payload);
    case 'heartbeat': return { success: true, alive: true, timestamp: new Date().toISOString() };
    default: return { success: false, error: `Tipo de comando desconhecido: ${type}` };
  }
}

// ================================================================
// POLL + EXECUTE LOOP
// ================================================================
async function pollAndExecute() {
  const sb = getSupabase();
  if (!sb) return;

  try {
    // Fetch pending commands
    const { data: commands, error } = await sb
      .from('remote_commands')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(5);

    if (error) {
      if (error.code !== '42P01') { // Ignore table-not-found silently
        log.db.error({ err: error.message }, 'Erro ao buscar comandos remotos');
      }
      return;
    }

    if (!commands || commands.length === 0) return;

    for (const cmd of commands) {
      // Security: validate auth_token (aceita API_TOKEN local ou hash da senha)
      if (!isValidToken(cmd.auth_token)) {
        log.db.warn({ id: cmd.id, type: cmd.type }, 'Comando remoto com token invalido - ignorando');
        await sb.from('remote_commands').update({
          status: 'rejected',
          result: { error: 'Token invalido' },
          completed_at: new Date().toISOString(),
        }).eq('id', cmd.id);
        continue;
      }

      log.db.info({ id: cmd.id, type: cmd.type }, 'Executando comando remoto');

      // Mark as running
      await sb.from('remote_commands').update({
        status: 'running',
        started_at: new Date().toISOString(),
      }).eq('id', cmd.id);

      try {
        // Execute with timeout
        const timeoutMs = cmd.payload?.timeout_ms || 30000;
        const resultPromise = executeCommand(cmd.type, cmd.payload || {});
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), timeoutMs)
        );

        const result = await Promise.race([resultPromise, timeoutPromise]);

        // Mark as done
        await sb.from('remote_commands').update({
          status: 'done',
          result,
          completed_at: new Date().toISOString(),
        }).eq('id', cmd.id);

        log.db.info({ id: cmd.id, type: cmd.type }, 'Comando remoto concluido');
      } catch (execErr) {
        await sb.from('remote_commands').update({
          status: 'error',
          result: { error: execErr.message },
          completed_at: new Date().toISOString(),
        }).eq('id', cmd.id);

        log.db.error({ id: cmd.id, type: cmd.type, err: execErr.message }, 'Erro executando comando remoto');
      }
    }
  } catch (e) {
    log.db.error({ err: e.message }, 'Erro no poll de comandos remotos');
  }
}

// ================================================================
// HEARTBEAT
// ================================================================
async function sendHeartbeat() {
  const sb = getSupabase();
  if (!sb) return;

  try {
    await sb.from('remote_commands').insert({
      type: 'heartbeat',
      status: 'done',
      auth_token: API_TOKEN,
      payload: { hostname: process.env.HOSTNAME || 'mac-local' },
      result: { alive: true, timestamp: new Date().toISOString(), uptime: process.uptime() },
      completed_at: new Date().toISOString(),
    });
  } catch (e) {
    // Silently ignore heartbeat errors
  }
}

// ================================================================
// CLEANUP — remove old commands (older than 24h)
// ================================================================
async function cleanupOldCommands() {
  const sb = getSupabase();
  if (!sb) return;

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await sb.from('remote_commands')
      .delete()
      .lt('created_at', cutoff)
      .in('status', ['done', 'error', 'rejected']);
  } catch {
    // Silently ignore cleanup errors
  }
}

// ================================================================
// DIRECT EXECUTION (for local calls, bypassing Supabase)
// ================================================================
export async function executeRemoteCommandDirect(type, payload) {
  return executeCommand(type, payload);
}

// ================================================================
// START / STOP
// ================================================================
export async function startRemotePoller() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    log.db.info('Supabase nao configurado, remote poller desativado');
    return;
  }

  log.db.info('Iniciando Remote Command Poller...');

  // Ensure table exists
  await ensureRemoteTable();

  // Send initial heartbeat
  await sendHeartbeat();

  // Start polling
  pollInterval = setInterval(pollAndExecute, POLL_INTERVAL_MS);

  // Start heartbeat
  heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  // Cleanup every hour
  setInterval(cleanupOldCommands, 60 * 60 * 1000);

  log.db.info({ pollMs: POLL_INTERVAL_MS, heartbeatMs: HEARTBEAT_INTERVAL_MS }, 'Remote Command Poller ativo');
}

export function stopRemotePoller() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  log.db.info('Remote Command Poller parado');
}
