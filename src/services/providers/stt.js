// ================================================================
// STT PROVIDERS — Speech-to-Text multi-provider
// Providers: OpenAI Whisper API, Local Whisper (faster-whisper), Parakeet
// ================================================================
import { registerProvider } from './registry.js';
import { log } from '../../logger.js';

const HF_SERVER = 'http://127.0.0.1:3010';

// ================================================================
// 1. OPENAI WHISPER API (provider atual — pago, alta qualidade)
// ================================================================
registerProvider({
  id: 'whisper-api',
  type: 'stt',
  name: 'OpenAI Whisper API',
  description: 'API da OpenAI, alta precisão, multilíngue. Pago por minuto de áudio.',
  quality: 9,
  speed: 7,
  cost: 'paid',
  local: false,
  requires: 'OPENAI_API_KEY',

  async execute(input, options = {}) {
    const { audioBuffer, language = 'pt', format = 'wav' } = input;
    if (!audioBuffer) throw new Error('audioBuffer obrigatório');

    const fileBlob = new Blob([audioBuffer], { type: `audio/${format}` });
    const fd = new FormData();
    fd.append('file', fileBlob, `audio.${format}`);
    fd.append('model', 'whisper-1');
    if (language) fd.append('language', language);
    fd.append('response_format', 'verbose_json');

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });

    if (!r.ok) throw new Error(`Whisper API HTTP ${r.status}`);
    const data = await r.json();

    return {
      text: data.text || '',
      language: data.language || language,
      duration: data.duration || null,
      segments: data.segments || [],
    };
  },

  async healthCheck() {
    return { ok: !!process.env.OPENAI_API_KEY };
  },
});

// ================================================================
// 2. LOCAL WHISPER (faster-whisper via HF Server — gratuito)
// ================================================================
registerProvider({
  id: 'whisper-local',
  type: 'stt',
  name: 'Whisper Local (faster-whisper)',
  description: 'Whisper rodando localmente via faster-whisper. Gratuito, privado, boa qualidade.',
  quality: 8,
  speed: 6,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { audioBuffer, language = 'pt', format = 'wav' } = input;
    if (!audioBuffer) throw new Error('audioBuffer obrigatório');

    const model = options.model || 'large-v3'; // small, medium, large-v3

    const r = await fetch(`${HF_SERVER}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: Buffer.from(audioBuffer).toString('base64'),
        format,
        language,
        model,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!r.ok) throw new Error(`Whisper local HTTP ${r.status}`);
    const data = await r.json();

    return {
      text: data.text || '',
      language: data.language || language,
      duration: data.duration || null,
      segments: data.segments || [],
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.stt === true, models: d.models?.stt };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// 3. WHISPER TURBO LOCAL (modelo menor, mais rápido)
// ================================================================
registerProvider({
  id: 'whisper-turbo',
  type: 'stt',
  name: 'Whisper Turbo (Local)',
  description: 'Whisper small/medium local. Mais rápido que large-v3, qualidade boa pra tempo real.',
  quality: 6,
  speed: 9,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { audioBuffer, language = 'pt', format = 'wav' } = input;
    if (!audioBuffer) throw new Error('audioBuffer obrigatório');

    const r = await fetch(`${HF_SERVER}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: Buffer.from(audioBuffer).toString('base64'),
        format,
        language,
        model: 'small', // modelo menor = mais rápido
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) throw new Error(`Whisper turbo HTTP ${r.status}`);
    const data = await r.json();

    return {
      text: data.text || '',
      language: data.language || language,
      duration: data.duration || null,
      segments: data.segments || [],
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.stt === true };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// 4. GOOGLE SPEECH-TO-TEXT (via Gemini — já tem key)
// ================================================================
registerProvider({
  id: 'google-stt',
  type: 'stt',
  name: 'Google Speech (Gemini)',
  description: 'Speech-to-Text via Google AI Studio. Pago, muito preciso.',
  quality: 9,
  speed: 7,
  cost: 'paid',
  local: false,
  requires: 'GOOGLE_AI_STUDIO_KEY',

  async execute(input, options = {}) {
    const { audioBuffer, language = 'pt', format = 'wav' } = input;
    if (!audioBuffer) throw new Error('audioBuffer obrigatório');

    // Usa Gemini multimodal para transcrever (aceita áudio)
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_STUDIO_KEY });

    const base64Audio = Buffer.from(audioBuffer).toString('base64');
    const mimeType = format === 'mp3' ? 'audio/mpeg' : format === 'ogg' ? 'audio/ogg' : 'audio/wav';

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{
        parts: [
          { inlineData: { mimeType, data: base64Audio } },
          { text: `Transcreva este áudio em ${language === 'pt' ? 'português brasileiro' : language}. Retorne APENAS o texto transcrito, sem nada mais.` },
        ],
      }],
    });

    const text = response.text || '';

    return {
      text: text.trim(),
      language,
      duration: null,
      segments: [],
    };
  },

  async healthCheck() {
    return { ok: !!process.env.GOOGLE_AI_STUDIO_KEY };
  },
});

log.ai.info('STT providers registrados: whisper-api, whisper-local, whisper-turbo, google-stt');
