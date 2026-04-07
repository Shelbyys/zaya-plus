// ================================================================
// PROACTIVE — Zaya monitora e avisa o admin automaticamente
// ================================================================
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, ADMIN_NAME } from '../config.js';
import { io } from '../state.js';
import { log } from '../logger.js';
import { calendarDB } from './calendar.js';

let sb = null;
function getSb() {
  if (!sb && SUPABASE_URL && SUPABASE_KEY) sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

// Notifica o dashboard (voz da Zaya)
function notify(text, tipo = 'info') {
  io?.emit('zaya-proactive', { text, tipo, timestamp: new Date().toISOString() });
  log.ai.info({ tipo }, `[PROACTIVE] ${text}`);
}

// ================================================================
// CHECAGENS PERIÓDICAS
// ================================================================

// 1. Eventos próximos (próximos 30 min)
function checkEventosProximos() {
  try {
    const agora = new Date();
    const em30min = new Date(agora.getTime() + 30 * 60 * 1000);
    const eventos = calendarDB.getRange(agora.toISOString(), em30min.toISOString());
    for (const ev of eventos) {
      if (!ev._notified) {
        const minutos = Math.round((new Date(ev.start_at) - agora) / 60000);
        notify(`${ADMIN_NAME}, tu tem "${ev.title}" daqui a ${minutos} minutos!`, 'evento');
        ev._notified = true;
      }
    }
  } catch (e) {}
}

// 2. Mensagens novas no WhatsApp (últimas não lidas)
let _lastWaCheck = new Date().toISOString();
async function checkMensagensWa() {
  const s = getSb();
  if (!s) return;
  try {
    const { data, error } = await s.from('wa_inbox')
      .select('push_name, message_body, phone')
      .eq('from_me', false)
      .gt('received_at', _lastWaCheck)
      .order('received_at', { ascending: false })
      .limit(5);

    if (!error && data && data.length > 0) {
      const nomes = [...new Set(data.map(m => m.push_name || m.phone))];
      if (nomes.length === 1) {
        notify(`${nomes[0]} te mandou ${data.length} mensagem(ns) no WhatsApp.`, 'whatsapp');
      } else {
        notify(`Tu tem ${data.length} mensagens novas no WhatsApp de ${nomes.join(', ')}.`, 'whatsapp');
      }
    }
    _lastWaCheck = new Date().toISOString();
  } catch (e) {}
}

// 3. Missões com respostas novas
let _lastMissaoCheck = new Date().toISOString();
async function checkMissoes() {
  const s = getSb();
  if (!s) return;
  try {
    // Missões ativas com conversas concluídas recentes
    const { data } = await s.from('missao_conversas')
      .select('lead_nome, missao_id, status, missoes(titulo)')
      .eq('status', 'concluido')
      .gt('updated_at', _lastMissaoCheck)
      .limit(10);

    if (data && data.length > 0) {
      const porMissao = {};
      for (const c of data) {
        const titulo = c.missoes?.titulo || `#${c.missao_id}`;
        if (!porMissao[titulo]) porMissao[titulo] = [];
        porMissao[titulo].push(c.lead_nome);
      }
      for (const [titulo, leads] of Object.entries(porMissao)) {
        notify(`Missão "${titulo}": ${leads.join(', ')} concluíram a conversa! Quer ver o relatório?`, 'missao');
      }
    }

    // Checa se alguma missão completou todos os leads
    const { data: missoes } = await s.from('missoes')
      .select('id, titulo, total_leads, concluidos')
      .eq('status', 'ativa')
      .gt('updated_at', _lastMissaoCheck);

    if (missoes) {
      for (const m of missoes) {
        if (m.concluidos >= m.total_leads && m.total_leads > 0) {
          notify(`Missão "${m.titulo}" CONCLUÍDA! Todos os ${m.total_leads} leads responderam. Vou gerar o relatório!`, 'missao_completa');
        }
      }
    }

    _lastMissaoCheck = new Date().toISOString();
  } catch (e) {}
}

// 4. Leads novos que responderam (fora de missão)
let _lastLeadCheck = new Date().toISOString();
async function checkLeadsResponderam() {
  const s = getSb();
  if (!s) return;
  try {
    const { data } = await s.from('leads')
      .select('nome, categoria')
      .eq('status', 'contatado')
      .gt('contatado_em', _lastLeadCheck)
      .limit(5);

    if (data && data.length > 0) {
      for (const lead of data) {
        notify(`Lead "${lead.nome}" (${lead.categoria}) foi contatado com sucesso!`, 'lead');
      }
    }
    _lastLeadCheck = new Date().toISOString();
  } catch (e) {}
}

// 5. Bom dia / Boa tarde / Boa noite
let _lastGreeting = '';
function checkSaudacao() {
  const hora = new Date().getHours();
  let saudacao = '';
  if (hora >= 6 && hora < 12) saudacao = 'bomdia';
  else if (hora >= 12 && hora < 18) saudacao = 'boatarde';
  else saudacao = 'boanoite';

  const hoje = new Date().toDateString();
  const key = `${saudacao}_${hoje}`;
  if (_lastGreeting === key) return;
  _lastGreeting = key;

  const msgs = {
    bomdia: `Bom dia, ${ADMIN_NAME}! Pronta pra mais um dia. Quer ver sua agenda?`,
    boatarde: `Boa tarde, ${ADMIN_NAME}! Como esta indo o dia?`,
    boanoite: `Boa noite, ${ADMIN_NAME}! Precisa de algo antes de descansar?`,
  };
  notify(msgs[saudacao], 'saudacao');
}

// ================================================================
// INICIAR MONITORAMENTO
// ================================================================
export function startProactiveMonitor() {
  log.ai.info('Proactive monitor iniciado');

  // Checagens a cada 2 minutos
  setInterval(() => {
    checkEventosProximos();
  }, 2 * 60 * 1000);

  // WhatsApp: a cada 3 minutos
  setInterval(() => {
    checkMensagensWa();
  }, 3 * 60 * 1000);

  // Missões: a cada 2 minutos
  setInterval(() => {
    checkMissoes();
  }, 2 * 60 * 1000);

  // Leads: a cada 5 minutos
  setInterval(() => {
    checkLeadsResponderam();
  }, 5 * 60 * 1000);

  // Saudação: a cada 30 minutos
  setInterval(() => {
    checkSaudacao();
  }, 30 * 60 * 1000);

  // Primeira execução após 10s
  setTimeout(() => {
    checkSaudacao();
    checkEventosProximos();
  }, 10000);
}
