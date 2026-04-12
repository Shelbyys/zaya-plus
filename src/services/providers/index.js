// ================================================================
// PROVIDERS INDEX — Importa e inicializa todos os providers
// ================================================================
import registry from './registry.js';
import './stt.js';
import './tts.js';
import './vad.js';
import './embeddings.js';
import './emotion.js';
import { log } from '../../logger.js';

// Re-exporta tudo do registry
export * from './registry.js';
export { cosineSimilarity } from './embeddings.js';

// ================================================================
// INICIALIZAR — carregar estados salvos e rodar health checks
// ================================================================
export async function initProviders() {
  log.ai.info('Inicializando sistema multi-provider...');

  // Carregar estados habilitado/desabilitado salvos pelo usuário
  registry.loadSavedStates();

  // Health check de todos os providers
  const results = await registry.checkAllHealth();

  const available = Object.entries(results).filter(([, r]) => r.ok).length;
  const total = Object.keys(results).length;

  log.ai.info({ available, total }, `Providers: ${available}/${total} disponíveis`);

  // Log dos que falharam
  for (const [key, r] of Object.entries(results)) {
    if (!r.ok) {
      log.ai.debug({ provider: key, error: r.error }, 'Provider indisponível');
    }
  }

  return results;
}

// ================================================================
// ATALHOS — funções de conveniência para uso rápido
// ================================================================

/**
 * Transcrever áudio (STT)
 * @param {Buffer} audioBuffer - áudio em formato WAV/MP3/OGG
 * @param {object} options - { language, format, context: { mode, situation } }
 */
export async function transcribe(audioBuffer, options = {}) {
  return registry.executeWithFallback('stt', {
    audioBuffer,
    language: options.language || 'pt',
    format: options.format || 'wav',
  }, options);
}

/**
 * Gerar áudio de texto (TTS)
 * @param {string} text - texto para falar
 * @param {object} options - { voice, speed, context: { mode, situation } }
 */
export async function speak(text, options = {}) {
  return registry.executeWithFallback('tts', { text }, options);
}

/**
 * Detectar atividade de voz (VAD)
 * @param {Buffer|Int16Array} audio - PCM samples ou WAV buffer
 * @param {object} options - { sampleRate, threshold, context }
 */
export async function detectVoice(audio, options = {}) {
  // Se recebeu Int16Array (PCM direto), usa RMS como fallback rápido
  if (audio instanceof Int16Array) {
    return registry.executeWithFallback('vad', { pcmSamples: audio }, options);
  }
  return registry.executeWithFallback('vad', {
    audioBuffer: audio,
    sampleRate: options.sampleRate || 16000,
  }, options);
}

/**
 * Gerar embeddings de texto
 * @param {string|string[]} texts - texto(s) para vetorizar
 * @param {object} options - { context }
 */
export async function embed(texts, options = {}) {
  const input = Array.isArray(texts) ? texts : [texts];
  return registry.executeWithFallback('embeddings', { texts: input }, options);
}

/**
 * Detectar emoção (texto ou áudio)
 * @param {object} input - { text } ou { audioBuffer, sampleRate }
 * @param {object} options - { context }
 */
export async function detectEmotion(input, options = {}) {
  return registry.executeWithFallback('emotion', input, options);
}

export default {
  initProviders,
  transcribe,
  speak,
  detectVoice,
  embed,
  detectEmotion,
  ...registry,
};
