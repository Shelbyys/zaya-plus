import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { chatDB, messagesDB, contactsDB } from '../database.js';
import { log } from '../logger.js';

// ================================================================
// SUPABASE CLIENT
// ================================================================
let supabase = null;

export function getSupabase() {
  if (!supabase && SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    log.db.info('Supabase client inicializado');
  }
  return supabase;
}

export function isSupabaseEnabled() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

// ================================================================
// INICIALIZAR TABELAS (cria se não existem)
// ================================================================
export async function initSupabaseTables() {
  const sb = getSupabase();
  if (!sb) return;

  try {
    // Testa conexão verificando se tabela pesquisas existe
    const { error } = await sb.from('pesquisas').select('id').limit(1);
    if (error && error.code === '42P01') {
      log.db.warn('Tabelas Supabase não encontradas. Crie-as via SQL no dashboard.');
      logCreateTableSQL();
    } else if (error) {
      log.db.error({ err: error.message }, 'Erro ao conectar no Supabase');
    } else {
      log.db.info('Supabase conectado e tabelas OK');
    }

    // Cria tabela leads se não existir (via RPC ou ignora erro)
    const { error: leadsErr } = await sb.from('leads').select('id').limit(1);
    if (leadsErr && leadsErr.code === '42P01') {
      log.db.warn('Tabela "leads" não existe. Crie via SQL no dashboard (ver logCreateTableSQL).');
    }
  } catch (e) {
    log.db.error({ err: e.message }, 'Erro inicializando Supabase');
  }
}

function logCreateTableSQL() {
  log.db.info(`Execute este SQL no Supabase Dashboard (SQL Editor):

-- Pesquisas
CREATE TABLE IF NOT EXISTS pesquisas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  local_id TEXT UNIQUE,
  query TEXT,
  title TEXT,
  content TEXT,
  filepath TEXT,
  type TEXT DEFAULT 'pesquisa',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  jid TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_jid ON chat_messages(jid);

-- Contatos
CREATE TABLE IF NOT EXISTS contatos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  telefone TEXT,
  jid TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Activity log (ações da Zaya)
CREATE TABLE IF NOT EXISTS activity_log (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  details JSONB,
  source TEXT DEFAULT 'voice',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Leads (contatos/empresas encontrados em pesquisas e scraping)
CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  telefone TEXT,
  email TEXT,
  website TEXT,
  endereco TEXT,
  cidade TEXT,
  estado TEXT,
  categoria TEXT,
  fonte TEXT,
  notas TEXT,
  status TEXT DEFAULT 'novo',
  contatado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_categoria ON leads(categoria);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_cidade ON leads(cidade);

-- WhatsApp Inbox (mensagens recebidas)
CREATE TABLE IF NOT EXISTS wa_inbox (
  id BIGSERIAL PRIMARY KEY,
  event TEXT,
  jid TEXT,
  phone TEXT,
  push_name TEXT,
  message_body TEXT,
  message_type TEXT DEFAULT 'text',
  media_url TEXT,
  mimetype TEXT,
  from_me BOOLEAN DEFAULT false,
  is_group BOOLEAN DEFAULT false,
  raw_payload JSONB,
  status TEXT DEFAULT 'pending',
  received_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wa_inbox_status ON wa_inbox(status);
CREATE INDEX IF NOT EXISTS idx_wa_inbox_phone ON wa_inbox(phone);
CREATE INDEX IF NOT EXISTS idx_wa_inbox_received ON wa_inbox(received_at DESC);

-- Unique index para contatos (evita duplicatas)
CREATE UNIQUE INDEX IF NOT EXISTS idx_contatos_telefone ON contatos(telefone);

-- RLS (Row Level Security) - acesso apenas com service key
ALTER TABLE pesquisas ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE contatos ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_inbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service access" ON pesquisas FOR ALL USING (true);
CREATE POLICY "Service access" ON chat_messages FOR ALL USING (true);
CREATE POLICY "Service access" ON contatos FOR ALL USING (true);
CREATE POLICY "Service access" ON activity_log FOR ALL USING (true);
CREATE POLICY "Service access" ON leads FOR ALL USING (true);
CREATE POLICY "Service access" ON wa_inbox FOR ALL USING (true);
`);
}

// ================================================================
// SYNC: SALVAR PESQUISA
// ================================================================
export async function syncPesquisa(msg) {
  const sb = getSupabase();
  if (!sb) return;

  try {
    const { error } = await sb.from('pesquisas').upsert({
      local_id: msg.id,
      query: msg.title?.replace('Pesquisa: ', '') || '',
      title: msg.title || '',
      content: msg.content || '',
      filepath: msg.filePath || '',
      type: msg.type || 'pesquisa',
      created_at: msg.timestamp || new Date().toISOString(),
    }, { onConflict: 'local_id' });

    if (error) log.db.error({ err: error.message }, 'Erro sync pesquisa');
    else log.db.info({ id: msg.id }, 'Pesquisa synced com Supabase');
  } catch (e) {
    log.db.error({ err: e.message }, 'Erro sync pesquisa');
  }
}

// ================================================================
// SYNC: CONTATO PARA SUPABASE
// ================================================================
export async function syncContactToSupabase(nome, telefone, jid) {
  const sb = getSupabase();
  if (!sb || !telefone) return;
  try {
    await sb.from('contatos').upsert({ nome, telefone, jid, updated_at: new Date().toISOString() }, { onConflict: 'telefone' });
  } catch {}
}

// ================================================================
// SYNC: SALVAR MENSAGEM WA NO INBOX
// ================================================================
export async function saveToWaInbox(phone, pushName, body, type = 'text', fromMe = false) {
  const sb = getSupabase();
  if (!sb) return;
  try {
    await sb.from('wa_inbox').insert({
      event: fromMe ? 'message.sent' : 'message.received',
      jid: phone + '@s.whatsapp.net',
      phone,
      push_name: pushName || phone,
      message_body: body,
      message_type: type,
      from_me: fromMe,
      status: fromMe ? 'processed' : 'pending',
    });
  } catch {}
}

// ================================================================
// BUSCAR CONTATO NO SUPABASE
// ================================================================
export async function searchContactSupabase(query) {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data } = await sb.from('contatos')
      .select('nome, telefone, jid')
      .or(`nome.ilike.%${query}%,telefone.ilike.%${query}%`)
      .limit(5);
    return data && data.length > 0 ? data : null;
  } catch { return null; }
}

// ================================================================
// SYNC: SALVAR MENSAGEM DE CHAT
// ================================================================
export async function syncChatMessage(jid, role, content) {
  const sb = getSupabase();
  if (!sb) return;

  try {
    const { error } = await sb.from('chat_messages').insert({
      jid, role, content,
    });
    if (error) log.db.error({ err: error.message }, 'Erro sync chat');
  } catch (e) {
    log.db.error({ err: e.message }, 'Erro sync chat');
  }
}

// ================================================================
// SYNC: LOG DE ATIVIDADE
// ================================================================
export async function logActivity(action, details = {}, source = 'voice') {
  const sb = getSupabase();
  if (!sb) return;

  try {
    await sb.from('activity_log').insert({
      action, details, source,
    });
  } catch (e) {
    // Silencioso — log de atividade não deve bloquear
  }
}

// ================================================================
// SYNC COMPLETO: SQLite → Supabase (bulk)
// ================================================================
export async function syncAllToSupabase() {
  const sb = getSupabase();
  if (!sb) {
    log.db.info('Supabase não configurado, sync ignorado');
    return { synced: false };
  }

  const results = { pesquisas: 0, chats: 0, contatos: 0 };

  try {
    // 1. Sync pesquisas/messages
    const messages = messagesDB.getAll();
    if (messages.length > 0) {
      const rows = messages.map(m => ({
        local_id: m.id,
        query: m.title?.replace('Pesquisa: ', '').replace('Claude Code: ', '') || '',
        title: m.title || '',
        content: m.content || '',
        filepath: m.filePath || '',
        type: m.type || 'pesquisa',
        created_at: m.timestamp || new Date().toISOString(),
      }));

      // Upsert em batches de 50
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const { error } = await sb.from('pesquisas').upsert(batch, { onConflict: 'local_id' });
        if (error) log.db.error({ err: error.message }, 'Erro sync pesquisas batch');
        else results.pesquisas += batch.length;
      }
    }

    // 2. Sync contatos
    const contatos = contactsDB.getAll();
    if (contatos.length > 0) {
      // Limpa e re-insere (contatos mudam pouco)
      const rows = contatos.map(c => ({
        nome: c.nome,
        telefone: c.telefone || '',
        jid: c.jid || '',
      }));

      // Verifica se tabela existe antes
      const { error: checkErr } = await sb.from('contatos').select('id').limit(1);
      if (!checkErr) {
        await sb.from('contatos').delete().neq('id', 0); // limpa
        for (let i = 0; i < rows.length; i += 50) {
          const batch = rows.slice(i, i + 50);
          const { error } = await sb.from('contatos').insert(batch);
          if (error) log.db.error({ err: error.message }, 'Erro sync contatos batch');
          else results.contatos += batch.length;
        }
      }
    }

    // 3. Sync chat messages (últimas 24h apenas para não sobrecarregar)
    const chats = chatDB.listChats();
    for (const chat of chats) {
      const msgs = chatDB.getHistory(chat.jid);
      if (msgs.length > 0) {
        const rows = msgs.map(m => ({
          jid: chat.jid,
          role: m.role,
          content: m.content,
        }));
        const { error } = await sb.from('chat_messages').upsert(rows, {
          onConflict: 'id',
          ignoreDuplicates: true,
        }).select();
        if (!error) results.chats += rows.length;
      }
    }

    log.db.info(results, 'Sync completo SQLite → Supabase');
    return { synced: true, ...results };
  } catch (e) {
    log.db.error({ err: e.message }, 'Erro no sync completo');
    return { synced: false, error: e.message };
  }
}

// ================================================================
// STORAGE: UPLOAD DE ARQUIVO E GERAR LINK PÚBLICO
// ================================================================
export async function uploadToStorage(filePath, bucket = 'zaya-files', folder = '') {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const { readFile } = await import('fs/promises');
  const { basename, extname } = await import('path');

  const fileName = basename(filePath);
  const ext = extname(fileName).toLowerCase();
  const mimeTypes = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip', '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  const fileData = await readFile(filePath);
  const timestamp = Date.now();
  const storagePath = folder ? `${folder}/${timestamp}_${fileName}` : `${timestamp}_${fileName}`;

  // Ensure bucket exists
  const { data: buckets } = await sb.storage.listBuckets();
  const bucketExists = buckets?.some(b => b.name === bucket);
  if (!bucketExists) {
    const { error: createErr } = await sb.storage.createBucket(bucket, { public: true });
    if (createErr && !createErr.message.includes('already exists')) {
      throw new Error(`Erro ao criar bucket "${bucket}": ${createErr.message}`);
    }
  }

  const { data, error } = await sb.storage.from(bucket).upload(storagePath, fileData, {
    contentType,
    upsert: true,
  });

  if (error) throw new Error(`Upload falhou: ${error.message}`);

  // Get public URL
  const { data: urlData } = sb.storage.from(bucket).getPublicUrl(storagePath);
  const publicUrl = urlData?.publicUrl;

  log.db.info({ file: fileName, url: publicUrl }, 'Arquivo uploaded para Supabase Storage');

  return {
    path: data?.path || storagePath,
    publicUrl,
    fileName,
    contentType,
    size: fileData.length,
  };
}

// ================================================================
// STORAGE: LISTAR ARQUIVOS
// ================================================================
export async function listStorageFiles(bucket = 'zaya-files', folder = '') {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const { data, error } = await sb.storage.from(bucket).list(folder, {
    limit: 50,
    sortBy: { column: 'created_at', order: 'desc' },
  });

  if (error) throw new Error(`Erro ao listar: ${error.message}`);

  return (data || []).map(f => {
    const { data: urlData } = sb.storage.from(bucket).getPublicUrl(folder ? `${folder}/${f.name}` : f.name);
    return {
      name: f.name,
      size: f.metadata?.size || 0,
      created: f.created_at,
      url: urlData?.publicUrl,
    };
  });
}

// ================================================================
// STORAGE: DELETAR ARQUIVO
// ================================================================
export async function deleteStorageFile(filePath, bucket = 'zaya-files') {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const { error } = await sb.storage.from(bucket).remove([filePath]);
  if (error) throw new Error(`Erro ao deletar: ${error.message}`);
  return true;
}

// ================================================================
// ROTA: STATUS DO SUPABASE
// ================================================================
export async function getSupabaseStatus() {
  const sb = getSupabase();
  if (!sb) return { enabled: false };

  try {
    const { count: pesquisas } = await sb.from('pesquisas').select('*', { count: 'exact', head: true });
    const { count: chats } = await sb.from('chat_messages').select('*', { count: 'exact', head: true });
    const { count: contatos } = await sb.from('contatos').select('*', { count: 'exact', head: true });
    const { count: logs } = await sb.from('activity_log').select('*', { count: 'exact', head: true });

    return {
      enabled: true,
      url: SUPABASE_URL,
      counts: { pesquisas, chats, contatos, logs },
    };
  } catch (e) {
    return { enabled: true, error: e.message };
  }
}
