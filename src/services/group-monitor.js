// ================================================================
// GROUP MONITOR — Monitora grupos do WhatsApp e gera relatórios
// PERSISTÊNCIA: Supabase (sobrevive restart do server)
// Tabela: group_monitors (jid, name, status, messages, started_at)
// ================================================================
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, AI_MODEL } from '../config.js';
import { log } from '../logger.js';
import { openai } from '../state.js';
import { logAction } from './action-logger.js';

let sb = null;
function getSb() {
  if (!sb && SUPABASE_URL && SUPABASE_KEY) sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

// Cache local pra não consultar Supabase a cada msg
const monitorCache = new Map();

// Inicializa cache do Supabase ao startar
async function initCache() {
  const s = getSb();
  if (!s) return;
  try {
    const { data } = await s.from('group_monitors').select('*').eq('status', 'active');
    if (data) {
      for (const row of data) {
        monitorCache.set(row.jid, {
          name: row.name,
          startedAt: new Date(row.started_at),
          messages: row.messages || [],
        });
      }
      if (data.length > 0) log.ai.info({ count: data.length }, 'GroupMonitor: cache restaurado do Supabase');
    }
  } catch (e) {
    log.ai.warn({ err: e.message }, 'GroupMonitor: falha ao carregar cache');
  }
}
initCache();

// ================================================================
// LISTAR GRUPOS VIA WASENDER
// ================================================================
export async function listGroups() {
  const apiKey = process.env.WASENDER_API_KEY;
  if (!apiKey) throw new Error('WASENDER_API_KEY não configurada');
  const res = await fetch('https://www.wasenderapi.com/api/groups', {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('WaSender resposta inválida'); }
  if (!data.success || !data.data) throw new Error('Falha ao listar grupos');
  return data.data.map(g => ({ id: g.id, name: g.name || 'Sem nome', imgUrl: g.imgUrl || null }));
}

// ================================================================
// BUSCAR GRUPOS POR NOME
// ================================================================
export async function searchGroups(query) {
  const groups = await listGroups();
  const q = query.toLowerCase();
  return groups.filter(g => g.name.toLowerCase().includes(q));
}

// ================================================================
// INICIAR MONITORAMENTO (persiste no Supabase)
// ================================================================
export async function startMonitoring(groupJid, groupName) {
  if (monitorCache.has(groupJid)) return { status: 'já monitorando', group: groupName };

  const s = getSb();
  if (s) {
    try {
      await s.from('group_monitors').upsert({
        jid: groupJid,
        name: groupName,
        status: 'active',
        messages: [],
        started_at: new Date().toISOString(),
      }, { onConflict: 'jid' });
    } catch (e) {
      log.ai.warn({ err: e.message }, 'GroupMonitor: falha ao salvar no Supabase');
    }
  }

  monitorCache.set(groupJid, {
    name: groupName,
    startedAt: new Date(),
    messages: [],
  });

  logAction('grupo_monitor', `Monitoramento iniciado: ${groupName}`, {
    subtype: 'inicio', metadata: { groupJid, groupName },
  });

  log.ai.info({ groupJid, groupName }, 'GroupMonitor: monitoramento iniciado');
  return { status: 'iniciado', group: groupName, jid: groupJid };
}

// ================================================================
// PARAR MONITORAMENTO
// ================================================================
export async function stopMonitoring(groupJid) {
  const group = monitorCache.get(groupJid);
  if (!group) return { status: 'não estava monitorando' };

  const result = {
    status: 'parado',
    group: group.name,
    duration: Math.round((Date.now() - group.startedAt.getTime()) / 60000),
    totalMessages: group.messages.length,
  };

  const s = getSb();
  if (s) {
    try {
      await s.from('group_monitors').update({ status: 'stopped', messages: group.messages }).eq('jid', groupJid);
    } catch {}
  }

  logAction('grupo_monitor', `Monitoramento parado: ${group.name} (${result.totalMessages} msgs em ${result.duration}min)`, {
    subtype: 'fim', metadata: { groupJid, groupName: group.name, totalMessages: result.totalMessages },
  });

  monitorCache.delete(groupJid);
  return result;
}

// ================================================================
// REGISTRAR MENSAGEM (chamado pelo inbox-poller)
// ================================================================
export function recordGroupMessage(groupJid, senderName, text, timestamp) {
  const group = monitorCache.get(groupJid);
  if (!group) return false;

  const msg = {
    sender: senderName || 'Desconhecido',
    text: text || '',
    time: timestamp || new Date().toISOString(),
    hora: new Date(timestamp || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  };

  group.messages.push(msg);

  // Salva no Supabase a cada 10 msgs (batch pra não sobrecarregar)
  if (group.messages.length % 10 === 0) {
    const s = getSb();
    if (s) {
      s.from('group_monitors').update({ messages: group.messages }).eq('jid', groupJid).then(() => {}).catch(() => {});
    }
  }

  return true;
}

// ================================================================
// GERAR RELATÓRIO
// ================================================================
export async function generateReport(groupJid) {
  const group = monitorCache.get(groupJid);
  if (!group) return { error: 'Grupo não está sendo monitorado.' };
  if (group.messages.length === 0) return { report: 'Nenhuma mensagem registrada.', group: group.name, messages: 0 };

  const duration = Math.round((Date.now() - group.startedAt.getTime()) / 60000);
  const transcript = group.messages.map(m => `[${m.hora}] ${m.sender}: ${m.text}`).join('\n');

  try {
    const res = await openai.chat.completions.create({
      model: AI_MODEL, max_tokens: 4000,
      messages: [
        { role: 'system', content: `Gere relatório completo do grupo WhatsApp "${group.name}". Duração: ${duration}min, ${group.messages.length} msgs. Inclua: resumo, tópicos, decisões, demandas, menções ao Alisson. Português brasileiro, objetivo.` },
        { role: 'user', content: transcript },
      ],
    });
    const report = res.choices[0].message.content || 'Erro';

    logAction('grupo_monitor', `Relatório: ${group.name} (${group.messages.length} msgs)`, {
      subtype: 'relatorio', details: report.slice(0, 3000),
      metadata: { groupJid, groupName: group.name, messages: group.messages.length, duration },
    });

    // Salva relatório no Supabase
    const s = getSb();
    if (s) {
      try { await s.from('group_monitors').update({ messages: group.messages, report }).eq('jid', groupJid); } catch {}
    }

    return { report, group: group.name, messages: group.messages.length, duration };
  } catch (e) {
    return { error: `Erro: ${e.message}` };
  }
}

// ================================================================
// STATUS
// ================================================================
export function getMonitorStatus() {
  const result = [];
  for (const [jid, group] of monitorCache) {
    result.push({
      jid,
      name: group.name,
      startedAt: group.startedAt.toISOString(),
      duration: Math.round((Date.now() - group.startedAt.getTime()) / 60000),
      messages: group.messages.length,
    });
  }
  return result;
}

// ================================================================
// CHECK SE GRUPO ESTÁ SENDO MONITORADO
// ================================================================
export function isMonitored(groupJid) {
  return monitorCache.has(groupJid);
}

export { monitorCache as monitoredGroups };
