// ================================================================
// AUTO-REPLY — Analisa conversas e responde como o Sr. Alisson
// Aprende o estilo de comunicação por contato
// ================================================================
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, AI_MODEL, AI_MODEL_MINI, ADMIN_NUMBER } from '../config.js';
import { openai } from '../state.js';
import { log } from '../logger.js';
import { logAction } from './action-logger.js';
import { settingsDB } from '../database.js';

let sb = null;
function getSb() {
  if (!sb && SUPABASE_URL && SUPABASE_KEY) sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

// Cache local + Supabase
let autoReplyContacts = {};

// Carrega do Supabase ao iniciar
async function initAutoReply() {
  const s = getSb();
  if (!s) return;
  try {
    const { data } = await s.from('auto_reply_contacts').select('*');
    if (data) {
      for (const c of data) {
        autoReplyContacts[c.phone] = {
          name: c.name, phone: c.phone, style: c.style,
          rules: c.rules || '', active: c.active,
          enabledAt: c.enabled_at,
        };
      }
      if (data.length > 0) log.ai.info({ count: data.length }, 'AutoReply: contatos carregados do Supabase');
    }
  } catch (e) {
    log.ai.warn({ err: e.message }, 'AutoReply: falha ao carregar do Supabase');
  }
}
initAutoReply();

function saveContacts() {
  // Salva no Supabase
  const s = getSb();
  if (!s) return;
  for (const [phone, c] of Object.entries(autoReplyContacts)) {
    s.from('auto_reply_contacts').upsert({
      phone, name: c.name, style: c.style,
      rules: c.rules || '', active: c.active,
      enabled_at: c.enabledAt || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'phone' }).then(() => {}).catch(() => {});
  }
}

// ================================================================
// ANALISAR ESTILO DE CONVERSA COM UM CONTATO
// ================================================================
export async function analyzeConversation(phone, name) {
  const s = getSb();
  if (!s) throw new Error('Supabase não configurado');

  const cleanPhone = phone.replace(/\D/g, '');
  const last8 = cleanPhone.slice(-8);

  // Busca do Supabase
  const { data: msgs } = await s.from('wa_inbox')
    .select('message_body, from_me, received_at, push_name')
    .or(`phone.eq.${cleanPhone},phone.ilike.%${last8}%`)
    .eq('is_group', false)
    .order('received_at', { ascending: false })
    .limit(200);

  let myMsgs = (msgs || []).filter(m => m.from_me).map(m => m.message_body).filter(Boolean);
  let theirMsgs = (msgs || []).filter(m => !m.from_me).map(m => m.message_body).filter(Boolean);
  let contactName = name || msgs?.find(m => !m.from_me && m.push_name)?.push_name || phone;

  // Se não tem msgs enviadas (from_me < 3), tenta scraping do WhatsApp Web
  if (myMsgs.length < 3) {
    log.ai.info({ phone: cleanPhone, name: contactName }, 'AutoReply: buscando msgs do WhatsApp Web...');
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const run = promisify(exec);

      const contactSearch = contactName || cleanPhone;
      const script = `osascript -e '
        tell application "Google Chrome"
          if (count of windows) = 0 then make new window
          tell front window to set URL of active tab to "https://web.whatsapp.com"
          delay 5
          -- Busca contato
          set js1 to "document.querySelector(\\'[data-testid=chat-list-search]\\')?.click(); setTimeout(()=>{ let s=document.querySelector(\\'[data-testid=chat-list-search-input]\\') || document.querySelector(\\'div[contenteditable=true][data-tab=3]\\'); if(s){s.focus();s.textContent=\\'${contactSearch.replace(/'/g, '')}\\';s.dispatchEvent(new Event(\\'input\\',{bubbles:true}))} },500)"
          execute active tab of front window javascript js1
          delay 3
          -- Clica no primeiro resultado
          set js2 to "document.querySelector(\\'[data-testid=cell-frame-container]\\')?.click()"
          execute active tab of front window javascript js2
          delay 2
          -- Extrai mensagens (últimas 30)
          set js3 to "JSON.stringify([...document.querySelectorAll(\\'[data-testid=msg-container]\\')].slice(-30).map(m=>{const out=!!m.querySelector(\\'[data-testid=msg-dblcheck]\\') || !!m.querySelector(\\'[data-testid=msg-check]\\'); const txt=m.querySelector(\\'span.selectable-text\\')?.innerText||''; return {from_me:out,text:txt}}).filter(m=>m.text))"
          set result to execute active tab of front window javascript js3
          return result
        end tell'`;

      const { stdout } = await run(script, { timeout: 25000 });
      const parsed = JSON.parse(stdout.trim());

      if (Array.isArray(parsed) && parsed.length > 0) {
        const webMyMsgs = parsed.filter(m => m.from_me).map(m => m.text).filter(Boolean);
        const webTheirMsgs = parsed.filter(m => !m.from_me).map(m => m.text).filter(Boolean);

        log.ai.info({ myMsgs: webMyMsgs.length, theirMsgs: webTheirMsgs.length }, 'AutoReply: msgs do WhatsApp Web importadas');

        if (webMyMsgs.length > myMsgs.length) myMsgs = webMyMsgs;
        if (webTheirMsgs.length > theirMsgs.length) theirMsgs = webTheirMsgs;
      }
    } catch (e) {
      log.ai.warn({ err: e.message?.slice(0, 100) }, 'AutoReply: WhatsApp Web scraping falhou');
    }
  }

  if (myMsgs.length < 1 && theirMsgs.length < 3) {
    return { error: `Poucas mensagens com ${contactName} (${cleanPhone}). Encontrei ${myMsgs.length} suas e ${theirMsgs.length} dele(a). Preciso de mais histórico.` };
  }

  const hasMyMsgs = myMsgs.length >= 3;

  const systemPrompt = hasMyMsgs
    ? `Analise as mensagens de WhatsApp entre o Sr. Alisson e ${contactName}. Retorne um JSON com:
{
  "relacao": "tipo de relação (amigo, namorada, colega, cliente, família, chefe, etc)",
  "tom_alisson": "como Alisson fala com essa pessoa (formal, informal, carinhoso, profissional, direto, brincalhão)",
  "palavras_frequentes": ["palavras/expressões que Alisson usa muito com essa pessoa"],
  "cumprimento_tipico": "como Alisson começa conversas com essa pessoa",
  "despedida_tipica": "como Alisson encerra",
  "usa_emoji": true/false,
  "usa_audio": true/false,
  "nivel_intimidade": 1-10,
  "resposta_tipica_tamanho": "curta/média/longa",
  "assuntos_comuns": ["temas que falam"],
  "observacoes": "qualquer padrão especial notado"
}
Retorne APENAS o JSON.`
    : `Analise as mensagens de WhatsApp que ${contactName} enviou para o Sr. Alisson. Não temos as respostas do Alisson ainda, mas analise o perfil do contato baseado no que ele envia. Retorne um JSON com:
{
  "relacao": "provável tipo de relação baseado no tom das msgs (amigo, namorada, colega, cliente, família, chefe, etc)",
  "tom_contato": "como ${contactName} fala (formal, informal, carinhoso, profissional, direto, brincalhão)",
  "tom_alisson": "sugestão de como Alisson provavelmente responderia (informal, direto, etc) — baseado no contexto",
  "palavras_frequentes": ["palavras/expressões que ${contactName} usa muito"],
  "usa_emoji": true/false,
  "nivel_intimidade": 1-10,
  "resposta_tipica_tamanho": "curta/média/longa",
  "assuntos_comuns": ["temas que ${contactName} fala sobre"],
  "observacoes": "padrões notados. Nota: análise feita apenas com msgs recebidas, sem respostas do Alisson."
}
Retorne APENAS o JSON.`;

  const userContent = hasMyMsgs
    ? `MENSAGENS DO ALISSON pra ${contactName}:\n${myMsgs.slice(0, 30).join('\n---\n')}\n\nMENSAGENS DE ${contactName}:\n${theirMsgs.slice(0, 30).join('\n---\n')}`
    : `MENSAGENS DE ${contactName} para Alisson (não temos as respostas do Alisson):\n${theirMsgs.slice(0, 50).join('\n---\n')}`;

  const analysis = await openai.chat.completions.create({
    model: AI_MODEL, max_tokens: 1000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  let style;
  try {
    const raw = (analysis.choices[0].message.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
    style = JSON.parse(raw);
  } catch {
    style = { raw: analysis.choices[0].message.content, tom_alisson: 'informal' };
  }

  style.contactName = contactName;
  style.phone = cleanPhone;
  style.analyzedAt = new Date().toISOString();
  style.sampleMessages = myMsgs.slice(0, 10);

  logAction('auto_reply', `Estilo analisado: ${contactName}`, {
    subtype: 'analise', metadata: { phone: cleanPhone, style },
  });

  return style;
}

// ================================================================
// GERAR RESPOSTA NO ESTILO DO ALISSON
// ================================================================
export async function generateReplyAs(phone, incomingMessage, style = null) {
  if (!style) {
    const contact = autoReplyContacts[phone];
    if (!contact?.style) throw new Error('Estilo não analisado. Use analisar_conversa primeiro.');
    style = contact.style;
  }

  // Busca contexto recente da conversa pra responder com coerência
  const s = getSb();
  let recentContext = '';
  if (s) {
    try {
      const cleanPhone = phone.replace(/\D/g, '');
      const { data: recent } = await s.from('wa_inbox')
        .select('message_body, from_me, push_name')
        .or(`phone.eq.${cleanPhone},phone.ilike.%${cleanPhone.slice(-8)}%`)
        .eq('is_group', false)
        .order('received_at', { ascending: false })
        .limit(8);
      if (recent?.length) {
        recentContext = '\n\nÚLTIMAS MENSAGENS DA CONVERSA (mais recente primeiro):\n' +
          recent.map(m => `${m.from_me ? 'Alisson' : m.push_name || 'Contato'}: ${(m.message_body || '').slice(0, 100)}`).join('\n');
      }
    } catch {}
  }

  const res = await openai.chat.completions.create({
    model: AI_MODEL_MINI, max_tokens: 300,
    messages: [
      { role: 'system', content: `Você é o Alisson respondendo no WhatsApp para ${style.contactName}.

PERFIL DO ALISSON:
- Cearense, empreendedor, dono da Easy4u (empresa de IA)
- Fala de forma direta, usa gírias nordestinas/cearenses às vezes
- Não é muito formal, mas é respeitoso
- Responde rápido, mensagens curtas na maioria

ESTILO COM ${style.contactName}:
- Relação: ${style.relacao || 'amigo/conhecido'}
- Tom: ${style.tom_alisson || style.tom_contato || 'informal, direto'}
- Intimidade: ${style.nivel_intimidade || 5}/10
- Usa emoji: ${style.usa_emoji !== false ? 'sim, moderado' : 'raramente'}
- Tamanho típico: ${style.resposta_tipica_tamanho || 'curta'}
- Palavras frequentes: ${(style.palavras_frequentes || ['opa', 'show', 'beleza', 'bora']).join(', ')}
- Assuntos comuns: ${(style.assuntos_comuns || []).join(', ') || 'trabalho, dia a dia'}

${(style.sampleMessages || []).length > 0 ? 'EXEMPLOS de como Alisson fala:\n' + style.sampleMessages.slice(0, 5).join('\n') : ''}
${recentContext}

REGRAS:
- Responda como se fosse o Alisson DIGITANDO no WhatsApp
- Mensagens CURTAS (1-3 linhas no máximo)
- Tom natural, como se tivesse mandando msg rápida
- Use o contexto da conversa recente pra manter a coerência
- Se não sabe do assunto, responda de forma vaga mas natural ("vou ver isso", "depois te falo")
- NUNCA revele que é uma IA ou que não é o Alisson
- NUNCA seja excessivamente educado ou formal demais
- Se for sobre trabalho/reunião, diga que "tá corrido" e agenda pra depois` },
      { role: 'user', content: incomingMessage },
    ],
  });

  return res.choices[0].message.content || '';
}

// ================================================================
// CONFIGURAR AUTO-RESPOSTA PRA UM CONTATO
// ================================================================
export async function enableAutoReply(phone, name, rules = '') {
  const cleanPhone = phone.replace(/\D/g, '');

  // Analisa estilo se não tem
  let style = autoReplyContacts[cleanPhone]?.style;
  if (!style) {
    log.ai.info({ phone: cleanPhone, name }, 'AutoReply: analisando estilo...');
    style = await analyzeConversation(cleanPhone, name);
    if (style.error) return { error: style.error };
  }

  autoReplyContacts[cleanPhone] = {
    name: name || style.contactName || cleanPhone,
    phone: cleanPhone,
    style,
    rules: rules || '',
    active: true,
    enabledAt: new Date().toISOString(),
  };
  saveContacts();

  logAction('auto_reply', `Auto-resposta ativada: ${name || cleanPhone}`, {
    subtype: 'ativado', metadata: { phone: cleanPhone, name },
  });

  return { status: 'ativado', contact: name || cleanPhone, style };
}

// ================================================================
// DESATIVAR AUTO-RESPOSTA
// ================================================================
export function disableAutoReply(phone) {
  const cleanPhone = phone.replace(/\D/g, '');
  if (autoReplyContacts[cleanPhone]) {
    autoReplyContacts[cleanPhone].active = false;
    saveContacts();
    return { status: 'desativado', contact: autoReplyContacts[cleanPhone].name };
  }
  return { status: 'não encontrado' };
}

// ================================================================
// LISTAR CONTATOS COM AUTO-RESPOSTA
// ================================================================
export function listAutoReply() {
  return Object.values(autoReplyContacts).map(c => ({
    name: c.name,
    phone: c.phone,
    active: c.active,
    relacao: c.style?.relacao,
    tom: c.style?.tom_alisson,
    enabledAt: c.enabledAt,
  }));
}

// ================================================================
// PROCESSAR MSG RECEBIDA (chamado pelo inbox-poller)
// ================================================================
export async function processAutoReply(phone, text, senderName) {
  const cleanPhone = phone.replace(/\D/g, '');

  // Tenta match por últimos 8 dígitos também
  let contact = autoReplyContacts[cleanPhone];
  if (!contact?.active) {
    const last8 = cleanPhone.slice(-8);
    contact = Object.values(autoReplyContacts).find(c => c.active && c.phone.endsWith(last8));
  }
  if (!contact?.active) return null;

  log.ai.info({ phone: cleanPhone, name: contact.name, text: text?.slice(0, 50) }, 'AutoReply: respondendo como Alisson');

  try {
    const reply = await generateReplyAs(contact.phone, text, contact.style);

    logAction('auto_reply', `Respondeu como Alisson pra ${contact.name}: ${text?.slice(0, 40)}`, {
      subtype: 'resposta',
      details: `Recebido: ${text?.slice(0, 100)}\nRespondido: ${reply?.slice(0, 100)}`,
      metadata: { phone: cleanPhone, name: contact.name },
    });

    // Notifica o Alisson no chat da Zaya
    try {
      const { io } = await import('../state.js');
      io?.emit('zaya-proactive', {
        text: `🤖 Respondi como você pro ${contact.name}:\n📩 "${text?.slice(0, 60)}"\n💬 "${reply?.slice(0, 80)}"`,
        tipo: 'auto_reply',
        speak: false,
      });
    } catch {}

    return reply;
  } catch (e) {
    log.ai.error({ err: e.message, phone: cleanPhone }, 'AutoReply: erro');
    return null;
  }
}

export { autoReplyContacts };
