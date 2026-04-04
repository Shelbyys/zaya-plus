import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, AI_MODEL, AI_MODEL_MINI, ADMIN_NAME } from '../config.js';
import { openai } from '../state.js';
import { log } from '../logger.js';
import { sendWhatsApp } from './messaging.js';

let sb = null;
function getSb() {
  if (!sb && SUPABASE_URL && SUPABASE_KEY) sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

// ================================================================
// CRIAR MISSÃO
// ================================================================
export async function criarMissao({ titulo, objetivo, etapas, categoria_leads, cidade_leads, filtros_leads }) {
  const s = getSb();
  if (!s) throw new Error('Supabase não configurado');

  // Script = array de etapas da conversa
  // Cada etapa: { ordem, mensagem, tipo: 'perguntar'|'informar'|'agendar'|'encerrar', campo_coletar: 'preco'|'horario'|etc }
  const script = etapas.map((e, i) => ({
    ordem: i,
    mensagem: e.mensagem,
    tipo: e.tipo || 'perguntar',
    campo_coletar: e.campo_coletar || null,
  }));

  const { data, error } = await s.from('missoes').insert({
    titulo,
    objetivo,
    script,
    categoria_leads: categoria_leads || null,
    cidade_leads: cidade_leads || null,
    filtros_leads: filtros_leads || null,
    status: 'ativa',
  }).select().single();

  if (error) throw new Error(`Erro ao criar missão: ${error.message}`);
  log.ai.info({ id: data.id, titulo }, 'Missão criada');
  return data;
}

// ================================================================
// INICIAR MISSÃO — busca leads e envia primeira mensagem
// ================================================================
export async function iniciarMissao(missaoId) {
  const s = getSb();
  if (!s) throw new Error('Supabase não configurado');

  const { data: missao, error } = await s.from('missoes').select('*').eq('id', missaoId).single();
  if (error || !missao) throw new Error('Missão não encontrada');
  if (missao.status !== 'ativa') throw new Error(`Missão está ${missao.status}`);

  // Busca leads pelos filtros
  let query = s.from('leads').select('*');
  if (missao.categoria_leads) query = query.eq('categoria', missao.categoria_leads);
  if (missao.cidade_leads) query = query.ilike('cidade', `%${missao.cidade_leads}%`);
  if (missao.filtros_leads) {
    for (const f of missao.filtros_leads) {
      query = query[f.operador](f.coluna, f.valor);
    }
  }
  // Só leads com telefone
  query = query.not('telefone', 'is', null).neq('telefone', '');

  const { data: leads, error: leadsErr } = await query;
  if (leadsErr) throw new Error(`Erro ao buscar leads: ${leadsErr.message}`);
  if (!leads || leads.length === 0) throw new Error('Nenhum lead encontrado com os filtros da missão');

  const primeiraMensagem = missao.script[0]?.mensagem || missao.objetivo;
  let enviados = 0;

  for (const lead of leads) {
    try {
      // Cria registro de conversa
      await s.from('missao_conversas').insert({
        missao_id: missaoId,
        lead_id: lead.id,
        lead_nome: lead.nome,
        lead_telefone: lead.telefone,
        status: 'enviado',
        etapa_atual: 0,
        historico: [{ de: 'zaya', msg: primeiraMensagem, ts: new Date().toISOString() }],
      });

      // Envia mensagem
      await sendWhatsApp(lead.telefone, primeiraMensagem);
      enviados++;
      log.ai.info({ lead: lead.nome, tel: lead.telefone }, 'Missão: mensagem enviada');

      // Delay entre envios (WaSender: mínimo 6s entre mensagens)
      await new Promise(r => setTimeout(r, 6000 + Math.random() * 3000));
    } catch (e) {
      log.ai.warn({ lead: lead.nome, err: e.message }, 'Missão: falha no envio');
    }
  }

  // Atualiza missão
  await s.from('missoes').update({ total_leads: leads.length, contatados: enviados, updated_at: new Date().toISOString() }).eq('id', missaoId);

  return { missaoId, totalLeads: leads.length, enviados, primeiraMensagem };
}

// ================================================================
// PROCESSAR RESPOSTA DE LEAD (chamado pelo handler do WhatsApp)
// ================================================================
export async function processarRespostaMissao(telefone, texto) {
  const s = getSb();
  if (!s) return null;

  // Busca conversa ativa para este telefone
  const { data: convs } = await s.from('missao_conversas')
    .select('*, missoes(*)')
    .eq('lead_telefone', telefone)
    .in('status', ['enviado', 'em_conversa'])
    .order('created_at', { ascending: false })
    .limit(1);

  if (!convs || convs.length === 0) return null;

  const conv = convs[0];
  const missao = conv.missoes;
  if (!missao || missao.status !== 'ativa') return null;

  const script = missao.script || [];
  const etapaAtual = conv.etapa_atual || 0;
  const historico = conv.historico || [];
  const dadosColetados = conv.dados_coletados || {};

  // Salva resposta no histórico
  historico.push({ de: 'lead', msg: texto, ts: new Date().toISOString() });

  // Coleta dado da etapa atual (se tiver campo_coletar)
  const etapa = script[etapaAtual];
  if (etapa?.campo_coletar) {
    dadosColetados[etapa.campo_coletar] = texto;
  }

  // Próxima etapa
  const proxEtapa = etapaAtual + 1;
  const temProxima = proxEtapa < script.length;

  let resposta = '';
  let novoStatus = 'em_conversa';

  if (temProxima) {
    // Gera resposta contextual com IA
    const proxScript = script[proxEtapa];
    try {
      const aiRes = await openai.chat.completions.create({
        model: AI_MODEL_MINI, max_tokens: 300,
        messages: [
          { role: 'system', content: `Você é a Zaya, assistente do ${ADMIN_NAME}. Está em uma conversa profissional via WhatsApp com ${conv.lead_nome}.
MISSÃO: ${missao.objetivo}
ETAPA ATUAL: ${proxScript.mensagem}
DADOS JÁ COLETADOS: ${JSON.stringify(dadosColetados)}
HISTÓRICO: ${historico.map(h => `${h.de}: ${h.msg}`).join('\n')}

Responda de forma natural e profissional. Agradeça a resposta anterior e faça a próxima pergunta/ação da etapa. Seja educada, direta e objetiva. Use português brasileiro.` },
          { role: 'user', content: texto },
        ],
      });
      resposta = aiRes.choices[0].message.content;
    } catch (e) {
      resposta = proxScript.mensagem; // Fallback: usa mensagem do script direto
    }
  } else {
    // Missão concluída para este lead
    novoStatus = 'concluido';
    try {
      const aiRes = await openai.chat.completions.create({
        model: AI_MODEL_MINI, max_tokens: 200,
        messages: [
          { role: 'system', content: `Você é a Zaya. Encerre a conversa educadamente com ${conv.lead_nome}. Agradeça as informações. Diga que o ${ADMIN_NAME} entrará em contato se necessário. Seja breve e profissional.` },
          { role: 'user', content: texto },
        ],
      });
      resposta = aiRes.choices[0].message.content;
    } catch (e) {
      resposta = `Muito obrigada pelas informações, ${conv.lead_nome}! O ${ADMIN_NAME} vai analisar tudo e entra em contato se precisar. Tenha um ótimo dia!`;
    }
  }

  // Salva resposta da Zaya no histórico
  historico.push({ de: 'zaya', msg: resposta, ts: new Date().toISOString() });

  // Atualiza conversa
  await s.from('missao_conversas').update({
    etapa_atual: temProxima ? proxEtapa : etapaAtual,
    status: novoStatus,
    historico,
    dados_coletados: dadosColetados,
    updated_at: new Date().toISOString(),
  }).eq('id', conv.id);

  // Se concluído, atualiza contadores da missão
  if (novoStatus === 'concluido') {
    const { count: respondidos } = await s.from('missao_conversas').select('*', { count: 'exact', head: true }).eq('missao_id', missao.id).in('status', ['em_conversa', 'concluido']);
    const { count: concluidos } = await s.from('missao_conversas').select('*', { count: 'exact', head: true }).eq('missao_id', missao.id).eq('status', 'concluido');

    await s.from('missoes').update({ respondidos, concluidos, updated_at: new Date().toISOString() }).eq('id', missao.id);

    // Se todos concluíram, gera relatório
    if (concluidos >= missao.total_leads) {
      await gerarRelatorio(missao.id);
    }
  }

  // Envia resposta via WhatsApp
  await sendWhatsApp(telefone, resposta);

  return { respondido: true, etapa: temProxima ? proxEtapa : 'final', resposta };
}

// ================================================================
// GERAR RELATÓRIO DA MISSÃO
// ================================================================
export async function gerarRelatorio(missaoId) {
  const s = getSb();
  if (!s) return null;

  const { data: missao } = await s.from('missoes').select('*').eq('id', missaoId).single();
  if (!missao) return null;

  const { data: conversas } = await s.from('missao_conversas').select('*').eq('missao_id', missaoId);
  if (!conversas) return null;

  // Monta contexto para a IA analisar
  const resumoConversas = conversas.map(c => {
    const dados = c.dados_coletados || {};
    return `${c.lead_nome} (${c.lead_telefone}) — Status: ${c.status}\nDados: ${JSON.stringify(dados)}\nConversa: ${(c.historico || []).map(h => `${h.de}: ${h.msg}`).join(' | ')}`;
  }).join('\n\n---\n\n');

  try {
    const aiRes = await openai.chat.completions.create({
      model: AI_MODEL, max_tokens: 1500,
      messages: [
        { role: 'system', content: `Você é a Zaya, assistente do ${ADMIN_NAME}. Gere um RELATÓRIO COMPLETO e uma ANÁLISE da missão.

MISSÃO: ${missao.titulo}
OBJETIVO: ${missao.objetivo}
TOTAL LEADS: ${missao.total_leads}
CONTATADOS: ${missao.contatados}
RESPONDIDOS: ${missao.respondidos}
CONCLUÍDOS: ${missao.concluidos}

Inclua no relatório:
1. Resumo executivo
2. Dados coletados por lead (tabela)
3. Análise comparativa
4. Recomendação do melhor lead/opção
5. Próximos passos sugeridos

Formato: texto natural, objetivo, com dados. Português brasileiro.` },
        { role: 'user', content: resumoConversas },
      ],
    });

    const relatorio = aiRes.choices[0].message.content;

    await s.from('missoes').update({
      status: 'concluida',
      relatorio,
      analise: relatorio,
      updated_at: new Date().toISOString(),
    }).eq('id', missaoId);

    log.ai.info({ id: missaoId, titulo: missao.titulo }, 'Missão concluída — relatório gerado');
    return relatorio;
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro ao gerar relatório');
    return null;
  }
}

// ================================================================
// LISTAR MISSÕES
// ================================================================
export async function listarMissoes(status) {
  const s = getSb();
  if (!s) return [];
  let query = s.from('missoes').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data } = await query;
  return data || [];
}

// ================================================================
// OBTER RELATÓRIO
// ================================================================
export async function obterRelatorio(missaoId) {
  const s = getSb();
  if (!s) return null;
  const { data } = await s.from('missoes').select('*').eq('id', missaoId).single();
  return data;
}
