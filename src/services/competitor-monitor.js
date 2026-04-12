// ================================================================
// MONITORAMENTO DE CONCORRENTES — Tracking IG competitors
// ================================================================
import { log } from '../logger.js';
import { getSupabase } from './supabase.js';
import { scrapeInstagramProfile } from './apify.js';
import { io } from '../state.js';

const TABLE = 'competitor_monitors';

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

CREATE TABLE IF NOT EXISTS competitor_monitors (
  id BIGSERIAL PRIMARY KEY,
  ig_username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  last_followers INTEGER DEFAULT 0,
  last_following INTEGER DEFAULT 0,
  last_posts INTEGER DEFAULT 0,
  last_engagement NUMERIC(5,2) DEFAULT 0,
  last_bio TEXT,
  history JSONB DEFAULT '[]',
  checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE competitor_monitors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service access" ON competitor_monitors FOR ALL USING (true);
`);
  } else {
    tableChecked = true;
  }
}

// ================================================================
// CRUD
// ================================================================

export async function addCompetitor(igUsername, displayName = '') {
  await ensureTable();
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  // Remove @ se presente
  const username = igUsername.replace(/^@/, '').trim().toLowerCase();

  const { data, error } = await sb.from(TABLE).upsert({
    ig_username: username,
    display_name: displayName || username,
  }, { onConflict: 'ig_username' }).select().single();

  if (error) throw new Error(`Erro ao adicionar concorrente: ${error.message}`);
  log.db.info({ username }, 'Competitor: Adicionado');
  return data;
}

export async function removeCompetitor(igUsername) {
  await ensureTable();
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const username = igUsername.replace(/^@/, '').trim().toLowerCase();
  const { error } = await sb.from(TABLE).delete().eq('ig_username', username);
  if (error) throw new Error(`Erro ao remover: ${error.message}`);
  return true;
}

export async function listCompetitors() {
  await ensureTable();
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb.from(TABLE).select('*').order('checked_at', { ascending: false });
  return error ? [] : (data || []);
}

// ================================================================
// CHECK COMPETITOR — scrape e atualiza dados
// ================================================================

export async function checkCompetitor(igUsername) {
  await ensureTable();
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const username = igUsername.replace(/^@/, '').trim().toLowerCase();

  try {
    log.ai.info({ username }, 'Competitor: Scraping perfil...');

    // Usa Apify para scrape
    const profiles = await scrapeInstagramProfile([username]);
    if (!profiles || profiles.length === 0) {
      throw new Error(`Perfil @${username} não encontrado`);
    }

    const profile = profiles[0];
    const followers = profile.followersCount || profile.followers || 0;
    const following = profile.followingCount || profile.following || 0;
    const posts = profile.postsCount || profile.posts || 0;
    const engagement = profile.engagementRate || 0;
    const bio = profile.biography || profile.bio || '';

    // Busca dados anteriores para histórico
    const { data: existing } = await sb.from(TABLE).select('*').eq('ig_username', username).single();
    const history = existing?.history || [];

    // Adiciona snapshot ao histórico
    history.push({
      date: new Date().toISOString(),
      followers,
      following,
      posts,
      engagement,
    });

    // Mantém apenas últimos 52 snapshots (1 ano se semanal)
    if (history.length > 52) history.splice(0, history.length - 52);

    const { data, error } = await sb.from(TABLE).upsert({
      ig_username: username,
      display_name: profile.fullName || profile.name || username,
      last_followers: followers,
      last_following: following,
      last_posts: posts,
      last_engagement: engagement,
      last_bio: bio,
      history,
      checked_at: new Date().toISOString(),
    }, { onConflict: 'ig_username' }).select().single();

    if (error) throw new Error(error.message);

    log.ai.info({ username, followers, posts }, 'Competitor: Dados atualizados');

    return {
      username,
      displayName: profile.fullName || username,
      followers,
      following,
      posts,
      engagement,
      bio,
      previousFollowers: existing?.last_followers || 0,
      followerChange: followers - (existing?.last_followers || 0),
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    log.ai.error({ username, err: e.message }, 'Competitor: Erro no scrape');
    throw new Error(`Erro ao verificar @${username}: ${e.message}`);
  }
}

// ================================================================
// CHECK ALL — verifica todos os concorrentes
// ================================================================

export async function checkAllCompetitors() {
  const competitors = await listCompetitors();
  if (competitors.length === 0) return 'Nenhum concorrente cadastrado.';

  const results = [];
  for (const comp of competitors) {
    try {
      const result = await checkCompetitor(comp.ig_username);
      results.push(result);
      // Delay entre requests para evitar rate limit
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      results.push({ username: comp.ig_username, error: e.message });
    }
  }
  return results;
}

// ================================================================
// COMPARAR COM EASY4U
// ================================================================

export async function compareWithEasy4u() {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  // Busca dados da Easy4u
  let easy4uData;
  try {
    const profiles = await scrapeInstagramProfile(['suaeasy4u']);
    easy4uData = profiles?.[0] || null;
  } catch (e) {
    easy4uData = null;
  }

  const competitors = await listCompetitors();
  if (competitors.length === 0) return 'Nenhum concorrente cadastrado para comparação.';

  const easy4uFollowers = easy4uData?.followersCount || easy4uData?.followers || 0;
  const easy4uPosts = easy4uData?.postsCount || easy4uData?.posts || 0;
  const easy4uEngagement = easy4uData?.engagementRate || 0;

  let report = `📊 *COMPARATIVO CONCORRENTES vs EASY4U*\n\n`;
  report += `🏢 *@suaeasy4u*\n`;
  report += `  Seguidores: ${easy4uFollowers.toLocaleString('pt-BR')}\n`;
  report += `  Posts: ${easy4uPosts}\n`;
  report += `  Engajamento: ${easy4uEngagement.toFixed(2)}%\n\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const comp of competitors) {
    const diff = (comp.last_followers || 0) - easy4uFollowers;
    const arrow = diff > 0 ? '🔴' : '🟢';
    const change = comp.history?.length >= 2
      ? comp.last_followers - (comp.history[comp.history.length - 2]?.followers || comp.last_followers)
      : 0;
    const changeIcon = change > 0 ? `📈 +${change}` : change < 0 ? `📉 ${change}` : '➡️ 0';

    report += `🏪 *@${comp.ig_username}* (${comp.display_name || ''})\n`;
    report += `  Seguidores: ${(comp.last_followers || 0).toLocaleString('pt-BR')} ${arrow} ${diff > 0 ? '+' : ''}${diff.toLocaleString('pt-BR')} vs Easy4u\n`;
    report += `  Posts: ${comp.last_posts || 0}\n`;
    report += `  Engajamento: ${(comp.last_engagement || 0).toFixed(2)}%\n`;
    report += `  Tendência: ${changeIcon} seguidores\n`;
    report += `  Último check: ${comp.checked_at ? new Date(comp.checked_at).toLocaleDateString('pt-BR') : 'nunca'}\n\n`;
  }

  report += `🤖 _Análise gerada pela Zaya — Easy4u_`;

  return report;
}

// ================================================================
// SCHEDULER — check semanal automático
// ================================================================

export function startCompetitorScheduler() {
  function checkWeekly() {
    const now = new Date();
    const brTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const day = brTime.getDay(); // 3 = quarta
    const hour = brTime.getHours();
    const minute = brTime.getMinutes();

    if (day === 3 && hour === 10 && minute < 5) {
      log.ai.info('Competitor monitor: check semanal');
      checkAllCompetitors()
        .then(results => {
          if (io) {
            io.emit('zaya-proactive', {
              type: 'competitor_check',
              message: `Check semanal de concorrentes concluído: ${Array.isArray(results) ? results.length : 0} perfis verificados`,
              data: results,
            });
          }
        })
        .catch(e => log.ai.error({ err: e.message }, 'Competitor: Erro no check semanal'));
    }
  }

  // Checa a cada 5 minutos
  setInterval(checkWeekly, 5 * 60 * 1000);
  log.ai.info('Competitor scheduler iniciado (quarta 10h BRT)');
}
