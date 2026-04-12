// ================================================================
// EMBEDDINGS PROVIDERS — Vetorização semântica multi-provider
// Providers: OpenAI, all-MiniLM-L6-v2 (local), BGE-large (local)
// ================================================================
import { registerProvider } from './registry.js';
import { log } from '../../logger.js';

const HF_SERVER = 'http://127.0.0.1:3010';

// ================================================================
// 1. OPENAI EMBEDDINGS (pago, alta dimensão, qualidade top)
// ================================================================
registerProvider({
  id: 'openai-embed',
  type: 'embeddings',
  name: 'OpenAI Embeddings',
  description: 'text-embedding-3-small/large da OpenAI. Pago, alta qualidade, 1536/3072 dimensões.',
  quality: 9,
  speed: 7,
  cost: 'paid',
  local: false,
  requires: 'OPENAI_API_KEY',

  async execute(input, options = {}) {
    const { texts } = input; // array de strings
    if (!texts || !texts.length) throw new Error('texts[] obrigatório');

    // Não usar se base URL é Groq
    const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    if (baseUrl.includes('groq')) throw new Error('Groq não suporta embeddings');

    const model = options.model || 'text-embedding-3-small';

    const r = await fetch(`https://api.openai.com/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input: texts }),
    });

    if (!r.ok) throw new Error(`OpenAI Embeddings HTTP ${r.status}`);
    const data = await r.json();

    return {
      embeddings: data.data.map(d => d.embedding),
      dimensions: data.data[0]?.embedding?.length || 0,
      model,
    };
  },

  async healthCheck() {
    if (!process.env.OPENAI_API_KEY) return { ok: false };
    if (process.env.OPENAI_BASE_URL?.includes('groq')) return { ok: false };
    return { ok: true };
  },
});

// ================================================================
// 2. ALL-MINILM-L6-V2 (local — 22MB, 384 dims, ultra-rápido)
// ================================================================
registerProvider({
  id: 'minilm',
  type: 'embeddings',
  name: 'MiniLM-L6-v2 (Local)',
  description: 'sentence-transformers/all-MiniLM-L6-v2. 22MB, 384 dims, <10ms por frase. Melhor custo-benefício.',
  quality: 7,
  speed: 10,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { texts } = input;
    if (!texts || !texts.length) throw new Error('texts[] obrigatório');

    const r = await fetch(`${HF_SERVER}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texts,
        model: 'all-MiniLM-L6-v2',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!r.ok) throw new Error(`MiniLM HTTP ${r.status}`);
    const data = await r.json();

    return {
      embeddings: data.embeddings,
      dimensions: data.dimensions || 384,
      model: 'all-MiniLM-L6-v2',
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.embeddings === true };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// 3. BGE-LARGE-EN (local — 335MB, 1024 dims, melhor qualidade open-source)
// ================================================================
registerProvider({
  id: 'bge-large',
  type: 'embeddings',
  name: 'BGE-large-en (Local)',
  description: 'BAAI/bge-large-en-v1.5. 335MB, 1024 dims. Melhor modelo open-source de embeddings.',
  quality: 9,
  speed: 6,
  cost: 'free',
  local: true,
  requires: null,

  async execute(input, options = {}) {
    const { texts } = input;
    if (!texts || !texts.length) throw new Error('texts[] obrigatório');

    const r = await fetch(`${HF_SERVER}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        texts,
        model: 'bge-large-en-v1.5',
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!r.ok) throw new Error(`BGE-large HTTP ${r.status}`);
    const data = await r.json();

    return {
      embeddings: data.embeddings,
      dimensions: data.dimensions || 1024,
      model: 'bge-large-en-v1.5',
    };
  },

  async healthCheck() {
    try {
      const r = await fetch(`${HF_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { ok: d.services?.embeddings_bge === true };
    } catch {
      return { ok: false };
    }
  },
});

// ================================================================
// UTILIDADE: Calcular similaridade de cosseno entre dois vetores
// ================================================================
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

log.ai.info('Embeddings providers registrados: openai-embed, minilm, bge-large');
