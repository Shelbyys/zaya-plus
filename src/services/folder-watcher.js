// ================================================================
// FOLDER WATCHER — monitora ~/Zaya/inbox/ para arquivos novos
// Faz upload para Supabase Storage e notifica via Socket.IO
// ================================================================
import { watch } from 'fs';
import { readdir, stat, rename, mkdir } from 'fs/promises';
import { join, extname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { log } from '../logger.js';
import { io as getIO } from '../state.js';
import { uploadToStorage } from './supabase.js';

const INBOX_DIR = join(homedir(), 'Zaya', 'inbox');
const PROCESSED_DIR = join(INBOX_DIR, 'processed');

// Garante que diretórios existem
[INBOX_DIR, PROCESSED_DIR].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

// Set de arquivos já processados (evita duplicatas do fs.watch)
const processing = new Set();

async function processNewFile(filename) {
  if (processing.has(filename)) return;
  processing.add(filename);

  const filePath = join(INBOX_DIR, filename);

  try {
    // Ignora diretórios e arquivos ocultos
    if (filename.startsWith('.') || filename === 'processed') {
      processing.delete(filename);
      return;
    }

    // Espera o arquivo terminar de ser escrito (tamanho estável por 1s)
    let prevSize = -1;
    for (let i = 0; i < 10; i++) {
      try {
        const s = await stat(filePath);
        if (s.isDirectory()) { processing.delete(filename); return; }
        if (s.size === prevSize && s.size > 0) break;
        prevSize = s.size;
      } catch { processing.delete(filename); return; }
      await new Promise(r => setTimeout(r, 1000));
    }

    log.media.info({ filename }, 'Folder watcher: novo arquivo detectado');

    // Upload para Supabase Storage
    let publicUrl = null;
    try {
      const result = await uploadToStorage(filePath, 'zaya-files', 'inbox');
      publicUrl = result?.publicUrl || result?.url || null;
      log.media.info({ filename, publicUrl }, 'Folder watcher: upload concluído');
    } catch (e) {
      log.media.error({ err: e.message, filename }, 'Folder watcher: erro no upload');
    }

    // Notifica via Socket.IO
    const ioInstance = getIO;
    ioInstance?.emit('folder-watcher', {
      type: 'new_file',
      filename,
      publicUrl,
      timestamp: new Date().toISOString(),
    });
    ioInstance?.emit('incoming-notification', {
      type: 'folder_file',
      title: `Novo arquivo detectado: ${filename}`,
      text: publicUrl ? `Upload concluído. Link: ${publicUrl}` : 'Arquivo processado (upload falhou).',
      timestamp: new Date().toISOString(),
    });

    // Move para processed/
    const destPath = join(PROCESSED_DIR, `${Date.now()}_${filename}`);
    try {
      await rename(filePath, destPath);
      log.media.info({ filename, dest: destPath }, 'Folder watcher: movido para processed/');
    } catch (e) {
      log.media.error({ err: e.message }, 'Folder watcher: erro ao mover arquivo');
    }

  } catch (e) {
    log.media.error({ err: e.message, filename }, 'Folder watcher: erro processando arquivo');
  } finally {
    processing.delete(filename);
  }
}

let watcher = null;

export function startFolderWatcher() {
  if (watcher) return;

  log.media.info({ dir: INBOX_DIR }, 'Folder watcher iniciado');

  // Processa arquivos que já estavam na pasta ao iniciar
  readdir(INBOX_DIR).then(files => {
    for (const f of files) {
      if (f !== 'processed' && !f.startsWith('.')) {
        processNewFile(f);
      }
    }
  }).catch(() => {});

  // Monitora novos arquivos
  watcher = watch(INBOX_DIR, (eventType, filename) => {
    if (!filename || filename === 'processed' || filename.startsWith('.')) return;
    // Debounce — espera 500ms para o arquivo ser criado completamente
    setTimeout(() => processNewFile(filename), 500);
  });

  watcher.on('error', (err) => {
    log.media.error({ err: err.message }, 'Folder watcher error');
  });
}

export function stopFolderWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    log.media.info('Folder watcher parado');
  }
}
