// ================================================================
// ACTION LOGGER — Registra tudo que a Zaya faz
// Cada ação gera um registro com tipo, resumo, arquivos, timestamps
// Injetado no system prompt para a Zaya saber o que já fez
// ================================================================
import { actionsDB } from '../database.js';
import { log } from '../logger.js';

// Tipos de ação reconhecidos
const ACTION_TYPES = {
  // Criação de conteúdo
  image: 'imagem',
  video: 'video',
  slide: 'slide',
  audio: 'audio',
  document: 'documento',
  site: 'site',

  // Comunicação
  whatsapp: 'whatsapp',
  imessage: 'imessage',
  call: 'ligacao',
  instagram: 'instagram',

  // Análise/Relatório
  report: 'relatorio',
  meeting: 'reuniao',
  research: 'pesquisa',
  screen: 'monitor_tela',

  // Operações
  mission: 'missao',
  schedule: 'agendamento',
  event: 'evento',
  command: 'comando',
  upload: 'upload',
};

/**
 * Registra uma ação da Zaya.
 *
 * @param {string} type - Tipo: image, video, slide, report, meeting, whatsapp, etc.
 * @param {string} summary - Resumo curto (1-2 frases)
 * @param {object} [opts] - Opções adicionais
 * @param {string} [opts.subtype] - Subtipo (ex: "dall-e", "kling", "nanoBanana")
 * @param {string} [opts.details] - Detalhes longos (conteúdo do relatório, prompt, etc.)
 * @param {string} [opts.filePath] - Caminho do arquivo gerado
 * @param {string} [opts.fileUrl] - URL pública do arquivo
 * @param {object} [opts.metadata] - Dados extras em JSON
 */
export function logAction(type, summary, opts = {}) {
  try {
    const { subtype, details, filePath, fileUrl, metadata } = opts;
    actionsDB.log(type, subtype || null, summary, details || null, filePath || null, fileUrl || null, metadata || null);
    log.ai.info({ type, subtype, summary: summary.slice(0, 80) }, 'ActionLog: registrado');
  } catch (e) {
    log.ai.warn({ err: e.message, type }, 'ActionLog: falha ao registrar');
  }
}

/**
 * Busca ações no histórico.
 *
 * @param {object} filtros
 * @param {string} [filtros.tipo] - Filtrar por tipo
 * @param {string} [filtros.data] - Data específica (YYYY-MM-DD)
 * @param {string} [filtros.data_inicio] - Início do range
 * @param {string} [filtros.data_fim] - Fim do range
 * @param {string} [filtros.busca] - Texto livre
 * @param {number} [filtros.limite] - Máximo de resultados
 * @returns {object[]}
 */
export function searchActions(filtros = {}) {
  try {
    // Tipo + data
    if (filtros.tipo && filtros.data) {
      return actionsDB.getByTypeAndDate(filtros.tipo, filtros.data);
    }
    // Só tipo
    if (filtros.tipo) {
      return actionsDB.getByType(filtros.tipo, filtros.limite || 20);
    }
    // Só data
    if (filtros.data) {
      return actionsDB.getByDate(filtros.data);
    }
    // Range de datas
    if (filtros.data_inicio && filtros.data_fim) {
      return actionsDB.getByDateRange(filtros.data_inicio, filtros.data_fim, filtros.limite || 50);
    }
    // Busca por texto
    if (filtros.busca) {
      return actionsDB.search(filtros.busca, filtros.limite || 20);
    }
    // Recentes
    return actionsDB.getRecent(filtros.limite || 15);
  } catch (e) {
    log.ai.warn({ err: e.message }, 'searchActions falhou');
    return [];
  }
}

/**
 * Retorna texto formatado das ações recentes para injetar no system prompt.
 */
export function getActionsForPrompt(limit = 15) {
  return actionsDB.getForPrompt(limit);
}

/**
 * Formata resultado da busca para devolver como resposta da tool.
 */
export function formatSearchResult(actions) {
  if (!actions || actions.length === 0) return 'Nenhuma ação encontrada no histórico.';

  const lines = actions.map(a => {
    const parts = [`[${a.createdAt}] ${a.type}${a.subtype ? '/' + a.subtype : ''}: ${a.summary}`];
    if (a.filePath) parts.push(`  Arquivo: ${a.filePath}`);
    if (a.fileUrl) parts.push(`  Link: ${a.fileUrl}`);
    if (a.details) parts.push(`  Detalhes: ${a.details.slice(0, 300)}`);
    return parts.join('\n');
  });

  return `Encontradas ${actions.length} ações:\n\n${lines.join('\n\n')}`;
}

export { ACTION_TYPES };
