// ================================================================
// ROUTES — Alexa Custom Skill
// POST /api/alexa/webhook — endpoint principal da skill
// GET  /api/alexa/config  — retorna config atual
// PUT  /api/alexa/config  — atualiza config
// GET  /api/alexa/devices — lista devices cadastrados
// POST /api/alexa/devices — adiciona device
// GET  /api/alexa/logs    — lista logs de interações
// POST /api/alexa/test    — simula request da alexa
// ================================================================
import { Router } from 'express';
import alexaVerifier from 'alexa-verifier';
import { log } from '../logger.js';
import {
  validateRequest, buildResponse, getAlexaConfig, updateAlexaConfig,
  addDevice, removeDevice, listDevices, getLogs, clearLogs, logInteraction,
} from '../services/alexa.js';
import { handleAlexaRequest } from '../services/alexa-intents.js';
import { getSkillsList, routeSkill } from '../services/alexa-skills.js';

const router = Router();

// ================================================================
// HEALTH CHECK
// ================================================================
router.get('/health', (req, res) => {
  const config = getAlexaConfig();
  res.json({
    ok: true,
    enabled: config.enabled,
    hasSkillId: !!config.skillId,
    whitelistMode: config.whitelistMode,
    devicesCount: config.devices.length,
  });
});

// ================================================================
// DEBUG — ultimos 10 logs (publico, sem auth — temporario para debug)
// ================================================================
router.get('/debug/last', (req, res) => {
  const logs = getLogs(10);
  res.json({ ok: true, count: logs.length, logs });
});

// ================================================================
// SKILLS — lista de skills disponiveis
// ================================================================
router.get('/skills', (req, res) => {
  const skills = getSkillsList();
  res.json({ ok: true, count: skills.length, skills });
});

// Testa uma skill sem precisar de Alexa
router.post('/skills/test', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query obrigatorio' });
  const result = await routeSkill(query);
  res.json({ success: true, query, result });
});

// ================================================================
// WEBHOOK — endpoint principal da Alexa
// O raw body vem de req.rawBody (capturado pelo express.json verify)
// O body parseado vem de req.body
// ================================================================
router.post('/webhook', async (req, res) => {
  const body = req.body;
  const rawBody = req.rawBody || JSON.stringify(body);
  const certUrl = req.headers['signaturecertchainurl'];
  const signature = req.headers['signature'];

  // LOG IMEDIATO (antes de qualquer validacao) — registra tudo que chega
  logInteraction({
    stage: 'received',
    type: body?.request?.type || 'Unknown',
    intent: body?.request?.intent?.name || null,
    deviceId: body?.context?.System?.device?.deviceId?.slice(-12) || null,
    hasRawBody: !!req.rawBody,
    rawBodyLen: rawBody?.length || 0,
    hasCert: !!certUrl,
    hasSig: !!signature,
    userAgent: req.headers['user-agent'] || null,
  });

  log.wa.info({
    type: body?.request?.type,
    intent: body?.request?.intent?.name,
    deviceId: body?.context?.System?.device?.deviceId?.slice(-12),
    hasRawBody: !!req.rawBody,
    rawBodyLen: rawBody?.length,
    hasCert: !!certUrl,
    hasSig: !!signature,
  }, 'Alexa: request recebido');

  // ============ VALIDAÇÃO DE ASSINATURA (Amazon) ============
  // Modo tolerante: loga falhas mas nao bloqueia (seguranca via Application ID)
  const strictSignature = process.env.ALEXA_STRICT_SIGNATURE === 'true';

  if (certUrl && signature) {
    try {
      await new Promise((resolve, reject) => {
        alexaVerifier(certUrl, signature, rawBody, (err) => {
          if (err) {
            const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
            reject(new Error(msg));
          } else {
            resolve();
          }
        });
      });
      logInteraction({ stage: 'signature_ok' });
    } catch (e) {
      log.wa.error({ err: e.message, certUrl }, 'Alexa: assinatura invalida');
      logInteraction({ stage: 'signature_failed', error: e.message, certUrl });
      // Em modo estrito, bloqueia. Senao, segue com warning.
      if (strictSignature) {
        return res.status(200).json(buildResponse({
          speech: 'Erro de validacao de seguranca: ' + e.message.slice(0, 80),
          endSession: true,
        }));
      }
    }
  }

  // ============ VALIDAÇÕES CUSTOMIZADAS ============
  const validation = validateRequest(body);
  if (!validation.valid) {
    log.wa.warn({ reason: validation.reason }, 'Alexa: request rejeitado');
    return res.status(200).json(buildResponse({
      speech: 'Acesso negado: ' + validation.reason,
      endSession: true,
    }));
  }

  // ============ PROCESSAMENTO ============
  try {
    const response = await handleAlexaRequest(body);
    res.status(200).json(response);
  } catch (e) {
    log.wa.error({ err: e.message, stack: e.stack }, 'Alexa: erro no processamento');
    // Alexa precisa de resposta válida mesmo em erro
    res.status(200).json(buildResponse({
      speech: 'Desculpe, tive um problema interno: ' + e.message.slice(0, 100),
      endSession: true,
    }));
  }
});

// ================================================================
// CONFIG
// ================================================================
router.get('/config', (req, res) => {
  const config = getAlexaConfig();
  // Não retorna os logs (use /logs)
  const { logs, ...rest } = config;
  res.json({ success: true, config: rest });
});

router.put('/config', (req, res) => {
  const allowed = ['skillId', 'enabled', 'whitelistMode', 'voice', 'language', 'maxTimestampSkew'];
  const patch = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  const updated = updateAlexaConfig(patch);
  const { logs, ...rest } = updated;
  res.json({ success: true, config: rest });
});

// ================================================================
// DEVICES
// ================================================================
router.get('/devices', (req, res) => {
  res.json({ success: true, devices: listDevices() });
});

router.post('/devices', (req, res) => {
  const { deviceId, label } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'deviceId obrigatorio' });
  const devices = addDevice(deviceId, label || 'Echo');
  res.json({ success: true, devices });
});

router.delete('/devices/:deviceId', (req, res) => {
  const devices = removeDevice(req.params.deviceId);
  res.json({ success: true, devices });
});

// ================================================================
// LOGS
// ================================================================
router.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ success: true, logs: getLogs(limit) });
});

router.delete('/logs', (req, res) => {
  clearLogs();
  res.json({ success: true });
});

// ================================================================
// TEST — simula request sem precisar da Alexa real
// Usa ALEXA_SKIP_VERIFY=true implicito
// ================================================================
router.post('/test', async (req, res) => {
  const { query, type = 'IntentRequest', intent = 'ConverseIntent' } = req.body;

  const fakeBody = {
    version: '1.0',
    session: {
      new: true,
      sessionId: 'test.session.' + Date.now(),
      application: { applicationId: getAlexaConfig().skillId || 'amzn1.ask.skill.test' },
      user: { userId: 'test.user' },
      attributes: {},
    },
    context: {
      System: {
        application: { applicationId: getAlexaConfig().skillId || 'amzn1.ask.skill.test' },
        user: { userId: 'test.user' },
        device: { deviceId: 'test.device', supportedInterfaces: {} },
      },
    },
    request: {
      type,
      requestId: 'test.request.' + Date.now(),
      timestamp: new Date().toISOString(),
      locale: 'pt-BR',
      ...(type === 'IntentRequest' && {
        intent: {
          name: intent,
          slots: query ? { query: { name: 'query', value: query } } : {},
        },
      }),
    },
  };

  try {
    const response = await handleAlexaRequest(fakeBody);
    res.json({ success: true, request: fakeBody, response });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// INTERACTION MODEL (JSON pra colar no Amazon Developer Console)
// ================================================================
router.get('/interaction-model', (req, res) => {
  const model = {
    interactionModel: {
      languageModel: {
        invocationName: 'minha zaya',
        intents: [
          { name: 'AMAZON.StopIntent', samples: [] },
          { name: 'AMAZON.CancelIntent', samples: [] },
          { name: 'AMAZON.HelpIntent', samples: [] },
          { name: 'AMAZON.FallbackIntent', samples: [] },
          {
            name: 'ConverseIntent',
            slots: [
              { name: 'query', type: 'AMAZON.SearchQuery' },
            ],
            samples: [
              // Verbos simples
              'pergunte {query}',
              'pergunta {query}',
              'diga {query}',
              'diz {query}',
              'fala {query}',
              'fale {query}',
              'conte {query}',
              'conta {query}',
              'responda {query}',
              'responde {query}',
              'explica {query}',
              'explique {query}',
              'mostre {query}',
              'mostra {query}',
              'veja {query}',
              'verifique {query}',
              'verifica {query}',
              'checa {query}',
              'cheque {query}',
              'confira {query}',
              'confere {query}',

              // Com "me"
              'me diga {query}',
              'me fala {query}',
              'me fale {query}',
              'me fale sobre {query}',
              'me fala sobre {query}',
              'me conte {query}',
              'me conta {query}',
              'me conte sobre {query}',
              'me conta sobre {query}',
              'me responda {query}',
              'me responde {query}',
              'me explica {query}',
              'me explique {query}',
              'me mostra {query}',
              'me mostre {query}',
              'me ajuda com {query}',
              'me ajude com {query}',

              // Querer saber
              'quero saber {query}',
              'eu quero saber {query}',
              'queria saber {query}',
              'gostaria de saber {query}',
              'preciso saber {query}',
              'eu preciso saber {query}',
              'preciso de {query}',
              'eu preciso de {query}',
              'quero {query}',
              'eu quero {query}',
              'queria {query}',

              // Perguntas abertas
              'o que é {query}',
              'o que e {query}',
              'o que são {query}',
              'o que significa {query}',
              'o que quer dizer {query}',
              'o que você sabe sobre {query}',
              'o que voce sabe sobre {query}',
              'o que acha de {query}',
              'o que você acha sobre {query}',
              'como é {query}',
              'como e {query}',
              'como funciona {query}',
              'como fazer {query}',
              'como posso {query}',
              'como eu faço {query}',
              'como eu posso {query}',
              'como se faz {query}',
              'por que {query}',
              'por quê {query}',
              'porque {query}',
              'quando {query}',
              'onde {query}',
              'onde fica {query}',
              'onde está {query}',
              'qual {query}',
              'qual é {query}',
              'qual o {query}',
              'qual a {query}',
              'quais {query}',
              'quem {query}',
              'quem é {query}',
              'quanto {query}',
              'quanto é {query}',
              'quanto custa {query}',

              // Busca e pesquisa
              'busque {query}',
              'busque por {query}',
              'busca {query}',
              'pesquise {query}',
              'pesquisa {query}',
              'procure {query}',
              'procura {query}',
              'encontre {query}',
              'encontra {query}',
              'acha {query}',
              'ache {query}',

              // Ajuda
              'ajude me com {query}',
              'ajuda com {query}',
              'preciso de ajuda com {query}',
              'preciso de ajuda para {query}',
              'pode me ajudar com {query}',
              'pode ajudar com {query}',
              'você pode {query}',
              'voce pode {query}',
              'pode {query}',

              // Comandos
              'liga {query}',
              'ligue {query}',
              'desliga {query}',
              'desligue {query}',
              'ativa {query}',
              'ative {query}',
              'cria {query}',
              'crie {query}',
              'cria uma {query}',
              'crie uma {query}',
              'cria um {query}',
              'crie um {query}',
              'abre {query}',
              'abra {query}',
              'fecha {query}',
              'feche {query}',
              'envia {query}',
              'envie {query}',
              'manda {query}',
              'mande {query}',
              'chama {query}',
              'chame {query}',
              'lembra me de {query}',
              'lembre me de {query}',
              'anota {query}',
              'anote {query}',
              'agenda {query}',
              'agende {query}',

              // Preposições
              'para {query}',
              'sobre {query}',
              'a respeito de {query}',

              // Saudações com continuação
              'zaya {query}',
              'oi zaya {query}',
              'ei zaya {query}',
              'olha zaya {query}',
            ],
          },
          {
            name: 'NotificationIntent',
            slots: [],
            samples: [
              'tenho mensagens',
              'tenho notificações',
              'alguma mensagem nova',
              'quais mensagens eu tenho',
              'verificar mensagens',
              'ler mensagens',
              'tem alguma coisa pra mim',
            ],
          },
        ],
        types: [],
      },
    },
  };

  res.json(model);
});

export default router;
