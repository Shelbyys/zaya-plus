// ================================================================
// WHISPER LOCAL — Transcrição de áudio grátis via Transformers.js
// Substitui OpenAI Whisper API ($0.006/min) por $0
// ================================================================
import { log } from '../logger.js';
import { readFileSync } from 'fs';

let pipeline = null;
let transcriber = null;
let loading = false;

async function getTranscriber() {
  if (transcriber) return transcriber;
  if (loading) {
    // Espera carregar
    while (loading) await new Promise(r => setTimeout(r, 500));
    return transcriber;
  }

  loading = true;
  try {
    log.ai.info('Carregando Whisper local (primeira vez demora ~30s)...');
    const { pipeline: createPipeline } = await import('@huggingface/transformers');
    pipeline = createPipeline;

    transcriber = await createPipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-small',
      { dtype: 'q4', device: 'cpu' }
    );

    log.ai.info('Whisper local carregado!');
    return transcriber;
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro ao carregar Whisper local');
    loading = false;
    throw e;
  } finally {
    loading = false;
  }
}

/**
 * Transcreve áudio localmente com Whisper
 * @param {string} audioPath - Caminho do arquivo de áudio
 * @param {string} language - Idioma (default: pt)
 * @returns {Promise<string>} Texto transcrito
 */
export async function transcribeLocal(audioPath, language = 'pt') {
  const t = await getTranscriber();

  try {
    const audioBuffer = readFileSync(audioPath);
    const float32 = convertToFloat32(audioBuffer);

    const result = await t(float32, {
      language,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    const text = result.text || '';
    log.ai.info({ chars: text.length, lang: language }, 'Whisper local transcreveu');
    return text.trim();
  } catch (e) {
    log.ai.error({ err: e.message, path: audioPath }, 'Erro Whisper local');
    throw e;
  }
}

/**
 * Transcreve a partir de um Buffer de áudio
 */
export async function transcribeBuffer(buffer, language = 'pt') {
  const t = await getTranscriber();

  try {
    const float32 = convertToFloat32(buffer);
    const result = await t(float32, {
      language,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    return (result.text || '').trim();
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro Whisper local (buffer)');
    throw e;
  }
}

/**
 * Converte audio buffer para Float32Array (16kHz mono PCM)
 * Suporta WAV. Para MP3/OGG, o Transformers.js tenta decodificar automaticamente.
 */
function convertToFloat32(buffer) {
  // Se é WAV, extrai PCM data
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    // Encontra chunk "data"
    let offset = 12;
    while (offset < buffer.length - 8) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        const pcm = buffer.slice(offset + 8, offset + 8 + chunkSize);
        const samples = new Float32Array(pcm.length / 2);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = pcm.readInt16LE(i * 2) / 32768;
        }
        return samples;
      }
      offset += 8 + chunkSize;
    }
  }

  // Para outros formatos, passa o buffer direto (Transformers.js decodifica)
  return new Uint8Array(buffer);
}

export function isWhisperLocalEnabled() {
  const stt = (process.env.STT_PROVIDER || '').toLowerCase();
  return stt === 'local' || stt === 'whisper-local';
}
