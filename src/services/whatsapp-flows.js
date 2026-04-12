// ================================================================
// WHATSAPP FLOWS — Meta Business API
// Cria, gerencia e envia fluxos interativos no WhatsApp
// Docs: https://developers.facebook.com/docs/whatsapp/flows
// ================================================================
import { log } from '../logger.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const WABA_ID = process.env.WHATSAPP_WABA_ID || '1506482697558392';
const PHONE_ID = process.env.WHATSAPP_PHONE_ID || '1111348328718461';
const WA_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const GRAPH = 'https://graph.facebook.com/v21.0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');
const FLOWS_DB = join(DATA_DIR, 'flows.json');

// Garante que o diretório data existe
mkdirSync(DATA_DIR, { recursive: true });

// ================================================================
// PERSISTÊNCIA LOCAL — salva flows criados
// ================================================================
function loadFlowsDB() {
  try {
    if (existsSync(FLOWS_DB)) return JSON.parse(readFileSync(FLOWS_DB, 'utf-8'));
  } catch {}
  return { flows: [], responses: [] };
}

function saveFlowsDB(db) {
  try {
    writeFileSync(FLOWS_DB, JSON.stringify(db, null, 2));
  } catch (e) {
    log.wa.error({ err: e.message }, 'Flows: erro ao salvar DB');
  }
}

// ================================================================
// CRIAR FLOW
// ================================================================
export async function createFlow(name, categories = ['OTHER']) {
  try {
    const r = await fetch(`${GRAPH}/${WABA_ID}/flows`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, categories }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);

    log.wa.info({ flowId: d.id, name }, 'Flow criado');

    // Salva localmente
    const db = loadFlowsDB();
    db.flows.push({ id: d.id, name, categories, createdAt: new Date().toISOString(), status: 'DRAFT' });
    saveFlowsDB(db);

    return { success: true, flowId: d.id };
  } catch (e) {
    log.wa.error({ err: e.message, name }, 'Erro ao criar flow');
    return { success: false, error: e.message };
  }
}

// ================================================================
// ATUALIZAR JSON DO FLOW (definição das telas)
// ================================================================
export async function updateFlowJSON(flowId, flowJSON) {
  try {
    const fd = new FormData();
    fd.append('file', new Blob([JSON.stringify(flowJSON)], { type: 'application/json' }), 'flow.json');

    const r = await fetch(`${GRAPH}/${flowId}/assets`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
      body: fd,
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);

    log.wa.info({ flowId }, 'Flow JSON atualizado');
    return { success: true, validationErrors: d.validation_errors || [] };
  } catch (e) {
    log.wa.error({ err: e.message, flowId }, 'Erro ao atualizar flow JSON');
    return { success: false, error: e.message };
  }
}

// ================================================================
// PUBLICAR FLOW (DRAFT → PUBLISHED)
// ================================================================
export async function publishFlow(flowId) {
  try {
    const r = await fetch(`${GRAPH}/${flowId}/publish`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);

    // Atualiza status local
    const db = loadFlowsDB();
    const flow = db.flows.find(f => f.id === flowId);
    if (flow) flow.status = 'PUBLISHED';
    saveFlowsDB(db);

    log.wa.info({ flowId }, 'Flow publicado');
    return { success: true };
  } catch (e) {
    log.wa.error({ err: e.message, flowId }, 'Erro ao publicar flow');
    return { success: false, error: e.message };
  }
}

// ================================================================
// DEPRECAR FLOW
// ================================================================
export async function deprecateFlow(flowId) {
  try {
    const r = await fetch(`${GRAPH}/${flowId}/deprecate`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);

    const db = loadFlowsDB();
    const flow = db.flows.find(f => f.id === flowId);
    if (flow) flow.status = 'DEPRECATED';
    saveFlowsDB(db);

    log.wa.info({ flowId }, 'Flow deprecado');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// DELETAR FLOW
// ================================================================
export async function deleteFlow(flowId) {
  try {
    const r = await fetch(`${GRAPH}/${flowId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);

    const db = loadFlowsDB();
    db.flows = db.flows.filter(f => f.id !== flowId);
    saveFlowsDB(db);

    log.wa.info({ flowId }, 'Flow deletado');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// LISTAR FLOWS
// ================================================================
export async function listFlows() {
  try {
    const r = await fetch(`${GRAPH}/${WABA_ID}/flows`, {
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);

    // Sincroniza com DB local
    const db = loadFlowsDB();
    for (const flow of (d.data || [])) {
      const existing = db.flows.find(f => f.id === flow.id);
      if (existing) {
        existing.status = flow.status;
        existing.name = flow.name;
      } else {
        db.flows.push({
          id: flow.id, name: flow.name, categories: flow.categories || [],
          createdAt: flow.created_at || new Date().toISOString(), status: flow.status,
        });
      }
    }
    saveFlowsDB(db);

    return { success: true, flows: d.data || [] };
  } catch (e) {
    log.wa.error({ err: e.message }, 'Erro ao listar flows');
    return { success: false, error: e.message };
  }
}

// ================================================================
// DETALHES DO FLOW
// ================================================================
export async function getFlow(flowId) {
  try {
    const r = await fetch(`${GRAPH}/${flowId}?fields=id,name,status,categories,validation_errors,json_version,data_api_version,data_channel_uri,preview`, {
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return { success: true, flow: d };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// PREVIEW DO FLOW
// ================================================================
export async function getFlowPreview(flowId) {
  try {
    const r = await fetch(`${GRAPH}/${flowId}?fields=preview.invalidate(false)`, {
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` },
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return { success: true, preview: d.preview };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// ENVIAR FLOW PARA UM CONTATO (via mensagem interativa)
// ================================================================
export async function sendFlow(to, flowId, { headerText, bodyText, footerText, flowCTA, screenId = 'INIT', flowData = {} } = {}) {
  const phone = formatPhone(to);
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'flow',
        header: headerText ? { type: 'text', text: headerText } : undefined,
        body: { text: bodyText || 'Toque no botão abaixo para continuar' },
        footer: footerText ? { text: footerText } : undefined,
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_id: flowId,
            flow_cta: flowCTA || 'Abrir',
            flow_action: 'navigate',
            flow_action_payload: {
              screen: screenId,
              data: flowData,
            },
          },
        },
      },
    };

    // Remove campos undefined
    if (!payload.interactive.header) delete payload.interactive.header;
    if (!payload.interactive.footer) delete payload.interactive.footer;

    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);

    log.wa.info({ to: phone, flowId, msgId: d.messages?.[0]?.id }, 'Flow enviado');
    return { success: true, messageId: d.messages?.[0]?.id };
  } catch (e) {
    log.wa.error({ err: e.message, to: phone, flowId }, 'Erro ao enviar flow');
    return { success: false, error: e.message };
  }
}

// ================================================================
// PROCESSAR RESPOSTA DE FLOW (chamado pelo webhook)
// ================================================================
export function processFlowResponse(from, nfmReply) {
  const responseData = nfmReply?.response_json ? JSON.parse(nfmReply.response_json) : nfmReply?.body || {};
  const flowId = nfmReply?.name || 'unknown';

  const entry = {
    flowId,
    from,
    data: responseData,
    receivedAt: new Date().toISOString(),
  };

  // Salva na DB local
  const db = loadFlowsDB();
  db.responses.push(entry);
  // Mantém últimas 1000 respostas
  if (db.responses.length > 1000) db.responses = db.responses.slice(-1000);
  saveFlowsDB(db);

  log.wa.info({ from, flowId, keys: Object.keys(responseData) }, 'Flow response recebida');
  return entry;
}

// ================================================================
// LISTAR RESPOSTAS DE FLOWS
// ================================================================
export function getFlowResponses(flowId = null, limit = 50) {
  const db = loadFlowsDB();
  let responses = db.responses || [];
  if (flowId) responses = responses.filter(r => r.flowId === flowId);
  return responses.slice(-limit);
}

// ================================================================
// TEMPLATES DE FLOWS PRONTOS
// ================================================================
export const FLOW_TEMPLATES = {

  // --- Atendimento ao Cliente ---
  atendimento: {
    name: 'Atendimento ao Cliente',
    categories: ['CUSTOMER_SUPPORT'],
    json: {
      version: '6.3',
      screens: [
        {
          id: 'INIT',
          title: 'Atendimento',
          data: {},
          layout: {
            type: 'SingleColumnLayout',
            children: [
              {
                type: 'TextHeading',
                text: 'Como podemos ajudar?',
              },
              {
                type: 'RadioButtonsGroup',
                name: 'motivo',
                label: 'Selecione o motivo do contato',
                required: true,
                'data-source': [
                  { id: 'duvida', title: 'Dúvida sobre produto/serviço' },
                  { id: 'problema', title: 'Problema técnico' },
                  { id: 'reclamacao', title: 'Reclamação' },
                  { id: 'sugestao', title: 'Sugestão' },
                  { id: 'outro', title: 'Outro' },
                ],
              },
              {
                type: 'TextArea',
                name: 'descricao',
                label: 'Descreva sua solicitação',
                required: true,
                'helper-text': 'Quanto mais detalhes, melhor poderemos ajudar',
              },
              {
                type: 'Footer',
                label: 'Enviar',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    motivo: '${form.motivo}',
                    descricao: '${form.descricao}',
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },

  // --- Agendamento ---
  agendamento: {
    name: 'Agendamento',
    categories: ['APPOINTMENT_BOOKING'],
    json: {
      version: '6.3',
      screens: [
        {
          id: 'INIT',
          title: 'Agendar Horário',
          data: {},
          layout: {
            type: 'SingleColumnLayout',
            children: [
              {
                type: 'TextHeading',
                text: 'Agende seu horário',
              },
              {
                type: 'TextInput',
                name: 'nome',
                label: 'Seu nome completo',
                'input-type': 'text',
                required: true,
              },
              {
                type: 'TextInput',
                name: 'email',
                label: 'E-mail',
                'input-type': 'email',
                required: false,
                'helper-text': 'Para enviar confirmação',
              },
              {
                type: 'Dropdown',
                name: 'servico',
                label: 'Tipo de serviço',
                required: true,
                'data-source': [
                  { id: 'consulta', title: 'Consulta' },
                  { id: 'reuniao', title: 'Reunião' },
                  { id: 'demonstracao', title: 'Demonstração' },
                  { id: 'suporte', title: 'Suporte técnico' },
                ],
              },
              {
                type: 'DatePicker',
                name: 'data',
                label: 'Data desejada',
                required: true,
                'min-date': new Date().toISOString().split('T')[0],
              },
              {
                type: 'Dropdown',
                name: 'horario',
                label: 'Horário preferido',
                required: true,
                'data-source': [
                  { id: '09:00', title: '09:00' },
                  { id: '10:00', title: '10:00' },
                  { id: '11:00', title: '11:00' },
                  { id: '14:00', title: '14:00' },
                  { id: '15:00', title: '15:00' },
                  { id: '16:00', title: '16:00' },
                ],
              },
              {
                type: 'Footer',
                label: 'Confirmar Agendamento',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    nome: '${form.nome}',
                    email: '${form.email}',
                    servico: '${form.servico}',
                    data: '${form.data}',
                    horario: '${form.horario}',
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },

  // --- Cadastro / Lead ---
  cadastro: {
    name: 'Formulário de Cadastro',
    categories: ['LEAD_GENERATION'],
    json: {
      version: '6.3',
      screens: [
        {
          id: 'INIT',
          title: 'Cadastro',
          data: {},
          layout: {
            type: 'SingleColumnLayout',
            children: [
              {
                type: 'TextHeading',
                text: 'Cadastre-se',
              },
              {
                type: 'TextBody',
                text: 'Preencha seus dados para receber novidades e ofertas exclusivas.',
              },
              {
                type: 'TextInput',
                name: 'nome',
                label: 'Nome completo',
                'input-type': 'text',
                required: true,
              },
              {
                type: 'TextInput',
                name: 'email',
                label: 'E-mail',
                'input-type': 'email',
                required: true,
              },
              {
                type: 'TextInput',
                name: 'telefone',
                label: 'Telefone',
                'input-type': 'phone',
                required: false,
              },
              {
                type: 'Dropdown',
                name: 'interesse',
                label: 'Área de interesse',
                required: true,
                'data-source': [
                  { id: 'produto_a', title: 'Produto A' },
                  { id: 'produto_b', title: 'Produto B' },
                  { id: 'servico_a', title: 'Serviço A' },
                  { id: 'servico_b', title: 'Serviço B' },
                ],
              },
              {
                type: 'OptIn',
                name: 'aceite',
                label: 'Aceito receber comunicações por WhatsApp',
                required: true,
                'on-click-action': {
                  name: 'navigate',
                  next: { type: 'screen', name: 'TERMS' },
                },
              },
              {
                type: 'Footer',
                label: 'Cadastrar',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    nome: '${form.nome}',
                    email: '${form.email}',
                    telefone: '${form.telefone}',
                    interesse: '${form.interesse}',
                    aceite: '${form.aceite}',
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },

  // --- Pesquisa de Satisfação ---
  pesquisa: {
    name: 'Pesquisa de Satisfação',
    categories: ['SURVEY'],
    json: {
      version: '6.3',
      screens: [
        {
          id: 'INIT',
          title: 'Pesquisa',
          data: {},
          layout: {
            type: 'SingleColumnLayout',
            children: [
              {
                type: 'TextHeading',
                text: 'Sua opinião é importante!',
              },
              {
                type: 'TextBody',
                text: 'Ajude-nos a melhorar respondendo algumas perguntas rápidas.',
              },
              {
                type: 'RadioButtonsGroup',
                name: 'satisfacao',
                label: 'Como você avalia nosso atendimento?',
                required: true,
                'data-source': [
                  { id: '5', title: '⭐⭐⭐⭐⭐ Excelente' },
                  { id: '4', title: '⭐⭐⭐⭐ Bom' },
                  { id: '3', title: '⭐⭐⭐ Regular' },
                  { id: '2', title: '⭐⭐ Ruim' },
                  { id: '1', title: '⭐ Péssimo' },
                ],
              },
              {
                type: 'RadioButtonsGroup',
                name: 'recomendaria',
                label: 'Recomendaria para um amigo?',
                required: true,
                'data-source': [
                  { id: 'sim', title: 'Sim, com certeza' },
                  { id: 'talvez', title: 'Talvez' },
                  { id: 'nao', title: 'Não' },
                ],
              },
              {
                type: 'TextArea',
                name: 'comentario',
                label: 'Deixe um comentário (opcional)',
                required: false,
              },
              {
                type: 'Footer',
                label: 'Enviar Avaliação',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    satisfacao: '${form.satisfacao}',
                    recomendaria: '${form.recomendaria}',
                    comentario: '${form.comentario}',
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },

  // --- Pedido / Catálogo Simples ---
  pedido: {
    name: 'Pedido Rápido',
    categories: ['OTHER'],
    json: {
      version: '6.3',
      screens: [
        {
          id: 'INIT',
          title: 'Pedido',
          data: {},
          layout: {
            type: 'SingleColumnLayout',
            children: [
              {
                type: 'TextHeading',
                text: 'Faça seu pedido',
              },
              {
                type: 'TextInput',
                name: 'nome',
                label: 'Seu nome',
                'input-type': 'text',
                required: true,
              },
              {
                type: 'Dropdown',
                name: 'produto',
                label: 'Selecione o produto',
                required: true,
                'data-source': [
                  { id: 'produto_1', title: 'Produto 1' },
                  { id: 'produto_2', title: 'Produto 2' },
                  { id: 'produto_3', title: 'Produto 3' },
                ],
              },
              {
                type: 'TextInput',
                name: 'quantidade',
                label: 'Quantidade',
                'input-type': 'number',
                required: true,
              },
              {
                type: 'TextArea',
                name: 'observacao',
                label: 'Observações',
                required: false,
              },
              {
                type: 'TextInput',
                name: 'endereco',
                label: 'Endereço de entrega',
                'input-type': 'text',
                required: true,
              },
              {
                type: 'Footer',
                label: 'Confirmar Pedido',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    nome: '${form.nome}',
                    produto: '${form.produto}',
                    quantidade: '${form.quantidade}',
                    observacao: '${form.observacao}',
                    endereco: '${form.endereco}',
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },
};

// ================================================================
// CRIAR FLOW A PARTIR DE TEMPLATE
// ================================================================
export async function createFlowFromTemplate(templateKey, customName = null) {
  const template = FLOW_TEMPLATES[templateKey];
  if (!template) return { success: false, error: `Template '${templateKey}' não encontrado. Disponíveis: ${Object.keys(FLOW_TEMPLATES).join(', ')}` };

  const name = customName || template.name;

  // 1. Cria o flow
  const created = await createFlow(name, template.categories);
  if (!created.success) return created;

  // 2. Upload do JSON
  const updated = await updateFlowJSON(created.flowId, template.json);
  if (!updated.success) {
    log.wa.warn({ flowId: created.flowId, error: updated.error }, 'Flow criado mas JSON falhou');
    return { success: true, flowId: created.flowId, warning: `Flow criado, mas JSON teve erro: ${updated.error}`, validationErrors: updated.validationErrors };
  }

  log.wa.info({ flowId: created.flowId, template: templateKey }, 'Flow criado a partir de template');
  return {
    success: true,
    flowId: created.flowId,
    name,
    template: templateKey,
    validationErrors: updated.validationErrors || [],
  };
}

// ================================================================
// HELPERS
// ================================================================
function formatPhone(phone) {
  let p = (phone || '').replace(/\D/g, '');
  if (p.startsWith('55') && p.length === 12) p = p.slice(0, 4) + '9' + p.slice(4);
  if (!p.startsWith('55') && p.length <= 11) p = '55' + p;
  return p;
}
