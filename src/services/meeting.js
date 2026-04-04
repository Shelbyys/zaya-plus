// ================================================================
// MEETING MODE — Grava reunião, transcreve e gera relatório
// ================================================================
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, AI_MODEL, ADMIN_NAME } from '../config.js';
import { openai, io } from '../state.js';
import { log } from '../logger.js';

let sb = null;
function getSb() { if (!sb && SUPABASE_URL && SUPABASE_KEY) sb = createClient(SUPABASE_URL, SUPABASE_KEY); return sb; }

let meetingActive = false;
let meetingId = null;
let meetingTitle = '';
let meetingChunks = [];
let meetingStartTime = null;

// ================================================================
// INICIAR REUNIÃO
// ================================================================
export function startMeeting(titulo = '') {
  if (meetingActive) return { status: 'já ativa', id: meetingId };
  meetingActive = true;
  meetingId = `meeting_${Date.now()}`;
  meetingTitle = titulo || `Reunião ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  meetingChunks = [];
  meetingStartTime = new Date();

  log.ai.info({ id: meetingId, titulo: meetingTitle }, 'Reunião iniciada');

  // Salva início no Supabase
  const s = getSb();
  if (s) {
    s.from('activity_log').insert({
      action: 'meeting_start',
      details: { meetingId, titulo: meetingTitle, inicio: meetingStartTime.toISOString() },
      source: 'meeting',
    }).catch(() => {});
  }

  return { status: 'iniciada', id: meetingId, titulo: meetingTitle };
}

// ================================================================
// ADICIONAR CHUNK DE TRANSCRIÇÃO (a cada 3 min)
// ================================================================
export async function addMeetingChunk(text) {
  if (!meetingActive || !text?.trim()) return;

  const chunk = {
    index: meetingChunks.length,
    timestamp: new Date().toISOString(),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    minuto: Math.round((Date.now() - meetingStartTime.getTime()) / 60000),
    texto: text.trim(),
  };

  meetingChunks.push(chunk);
  log.ai.info({ chunk: chunk.index, min: chunk.minuto, chars: text.length }, 'Meeting chunk salvo');

  // Salva chunk no Supabase
  const s = getSb();
  if (s) {
    try {
      await s.from('activity_log').insert({
        action: 'meeting_chunk',
        details: { meetingId, ...chunk },
        source: 'meeting',
      });
    } catch (e) {}
  }

  // Notifica frontend
  io?.emit('zaya-proactive', {
    text: `Reunião: ${chunk.minuto}min gravados (${meetingChunks.length} blocos)`,
    tipo: 'meeting',
  });

  return chunk;
}

// ================================================================
// ENCERRAR REUNIÃO E GERAR RELATÓRIO
// ================================================================
export async function endMeeting() {
  if (!meetingActive) return { status: 'nenhuma reunião ativa' };

  meetingActive = false;
  const duracao = Math.round((Date.now() - meetingStartTime.getTime()) / 60000);

  if (meetingChunks.length === 0) {
    return { status: 'encerrada', relatorio: 'Nenhuma transcrição capturada durante a reunião.' };
  }

  log.ai.info({ id: meetingId, chunks: meetingChunks.length, duracao }, 'Gerando relatório da reunião');

  // Junta toda a transcrição
  const fullTranscription = meetingChunks
    .map(c => `[${c.hora} — min ${c.minuto}]\n${c.texto}`)
    .join('\n\n');

  // Gera relatório com GPT-4o
  try {
    const res = await openai.chat.completions.create({
      model: AI_MODEL, max_tokens: 4000,
      messages: [
        { role: 'system', content: `Você é um assistente executivo expert em atas de reunião. Gere um relatório COMPLETO e BEM ESTRUTURADO da reunião. Português brasileiro.

O relatório DEVE conter:

# ${meetingTitle}
**Data:** ${meetingStartTime.toLocaleDateString('pt-BR')}
**Horário:** ${meetingStartTime.toLocaleTimeString('pt-BR')} — ${new Date().toLocaleTimeString('pt-BR')}
**Duração:** ${duracao} minutos
**Blocos transcritos:** ${meetingChunks.length}

## Resumo Executivo
(2-3 parágrafos resumindo os pontos principais)

## Participantes Identificados
(Liste nomes mencionados na conversa)

## Tópicos Discutidos
(Liste cada tópico com sub-pontos)

## Menções ao ${ADMIN_NAME}
(Tudo que foi dito sobre ou para o Alisson, com contexto)

## Decisões Tomadas
(Liste decisões claras que foram feitas)

## Demandas e Ações
(Liste CADA tarefa/demanda identificada com responsável se mencionado)
- [ ] Tarefa 1 — Responsável — Prazo
- [ ] Tarefa 2 — Responsável — Prazo

## Pontos de Atenção
(Problemas, riscos ou preocupações levantados)

## Próximos Passos
(O que deve acontecer depois da reunião)

Seja detalhista e objetivo. Se algo não foi mencionado, omita a seção.` },
        { role: 'user', content: `TRANSCRIÇÃO COMPLETA DA REUNIÃO:\n\n${fullTranscription}` },
      ],
    });

    const relatorio = res.choices[0].message.content || 'Erro ao gerar relatório';

    // Salva no Supabase
    const s = getSb();
    if (s) {
      try {
        await s.from('activity_log').insert({
          action: 'meeting_report',
          details: {
            meetingId,
            titulo: meetingTitle,
            inicio: meetingStartTime.toISOString(),
            fim: new Date().toISOString(),
            duracao,
            chunks: meetingChunks.length,
            transcricao_completa: fullTranscription,
            relatorio,
          },
          source: 'meeting',
        });
      } catch (e) {}
    }

    log.ai.info({ id: meetingId, reportLen: relatorio.length }, 'Relatório da reunião gerado');

    // Limpa
    const result = {
      status: 'encerrada',
      id: meetingId,
      titulo: meetingTitle,
      duracao,
      chunks: meetingChunks.length,
      relatorio,
    };
    meetingId = null;
    meetingTitle = '';
    meetingChunks = [];
    meetingStartTime = null;

    return result;
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro ao gerar relatório');
    return { status: 'encerrada', relatorio: `Erro ao gerar relatório: ${e.message}\n\nTranscrição bruta:\n${fullTranscription}` };
  }
}

// ================================================================
// STATUS DA REUNIÃO
// ================================================================
export function getMeetingStatus() {
  if (!meetingActive) return { ativa: false };
  return {
    ativa: true,
    id: meetingId,
    titulo: meetingTitle,
    duracao: Math.round((Date.now() - meetingStartTime.getTime()) / 60000),
    chunks: meetingChunks.length,
    ultimoChunk: meetingChunks[meetingChunks.length - 1]?.hora || null,
  };
}

// ================================================================
// VERIFICAR SE REUNIÃO ESTÁ ATIVA (usado pelo frontend)
// ================================================================
export function isMeetingActive() {
  return meetingActive;
}
