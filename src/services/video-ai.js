// ================================================================
// VIDEO AI — Geração de vídeos via Freepik API (Kling)
// ================================================================
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { TMP_DIR } from '../config.js';
import { log } from '../logger.js';

const FREEPIK_BASE = 'https://api.freepik.com';

function getApiKey() {
  const key = process.env.FREEPIK_API_KEY;
  if (!key) throw new Error('FREEPIK_API_KEY não configurada no .env. Pegue em https://www.freepik.com/api/keys');
  return key;
}

async function freepikRequest(method, path, body = null) {
  const opts = {
    method,
    headers: {
      'x-freepik-api-key': getApiKey(),
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${FREEPIK_BASE}${path}`, opts);
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error(`Freepik ${method} ${path} → HTTP ${r.status}: ${err.slice(0, 300)}`);
  }
  return r.json();
}

// Converte imagem local para base64 raw (sem prefixo data:, como Freepik exige)
function imageToBase64(imagePath) {
  const data = readFileSync(imagePath);
  return data.toString('base64');
}

// Poll até completar (max 5 min)
async function pollTask(path, taskId, maxWaitMs = 300000) {
  const start = Date.now();
  const pollInterval = 4000; // 4s entre checks

  while (Date.now() - start < maxWaitMs) {
    const status = await freepikRequest('GET', `${path}/${taskId}`);
    const taskStatus = status.data?.status || status.status;

    if (taskStatus === 'COMPLETED' || taskStatus === 'completed') {
      return status;
    }
    if (taskStatus === 'FAILED' || taskStatus === 'failed') {
      throw new Error(`Vídeo falhou: ${JSON.stringify(status).slice(0, 500)}`);
    }

    log.ai.info({ taskId, status: taskStatus, elapsed: ((Date.now() - start) / 1000).toFixed(0) + 's' }, 'VideoAI: aguardando...');
    await new Promise(r => setTimeout(r, pollInterval));
  }
  throw new Error(`Timeout: vídeo não ficou pronto em ${maxWaitMs / 1000}s`);
}

// ================================================================
// GERAR VÍDEO A PARTIR DE IMAGEM (image-to-video) — Freepik Kling
// ================================================================
export async function gerarVideoDeImagem(prompt, imagemInput, opcoes = {}) {
  const dir = join(TMP_DIR, 'videos');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Modelos disponíveis no Freepik
  const modelos = {
    'kling-pro': '/v1/ai/image-to-video/kling-o1-pro',
    'kling-std': '/v1/ai/image-to-video/kling-o1-std',
    'kling-elements-pro': '/v1/ai/image-to-video/kling-elements-pro',
    'kling-elements-std': '/v1/ai/image-to-video/kling-elements-std',
    'kling': '/v1/ai/image-to-video/kling-o1-std',
  };

  const modelKey = opcoes.modelo || 'kling-std';
  const endpoint = modelos[modelKey] || modelos['kling-std'];
  const pollPath = endpoint.includes('elements')
    ? '/v1/ai/image-to-video/kling-elements'
    : '/v1/ai/image-to-video/kling-o1';

  // Prepara imagem (URL ou base64)
  let firstFrame = imagemInput;
  if (imagemInput && !imagemInput.startsWith('http') && !imagemInput.startsWith('data:')) {
    firstFrame = imageToBase64(imagemInput);
  }

  log.ai.info({ prompt: prompt.slice(0, 100), modelo: modelKey }, 'VideoAI Freepik: image-to-video');

  const body = {
    first_frame: firstFrame,
    prompt: prompt.slice(0, 2500),
    aspect_ratio: opcoes.aspecto || '16:9',
    duration: (opcoes.duracao || '5').replace('s', ''),
  };

  // Envia request
  const task = await freepikRequest('POST', endpoint, body);
  const taskId = task.data?.task_id || task.task_id;
  if (!taskId) throw new Error('Freepik não retornou task_id: ' + JSON.stringify(task).slice(0, 200));

  log.ai.info({ taskId, modelo: modelKey }, 'VideoAI Freepik: task criada, aguardando...');

  // Poll até completar
  const result = await pollTask(pollPath, taskId);
  const videoUrl = result.data?.generated?.[0] || result.data?.video?.url || result.data?.result?.video_url;
  if (!videoUrl) throw new Error('Vídeo pronto mas sem URL: ' + JSON.stringify(result.data).slice(0, 200));

  // Baixa o vídeo
  const filePath = join(dir, `video_freepik_${Date.now()}.mp4`);
  const response = await fetch(videoUrl);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(filePath, buffer);

  log.ai.info({ path: filePath, size: buffer.length, modelo: modelKey }, 'VideoAI Freepik: vídeo salvo');
  return { success: true, path: filePath, url: videoUrl, size: buffer.length, engine: `Freepik ${modelKey}` };
}

// ================================================================
// GERAR VÍDEO (text-to-video) — usa image-to-video com imagem gerada
// Freepik não tem text-to-video direto, então gera imagem primeiro
// ================================================================
export async function gerarVideo(prompt, opcoes = {}) {
  // Freepik só tem image-to-video, então retorna instrução
  return {
    success: false,
    error: 'Freepik só suporta image-to-video. Envie uma imagem de referência ou use gerar_imagem/nano_banana primeiro para criar a imagem base.',
    needsImage: true,
  };
}
