// ================================================================
// FLIGHT MONITOR — vigia promoções internacionais no Melhores Destinos
// Roda em cron 3x/dia. Dedupa via Supabase. Notifica via WaSender.
// ================================================================
import crypto from 'crypto';

const RSS_URL = 'https://www.melhoresdestinos.com.br/feed';
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_KEY || '';
const WA_KEY = process.env.WASENDER_API_KEY || '';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '5511936189388';
const MAX_PRICE = parseInt(process.env.FLIGHT_MAX_PRICE || '2500', 10);

const TABLE = 'promo_flights_seen';

// Cidades/estados/termos brasileiros — exclui do filtro internacional
const BR_KEYWORDS = [
  'são paulo', 'rio de janeiro', 'salvador', 'recife', 'fortaleza', 'natal',
  'maceió', 'joão pessoa', 'porto alegre', 'curitiba', 'belo horizonte',
  'brasília', 'manaus', 'belém', 'florianópolis', 'gramado', 'cabo frio',
  'búzios', 'paraty', 'ilhabela', 'campos do jordão', 'foz do iguaçu',
  'porto seguro', 'fernando de noronha', 'jericoacoara', 'pipa', 'morro de são paulo',
  'chapada', 'bonito', 'lençóis', 'maranhão', 'ceará', 'alagoas', 'bahia',
  'pernambuco', 'rio grande do norte', 'santa catarina', 'paraná', 'minas gerais',
  'maragogi', 'guarujá', 'ubatuba', 'goiânia', 'holambra', 'campinas',
  'costa do sauipe', 'olímpia', 'caldas novas', 'porto galinhas', 'rio quente',
  'nacionais', 'nacional', 'brasil', 'interior',
];

// ================================================================
// SUPABASE HELPERS
// ================================================================
const sbH = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

async function sbSelect(filter) {
  if (!SB_URL || !SB_KEY) return [];
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}?${filter}`, { headers: sbH });
  if (!r.ok) throw new Error(`Supabase select: ${r.status}`);
  return r.json();
}

async function sbInsert(body) {
  if (!SB_URL || !SB_KEY) return null;
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: { ...sbH, 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    if (r.status === 409) return null; // duplicata (UNIQUE constraint)
    throw new Error(`Supabase insert: ${r.status} ${txt.slice(0, 200)}`);
  }
  return r.json();
}

// ================================================================
// RSS PARSER — regex simples, sem dependência externa
// ================================================================
function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || '').trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
    const description = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || '').trim();
    if (title && link) items.push({ title, link, pubDate, description });
  }
  return items;
}

// ================================================================
// FILTROS
// ================================================================
function extractPrice(title) {
  // "R$ 1.173", "R$ 3.054", "R$ 637 por pessoa"
  const m = title.match(/R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)/);
  if (!m) return null;
  return parseInt(m[1].replace(/\./g, ''), 10);
}

function isPromoPost(link) {
  return /\/promocao\//i.test(link);
}

function isInternational(title) {
  const lower = title.toLowerCase();
  // Se tem alguma keyword BR explícita como destino primário → nacional
  // (o título geralmente começa com o destino)
  const first30 = lower.slice(0, 40);
  return !BR_KEYWORDS.some(kw => first30.includes(kw));
}

function mentionsSaoPaulo(title, description) {
  const t = (title + ' ' + description).toLowerCase();
  // Origem SP: menciona "saindo de SP" ou "SP" ou GRU/CGH/VCP OU não especifica origem (geralmente cobre várias cidades inclusive SP)
  if (/saindo de s[aã]o paulo|\b(gru|cgh|vcp)\b|de s[aã]o paulo/i.test(t)) return true;
  // Se menciona outra origem específica e NÃO SP, exclui
  const outrasOrigens = /saindo (?:de|do) (?:rio|recife|salvador|fortaleza|bras[ií]lia|bh|belo horizonte|curitiba|porto alegre|manaus|bel[eé]m)/i;
  if (outrasOrigens.test(t) && !/s[aã]o paulo|gru|cgh|vcp/i.test(t)) return false;
  return true; // default: assume que cobre SP
}

// ================================================================
// WASENDER
// ================================================================
async function sendWhatsApp(text) {
  if (!WA_KEY) {
    console.warn('[flight-monitor] WASENDER_API_KEY não configurada');
    return { success: false, error: 'no_key' };
  }
  try {
    const r = await fetch('https://www.wasenderapi.com/api/send-message', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: `${ADMIN_PHONE}@s.whatsapp.net`, text }),
    });
    const data = await r.json();
    return { success: !!data.success, data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ================================================================
// MAIN — busca, filtra, dedupa, notifica
// ================================================================
export async function checkPromos({ silent = false } = {}) {
  const startTs = Date.now();
  const result = { checked: 0, matched: 0, new: 0, sent: 0, errors: [] };

  try {
    const res = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (flight-monitor)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseRss(xml);
    result.checked = items.length;

    for (const item of items) {
      if (!isPromoPost(item.link)) continue;
      const price = extractPrice(item.title);
      if (!price || price > MAX_PRICE) continue;
      if (!isInternational(item.title)) continue;
      if (!mentionsSaoPaulo(item.title, item.description)) continue;

      result.matched++;

      // Dedup: já viu essa URL?
      const urlHash = crypto.createHash('md5').update(item.link).digest('hex');
      try {
        const existing = await sbSelect(`url_hash=eq.${urlHash}&select=id`);
        if (existing.length > 0) continue;
      } catch (e) {
        result.errors.push(`dedup-check: ${e.message}`);
        continue;
      }

      // Novo! Salva no Supabase
      const row = {
        url: item.link,
        url_hash: urlHash,
        title: item.title,
        price: price,
        price_text: `R$ ${price.toLocaleString('pt-BR')}`,
        pub_date: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      };
      try {
        await sbInsert(row);
        result.new++;
      } catch (e) {
        if (!e.message.includes('409')) result.errors.push(`insert: ${e.message}`);
        continue;
      }

      // Envia WhatsApp
      if (!silent) {
        const msg = `✈️ *Promoção internacional — Zaya achou!*\n\n*${item.title}*\n\n💰 R$ ${price.toLocaleString('pt-BR')} (≤ R$ ${MAX_PRICE.toLocaleString('pt-BR')} por pessoa)\n\n🔗 ${item.link}\n\n_Monitorando Melhores Destinos 3x/dia_`;
        const waRes = await sendWhatsApp(msg);
        if (waRes.success) {
          result.sent++;
          // Marca como enviada
          try {
            await fetch(`${SB_URL}/rest/v1/${TABLE}?url_hash=eq.${urlHash}`, {
              method: 'PATCH',
              headers: sbH,
              body: JSON.stringify({ sent_to_wa: true, sent_at: new Date().toISOString() }),
            });
          } catch {}
        } else {
          result.errors.push(`wasender: ${waRes.error || 'failed'}`);
        }
      }
    }
  } catch (e) {
    result.errors.push(`main: ${e.message}`);
  }

  result.elapsed_ms = Date.now() - startTs;
  console.log('[flight-monitor]', JSON.stringify(result));
  return result;
}

// ================================================================
// STARTER — cron 3x/dia (8h, 14h, 20h BRT — ajustado p/ UTC)
// BRT = UTC-3 → rodar em 11h, 17h, 23h UTC
// ================================================================
let started = false;
export function startFlightMonitor() {
  if (started) return;
  started = true;

  const CHECK_INTERVAL_MS = 1000 * 60 * 60 * 4; // 4h (6x/dia) — mais agressivo
  console.log('[flight-monitor] iniciado (check a cada 4h, max R$', MAX_PRICE, 'por pessoa)');

  // Primeiro check 30s após boot (silencioso pra não spammar boot)
  setTimeout(() => checkPromos({ silent: false }).catch(e => console.error('[flight-monitor] erro:', e)), 30000);
  setInterval(() => checkPromos({ silent: false }).catch(e => console.error('[flight-monitor] erro:', e)), CHECK_INTERVAL_MS);
}
