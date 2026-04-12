// ================================================================
// TTS PROVIDERS — Text-to-Speech multi-provider
// Providers: ElevenLabs, Kokoro-82M, XTTS-v2, OpenAI TTS
// ================================================================
import { registerProvider } from './registry.js';
import { settingsDB } from '../../database.js';
import { log } from '../../logger.js';

const HF_SERVER = 'http://127.0.0.1:3010';

// ================================================================
// 1. ELEVENLABS (provider atual — pago, qualidade premium)
// ================================================================
registerProvider({
  id: 'elevenlabs',
  type: 'tts',
  name: 'ElevenLabs',
  description: 'TTS premium com vozes ultra-realistas. Pago por caractere. Suporta voz clonada do Sr. Alisson.',
  quality: 10,
  speed: 7,
  cost: 'paid',
  local: false,
  requires: 'ELEVENLABS_API_KEY',

  async execute(input, options = {}) {
    const { text } = input;
    if (!text) throw new Error('text obrigatório');

    const voiceId = options.voiceId
      || settingsDB.get('elevenlabs_voice_id', process.env.ELEVENLABS_VOICE_ID || 'RGymW84CSmfVugnA5tvA');
    const model = options.model || 'eleven_v3';

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.slice(0, 5000),
        model_id: model,
        voice_settings: {
          stability: options.stability || 0.3,
          similarity_boost: options.similarityBoost || 0.75,
          style: options.style || 0.55,
          use_speaker_boost: true,
        },
      }),
    });

    if (!r.ok) throw new Error(`ElevenLabs HTTP ${r.status}`);
    const buffer = Buffer.from(await r.arrayBuffer());

    return {
      audioBuffer: buffer,
      format: 'mp3',
      size: buffer.length,
      voiceId,
    };
  },

  async healthCheck() {
    if (!process.env.ELEVENLABS_API_KEY) return { ok: false };
    try {
      const r = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const d = await r.json();
        return { ok: true, remainingChars: d.subscription?.character_count || 'unknown' };
      }
      return { ok: false };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// 2. KOKORO-82M (local — gratuito, ultra-leve, qualidade surpreendente)
// ================================================================
registerProvider({
  id: 'kokoro',
  type: 'tts',
  name: 'Kokoro-82M (Local)',
  description: 'TTS ultra-leve (82MB). Qualidade MOS 4.2 — melhor score entre modelos open-source. Inglês e japonês.',
  quality: 7,
  speed: 9,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { text } = input;
    if (!text) throw new Error('text obrigatório');

    const r = await fetch(`${HF_SERVER}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.slice(0, 3000),
        engine: 'kokoro',
        voice: options.voice || 'af_heart',  // af_heart, af_bella, am_adam, etc.
        speed: options.speed || 1.0,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!r.ok) throw new Error(`Kokoro HTTP ${r.status}`);
    const data = await r.json();

    return {
      audioBuffer: Buffer.from(data.audio_base64, 'base64'),
      format: data.format || 'wav',
      size: data.size || 0,
      sampleRate: data.sample_rate || 24000,
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.tts_kokoro === true };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// 3. XTTS-v2 (local — clonagem de voz com 6s de amostra)
// ================================================================
registerProvider({
  id: 'xtts',
  type: 'tts',
  name: 'XTTS-v2 (Voice Clone)',
  description: 'Coqui XTTS-v2: clona qualquer voz com apenas 6 segundos de amostra. 17 idiomas incluindo PT-BR.',
  quality: 8,
  speed: 5,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { text } = input;
    if (!text) throw new Error('text obrigatório');

    const body = {
      text: text.slice(0, 2000),
      engine: 'xtts',
      language: options.language || 'pt',
      speed: options.speed || 1.0,
    };

    // Se tem amostra de voz para clonar
    if (options.speakerWav) {
      body.speaker_wav_base64 = Buffer.from(options.speakerWav).toString('base64');
    } else if (options.speakerProfile) {
      body.speaker_profile = options.speakerProfile; // nome do perfil salvo
    }

    const r = await fetch(`${HF_SERVER}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000), // XTTS pode ser mais lento
    });

    if (!r.ok) throw new Error(`XTTS HTTP ${r.status}`);
    const data = await r.json();

    return {
      audioBuffer: Buffer.from(data.audio_base64, 'base64'),
      format: data.format || 'wav',
      size: data.size || 0,
      sampleRate: data.sample_rate || 24000,
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.tts_xtts === true };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// 4. OPENAI TTS (API — pago, boa qualidade, várias vozes)
// ================================================================
registerProvider({
  id: 'openai-tts',
  type: 'tts',
  name: 'OpenAI TTS',
  description: 'TTS da OpenAI (alloy, echo, fable, onyx, nova, shimmer). Pago, qualidade boa, rápido.',
  quality: 8,
  speed: 8,
  cost: 'paid',
  local: false,
  requires: 'OPENAI_API_KEY',

  async execute(input, options = {}) {
    const { text } = input;
    if (!text) throw new Error('text obrigatório');

    // Não usar se OPENAI_BASE_URL é Groq (Groq não tem TTS)
    if (process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL.includes('groq')) {
      throw new Error('OpenAI TTS não disponível via Groq');
    }

    const voice = options.voice || 'nova'; // nova soa mais feminino (bom pra Zaya)
    const model = options.model || 'tts-1'; // tts-1 (rápido) ou tts-1-hd (qualidade)

    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        input: text.slice(0, 4096),
        response_format: 'mp3',
        speed: options.speed || 1.0,
      }),
    });

    if (!r.ok) throw new Error(`OpenAI TTS HTTP ${r.status}`);
    const buffer = Buffer.from(await r.arrayBuffer());

    return {
      audioBuffer: buffer,
      format: 'mp3',
      size: buffer.length,
      voice,
    };
  },

  async healthCheck() {
    if (!process.env.OPENAI_API_KEY) return { ok: false };
    // Groq não suporta TTS
    if (process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL.includes('groq')) return { ok: false };
    return { ok: true };
  },
});

// ================================================================
// 5. EDGE TTS (Microsoft — gratuito, sem limite, várias vozes PT-BR)
// ================================================================
registerProvider({
  id: 'edge-tts',
  type: 'tts',
  name: 'Edge TTS (Microsoft)',
  description: 'TTS gratuito da Microsoft Edge. Vozes PT-BR nativas (Francisca, Antonio). Sem limite de uso.',
  quality: 6,
  speed: 8,
  cost: 'free',
  local: false,
  requires: null,

  async execute(input, options = {}) {
    const { text } = input;
    if (!text) throw new Error('text obrigatório');

    // Usa o HF server como proxy para edge-tts (pacote Python)
    const r = await fetch(`${HF_SERVER}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.slice(0, 3000),
        engine: 'edge',
        voice: options.voice || 'pt-BR-FranciscaNeural', // pt-BR-FranciscaNeural, pt-BR-AntonioNeural
        rate: options.rate || '+0%',
        pitch: options.pitch || '+0Hz',
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) throw new Error(`Edge TTS HTTP ${r.status}`);
    const data = await r.json();

    return {
      audioBuffer: Buffer.from(data.audio_base64, 'base64'),
      format: data.format || 'mp3',
      size: data.size || 0,
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.tts_edge === true };
    } catch {
      return { ok: false };
    }
  },
});

log.ai.info('TTS providers registrados: elevenlabs, kokoro, xtts, openai-tts, edge-tts');
