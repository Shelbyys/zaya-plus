import puppeteer from 'puppeteer-core';
import { CHROME_PATH, CHROME_PROFILE, TMP_DIR } from '../config.js';
import { getSupabase } from './supabase.js';
import { log } from '../logger.js';
import db from '../database.js';

// Criar tabela local SQLite
db.exec(`
  CREATE TABLE IF NOT EXISTS ig_ad_followers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ig_username TEXT NOT NULL,
    ig_id TEXT,
    date TEXT NOT NULL,
    followers_from_ads INTEGER DEFAULT 0,
    followers_organic INTEGER DEFAULT 0,
    followers_total INTEGER DEFAULT 0,
    follower_usernames TEXT DEFAULT '{}',
    screenshot_urls TEXT DEFAULT '[]',
    raw_ai_response TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(ig_username, date)
  );
`);
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

// ================================================================
// INSTAGRAM FOLLOWERS SCRAPER
// Abre Instagram, vai em notificações, tira prints,
// usa IA para contar seguidores vindos de anúncios
// ================================================================

const SCREENSHOTS_DIR = join(TMP_DIR, 'ig-screenshots');
const IG_SESSION_DIR = join(TMP_DIR, 'ig-chrome-profile');
const INSTAGRAM_URL = 'https://www.instagram.com';

if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (!existsSync(IG_SESSION_DIR)) mkdirSync(IG_SESSION_DIR, { recursive: true });

// ================================================================
// INICIALIZAR TABELA NO SUPABASE
// ================================================================
export async function initFollowersTable() {
  const sb = getSupabase();
  if (!sb) return;

  try {
    // Tenta inserir e deletar para verificar se a tabela existe
    const { error } = await sb.from('ig_ad_followers').select('id').limit(1);
    if (error && error.code === '42P01') {
      log.db.info('Tabela ig_ad_followers não existe, precisa criar manualmente no Supabase');
    }
  } catch (e) {
    log.db.warn({ err: e.message }, 'Verificação ig_ad_followers');
  }
}

// SQL para criar a tabela no Supabase (rodar manualmente):
/*
CREATE TABLE IF NOT EXISTS ig_ad_followers (
  id BIGSERIAL PRIMARY KEY,
  ig_username TEXT NOT NULL,
  ig_id TEXT,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  followers_from_ads INTEGER DEFAULT 0,
  followers_organic INTEGER DEFAULT 0,
  followers_total INTEGER DEFAULT 0,
  follower_usernames JSONB DEFAULT '[]',
  screenshot_urls JSONB DEFAULT '[]',
  raw_ai_response TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ig_username, date)
);

CREATE INDEX idx_ig_followers_date ON ig_ad_followers(date);
CREATE INDEX idx_ig_followers_username ON ig_ad_followers(ig_username);

ALTER TABLE ig_ad_followers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service access" ON ig_ad_followers FOR ALL USING (true);
*/

// ================================================================
// ABRIR BROWSER COM PERFIL LOGADO
// ================================================================
const IG_SESSION_ID = process.env.IG_SESSION_ID || '';

async function launchBrowser() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--window-size=430,932'
    ],
    defaultViewport: { width: 430, height: 932, isMobile: true, hasTouch: true }
  });
  return { browser, connected: false };
}

async function injectSession(page) {
  const sid = IG_SESSION_ID;
  if (!sid) {
    log.server.warn('IG_SESSION_ID não configurado no .env');
    return false;
  }
  await page.setCookie(
    { name: 'sessionid', value: sid, domain: '.instagram.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
    { name: 'ds_user_id', value: sid.split(':')[0], domain: '.instagram.com', path: '/', secure: true, sameSite: 'None' }
  );
  return true;
}

// ================================================================
// VERIFICAR LOGIN / FAZER LOGIN
// ================================================================
async function ensureLoggedIn(page, username) {
  await page.goto(`${INSTAGRAM_URL}/`, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Verificar se está logado
  const url = page.url();
  const isLoggedIn = !url.includes('/accounts/login');

  if (!isLoggedIn) {
    log.server.warn('Instagram não está logado. Faça login manualmente primeiro.');
    return false;
  }

  // Verificar se está na conta certa
  try {
    // Fechar popups/modais que aparecem
    const closeButtons = await page.$$('[aria-label="Close"], [aria-label="Fechar"], button:has-text("Agora não")');
    for (const btn of closeButtons) {
      try { await btn.click(); await new Promise(r => setTimeout(r, 1000)); } catch(e) {}
    }
  } catch(e) {}

  return true;
}

// ================================================================
// NAVEGAR PARA NOTIFICAÇÕES E TIRAR SCREENSHOTS
// ================================================================
async function scrapeNotifications(page) {
  const screenshots = [];

  // Ir para a página de notificações
  // No mobile, clicar no ícone de coração/notificação
  await page.goto(`${INSTAGRAM_URL}/accounts/activity/`, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Fechar TODOS os modais/popups
  for (let attempt = 0; attempt < 5; attempt++) {
    const closed = await page.evaluate(() => {
      // Procurar qualquer botão com texto "Agora não", "Not Now", "Ahora no"
      const buttons = document.querySelectorAll('button, div[role="button"], a[role="button"]');
      for (const btn of buttons) {
        const t = (btn.textContent || '').trim().toLowerCase();
        if (t === 'agora não' || t === 'not now' || t === 'ahora no' || t === 'cancel' || t === 'cancelar') {
          btn.click();
          return 'clicked: ' + t;
        }
      }
      // Procurar botão X de fechar
      const svgClose = document.querySelector('svg[aria-label="Close"], svg[aria-label="Fechar"]');
      if (svgClose) {
        const clickable = svgClose.closest('button') || svgClose.closest('[role="button"]') || svgClose.parentElement;
        if (clickable) { clickable.click(); return 'clicked: X'; }
      }
      // Procurar div com role dialog e fechar
      const dialog = document.querySelector('div[role="dialog"]');
      if (dialog) {
        const xBtn = dialog.querySelector('button, [role="button"]');
        if (xBtn) { xBtn.click(); return 'clicked: dialog btn'; }
      }
      return null;
    });
    if (closed) {
      log.server.info({ closed }, 'Modal fechado');
      await new Promise(r => setTimeout(r, 2000));
    } else {
      break;
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  // Tirar screenshot da primeira tela
  const ss1 = join(SCREENSHOTS_DIR, `notif_${Date.now()}_1.png`);
  await page.screenshot({ path: ss1, fullPage: false });
  screenshots.push(ss1);

  // Scroll e tirar mais screenshots para pegar mais notificações
  for (let i = 2; i <= 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await new Promise(r => setTimeout(r, 2000));

    const ssPath = join(SCREENSHOTS_DIR, `notif_${Date.now()}_${i}.png`);
    await page.screenshot({ path: ssPath, fullPage: false });
    screenshots.push(ssPath);
  }

  return screenshots;
}

// ================================================================
// ANALISAR SCREENSHOTS COM IA
// ================================================================
async function analyzeScreenshots(screenshots) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Converter screenshots para base64
  const imageContents = screenshots.map(path => {
    const data = readFileSync(path);
    return {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') }
    };
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        ...imageContents,
        {
          type: 'text',
          text: `Analise estas screenshots de notificações do Instagram.

TAREFA: Conte TODOS os seguidores que vieram de anúncios.
Procure por notificações que dizem "começou a seguir você no seu anúncio" ou "started following you from your ad".

Retorne um JSON válido (sem markdown, sem backticks) com esta estrutura exata:
{
  "followers_from_ads": <número total de seguidores que vieram de anúncios>,
  "followers_organic": <número de seguidores orgânicos, que dizem apenas "começou a seguir você" sem mencionar anúncio>,
  "usernames_from_ads": ["username1", "username2", ...],
  "usernames_organic": ["username1", "username2", ...],
  "total_notifications_analyzed": <número total de notificações visíveis>
}

IMPORTANTE:
- Conte CADA username individualmente
- "no seu anúncio" = veio de ads
- Apenas "começou a seguir você" sem "anúncio" = orgânico
- Se não conseguir ler, retorne zeros
- Retorne APENAS o JSON, nada mais`
        }
      ]
    }]
  });

  const text = response.content?.[0]?.text?.trim() || '{}';

  // Limpar possíveis backticks
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    log.server.error({ err: e.message, raw: text }, 'Erro ao parsear resposta da IA');
    return {
      followers_from_ads: 0,
      followers_organic: 0,
      usernames_from_ads: [],
      usernames_organic: [],
      total_notifications_analyzed: 0,
      raw: text
    };
  }
}

// ================================================================
// SALVAR NO SUPABASE
// ================================================================
async function saveData(igUsername, igId, data, screenshotUrls) {
  const today = new Date().toISOString().split('T')[0];
  const usernames = JSON.stringify({
    from_ads: data.usernames_from_ads || [],
    organic: data.usernames_organic || []
  });
  const screenshotsJson = JSON.stringify(screenshotUrls || []);
  const rawResponse = JSON.stringify(data);
  const totalFollowers = (data.followers_from_ads || 0) + (data.followers_organic || 0);

  // Salvar no SQLite (sempre funciona)
  try {
    db.prepare(`INSERT OR REPLACE INTO ig_ad_followers
      (ig_username, ig_id, date, followers_from_ads, followers_organic, followers_total, follower_usernames, screenshot_urls, raw_ai_response)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(igUsername, igId || null, today, data.followers_from_ads || 0, data.followers_organic || 0, totalFollowers, usernames, screenshotsJson, rawResponse);
    log.server.info({ username: igUsername, ads: data.followers_from_ads, organic: data.followers_organic }, 'Dados salvos no SQLite');
  } catch (e) {
    log.server.error({ err: e.message }, 'Erro ao salvar no SQLite');
  }

  // Tentar salvar no Supabase também
  const sb = getSupabase();
  if (sb) {
    try {
      await sb.from('ig_ad_followers').upsert({
        ig_username: igUsername, ig_id: igId || null, date: today,
        followers_from_ads: data.followers_from_ads || 0,
        followers_organic: data.followers_organic || 0,
        followers_total: totalFollowers,
        follower_usernames: { from_ads: data.usernames_from_ads || [], organic: data.usernames_organic || [] },
        screenshot_urls: screenshotUrls || [],
        raw_ai_response: rawResponse
      }, { onConflict: 'ig_username,date' });
    } catch (e) {
      // Tabela pode não existir no Supabase ainda — sem problema, SQLite é o fallback
    }
  }

  return true;
}

// ================================================================
// UPLOAD SCREENSHOTS PARA SUPABASE STORAGE
// ================================================================
async function uploadScreenshots(screenshots, igUsername) {
  const sb = getSupabase();
  if (!sb) return [];

  const urls = [];
  const today = new Date().toISOString().split('T')[0];

  for (let i = 0; i < screenshots.length; i++) {
    try {
      const data = readFileSync(screenshots[i]);
      const fileName = `ig-followers/${igUsername}/${today}_${i + 1}.png`;

      const { error } = await sb.storage
        .from('zaya-files')
        .upload(fileName, data, { contentType: 'image/png', upsert: true });

      if (!error) {
        const { data: urlData } = sb.storage
          .from('zaya-files')
          .getPublicUrl(fileName);
        urls.push(urlData.publicUrl);
      }
    } catch (e) {
      log.server.warn({ err: e.message }, 'Erro upload screenshot');
    }
  }

  return urls;
}

// ================================================================
// FUNÇÃO PRINCIPAL - SCRAPE DE UM PERFIL
// ================================================================
export async function scrapeIGFollowers(igUsername, igId) {
  log.server.info({ username: igUsername }, 'Iniciando scrape de seguidores IG');

  let browser, connected = false;
  try {
    const launch = await launchBrowser();
    browser = launch.browser;
    connected = launch.connected;
    const page = connected ? (await browser.pages())[0] || await browser.newPage() : await browser.newPage();

    // Configurar user agent mobile
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');

    // Injetar cookie de sessão
    const hasSession = await injectSession(page);
    if (!hasSession) {
      return { success: false, error: 'IG_SESSION_ID não configurado no .env' };
    }

    // Verificar login
    const loggedIn = await ensureLoggedIn(page, igUsername);
    if (!loggedIn) {
      return { success: false, error: 'Sessão expirada. Atualize o IG_SESSION_ID no .env' };
    }

    // Tirar screenshots das notificações
    const screenshots = await scrapeNotifications(page);
    log.server.info({ count: screenshots.length }, 'Screenshots capturados');

    // Analisar com IA
    const analysis = await analyzeScreenshots(screenshots);
    log.server.info({
      ads: analysis.followers_from_ads,
      organic: analysis.followers_organic,
      total: analysis.total_notifications_analyzed
    }, 'Análise de seguidores concluída');

    // Upload screenshots
    const screenshotUrls = await uploadScreenshots(screenshots, igUsername);

    // Salvar dados
    const saved = await saveData(igUsername, igId, analysis, screenshotUrls);

    // Só fecha se abriu novo, não se conectou ao existente
    if (!connected) await browser.close();

    return {
      success: true,
      date: new Date().toISOString().split('T')[0],
      username: igUsername,
      followers_from_ads: analysis.followers_from_ads,
      followers_organic: analysis.followers_organic,
      usernames_from_ads: analysis.usernames_from_ads,
      usernames_organic: analysis.usernames_organic,
      total_analyzed: analysis.total_notifications_analyzed,
      screenshots: screenshotUrls,
      saved: !!saved
    };
  } catch (e) {
    log.server.error({ err: e.message }, 'Erro no scrape de seguidores');
    if (browser && !connected) try { await browser.close(); } catch(ex) {}
    return { success: false, error: e.message };
  }
}

// ================================================================
// SCRAPE TODOS OS PERFIS
// ================================================================
export async function scrapeAllProfiles(profiles) {
  const results = [];
  for (const profile of profiles) {
    const result = await scrapeIGFollowers(profile.username, profile.id);
    results.push(result);
    // Esperar entre perfis para não ser bloqueado
    await new Promise(r => setTimeout(r, 5000));
  }
  return results;
}

// ================================================================
// BUSCAR HISTÓRICO DO SUPABASE
// ================================================================
export async function getFollowersHistory(igUsername, days = 30) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split('T')[0];

    const rows = db.prepare(`SELECT * FROM ig_ad_followers WHERE ig_username = ? AND date >= ? ORDER BY date DESC`)
      .all(igUsername, sinceStr);

    // Parse JSON fields
    return rows.map(r => ({
      ...r,
      follower_usernames: JSON.parse(r.follower_usernames || '{}'),
      screenshot_urls: JSON.parse(r.screenshot_urls || '[]')
    }));
  } catch (e) {
    log.server.error({ err: e.message }, 'Erro ao buscar histórico');
    return [];
  }
}

// ================================================================
// BUSCAR RESUMO DE TODOS OS PERFIS
// ================================================================
export async function getFollowersSummary() {
  try {
    return db.prepare(`SELECT ig_username, date, followers_from_ads, followers_organic, followers_total FROM ig_ad_followers ORDER BY date DESC LIMIT 100`).all();
  } catch (e) {
    return [];
  }
}

export default {
  scrapeIGFollowers,
  scrapeAllProfiles,
  getFollowersHistory,
  getFollowersSummary,
  initFollowersTable
};
