// ================================================================
// IG SCHEDULER — Agendamento de postagens no Instagram
// Verifica a cada 60s se há posts para publicar
// ================================================================
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { log } from '../logger.js';
import { io } from '../state.js';

let supabase = null;
let pollInterval = null;

function getSb() {
  if (!supabase && SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY.replace(/\s+/g, ''));
  }
  return supabase;
}

const ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';
const GRAPH = 'https://graph.facebook.com/v21.0';

const IG_ACCOUNTS = {
  pessoal: { id: '17841410457949155', username: 'soualissonsilva' },
  easy4u:  { id: '17841476756797534', username: 'suaeasy4u' },
};

function resolveIGAccount(accountIdOrName) {
  if (!accountIdOrName) return IG_ACCOUNTS.pessoal.id;
  const lower = (accountIdOrName + '').toLowerCase();
  if (lower === 'easy4u' || lower === 'suaeasy4u' || lower === IG_ACCOUNTS.easy4u.id) return IG_ACCOUNTS.easy4u.id;
  if (lower === 'pessoal' || lower === 'soualissonsilva' || lower === IG_ACCOUNTS.pessoal.id) return IG_ACCOUNTS.pessoal.id;
  return accountIdOrName;
}

function getAccountName(igId) {
  if (igId === IG_ACCOUNTS.easy4u.id) return '@suaeasy4u';
  if (igId === IG_ACCOUNTS.pessoal.id) return '@soualissonsilva';
  return igId;
}

// ================================================================
// PUBLICAR POST NO INSTAGRAM
// ================================================================
async function publishPost(post) {
  if (!ACCESS_TOKEN) throw new Error('FACEBOOK_ACCESS_TOKEN não configurado');

  // RESOLVE a conta IG correta — NUNCA usar hardcoded
  const targetIG = resolveIGAccount(post.ig_account_id);
  const accountName = getAccountName(targetIG);
  log.ai.info({ targetIG, accountName, type: post.type }, 'IG Scheduler: publicando na conta');

  const { type, media_url, caption } = post;
  const fullCaption = [caption, post.hashtags].filter(Boolean).join('\n\n');

  let params = '';
  if (type === 'feed') {
    params = `image_url=${encodeURIComponent(media_url)}&caption=${encodeURIComponent(fullCaption)}`;
  } else if (type === 'story') {
    const isVideo = media_url.match(/\.(mp4|mov|webm)/i);
    const mediaParam = isVideo ? 'video_url' : 'image_url';
    params = `${mediaParam}=${encodeURIComponent(media_url)}&media_type=STORIES`;
    if (fullCaption) params += `&caption=${encodeURIComponent(fullCaption)}`;
  } else if (type === 'reel') {
    params = `video_url=${encodeURIComponent(media_url)}&media_type=REELS&caption=${encodeURIComponent(fullCaption)}&share_to_feed=true`;
  }

  const containerRes = await fetch(`${GRAPH}/${targetIG}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `${params}&access_token=${ACCESS_TOKEN}`,
  });
  const containerData = await containerRes.json();
  if (containerData.error) throw new Error(containerData.error.message);
  if (!containerData.id) throw new Error('Container sem ID');

  // Step 2: Aguardar processamento (reels/videos)
  if (type === 'reel' || type === 'story') {
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const chk = await fetch(`${GRAPH}/${containerData.id}?fields=status_code&access_token=${ACCESS_TOKEN}`);
      const chkData = await chk.json();
      if (chkData.status_code === 'FINISHED') break;
      if (chkData.status_code === 'ERROR') throw new Error('Processamento falhou');
    }
  } else {
    // Imagens: espera um pouco
    await new Promise(r => setTimeout(r, 3000));
  }

  // Step 3: Publicar
  const pubRes = await fetch(`${GRAPH}/${targetIG}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `creation_id=${containerData.id}&access_token=${ACCESS_TOKEN}`,
  });
  const pubData = await pubRes.json();
  if (pubData.error) throw new Error(pubData.error.message);

  return pubData.id;
}

// ================================================================
// POLL — verifica posts pendentes a cada 60s
// ================================================================
async function pollScheduledPosts() {
  const sb = getSb();
  if (!sb) return;

  try {
    const now = new Date().toISOString();

    // Busca posts pendentes que já passaram do horário
    const { data: posts, error } = await sb
      .from('ig_scheduled_posts')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', now)
      .order('scheduled_at', { ascending: true })
      .limit(5);

    if (error || !posts?.length) return;

    for (const post of posts) {
      log.ai.info({ id: post.id, type: post.type, campaign: post.campaign_name }, 'IG Scheduler: publicando post agendado');

      // Marca como publishing
      await sb.from('ig_scheduled_posts').update({ status: 'publishing' }).eq('id', post.id);

      try {
        const publishedId = await publishPost(post);

        await sb.from('ig_scheduled_posts').update({
          status: 'published',
          published_id: publishedId,
          published_at: new Date().toISOString(),
        }).eq('id', post.id);

        const acctName = getAccountName(resolveIGAccount(post.ig_account_id));
        log.ai.info({ id: post.id, publishedId, type: post.type, account: acctName }, 'IG Scheduler: post publicado!');

        // Notifica no chat da Zaya (aparece como mensagem + fala)
        const notifText = `📸 Post ${post.type} publicado na ${acctName}! ${post.campaign_name ? `Campanha: ${post.campaign_name}` : ''}`.trim();
        io?.emit('zaya-proactive', { text: notifText, tipo: 'instagram', speak: true });
        io?.emit('incoming-notification', { type: 'ig_published', title: `Post publicado ${acctName}`, text: `${post.type} agendado foi publicado com sucesso.`, timestamp: new Date().toISOString() });
      } catch (e) {
        log.ai.error({ id: post.id, err: e.message }, 'IG Scheduler: erro ao publicar');
        await sb.from('ig_scheduled_posts').update({
          status: 'error',
          error: e.message,
        }).eq('id', post.id);

        // Notifica erro no chat
        io?.emit('zaya-proactive', { text: `⚠️ Erro ao publicar ${post.type} agendado: ${e.message}`, tipo: 'erro', speak: true });
      }

      // Rate limit entre posts
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (e) {
    log.ai.error({ err: e.message }, 'IG Scheduler: poll error');
  }
}

// ================================================================
// CRUD — criar/listar/cancelar agendamentos
// ================================================================
export async function createScheduledPost(data) {
  const sb = getSb();
  if (!sb) throw new Error('Supabase não configurado');

  // VALIDAÇÃO DE CONTA — detecta automaticamente Easy4u pelo conteúdo
  let accountId = data.ig_account_id || data.conta || '';
  const allText = [data.caption, data.campaign_name, data.hashtags, data.media_url].filter(Boolean).join(' ').toLowerCase();
  const isEasy4uContent = /easy4u|suaeasy|@suaeasy4u|easy4u_|easy4u-/.test(allText);

  if (!accountId && isEasy4uContent) {
    accountId = 'easy4u';
    log.ai.info('IG Scheduler: conteúdo Easy4u detectado → conta @suaeasy4u');
  }

  const resolvedIG = resolveIGAccount(accountId);
  const accountName = getAccountName(resolvedIG);

  // SEGURANÇA: se conteúdo é Easy4u mas conta é pessoal, BLOQUEIA
  if (isEasy4uContent && resolvedIG === IG_ACCOUNTS.pessoal.id) {
    throw new Error(`BLOQUEADO: Conteúdo da Easy4u detectado mas conta selecionada é @soualissonsilva. Use conta='easy4u' ou ig_account_id='${IG_ACCOUNTS.easy4u.id}' para postar na @suaeasy4u.`);
  }

  const post = {
    ig_account_id: resolvedIG,
    type: data.type || 'feed',
    media_url: data.media_url,
    caption: data.caption || '',
    hashtags: data.hashtags || '',
    scheduled_at: data.scheduled_at,
    campaign_name: data.campaign_name || '',
    status: 'pending',
  };

  if (!post.media_url) throw new Error('media_url obrigatório');
  if (!post.scheduled_at) throw new Error('scheduled_at obrigatório');

  const { data: result, error } = await sb.from('ig_scheduled_posts').insert(post).select().single();
  if (error) throw new Error(error.message);

  log.ai.info({ id: result.id, type: post.type, at: post.scheduled_at, account: accountName }, 'IG Scheduler: post agendado');
  return { ...result, accountName };
}

export async function createBulkSchedule(posts) {
  const results = [];
  for (const p of posts) {
    try {
      const result = await createScheduledPost(p);
      results.push({ success: true, id: result.id, scheduled_at: result.scheduled_at, type: result.type });
    } catch (e) {
      results.push({ success: false, error: e.message });
    }
  }
  return results;
}

export async function listScheduledPosts(filters = {}) {
  const sb = getSb();
  if (!sb) return [];

  let query = sb.from('ig_scheduled_posts').select('*').order('scheduled_at', { ascending: true });
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.campaign) query = query.eq('campaign_name', filters.campaign);
  if (filters.type) query = query.eq('type', filters.type);
  if (filters.limit) query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

export async function cancelScheduledPost(id) {
  const sb = getSb();
  if (!sb) throw new Error('Supabase não configurado');
  const { error } = await sb.from('ig_scheduled_posts').update({ status: 'cancelled' }).eq('id', id).eq('status', 'pending');
  if (error) throw new Error(error.message);
  return true;
}

export async function cancelCampaign(campaignName) {
  const sb = getSb();
  if (!sb) throw new Error('Supabase não configurado');
  const { data, error } = await sb.from('ig_scheduled_posts')
    .update({ status: 'cancelled' })
    .eq('campaign_name', campaignName)
    .eq('status', 'pending')
    .select('id');
  if (error) throw new Error(error.message);
  return data?.length || 0;
}

// ================================================================
// START / STOP
// ================================================================
export function startIGScheduler() {
  if (!SUPABASE_URL || !SUPABASE_KEY || !ACCESS_TOKEN) {
    log.ai.warn('IG Scheduler: faltam credenciais (Supabase ou Meta)');
    return;
  }
  log.ai.info('IG Scheduler iniciado (check a cada 60s)');
  pollInterval = setInterval(pollScheduledPosts, 60000);
  pollScheduledPosts(); // check imediato
}

export function stopIGScheduler() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}
