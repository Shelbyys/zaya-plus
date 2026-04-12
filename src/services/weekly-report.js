// ================================================================
// RELATÓRIO SEMANAL — Gerado toda segunda-feira às 8h
// ================================================================
import { log } from '../logger.js';
import { ADMIN_NUMBER } from '../config.js';
import { getSupabase, isSupabaseEnabled } from './supabase.js';
import { sendText } from './wasender.js';
import { io } from '../state.js';

// ================================================================
// COLETA DE DADOS DA SEMANA
// ================================================================

async function getWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=dom, 1=seg
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMonday - 7); // Segunda passada
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday.toISOString(), end: sunday.toISOString() };
}

async function countPostsPublished(sb, start, end) {
  try {
    const { count, error } = await sb.from('brand_posts')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', start)
      .lte('created_at', end);
    return error ? 0 : (count || 0);
  } catch { return 0; }
}

async function countLeadsContacted(sb, start, end) {
  try {
    const { count, error } = await sb.from('crm_leads')
      .select('*', { count: 'exact', head: true })
      .gte('last_contact', start)
      .lte('last_contact', end);
    return error ? 0 : (count || 0);
  } catch { return 0; }
}

async function countNewLeads(sb, start, end) {
  try {
    const { count, error } = await sb.from('crm_leads')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', start)
      .lte('created_at', end);
    return error ? 0 : (count || 0);
  } catch { return 0; }
}

async function countLeadsByStatus(sb) {
  try {
    const { data, error } = await sb.from('crm_leads').select('status');
    if (error || !data) return {};
    const counts = {};
    for (const lead of data) {
      counts[lead.status] = (counts[lead.status] || 0) + 1;
    }
    return counts;
  } catch { return {}; }
}

async function countCalendarEvents(sb, start, end) {
  try {
    const { count, error } = await sb.from('calendar_events')
      .select('*', { count: 'exact', head: true })
      .gte('start_date', start)
      .lte('start_date', end);
    return error ? 0 : (count || 0);
  } catch { return 0; }
}

async function countWhatsAppMessages(sb, start, end) {
  try {
    const { count, error } = await sb.from('chat_messages')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', start)
      .lte('created_at', end);
    return error ? 0 : (count || 0);
  } catch { return 0; }
}

async function countActivities(sb, start, end) {
  try {
    const { count, error } = await sb.from('activity_log')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', start)
      .lte('created_at', end);
    return error ? 0 : (count || 0);
  } catch { return 0; }
}

// ================================================================
// GERAR RELATÓRIO
// ================================================================

export async function generateWeeklyReport() {
  const sb = getSupabase();
  if (!sb) return 'Supabase não configurado. Impossível gerar relatório.';

  const { start, end } = await getWeekRange();
  const startDate = new Date(start).toLocaleDateString('pt-BR');
  const endDate = new Date(end).toLocaleDateString('pt-BR');

  // Coleta dados em paralelo
  const [
    posts,
    leadsContacted,
    newLeads,
    leadsByStatus,
    events,
    messages,
    activities,
  ] = await Promise.all([
    countPostsPublished(sb, start, end),
    countLeadsContacted(sb, start, end),
    countNewLeads(sb, start, end),
    countLeadsByStatus(sb),
    countCalendarEvents(sb, start, end),
    countWhatsAppMessages(sb, start, end),
    countActivities(sb, start, end),
  ]);

  const statusLine = Object.entries(leadsByStatus)
    .map(([s, c]) => `  • ${s}: ${c}`)
    .join('\n') || '  • Nenhum lead registrado';

  const report = `📊 *RELATÓRIO SEMANAL EASY4U*
📅 ${startDate} a ${endDate}

━━━━━━━━━━━━━━━━━━━━━
📱 *CONTEÚDO & MARKETING*
  • Posts publicados: ${posts}
  • Atividades da Zaya: ${activities}

━━━━━━━━━━━━━━━━━━━━━
👥 *CRM & LEADS*
  • Novos leads: ${newLeads}
  • Leads contatados: ${leadsContacted}
  • Pipeline atual:
${statusLine}

━━━━━━━━━━━━━━━━━━━━━
📅 *AGENDA*
  • Eventos/compromissos: ${events}

━━━━━━━━━━━━━━━━━━━━━
💬 *COMUNICAÇÃO*
  • Mensagens WhatsApp: ${messages}

━━━━━━━━━━━━━━━━━━━━━
🤖 _Relatório gerado automaticamente pela Zaya_
_Easy Solutions LTDA — @suaeasy4u_`;

  return report;
}

// ================================================================
// ENVIAR RELATÓRIO
// ================================================================

export async function sendWeeklyReport() {
  try {
    const report = await generateWeeklyReport();

    // Envia via WhatsApp
    try {
      await sendText(ADMIN_NUMBER, report);
      log.ai.info('Relatório semanal enviado via WhatsApp');
    } catch (e) {
      log.ai.error({ err: e.message }, 'Erro ao enviar relatório via WA');
    }

    // Emite no dashboard
    if (io) {
      io.emit('zaya-proactive', {
        type: 'weekly_report',
        message: report,
      });
    }

    return report;
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro ao gerar relatório semanal');
    return `Erro ao gerar relatório: ${e.message}`;
  }
}

// ================================================================
// SCHEDULER — Toda segunda às 8h (America/Sao_Paulo)
// ================================================================

export function startWeeklyReportScheduler() {
  function checkAndSend() {
    const now = new Date();
    // Converte para horário de Brasília
    const brTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const day = brTime.getDay(); // 1 = segunda
    const hour = brTime.getHours();
    const minute = brTime.getMinutes();

    if (day === 1 && hour === 8 && minute < 5) {
      log.ai.info('Relatório semanal: hora de enviar!');
      sendWeeklyReport().catch(e => log.ai.error({ err: e.message }, 'Erro relatório semanal'));
    }
  }

  // Checa a cada 5 minutos
  setInterval(checkAndSend, 5 * 60 * 1000);
  log.ai.info('Weekly report scheduler iniciado (segunda 8h BRT)');
}
