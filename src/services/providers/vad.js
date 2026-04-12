// ================================================================
// VAD PROVIDERS — Voice Activity Detection multi-provider
// Providers: RMS Threshold (atual), Silero VAD, pyannote
// ================================================================
import { registerProvider } from './registry.js';
import { log } from '../../logger.js';

const HF_SERVER = 'http://127.0.0.1:3010';

// ================================================================
// 1. RMS THRESHOLD (provider atual — simples, sem dependências)
// ================================================================
registerProvider({
  id: 'rms-threshold',
  type: 'vad',
  name: 'RMS Threshold (Simples)',
  description: 'Detecção por energia sonora (RMS). Simples e rápido, mas sensível a ruído de fundo.',
  quality: 4,
  speed: 10,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { pcmSamples } = input;
    if (!pcmSamples) throw new Error('pcmSamples obrigatório');

    const threshold = options.threshold || 200;

    let sum = 0;
    for (let i = 0; i < pcmSamples.length; i++) {
      sum += pcmSamples[i] * pcmSamples[i];
    }
    const rms = Math.sqrt(sum / pcmSamples.length);

    return {
      isSpeech: rms > threshold,
      confidence: Math.min(rms / (threshold * 3), 1.0),
      rms,
      threshold,
    };
  },

  async healthCheck() {
    return { ok: true }; // Sempre disponível (sem dependências)
  },
});

// ================================================================
// 2. SILERO VAD (neural — ~2MB, alta precisão, padrão da indústria)
// ================================================================
registerProvider({
  id: 'silero-vad',
  type: 'vad',
  name: 'Silero VAD (Neural)',
  description: 'VAD neural ultra-leve (~2MB). >95% de acurácia mesmo com ruído. Padrão da indústria.',
  quality: 9,
  speed: 9,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { audioBuffer, sampleRate = 16000 } = input;
    if (!audioBuffer) throw new Error('audioBuffer obrigatório (PCM Int16 ou WAV)');

    const r = await fetch(`${HF_SERVER}/vad`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: Buffer.from(audioBuffer).toString('base64'),
        sample_rate: sampleRate,
        engine: 'silero',
        threshold: options.threshold || 0.5,
        min_speech_duration: options.minSpeechMs || 250,
        min_silence_duration: options.minSilenceMs || 100,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!r.ok) throw new Error(`Silero VAD HTTP ${r.status}`);
    const data = await r.json();

    return {
      isSpeech: data.is_speech,
      confidence: data.confidence,
      speechSegments: data.segments || [],     // [{start: 0.1, end: 1.5}, ...]
      speechDurationMs: data.speech_duration_ms || 0,
      silenceDurationMs: data.silence_duration_ms || 0,
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.vad === true };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// 3. PYANNOTE SEGMENTATION (VAD + speaker change + overlap)
// ================================================================
registerProvider({
  id: 'pyannote-vad',
  type: 'vad',
  name: 'pyannote Segmentation',
  description: 'VAD avançado: detecta fala, troca de falante e sobreposição. Mais pesado que Silero.',
  quality: 10,
  speed: 6,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { audioBuffer, sampleRate = 16000 } = input;
    if (!audioBuffer) throw new Error('audioBuffer obrigatório');

    const r = await fetch(`${HF_SERVER}/vad`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: Buffer.from(audioBuffer).toString('base64'),
        sample_rate: sampleRate,
        engine: 'pyannote',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) throw new Error(`pyannote VAD HTTP ${r.status}`);
    const data = await r.json();

    return {
      isSpeech: data.is_speech,
      confidence: data.confidence,
      speechSegments: data.segments || [],
      speakerChanges: data.speaker_changes || [],
      overlapSegments: data.overlap_segments || [],
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.vad_pyannote === true };
    } catch {
      return { ok: false };
    }
  },
});

log.ai.info('VAD providers registrados: rms-threshold, silero-vad, pyannote-vad');
