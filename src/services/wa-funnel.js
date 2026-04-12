// ================================================================
// FUNIL WHATSAPP — Automação de sequências de mensagens
// ================================================================
import { log } from '../logger.js';
import { getSupabase } from './supabase.js';
import { sendText } from './wasender.js';
import { io } from '../state.js';

const FUNNELS_TABLE = 'wa_funnels';
const LEADS_TABLE = 'wa_funnel_leads';

// ================================================================
// INIT — garante tabelas
// ================================================================
let tableChecked = false;

async function ensureTables() {
  if (tableChecked) return;
  const sb = getSupabase();
  if (!sb) return;

  const { error: e1 } = await sb.from(FUNNELS_TABLE).select('id').limit(1);
  const { error: e2 } = await sb.from(LEADS_TABLE).select('id').limit(1);

  if ((e1 && e1.code === '42P01') || (e2 && e2.code === '42P01')) {
    log.db.warn(`Tabelas do funil não existem. Crie via SQL:

CREATE TABLE IF NOT EXISTS wa_funnels (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  steps JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE wa_funnels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service access" ON wa_funnels FOR ALL USING (true);

CREATE TABLE IF NOT EXISTS wa_funnel_leads (
  id BIGSERIAL PRIMARY KEY,
  funnel_id BIGINT REFERENCES wa_funnels(id),
  phone TEXT NOT NULL,
  name TEXT,
  current_step INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ativo',
  step_data JSONB DEFAULT '{}',
  next_send_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wfl_funnel ON wa_funnel_leads(funnel_id);
CREATE INDEX IF NOT EXISTS idx_wfl_status ON wa_funnel_leads(status);
CREATE INDEX IF NOT EXISTS idx_wfl_next_send ON wa_funnel_leads(next_send_at);
ALTER TABLE wa_funnel_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service access" ON wa_funnel_leads FOR ALL USING (true);
`);
  } else {
    tableChecked = true;
  }
}

// ================================================================
// FUNIL CRUD
// ================================================================

/**
 * Cria um funil de mensagens
 * @param {string} name - Nome do funil
 * @param {string} description - Descrição
 * @param {Array} steps - Array de etapas: [{message, delay_minutes, condition?}]
 *   delay_minutes: tempo de espera antes de enviar esta etapa (0 = imediato)
 *   condition: (opcional) condição para enviar (ex: "replied", "no_reply")
 */
export async function createFunnel(name, description, steps) {
  await ensureTables();
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  // Valida steps
  const validSteps = (steps || []).map((s, i) => ({
    index: i,
    message: s.message || s.mensagem || '',
    delay_minutes: s.delay_minutes || s.delay || s.minutos || 0,
    condition: s.condition || s.condicao || null,
  }));

  if (validSteps.length === 0) throw new Error('Funil precisa de pelo menos 1 etapa');

  const { data, error } = await sb.from(FUNNELS_TABLE).insert({
    name,
    description: description || '',
    steps: validSteps,
  }).select().single();

  if (error) throw new Error(`Erro ao criar funil: ${error.message}`);
  log.db.info({ id: data.id, name, steps: validSteps.length }, 'WA Funnel: Funil criado');
  return data;
}

export async function listFunnels(activeOnly = true) {
  await ensureTables();
  const sb = getSupabase();
  if (!sb) return [];

  let query = sb.from(FUNNELS_TABLE).select('*').order('created_at', { ascending: false });
  if (activeOnly) query = query.eq('active', true);

  const { data, error } = await query;
  return error ? [] : (data || []);
}

export async function getFunnel(id) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const { data, error } = await sb.from(FUNNELS_TABLE).select('*').eq('id', id).single();
  if (error) throw new Error(`Funil não encontrado: ${error.message}`);
  return data;
}

export async function updateFunnel(id, updates) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  updates.updated_at = new Date().toISOString();
  const { data, error } = await sb.from(FUNNELS_TABLE).update(updates).eq('id', id).select().single();
  if (error) throw new Error(`Erro ao atualizar funil: ${error.message}`);
  return data;
}

export async function deleteFunnel(id) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  // Cancela leads ativos no funil
  await sb.from(LEADS_TABLE).update({ status: 'cancelado', updated_at: new Date().toISOString() })
    .eq('funnel_id', id).eq('status', 'ativo');

  const { error } = await sb.from(FUNNELS_TABLE).update({ active: false, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`Erro ao deletar funil: ${error.message}`);
  return true;
}

// ================================================================
// LEAD NO FUNIL
// ================================================================

export async function startFunnelForLead(funnelId, phone, name = '') {
  await ensureTables();
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  // Busca funil
  const funnel = await getFunnel(funnelId);
  if (!funnel || !funnel.active) throw new Error('Funil não encontrado ou inativo');

  const steps = funnel.steps || [];
  if (steps.length === 0) throw new Error('Funil sem etapas');

  // Calcula quando enviar a primeira mensagem
  const firstDelay = steps[0]?.delay_minutes || 0;
  const nextSendAt = new Date(Date.now() + firstDelay * 60 * 1000).toISOString();

  const { data, error } = await sb.from(LEADS_TABLE).insert({
    funnel_id: funnelId,
    phone: phone.replace(/\D/g, ''),
    name: name || '',
    current_step: 0,
    status: 'ativo',
    next_send_at: nextSendAt,
  }).select().single();

  if (error) throw new Error(`Erro ao iniciar funil para lead: ${error.message}`);

  log.db.info({ leadId: data.id, funnelId, phone }, 'WA Funnel: Lead adicionado ao funil');

  // Se delay da primeira etapa é 0, envia imediatamente
  if (firstDelay === 0) {
    await processNextStep(data.id);
  }

  return data;
}

export async function startFunnelForMultipleLeads(funnelId, leads) {
  const results = [];
  for (const lead of leads) {
    try {
      const result = await startFunnelForLead(funnelId, lead.phone || lead.telefone, lead.name || lead.nome);
      results.push({ ...result, success: true });
      // Delay entre envios para evitar rate limit
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      results.push({ phone: lead.phone || lead.telefone, success: false, error: e.message });
    }
  }
  return results;
}

// ================================================================
// PROCESSAR PRÓXIMA ETAPA
// ================================================================

export async function processNextStep(leadId) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  // Busca lead
  const { data: lead, error: leadErr } = await sb.from(LEADS_TABLE).select('*').eq('id', leadId).single();
  if (leadErr || !lead) throw new Error('Lead não encontrado');
  if (lead.status !== 'ativo') return { skipped: true, reason: 'lead não está ativo' };

  // Busca funil
  const funnel = await getFunnel(lead.funnel_id);
  if (!funnel) throw new Error('Funil não encontrado');

  const steps = funnel.steps || [];
  const currentStep = lead.current_step || 0;

  if (currentStep >= steps.length) {
    // Funil concluído
    await sb.from(LEADS_TABLE).update({
      status: 'concluido',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', leadId);

    log.db.info({ leadId, funnelId: funnel.id }, 'WA Funnel: Lead concluiu funil');
    return { completed: true };
  }

  const step = steps[currentStep];

  // Personaliza mensagem (substitui variáveis)
  let message = step.message || '';
  message = message.replace(/\{nome\}/gi, lead.name || 'amigo(a)');
  message = message.replace(/\{phone\}/gi, lead.phone || '');

  // Envia mensagem via WhatsApp
  try {
    await sendText(lead.phone, message);
    log.db.info({ leadId, step: currentStep, phone: lead.phone }, 'WA Funnel: Mensagem enviada');
  } catch (e) {
    log.db.error({ leadId, err: e.message }, 'WA Funnel: Erro ao enviar mensagem');
    // Marca como erro mas não para o funil
    await sb.from(LEADS_TABLE).update({
      step_data: { ...(lead.step_data || {}), [`step_${currentStep}_error`]: e.message },
      updated_at: new Date().toISOString(),
    }).eq('id', leadId);
    return { sent: false, error: e.message };
  }

  // Avança para próxima etapa
  const nextStep = currentStep + 1;
  let nextSendAt = null;

  if (nextStep < steps.length) {
    const nextDelay = steps[nextStep]?.delay_minutes || 0;
    nextSendAt = new Date(Date.now() + nextDelay * 60 * 1000).toISOString();
  }

  await sb.from(LEADS_TABLE).update({
    current_step: nextStep,
    next_send_at: nextSendAt,
    step_data: { ...(lead.step_data || {}), [`step_${currentStep}_sent_at`]: new Date().toISOString() },
    updated_at: new Date().toISOString(),
    ...(nextStep >= steps.length ? { status: 'concluido', completed_at: new Date().toISOString() } : {}),
  }).eq('id', leadId);

  return {
    sent: true,
    step: currentStep,
    message: message.slice(0, 100),
    nextStep: nextStep < steps.length ? nextStep : null,
    nextSendAt,
    completed: nextStep >= steps.length,
  };
}

// ================================================================
// SCHEDULER — processa etapas pendentes
// ================================================================

async function processPendingSteps() {
  try {
    const sb = getSupabase();
    if (!sb) return;

    const now = new Date().toISOString();

    const { data: pendingLeads, error } = await sb.from(LEADS_TABLE)
      .select('*')
      .eq('status', 'ativo')
      .lte('next_send_at', now)
      .not('next_send_at', 'is', null)
      .order('next_send_at', { ascending: true })
      .limit(20);

    if (error || !pendingLeads || pendingLeads.length === 0) return;

    log.db.info({ count: pendingLeads.length }, 'WA Funnel: Processando etapas pendentes');

    for (const lead of pendingLeads) {
      try {
        await processNextStep(lead.id);
        // Delay entre envios
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) {
        log.db.error({ leadId: lead.id, err: e.message }, 'WA Funnel: Erro ao processar etapa');
      }
    }
  } catch (e) {
    log.db.error({ err: e.message }, 'WA Funnel: Erro no scheduler');
  }
}

export function startFunnelScheduler() {
  // Processa etapas pendentes a cada 2 minutos
  setInterval(processPendingSteps, 2 * 60 * 1000);
  // Primeira execução após 1 minuto
  setTimeout(processPendingSteps, 60 * 1000);
  log.db.info('WA Funnel scheduler iniciado (intervalo: 2min)');
}

// ================================================================
// STATUS & RELATÓRIO
// ================================================================

export async function getFunnelStatus(funnelId) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const funnel = await getFunnel(funnelId);

  const { data: leads, error } = await sb.from(LEADS_TABLE)
    .select('*')
    .eq('funnel_id', funnelId)
    .order('started_at', { ascending: false });

  if (error) throw new Error(error.message);

  const total = leads?.length || 0;
  const ativos = leads?.filter(l => l.status === 'ativo').length || 0;
  const concluidos = leads?.filter(l => l.status === 'concluido').length || 0;
  const cancelados = leads?.filter(l => l.status === 'cancelado').length || 0;

  return {
    funnel: { id: funnel.id, name: funnel.name, steps: (funnel.steps || []).length },
    leads: { total, ativos, concluidos, cancelados },
    leadsList: (leads || []).map(l => ({
      id: l.id,
      name: l.name,
      phone: l.phone,
      step: `${l.current_step}/${(funnel.steps || []).length}`,
      status: l.status,
      startedAt: l.started_at,
    })),
  };
}

export async function pauseLead(leadId) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const { error } = await sb.from(LEADS_TABLE).update({
    status: 'pausado',
    updated_at: new Date().toISOString(),
  }).eq('id', leadId);

  if (error) throw new Error(error.message);
  return true;
}

export async function resumeLead(leadId) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const { data: lead } = await sb.from(LEADS_TABLE).select('*').eq('id', leadId).single();
  if (!lead) throw new Error('Lead não encontrado');

  const { error } = await sb.from(LEADS_TABLE).update({
    status: 'ativo',
    next_send_at: new Date().toISOString(), // Envia próxima etapa agora
    updated_at: new Date().toISOString(),
  }).eq('id', leadId);

  if (error) throw new Error(error.message);
  return true;
}
