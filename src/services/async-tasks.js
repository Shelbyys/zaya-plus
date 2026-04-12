// ================================================================
// ASYNC TASKS — Gerencia tarefas assíncronas (webhook-driven)
//
// Fluxo: Tool envia request → registra pendingTask → retorna imediato
//        Webhook chega → encontra task → processa → notifica usuário
// ================================================================
import { log } from '../logger.js';
import { io } from '../state.js';
import { logAction } from './action-logger.js';
import { uploadToStorage } from './supabase.js';
import { ADMIN_NUMBER, TMP_DIR } from '../config.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// Tasks pendentes: taskId → { tipo, origin, metadata, createdAt }
const pendingTasks = new Map();

// Cleanup: remove tasks com mais de 30min
setInterval(() => {
  const now = Date.now();
  for (const [id, task] of pendingTasks) {
    if (now - task.createdAt > 30 * 60 * 1000) {
      log.ai.warn({ taskId: id, tipo: task.tipo }, 'AsyncTask expirada — removendo');
      pendingTasks.delete(id);
    }
  }
}, 5 * 60 * 1000);

/**
 * Registra uma task pendente (aguardando webhook).
 *
 * @param {string} taskId - ID retornado pela API (Freepik task_id, etc.)
 * @param {string} tipo - 'video', 'image', 'upscale', etc.
 * @param {object} opts
 * @param {string} opts.origin - 'whatsapp', 'voice', 'dashboard'
 * @param {string} opts.phone - Número WhatsApp pra notificar (se origin=whatsapp)
 * @param {string} opts.prompt - Prompt original do pedido
 * @param {string} opts.modelo - Modelo usado (kling-v2.6-pro, etc.)
 * @param {boolean} opts.addSfx - Adicionar SFX ao vídeo quando pronto
 * @param {string} opts.sfxPrompt - Prompt pra SFX
 * @param {string} opts.narration - Texto pra narração
 * @param {object} opts.extra - Dados extras
 */
export function registerPendingTask(taskId, tipo, opts = {}) {
  const task = {
    taskId,
    tipo,
    origin: opts.origin || 'voice',
    phone: opts.phone || ADMIN_NUMBER,
    prompt: opts.prompt || '',
    modelo: opts.modelo || '',
    addSfx: opts.addSfx || false,
    sfxPrompt: opts.sfxPrompt || '',
    narration: opts.narration || '',
    extra: opts.extra || {},
    createdAt: Date.now(),
    status: 'pending',
  };

  pendingTasks.set(taskId, task);
  log.ai.info({ taskId, tipo, origin: task.origin }, 'AsyncTask registrada');
  return task;
}

/**
 * Busca uma task pendente pelo ID.
 */
export function getPendingTask(taskId) {
  return pendingTasks.get(taskId) || null;
}

/**
 * Processa resultado de uma task concluída (chamado pelo webhook).
 *
 * @param {string} taskId
 * @param {object} result - Dados do webhook { status, generated, video_url, etc. }
 */
export async function completeTask(taskId, result) {
  const task = pendingTasks.get(taskId);
  if (!task) {
    log.ai.warn({ taskId }, 'AsyncTask não encontrada — ignorando webhook');
    return null;
  }

  task.status = 'processing';
  log.ai.info({ taskId, tipo: task.tipo, modelo: task.modelo }, 'AsyncTask: processando resultado');

  try {
    const videoDir = join(TMP_DIR, 'videos');
    if (!existsSync(videoDir)) mkdirSync(videoDir, { recursive: true });

    // Extrai URL do resultado
    const mediaUrl = result.generated?.[0] || result.video_url || result.image_url || result.url || null;
    if (!mediaUrl) {
      throw new Error('Webhook sem URL de mídia: ' + JSON.stringify(result).slice(0, 200));
    }

    // Baixa o arquivo
    const ext = task.tipo === 'video' ? 'mp4' : task.tipo === 'image' ? 'jpg' : 'mp4';
    const localPath = join(videoDir, `webhook_${task.tipo}_${Date.now()}.${ext}`);
    log.ai.info({ url: mediaUrl.slice(0, 80), localPath }, 'AsyncTask: baixando mídia');

    const response = await fetch(mediaUrl);
    if (!response.ok) throw new Error(`Download falhou: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(localPath, buffer);

    let finalPath = localPath;
    let finalUrl = null;

    // Post-processing: SFX para vídeos
    if (task.tipo === 'video' && task.addSfx) {
      try {
        log.ai.info({ taskId }, 'AsyncTask: adicionando SFX');
        const sfxPath = await generateQuickSFX(task.sfxPrompt || task.prompt, localPath);
        if (sfxPath) {
          const withSfxPath = join(videoDir, `webhook_sfx_${Date.now()}.mp4`);
          const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
          execSync(`"${ffmpeg}" -i "${localPath}" -i "${sfxPath}" -filter_complex "[1:a]volume=0.5[sfx];[sfx]apad[sfxp];[0:a][sfxp]amix=inputs=2:duration=first[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${withSfxPath}" -y 2>/dev/null || "${ffmpeg}" -i "${localPath}" -i "${sfxPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${withSfxPath}" -y`, { timeout: 60000 });
          if (existsSync(withSfxPath)) finalPath = withSfxPath;
        }
      } catch (e) {
        log.ai.warn({ err: e.message }, 'AsyncTask: SFX falhou (continua sem)');
      }
    }

    // Post-processing: Narração
    if (task.tipo === 'video' && task.narration) {
      try {
        log.ai.info({ taskId }, 'AsyncTask: adicionando narração');
        const { default: pipeline } = await import('./video-pipeline.js');
        // Usa generateNarration e mergeVideoAudio do pipeline se disponíveis
      } catch {}
    }

    // Upload pro Supabase
    try {
      const pasta = task.tipo === 'video' ? 'videos' : 'imagens';
      const upload = await uploadToStorage(finalPath, 'zaya-files', pasta);
      finalUrl = upload.publicUrl;
    } catch (e) {
      log.ai.warn({ err: e.message }, 'AsyncTask: upload falhou');
    }

    // Log da ação
    logAction(task.tipo, `${task.tipo} pronto (webhook): ${task.prompt.slice(0, 80)}`, {
      subtype: task.modelo,
      filePath: finalPath,
      fileUrl: finalUrl,
      metadata: { taskId, prompt: task.prompt, modelo: task.modelo, origin: task.origin },
    });

    // Notifica o usuário
    await notifyUser(task, finalPath, finalUrl);

    task.status = 'completed';
    task.resultPath = finalPath;
    task.resultUrl = finalUrl;

    log.ai.info({ taskId, tipo: task.tipo, path: finalPath, url: finalUrl?.slice(0, 60) }, 'AsyncTask: concluída!');

    // Remove da fila após 5min (mantém pra consulta)
    setTimeout(() => pendingTasks.delete(taskId), 5 * 60 * 1000);

    return { success: true, path: finalPath, url: finalUrl };
  } catch (e) {
    log.ai.error({ taskId, err: e.message }, 'AsyncTask: erro ao processar');
    task.status = 'error';
    task.error = e.message;

    // Notifica erro
    try {
      await notifyUser(task, null, null, e.message);
    } catch {}

    return { success: false, error: e.message };
  }
}

/**
 * Notifica o usuário que a task completou.
 */
async function notifyUser(task, filePath, fileUrl, error = null) {
  const emoji = task.tipo === 'video' ? '🎬' : task.tipo === 'image' ? '🎨' : '✅';

  // Dashboard (Socket.IO)
  io?.emit('zaya-proactive', {
    text: error
      ? `❌ ${task.tipo} falhou: ${error}`
      : `${emoji} Seu ${task.tipo} ficou pronto! ${fileUrl || ''}`,
    tipo: 'async_task',
    taskId: task.taskId,
    fileUrl,
    filePath,
  });

  // WhatsApp
  if (task.phone) {
    try {
      const { sendText, sendLocalFile } = await import('./wasender.js');
      if (error) {
        await sendText(task.phone, `${emoji} Erro ao gerar ${task.tipo}: ${error}`);
      } else {
        await sendText(task.phone, `${emoji} Seu ${task.tipo} ficou pronto!${fileUrl ? '\n' + fileUrl : ''}`);
        // Envia o arquivo direto no WhatsApp
        if (filePath && existsSync(filePath)) {
          await new Promise(r => setTimeout(r, 2000)); // delay pra não bater rate limit
          await sendLocalFile(task.phone, filePath, '');
        }
      }
    } catch (e) {
      log.ai.warn({ err: e.message }, 'AsyncTask: falha ao notificar via WhatsApp');
    }
  }
}

/**
 * Gera SFX rápido para vídeo via ElevenLabs.
 */
async function generateQuickSFX(prompt, videoPath) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  try {
    // Calcula duração do vídeo
    let duration = 5;
    try {
      const ffprobe = process.env.FFPROBE_PATH || '/opt/homebrew/bin/ffprobe';
      const dur = execSync(`"${ffprobe}" -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`, { timeout: 10000 }).toString().trim();
      duration = Math.min(Math.ceil(parseFloat(dur)), 22);
    } catch {}

    const sfxPrompt = prompt
      ? `Ambient cinematic sound for: ${prompt.slice(0, 120)}. Subtle, immersive.`
      : 'Subtle cinematic ambient background, atmospheric';

    const sfxRes = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sfxPrompt, duration_seconds: duration, prompt_influence: 0.4 }),
    });
    if (!sfxRes.ok) return null;

    const sfxPath = join(TMP_DIR, 'videos', `sfx_webhook_${Date.now()}.mp3`);
    writeFileSync(sfxPath, Buffer.from(await sfxRes.arrayBuffer()));
    return sfxPath;
  } catch (e) {
    log.ai.warn({ err: e.message }, 'AsyncTask: SFX falhou');
    return null;
  }
}

/**
 * Lista tasks pendentes (para debug/status).
 */
export function listPendingTasks() {
  const result = [];
  for (const [id, task] of pendingTasks) {
    result.push({
      taskId: id,
      tipo: task.tipo,
      status: task.status,
      modelo: task.modelo,
      prompt: task.prompt.slice(0, 60),
      origin: task.origin,
      age: Math.round((Date.now() - task.createdAt) / 1000) + 's',
    });
  }
  return result;
}

export { pendingTasks };
