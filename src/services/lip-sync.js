// ================================================================
// LIP SYNC — Sincronização labial em vídeos
// Providers: Sync Labs API (principal), Wav2Lip local (fallback)
// ================================================================
import { exec } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { TMP_DIR, FFMPEG } from '../config.js';
import { log } from '../logger.js';
import { uploadToStorage } from './supabase.js';

const SYNC_LABS_KEY = process.env.SYNC_LABS_API_KEY || '';
const SYNC_LABS_BASE = 'https://api.sync.so/v2';

// ================================================================
// SYNC LABS API (principal — melhor qualidade, cloud)
// ================================================================
async function syncLabsLipSync(videoUrl, audioUrl) {
  if (!SYNC_LABS_KEY) throw new Error('SYNC_LABS_API_KEY não configurada');

  log.ai.info({ videoUrl: videoUrl?.slice(0, 60), audioUrl: audioUrl?.slice(0, 60) }, 'LipSync: iniciando via Sync Labs');

  // 1. Criar job (API v2)
  const createRes = await fetch(`${SYNC_LABS_BASE}/generate`, {
    method: 'POST',
    headers: { 'x-api-key': SYNC_LABS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'sync-3',
      input: [
        { type: 'video', url: videoUrl },
        { type: 'audio', url: audioUrl },
      ],
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Sync Labs erro: ${createRes.status} — ${err.slice(0, 200)}`);
  }

  const job = await createRes.json();
  const jobId = job.id;
  log.ai.info({ jobId }, 'LipSync: job criado, aguardando processamento...');

  // 2. Poll até completar (max 5 min)
  const start = Date.now();
  const maxWait = 360000; // sync-3 demora mais (~4 min)

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 5000));

    const statusRes = await fetch(`${SYNC_LABS_BASE}/generate/${jobId}`, {
      headers: { 'x-api-key': SYNC_LABS_KEY },
    });

    if (!statusRes.ok) continue;
    const status = await statusRes.json();

    if (status.status === 'COMPLETED' && status.outputUrl) {
      log.ai.info({ jobId, url: status.outputUrl?.slice(0, 60) }, 'LipSync: completo!');

      // Baixar vídeo resultado
      const videoRes = await fetch(status.outputUrl);
      const buffer = Buffer.from(await videoRes.arrayBuffer());
      const outPath = join(TMP_DIR, 'videos', `lipsync_${Date.now()}.mp4`);
      if (!existsSync(join(TMP_DIR, 'videos'))) mkdirSync(join(TMP_DIR, 'videos'), { recursive: true });
      writeFileSync(outPath, buffer);

      return { success: true, path: outPath, url: status.outputUrl, provider: 'sync-labs' };
    }

    if (status.status === 'FAILED') {
      throw new Error('Sync Labs: falhou — ' + (status.error || 'sem detalhes'));
    }

    log.ai.debug({ jobId, status: status.status, elapsed: Math.round((Date.now() - start) / 1000) }, 'LipSync: aguardando...');
  }

  throw new Error('Sync Labs: timeout (5 min)');
}

// ================================================================
// FFMPEG FALLBACK — Merge simples de áudio + vídeo (sem lip sync real)
// Substitui o áudio original pela fala, timing alinhado
// ================================================================
async function ffmpegMerge(videoPath, audioPath) {
  log.ai.info('LipSync fallback: merge via ffmpeg (sem lip sync real)');

  const outPath = join(TMP_DIR, 'videos', `lipsync_merge_${Date.now()}.mp4`);
  if (!existsSync(join(TMP_DIR, 'videos'))) mkdirSync(join(TMP_DIR, 'videos'), { recursive: true });

  return new Promise((resolve, reject) => {
    const cmd = `${FFMPEG} -y -i "${videoPath}" -i "${audioPath}" -filter_complex "[1:a]adelay=300|300[delayed];[delayed]apad[padded]" -map 0:v -map "[padded]" -c:v copy -c:a aac -shortest "${outPath}"`;
    exec(cmd, { timeout: 30000 }, (err) => {
      if (err) {
        reject(new Error('FFmpeg merge falhou: ' + err.message));
        return;
      }
      resolve({ success: true, path: outPath, provider: 'ffmpeg-merge' });
    });
  });
}

// ================================================================
// LIP SYNC PRINCIPAL — tenta Sync Labs, fallback ffmpeg
// ================================================================
export async function lipSync(videoInput, audioInput, options = {}) {
  const videoDir = join(TMP_DIR, 'videos');
  if (!existsSync(videoDir)) mkdirSync(videoDir, { recursive: true });

  // Resolve inputs (path local ou URL)
  let videoUrl = videoInput;
  let audioUrl = audioInput;
  let videoPath = videoInput;
  let audioPath = audioInput;

  // Se é path local, faz upload pro Supabase para ter URL pública
  if (videoInput && !videoInput.startsWith('http')) {
    try {
      const u = await uploadToStorage(videoInput, 'zaya-files', 'videos');
      videoUrl = u.publicUrl;
    } catch { videoUrl = null; }
    videoPath = videoInput;
  }

  if (audioInput && !audioInput.startsWith('http')) {
    try {
      const u = await uploadToStorage(audioInput, 'zaya-files', 'audios');
      audioUrl = u.publicUrl;
    } catch { audioUrl = null; }
    audioPath = audioInput;
  }

  // 1. Tenta Sync Labs (lip sync real)
  if (SYNC_LABS_KEY && videoUrl && audioUrl) {
    try {
      const result = await syncLabsLipSync(videoUrl, audioUrl);
      // Upload resultado
      try {
        const upload = await uploadToStorage(result.path, 'zaya-files', 'videos');
        result.url = upload.publicUrl;
      } catch {}
      return result;
    } catch (e) {
      log.ai.warn({ err: e.message }, 'Sync Labs falhou, usando ffmpeg fallback');
    }
  }

  // 2. Fallback: ffmpeg merge (áudio sobre vídeo, sem lip sync)
  if (videoPath && existsSync(videoPath) && audioPath && existsSync(audioPath)) {
    try {
      const result = await ffmpegMerge(videoPath, audioPath);
      try {
        const upload = await uploadToStorage(result.path, 'zaya-files', 'videos');
        result.url = upload.publicUrl;
      } catch {}
      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  return { success: false, error: 'Sem input válido para lip sync' };
}

// ================================================================
// GERAR FALA + LIP SYNC em um passo
// ================================================================
export async function generateLipSyncVideo(videoInput, text, options = {}) {
  // 1. Gerar áudio com voz do Alisson
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = options.voiceId || process.env.ELEVENLABS_ALISSON_VOICE_ID || process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) throw new Error('ElevenLabs não configurado');

  const isAlissonVoice = voiceId === process.env.ELEVENLABS_ALISSON_VOICE_ID;
  // Voz clonada do Alisson usa v2.5 (melhor fidelidade), Zaya usa v3
  const model = isAlissonVoice ? 'eleven_multilingual_v2' : 'eleven_v3';

  log.ai.info({ text: text.slice(0, 60), voiceId: voiceId.slice(0, 10), model }, 'LipSync: gerando áudio');

  const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: isAlissonVoice
        ? { stability: 0.45, similarity_boost: 0.92, style: 0.35, use_speaker_boost: true }
        : { stability: 0.3, similarity_boost: 0.75, style: 0.55, use_speaker_boost: true },
    }),
  });

  if (!ttsRes.ok) throw new Error(`ElevenLabs: HTTP ${ttsRes.status}`);

  const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
  const audioPath = join(TMP_DIR, 'videos', `lipsync_audio_${Date.now()}.mp3`);
  writeFileSync(audioPath, audioBuffer);

  log.ai.info({ audioSize: audioBuffer.length }, 'LipSync: áudio gerado');

  // 2. Lip sync
  const result = await lipSync(videoInput, audioPath, options);

  // Limpa áudio temporário
  try { unlinkSync(audioPath); } catch {}

  return result;
}
