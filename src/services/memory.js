import { memoriesDB, archiveDB } from '../database.js';
import { openai } from '../state.js';
import { AI_MODEL_MINI } from '../config.js';
import { log } from '../logger.js';

// ================================================================
// EXTRAÇÃO AUTOMÁTICA DE MEMÓRIAS
// Analisa a conversa e salva fatos importantes sobre o usuário
// ================================================================
export async function extractMemories(userMessage, assistantReply, jid) {
  // Arquiva a conversa completa (sem limite)
  archiveDB.add(jid, 'user', userMessage);
  archiveDB.add(jid, 'assistant', assistantReply);

  // Só extrai se a mensagem do usuário tem conteúdo pessoal (não comandos)
  if (userMessage.length < 10) return;
  if (/^\/(login|logout|ping|help|limpar|stop)/.test(userMessage)) return;

  // Extrai em background (não bloqueia a resposta)
  setImmediate(async () => {
    try {
      const existingMemories = memoriesDB.getAll().map(m => `[${m.category}] ${m.content}`).join('\n');

      const response = await openai.chat.completions.create({
        model: AI_MODEL_MINI,
        max_tokens: 500,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: `Você é um extrator de informações pessoais. Analise a mensagem do usuário e extraia FATOS NOVOS sobre ele.

CATEGORIAS: personal, preference, work, relationship, routine, opinion, goal, health, finance, other

REGRAS:
- Só extraia fatos CONCRETOS e ÚTEIS (não opiniões vagas)
- Não repita informações que já existem nas memórias
- Se não houver nada novo para extrair, responda APENAS: NENHUM
- Formato: uma linha por fato: CATEGORIA|CONTEÚDO|IMPORTÂNCIA(1-10)
- Importância: 10=nome/dados pessoais, 7=preferências, 5=fatos gerais, 3=detalhes menores

Exemplos:
personal|Se chama Alisson, mora em Sergipe|10
preference|Prefere café sem açúcar|5
work|Trabalha com desenvolvimento de software e IA|8
relationship|Tem uma namorada chamada Julia|7
goal|Quer criar um app de delivery até junho|6

MEMÓRIAS JÁ SALVAS:
${existingMemories || '(nenhuma ainda)'}`,
          },
          {
            role: 'user',
            content: `MENSAGEM DO USUÁRIO: "${userMessage}"\nRESPOSTA DA ASSISTENTE: "${assistantReply.slice(0, 300)}"`,
          },
        ],
      });

      const result = response.choices[0].message.content.trim();
      if (result === 'NENHUM' || !result) return;

      const lines = result.split('\n').filter(l => l.includes('|'));
      let saved = 0;

      for (const line of lines) {
        const parts = line.split('|').map(s => s.trim());
        if (parts.length < 2) continue;

        const category = parts[0].toLowerCase();
        const content = parts[1];
        const importance = parseInt(parts[2]) || 5;

        if (!content || content.length < 5) continue;

        // Verifica duplicata
        const existing = memoriesDB.search(content.slice(0, 30));
        if (existing.some(m => m.content.toLowerCase().includes(content.toLowerCase().slice(0, 20)))) {
          continue;
        }

        memoriesDB.add(category, content, 'auto', importance);
        saved++;
      }

      if (saved > 0) {
        log.ai.info({ saved, total: memoriesDB.count() }, 'Memórias extraídas');
      }
    } catch (e) {
      log.ai.error({ err: e.message }, 'Erro ao extrair memórias');
    }
  });
}

// ================================================================
// MEMÓRIAS PARA O PROMPT
// ================================================================
export function getMemoriesForPrompt() {
  return memoriesDB.getForPrompt();
}

// ================================================================
// BUSCAR CONTEXTO RELEVANTE NO ARQUIVO
// ================================================================
export function getRelevantHistory(jid, limit = 30) {
  return archiveDB.getRecent(jid, limit);
}
