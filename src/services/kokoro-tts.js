// ================================================================
// KOKORO TTS — Voz local gratuita via kokoro-js
// Substitui ElevenLabs ($5-99/mês) por $0
// Nota: Melhor qualidade em inglês. PT-BR básico.
// ================================================================
import { log } from '../logger.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

let kokoroInstance = null;
let loading = false;

async function getKokoro() {
  if (kokoroInstance) return kokoroInstance;
  if (loading) {
    while (loading) await new Promise(r => setTimeout(r, 500));
    return kokoroInstance;
  }

  loading = true;
  try {
    log.ai.info('Carregando Kokoro TTS (primeira vez demora ~20s)...');
    const { KokoroTTS } = await import('kokoro-js');

    kokoroInstance = await KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      { dtype: 'q8' }
    );

    log.ai.info('Kokoro TTS carregado!');
    return kokoroInstance;
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro ao carregar Kokoro TTS');
    loading = false;
    throw e;
  } finally {
    loading = false;
  }
}

// Vozes disponíveis no Kokoro
const KOKORO_VOICES = {
  // Femininas
  'af_heart': 'Heart (feminina, calorosa)',
  'af_alloy': 'Alloy (feminina, neutra)',
  'af_aoede': 'Aoede (feminina, suave)',
  'af_bella': 'Bella (feminina, expressiva)',
  'af_jessica': 'Jessica (feminina, clara)',
  'af_kore': 'Kore (feminina, jovem)',
  'af_nicole': 'Nicole (feminina, madura)',
  'af_nova': 'Nova (feminina, energética)',
  'af_river': 'River (feminina, calma)',
  'af_sarah': 'Sarah (feminina, profissional)',
  'af_sky': 'Sky (feminina, leve)',
  // Masculinas
  'am_adam': 'Adam (masculina, grave)',
  'am_echo': 'Echo (masculina, ressonante)',
  'am_eric': 'Eric (masculina, firme)',
  'am_liam': 'Liam (masculina, jovem)',
  'am_michael': 'Michael (masculina, madura)',
  'am_onyx': 'Onyx (masculina, profunda)',
};

/**
 * Gera áudio com Kokoro TTS
 * @param {string} text - Texto para sintetizar
 * @param {string} voice - ID da voz (default: af_heart)
 * @returns {Promise<Buffer>} Buffer do áudio WAV
 */
export async function generateSpeech(text, voice = null) {
  const kokoro = await getKokoro();
  const voiceId = voice || process.env.KOKORO_VOICE || 'af_heart';

  try {
    const audio = await kokoro.generate(text.slice(0, 500), { voice: voiceId });

    // Converter para WAV buffer
    const wavBuffer = audioToWavBuffer(audio);
    log.ai.info({ voice: voiceId, chars: text.length, size: wavBuffer.length }, 'Kokoro TTS gerado');
    return wavBuffer;
  } catch (e) {
    log.ai.error({ err: e.message, voice: voiceId }, 'Erro Kokoro TTS');
    throw e;
  }
}

/**
 * Gera áudio e salva em arquivo
 * @returns {Promise<string>} Caminho do arquivo salvo
 */
export async function generateSpeechToFile(text, voice = null) {
  const kokoro = await getKokoro();
  const voiceId = voice || process.env.KOKORO_VOICE || 'af_heart';

  try {
    const audio = await kokoro.generate(text.slice(0, 500), { voice: voiceId });
    const filePath = join('/tmp', `kokoro-${Date.now()}.wav`);
    await audio.save(filePath);
    log.ai.info({ path: filePath, voice: voiceId }, 'Kokoro TTS salvo');
    return filePath;
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro Kokoro TTS save');
    throw e;
  }
}

/**
 * Lista vozes disponíveis
 */
export function listVoices() {
  return Object.entries(KOKORO_VOICES).map(([id, name]) => ({ id, name }));
}

/**
 * Converte AudioOutput do Kokoro para WAV Buffer
 */
function audioToWavBuffer(audio) {
  const samples = audio.audio;
  const sampleRate = audio.sampling_rate || 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const headerSize = 44;

  const buffer = Buffer.alloc(headerSize + dataSize);

  // WAV header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // PCM data
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s * 32767), headerSize + i * 2);
  }

  return buffer;
}

export function isKokoroEnabled() {
  const tts = (process.env.TTS_PROVIDER || '').toLowerCase();
  return tts === 'kokoro' || tts === 'kokoro-local';
}
