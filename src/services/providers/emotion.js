// ================================================================
// EMOTION PROVIDERS — Detecção de emoção multi-provider
// Providers: Text (distilbert-emotion, sentiment), Voice (wav2vec2)
// ================================================================
import { registerProvider } from './registry.js';
import { log } from '../../logger.js';

const HF_SERVER = 'http://127.0.0.1:3010';

// ================================================================
// 1. DISTILBERT EMOTION (texto — 6 emoções detalhadas)
// ================================================================
registerProvider({
  id: 'distilbert-emotion',
  type: 'emotion',
  name: 'DistilBERT Emotion (Texto)',
  description: 'Detecta 6 emoções no texto: joy, sadness, anger, fear, love, surprise. 66MB, roda local.',
  quality: 8,
  speed: 9,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { text } = input;
    if (!text) throw new Error('text obrigatório');

    const r = await fetch(`${HF_SERVER}/emotion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        engine: 'distilbert',
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!r.ok) throw new Error(`Emotion text HTTP ${r.status}`);
    const data = await r.json();

    return {
      emotion: data.emotion,            // 'joy', 'sadness', etc.
      confidence: data.confidence,       // 0.0 - 1.0
      allEmotions: data.all_emotions,    // { joy: 0.8, sadness: 0.1, ... }
      source: 'text',
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.emotion_text === true };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// 2. SENTIMENT ANALYSIS (texto — positivo/negativo/neutro)
// ================================================================
registerProvider({
  id: 'sentiment',
  type: 'emotion',
  name: 'Sentiment Analysis (Texto)',
  description: 'Análise de sentimento: positivo, negativo, neutro. Rápido e leve.',
  quality: 6,
  speed: 10,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { text } = input;
    if (!text) throw new Error('text obrigatório');

    const r = await fetch(`${HF_SERVER}/emotion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        engine: 'sentiment',
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!r.ok) throw new Error(`Sentiment HTTP ${r.status}`);
    const data = await r.json();

    return {
      emotion: data.sentiment,           // 'positive', 'negative', 'neutral'
      confidence: data.confidence,
      score: data.score,                 // -1.0 a 1.0
      source: 'text',
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.sentiment === true };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// 3. VOICE EMOTION (áudio — wav2vec2 IEMOCAP)
// ================================================================
registerProvider({
  id: 'voice-emotion',
  type: 'emotion',
  name: 'Voice Emotion (wav2vec2)',
  description: 'Detecta emoção pela VOZ: angry, happy, sad, neutral. Baseado em wav2vec2 treinado no IEMOCAP.',
  quality: 8,
  speed: 6,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { audioBuffer, sampleRate = 16000 } = input;
    if (!audioBuffer) throw new Error('audioBuffer obrigatório');

    const r = await fetch(`${HF_SERVER}/emotion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: Buffer.from(audioBuffer).toString('base64'),
        sample_rate: sampleRate,
        engine: 'voice',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) throw new Error(`Voice emotion HTTP ${r.status}`);
    const data = await r.json();

    return {
      emotion: data.emotion,            // 'angry', 'happy', 'sad', 'neutral'
      confidence: data.confidence,
      allEmotions: data.all_emotions,
      source: 'voice',
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.emotion_voice === true };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// 4. AI EMOTION (usa LLM para inferir emoção — fallback)
// ================================================================
registerProvider({
  id: 'ai-emotion',
  type: 'emotion',
  name: 'AI Emotion (LLM)',
  description: 'Usa GPT/Claude para inferir emoção do texto. Fallback quando modelos locais não estão disponíveis.',
  quality: 7,
  speed: 4,
  cost: 'paid',
  local: false,
  requires: 'OPENAI_API_KEY',

  async execute(input, options = {}) {
    const { text } = input;
    if (!text) throw new Error('text obrigatório');

    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const r = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      temperature: 0,
      messages: [{
        role: 'system',
        content: 'Analise a emoção do texto. Responda APENAS em JSON: {"emotion":"joy|sadness|anger|fear|love|surprise|neutral","confidence":0.0-1.0}',
      }, {
        role: 'user',
        content: text,
      }],
    });

    const parsed = JSON.parse(r.choices[0].message.content);

    return {
      emotion: parsed.emotion,
      confidence: parsed.confidence,
      source: 'llm',
    };
  },

  async healthCheck() {
    return { ok: !!process.env.OPENAI_API_KEY };
  },
});

log.ai.info('Emotion providers registrados: distilbert-emotion, sentiment, voice-emotion, ai-emotion');
