// ================================================================
// ROTAS /api/providers — Gerenciar providers via Dashboard/API
// ================================================================
import { Router } from 'express';
import {
  listProviders,
  checkAllHealth,
  checkHealth,
  enableProvider,
  setDefaultMode,
  setUserPreference,
  clearUserPreference,
  explainSelection,
  MODES,
  CONTEXTS,
} from '../services/providers/index.js';
import { providerStatsDB } from '../database.js';
import { log } from '../logger.js';
import { settingsDB } from '../database.js';

const router = Router();

// ================================================================
// GET /api/providers — Listar todos os providers
// ================================================================
router.get('/', (req, res) => {
  const type = req.query.type || null; // ?type=stt
  const providers = listProviders(type);

  const mode = settingsDB.get('provider_mode', 'balanced');

  res.json({
    mode,
    modes: Object.entries(MODES).map(([k, v]) => ({ id: k, ...v })),
    contexts: Object.entries(CONTEXTS).map(([k, v]) => ({ id: k, ...v })),
    providers,
    types: [...new Set(providers.map(p => p.type))],
  });
});

// ================================================================
// POST /api/providers/health — Health check de todos
// ================================================================
router.post('/health', async (req, res) => {
  try {
    const results = await checkAllHealth();
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// POST /api/providers/health/:type/:id — Health check de um específico
// ================================================================
router.post('/health/:type/:id', async (req, res) => {
  try {
    const result = await checkHealth(req.params.type, req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// POST /api/providers/mode — Alterar modo global (quality/balanced/fast/free)
// ================================================================
router.post('/mode', (req, res) => {
  try {
    const { mode } = req.body;
    setDefaultMode(mode);
    res.json({ success: true, mode });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ================================================================
// POST /api/providers/prefer — Definir provider preferido para um tipo
// ================================================================
router.post('/prefer', (req, res) => {
  const { type, providerId } = req.body;
  if (!type) return res.status(400).json({ error: 'type obrigatório' });

  if (providerId) {
    setUserPreference(type, providerId);
    res.json({ success: true, type, preferred: providerId });
  } else {
    clearUserPreference(type);
    res.json({ success: true, type, preferred: null, message: 'Preferência removida — Smart Select ativo' });
  }
});

// ================================================================
// POST /api/providers/enable — Habilitar/desabilitar provider
// ================================================================
router.post('/enable', (req, res) => {
  try {
    const { type, id, enabled } = req.body;
    enableProvider(type, id, enabled !== false);
    res.json({ success: true, type, id, enabled: enabled !== false });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ================================================================
// POST /api/providers/explain — Zaya explica por que escolheu aquele provider
// ================================================================
router.post('/explain', (req, res) => {
  const { type, mode, situation } = req.body;
  if (!type) return res.status(400).json({ error: 'type obrigatório' });

  const explanation = explainSelection(type, { mode, situation });
  res.json(explanation);
});

// ================================================================
// GET /api/providers/stats — Estatísticas de uso dos providers
// ================================================================
router.get('/stats', (req, res) => {
  const stats = providerStatsDB.getStats();
  res.json({ stats });
});

// ================================================================
// POST /api/providers/test — Testar um provider específico
// ================================================================
router.post('/test', async (req, res) => {
  const { type, id, input } = req.body;

  if (!type || !id) {
    return res.status(400).json({ error: 'type e id obrigatórios' });
  }

  try {
    const providers = listProviders(type);
    const provider = providers.find(p => p.id === id);
    if (!provider) return res.status(404).json({ error: `Provider ${type}:${id} não encontrado` });
    if (!provider.available) return res.status(503).json({ error: `Provider ${id} não está disponível` });

    // Testes padrão por tipo
    let testInput = input;
    if (!testInput) {
      if (type === 'emotion') testInput = { text: 'Estou muito feliz hoje! Que dia maravilhoso!' };
      else if (type === 'embeddings') testInput = { texts: ['teste de embeddings'] };
      else return res.status(400).json({ error: 'input obrigatório para este tipo de provider' });
    }

    const { executeWithFallback } = await import('../services/providers/registry.js');

    // Força usar o provider específico
    const start = Date.now();
    const result = await executeWithFallback(type, testInput, {
      context: { mode: 'quality' },
      maxRetries: 1,
    });
    const elapsed = Date.now() - start;

    // Formata resultado baseado no tipo
    let formattedResult = result;
    if (type === 'embeddings') {
      formattedResult = { dimensions: result.dimensions, model: result.model, sample: result.embeddings?.[0]?.slice(0, 5) };
    } else if (type === 'tts' && result.audioBuffer) {
      // Converte audioBuffer para base64 para o frontend reproduzir
      const buf = Buffer.isBuffer(result.audioBuffer) ? result.audioBuffer : Buffer.from(result.audioBuffer);
      formattedResult = {
        audio_base64: buf.toString('base64'),
        format: result.format || 'mp3',
        size: buf.length,
        voice: result.voice || result.voiceId || '',
      };
    }

    res.json({
      success: true,
      provider: id,
      elapsed,
      result: formattedResult,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
