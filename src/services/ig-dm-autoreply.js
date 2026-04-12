// ================================================================
// INSTAGRAM DM AUTO-REPLY — Responde DMs da @suaeasy4u com IA
// ================================================================
import { log } from '../logger.js';
import { AI_MODEL_MINI } from '../config.js';
import { getSupabase } from './supabase.js';
import { openai, io } from '../state.js';

const TABLE = 'ig_dm_conversations';

// Easy4u brand profile for context
const EASY4U_PROFILE = `Você é a assistente virtual da Easy4u (Easy Solutions LTDA).
A Easy4u é uma empresa de soluções tecnológicas especializada em:
- Automação de atendimento via WhatsApp e Instagram
- Criação de conteúdo com IA para redes sociais
- Gestão de marketing digital
- Chatbots inteligentes
- Sites e landing pages

Tom: profissional mas amigável, direto, prestativo.
Instagram: @suaeasy4u
Cor da marca: #EF641D (laranja)

REGRAS:
- Responda em português brasileiro
- Seja breve e objetiva (Instagram = mensagens curtas)
- Se perguntarem preço, diga que depende do projeto e ofereça uma conversa no WhatsApp
- Nunca invente serviços que não existem
- Se não souber, diga que vai verificar e retorna
- Sempre tente capturar o contato (WhatsApp) do interessado
- Finalize com chamada para ação (agendar call, mandar WhatsApp, etc.)`;

// ================================================================
// INIT — garante tabela
// ================================================================
let tableChecked = false;

async function ensureTable() {
  if (tableChecked) return;
  const sb = getSupabase();
  if (!sb) return;

  const { error } = await sb.from(TABLE).select('id').limit(1);
  if (error && error.code === '42P01') {
    log.db.warn(`Tabela "${TABLE}" não existe. Crie via SQL:

CREATE TABLE IF NOT EXISTS ig_dm_conversations (
  id BIGSERIAL PRIMARY KEY,
  ig_user_id TEXT NOT NULL,
  ig_username TEXT,
  ig_user_name TEXT,
  message_received TEXT,
  message_sent TEXT,
  message_id TEXT,
  direction TEXT DEFAULT 'received',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ig_dm_user ON ig_dm_conversations(ig_user_id);
CREATE INDEX IF NOT EXISTS idx_ig_dm_created ON ig_dm_conversations(created_at);
ALTER TABLE ig_dm_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service access" ON ig_dm_conversations FOR ALL USING (true);
`);
  } else {
    tableChecked = true;
  }
}

// ================================================================
// GERAR RESPOSTA COM IA
// ================================================================

async function generateReply(userMessage, conversationHistory = []) {
  try {
    const messages = [
      { role: 'system', content: EASY4U_PROFILE },
    ];

    // Adiciona histórico recente (últimas 10 msgs)
    for (const msg of conversationHistory.slice(-10)) {
      messages.push({
        role: msg.direction === 'received' ? 'user' : 'assistant',
        content: msg.direction === 'received' ? msg.message_received : msg.message_sent,
      });
    }

    messages.push({ role: 'user', content: userMessage });

    const res = await openai.chat.completions.create({
      model: AI_MODEL_MINI,
      messages,
      max_tokens: 300,
      temperature: 0.7,
    });

    return res.choices[0]?.message?.content || 'Olá! Obrigada pelo contato. Como posso te ajudar? 😊';
  } catch (e) {
    log.ai.error({ err: e.message }, 'IG DM: Erro ao gerar resposta IA');
    return 'Olá! Obrigada pelo interesse na Easy4u! Em breve retornaremos seu contato. 🧡';
  }
}

// ================================================================
// SALVAR CONVERSA
// ================================================================

async function saveConversation(igUserId, igUsername, igUserName, messageReceived, messageSent, messageId, direction = 'received') {
  await ensureTable();
  const sb = getSupabase();
  if (!sb) return;

  try {
    await sb.from(TABLE).insert({
      ig_user_id: igUserId,
      ig_username: igUsername,
      ig_user_name: igUserName,
      message_received: messageReceived,
      message_sent: messageSent,
      message_id: messageId,
      direction,
    });
  } catch (e) {
    log.db.error({ err: e.message }, 'IG DM: Erro ao salvar conversa');
  }
}

// ================================================================
// BUSCAR HISTÓRICO
// ================================================================

async function getConversationHistory(igUserId, limit = 20) {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    const { data, error } = await sb.from(TABLE)
      .select('*')
      .eq('ig_user_id', igUserId)
      .order('created_at', { ascending: true })
      .limit(limit);

    return error ? [] : (data || []);
  } catch { return []; }
}

// ================================================================
// PROCESSAR DM RECEBIDA (chamado pelo webhook Meta)
// ================================================================

export async function processInstagramDM({ senderId, senderUsername, senderName, messageText, messageId }) {
  try {
    log.ai.info({ senderId, senderUsername, messageText: messageText?.slice(0, 100) }, 'IG DM recebida');

    // Salva mensagem recebida
    await saveConversation(senderId, senderUsername, senderName, messageText, null, messageId, 'received');

    // Busca histórico de conversa
    const history = await getConversationHistory(senderId);

    // Gera resposta com IA
    const reply = await generateReply(messageText, history);

    // Envia resposta via Meta API
    const sent = await sendInstagramReply(senderId, reply);

    // Salva resposta enviada
    await saveConversation(senderId, senderUsername, senderName, null, reply, sent?.messageId, 'sent');

    // Notifica no dashboard
    if (io) {
      io.emit('zaya-proactive', {
        type: 'ig_dm',
        message: `💬 DM Instagram de @${senderUsername || senderId}: "${messageText?.slice(0, 100)}"\n\n🤖 Resposta: "${reply.slice(0, 100)}"`,
      });
    }

    log.ai.info({ senderId, reply: reply.slice(0, 80) }, 'IG DM: Resposta enviada');
    return { success: true, reply };
  } catch (e) {
    log.ai.error({ err: e.message }, 'IG DM: Erro ao processar');
    return { success: false, error: e.message };
  }
}

// ================================================================
// ENVIAR RESPOSTA VIA META API
// ================================================================

async function sendInstagramReply(recipientId, text) {
  const pageToken = process.env.META_PAGE_TOKEN;
  if (!pageToken) {
    log.ai.warn('META_PAGE_TOKEN não configurado — DM reply não enviada');
    return null;
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${pageToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: text.slice(0, 1000) },
        messaging_type: 'RESPONSE',
      }),
    });

    const data = await res.json();
    if (data.error) {
      log.ai.error({ error: data.error }, 'IG DM: Meta API error');
      return null;
    }
    return { messageId: data.message_id };
  } catch (e) {
    log.ai.error({ err: e.message }, 'IG DM: Erro ao enviar via Meta API');
    return null;
  }
}

// ================================================================
// LISTAR CONVERSAS
// ================================================================

export async function listConversations(limit = 20) {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    // Pega últimas conversas agrupadas por usuário
    const { data, error } = await sb.from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    return error ? [] : (data || []);
  } catch { return []; }
}

// ================================================================
// STATS
// ================================================================

export async function getDMStats() {
  const sb = getSupabase();
  if (!sb) return { enabled: false };

  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count: total } = await sb.from(TABLE).select('*', { count: 'exact', head: true });
    const { count: thisWeek } = await sb.from(TABLE)
      .select('*', { count: 'exact', head: true })
      .gte('created_at', weekAgo)
      .eq('direction', 'received');

    return {
      enabled: true,
      total_messages: total || 0,
      received_this_week: thisWeek || 0,
    };
  } catch (e) {
    return { enabled: true, error: e.message };
  }
}
