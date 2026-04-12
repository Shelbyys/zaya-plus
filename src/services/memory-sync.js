// ================================================================
// MEMORY SYNC — Sincroniza memórias e ações com Supabase
// Garante que tudo persiste na nuvem (sobrevive restart)
// ================================================================
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { log } from '../logger.js';

let sb = null;
function getSb() {
  if (!sb && SUPABASE_URL && SUPABASE_KEY) sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

/**
 * Salva uma memória no Supabase (chamado após salvar no SQLite)
 */
export async function syncMemory(memory) {
  const s = getSb();
  if (!s) return;
  try {
    await s.from('memories').upsert({
      id: memory.id,
      category: memory.category,
      content: memory.content,
      source: memory.source || 'conversation',
      importance: memory.importance || 5,
      created_at: memory.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (e) {
    log.ai.warn({ err: e.message }, 'MemorySync: falha ao sincronizar memória');
  }
}

/**
 * Salva uma ação no Supabase (chamado após salvar no SQLite)
 */
export async function syncAction(action) {
  const s = getSb();
  if (!s) return;
  try {
    await s.from('zaya_actions').upsert({
      id: action.id,
      type: action.type,
      subtype: action.subtype,
      summary: action.summary,
      details: action.details,
      file_path: action.file_path,
      file_url: action.file_url,
      metadata: action.metadata ? (typeof action.metadata === 'string' ? JSON.parse(action.metadata) : action.metadata) : null,
      created_at: action.created_at || new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (e) {
    log.ai.warn({ err: e.message }, 'MemorySync: falha ao sincronizar ação');
  }
}

/**
 * Carrega memórias do Supabase → SQLite local (ao iniciar)
 */
export async function loadMemoriesFromCloud(localDB) {
  const s = getSb();
  if (!s || !localDB) return;
  try {
    const { data } = await s.from('memories').select('*').order('id', { ascending: true });
    if (!data || data.length === 0) return;

    const localCount = localDB.prepare('SELECT COUNT(*) as n FROM memories').get().n;
    if (localCount >= data.length) return; // Local já tem tudo

    const insert = localDB.prepare('INSERT OR REPLACE INTO memories (id, category, content, source, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const tx = localDB.transaction(() => {
      for (const m of data) {
        insert.run(m.id, m.category, m.content, m.source, m.importance, m.created_at, m.updated_at);
      }
    });
    tx();
    log.ai.info({ cloudCount: data.length, localCount }, 'MemorySync: memórias carregadas do Supabase');
  } catch (e) {
    log.ai.warn({ err: e.message }, 'MemorySync: falha ao carregar memórias');
  }
}

/**
 * Carrega ações do Supabase → SQLite local (ao iniciar)
 */
export async function loadActionsFromCloud(localDB) {
  const s = getSb();
  if (!s || !localDB) return;
  try {
    const { count } = await s.from('zaya_actions').select('*', { count: 'exact', head: true });
    const localCount = localDB.prepare('SELECT COUNT(*) as n FROM zaya_actions').get().n;
    if (localCount >= (count || 0)) return;

    // Pega só os que faltam (últimos 200)
    const { data } = await s.from('zaya_actions').select('*').order('id', { ascending: false }).limit(200);
    if (!data || data.length === 0) return;

    const insert = localDB.prepare('INSERT OR REPLACE INTO zaya_actions (id, type, subtype, summary, details, file_path, file_url, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const tx = localDB.transaction(() => {
      for (const a of data) {
        insert.run(a.id, a.type, a.subtype, a.summary, a.details, a.file_path, a.file_url,
          a.metadata ? JSON.stringify(a.metadata) : null, a.created_at);
      }
    });
    tx();
    log.ai.info({ cloudCount: count, synced: data.length }, 'MemorySync: ações carregadas do Supabase');
  } catch (e) {
    log.ai.warn({ err: e.message }, 'MemorySync: falha ao carregar ações');
  }
}
