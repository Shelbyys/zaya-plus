// ================================================================
// CRM BÁSICO — Gestão de leads e follow-ups para Easy4u
// ================================================================
import { log } from '../logger.js';
import { ADMIN_NUMBER } from '../config.js';
import { getSupabase, isSupabaseEnabled } from './supabase.js';
import { sendText } from './wasender.js';
import { io } from '../state.js';

const TABLE = 'crm_leads';

// ================================================================
// INIT — garante que tabela existe
// ================================================================
let tableChecked = false;

async function ensureTable() {
  if (tableChecked) return;
  const sb = getSupabase();
  if (!sb) return;

  const { error } = await sb.from(TABLE).select('id').limit(1);
  if (error && error.code === '42P01') {
    log.db.warn(`Tabela "${TABLE}" não existe. Crie via SQL:

CREATE TABLE IF NOT EXISTS crm_leads (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  company TEXT,
  source TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'novo',
  notes TEXT,
  last_contact TIMESTAMPTZ,
  next_followup TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_leads_status ON crm_leads(status);
CREATE INDEX IF NOT EXISTS idx_crm_leads_source ON crm_leads(source);
CREATE INDEX IF NOT EXISTS idx_crm_leads_followup ON crm_leads(next_followup);
ALTER TABLE crm_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service access" ON crm_leads FOR ALL USING (true);
`);
  } else {
    tableChecked = true;
  }
}

// ================================================================
// CRUD
// ================================================================

export async function addLead({ name, phone, email, company, source = 'manual', status = 'novo', notes = '' }) {
  await ensureTable();
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const { data, error } = await sb.from(TABLE).insert({
    name, phone, email, company, source, status, notes,
    last_contact: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).select().single();

  if (error) throw new Error(`Erro ao adicionar lead: ${error.message}`);
  log.db.info({ id: data.id, name }, 'CRM: Lead adicionado');
  return data;
}

export async function updateLead(id, updates) {
  await ensureTable();
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  updates.updated_at = new Date().toISOString();

  const { data, error } = await sb.from(TABLE).update(updates).eq('id', id).select().single();
  if (error) throw new Error(`Erro ao atualizar lead: ${error.message}`);
  log.db.info({ id, updates: Object.keys(updates) }, 'CRM: Lead atualizado');
  return data;
}

export async function listLeads(filters = {}) {
  await ensureTable();
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  let query = sb.from(TABLE).select('*');

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.source) query = query.eq('source', filters.source);
  if (filters.search) query = query.or(`name.ilike.%${filters.search}%,company.ilike.%${filters.search}%,phone.ilike.%${filters.search}%`);

  query = query.order('updated_at', { ascending: false });
  if (filters.limit) query = query.limit(filters.limit);
  else query = query.limit(50);

  const { data, error } = await query;
  if (error) throw new Error(`Erro ao listar leads: ${error.message}`);
  return data || [];
}

export async function getLeadsByStatus(status) {
  return listLeads({ status });
}

export async function scheduleFollowup(id, followupDate, notes = '') {
  await ensureTable();
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const updates = {
    next_followup: followupDate,
    updated_at: new Date().toISOString(),
  };
  if (notes) updates.notes = notes;

  const { data, error } = await sb.from(TABLE).update(updates).eq('id', id).select().single();
  if (error) throw new Error(`Erro ao agendar follow-up: ${error.message}`);
  log.db.info({ id, followupDate }, 'CRM: Follow-up agendado');
  return data;
}

export async function deleteLead(id) {
  await ensureTable();
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const { error } = await sb.from(TABLE).delete().eq('id', id);
  if (error) throw new Error(`Erro ao deletar lead: ${error.message}`);
  log.db.info({ id }, 'CRM: Lead deletado');
  return true;
}

// ================================================================
// AUTO FOLLOW-UP — verifica a cada hora
// ================================================================

export function startFollowupChecker() {
  // Checa a cada 1 hora
  setInterval(checkPendingFollowups, 60 * 60 * 1000);
  // Primeira checagem após 5 min do boot
  setTimeout(checkPendingFollowups, 5 * 60 * 1000);
  log.db.info('CRM: Follow-up checker iniciado (intervalo: 1h)');
}

async function checkPendingFollowups() {
  try {
    const sb = getSupabase();
    if (!sb) return;

    const now = new Date().toISOString();
    const { data: leads, error } = await sb.from(TABLE)
      .select('*')
      .lte('next_followup', now)
      .not('next_followup', 'is', null)
      .neq('status', 'cliente')
      .neq('status', 'perdido')
      .order('next_followup', { ascending: true })
      .limit(20);

    if (error || !leads || leads.length === 0) return;

    log.db.info({ count: leads.length }, 'CRM: Follow-ups pendentes encontrados');

    for (const lead of leads) {
      const msg = `📋 *Follow-up CRM*\n\n*Lead:* ${lead.name}\n*Empresa:* ${lead.company || '-'}\n*Tel:* ${lead.phone || '-'}\n*Status:* ${lead.status}\n*Notas:* ${lead.notes || '-'}\n\nAgendado para: ${new Date(lead.next_followup).toLocaleString('pt-BR')}`;

      // Notifica via WhatsApp
      try {
        await sendText(ADMIN_NUMBER, msg);
      } catch (e) {
        log.db.error({ err: e.message }, 'CRM: Erro ao enviar follow-up via WA');
      }

      // Notifica no dashboard
      if (io) {
        io.emit('zaya-proactive', {
          type: 'crm_followup',
          message: `Follow-up pendente: ${lead.name} (${lead.company || 'sem empresa'}) — ${lead.status}`,
          data: lead,
        });
      }

      // Limpa o next_followup para não notificar de novo
      await sb.from(TABLE).update({
        next_followup: null,
        last_contact: now,
        updated_at: now,
      }).eq('id', lead.id);
    }
  } catch (e) {
    log.db.error({ err: e.message }, 'CRM: Erro no follow-up checker');
  }
}

// ================================================================
// INTEGRAÇÃO APIFY — auto-add leads do Google Maps
// ================================================================

export async function addLeadsFromGoogleMaps(results) {
  const added = [];
  for (const r of results) {
    try {
      const lead = await addLead({
        name: r.title || r.name || 'Sem nome',
        phone: r.phone || r.phoneUnformatted || '',
        email: r.email || '',
        company: r.title || r.name || '',
        source: 'google_maps',
        status: 'novo',
        notes: `Endereço: ${r.address || '-'} | Rating: ${r.totalScore || r.rating || '-'} | Reviews: ${r.reviewsCount || '-'}`,
      });
      added.push(lead);
    } catch (e) {
      // Ignora duplicatas ou erros individuais
      log.db.warn({ name: r.title, err: e.message }, 'CRM: Erro ao adicionar lead do Google Maps');
    }
  }
  log.db.info({ count: added.length }, 'CRM: Leads do Google Maps adicionados');
  return added;
}
