// ================================================================
// ROTAS — WhatsApp Flows (CRUD + envio + respostas)
// ================================================================
import { Router } from 'express';
import { log } from '../logger.js';
import {
  createFlow, updateFlowJSON, publishFlow, deprecateFlow, deleteFlow,
  listFlows, getFlow, getFlowPreview, sendFlow,
  createFlowFromTemplate, getFlowResponses, FLOW_TEMPLATES,
} from '../services/whatsapp-flows.js';

const router = Router();

// ================================================================
// ROTAS FIXAS (ANTES de /:flowId para evitar conflito)
// ================================================================

// Listar flows
router.get('/', async (req, res) => {
  const result = await listFlows();
  res.json(result);
});

// Templates disponíveis
router.get('/templates', (req, res) => {
  const templates = Object.entries(FLOW_TEMPLATES).map(([key, t]) => ({
    key,
    name: t.name,
    categories: t.categories,
    screens: t.json.screens.length,
  }));
  res.json({ success: true, templates });
});

// Todas as respostas
router.get('/responses/all', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const responses = getFlowResponses(null, limit);
  res.json({ success: true, count: responses.length, responses });
});

// Criar flow
router.post('/', async (req, res) => {
  const { name, categories, template } = req.body;
  if (template) {
    const result = await createFlowFromTemplate(template, name);
    return res.json(result);
  }
  if (!name) return res.status(400).json({ error: 'name é obrigatório' });
  const result = await createFlow(name, categories);
  res.json(result);
});

// ================================================================
// ROTAS COM PARÂMETRO /:flowId
// ================================================================

// Detalhes do flow
router.get('/:flowId', async (req, res) => {
  const result = await getFlow(req.params.flowId);
  res.json(result);
});

// Preview do flow
router.get('/:flowId/preview', async (req, res) => {
  const result = await getFlowPreview(req.params.flowId);
  res.json(result);
});

// Respostas de um flow específico
router.get('/:flowId/responses', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const responses = getFlowResponses(req.params.flowId, limit);
  res.json({ success: true, count: responses.length, responses });
});

// Atualizar JSON do flow
router.put('/:flowId/json', async (req, res) => {
  const { json } = req.body;
  if (!json) return res.status(400).json({ error: 'json é obrigatório' });
  const result = await updateFlowJSON(req.params.flowId, json);
  res.json(result);
});

// Publicar flow
router.post('/:flowId/publish', async (req, res) => {
  const result = await publishFlow(req.params.flowId);
  res.json(result);
});

// Deprecar flow
router.post('/:flowId/deprecate', async (req, res) => {
  const result = await deprecateFlow(req.params.flowId);
  res.json(result);
});

// Enviar flow para contato
router.post('/:flowId/send', async (req, res) => {
  const { to, headerText, bodyText, footerText, flowCTA, screenId, flowData } = req.body;
  if (!to) return res.status(400).json({ error: 'to (telefone) é obrigatório' });
  const result = await sendFlow(to, req.params.flowId, {
    headerText, bodyText, footerText, flowCTA, screenId, flowData,
  });
  res.json(result);
});

// Broadcast para múltiplos contatos
router.post('/:flowId/broadcast', async (req, res) => {
  const { contacts, headerText, bodyText, footerText, flowCTA, screenId, flowData } = req.body;
  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'contacts (array de telefones) é obrigatório' });
  }

  const results = [];
  for (const to of contacts) {
    const result = await sendFlow(to, req.params.flowId, {
      headerText, bodyText, footerText, flowCTA, screenId, flowData,
    });
    results.push({ to, ...result });
    // Rate limit: 1 msg por segundo
    await new Promise(r => setTimeout(r, 1000));
  }

  const sent = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  res.json({ success: true, total: contacts.length, sent, failed, details: results });
});

// Deletar flow
router.delete('/:flowId', async (req, res) => {
  const result = await deleteFlow(req.params.flowId);
  res.json(result);
});

export default router;
