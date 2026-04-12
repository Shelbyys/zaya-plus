// ================================================================
// BRAND PATTERNS — Aprende padrões visuais dos posts publicados
// Salva cada post no Supabase e constrói perfil de estilo
// ================================================================
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { log } from '../logger.js';

let sb = null;
function getSb() {
  if (!sb && SUPABASE_URL && SUPABASE_KEY) sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

let cachedPattern = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function savePublishedPost(data) {
  const s = getSb();
  if (!s) return;

  const row = {
    brand: data.brand || 'easy4u',
    estilo: data.estilo || '',
    formato: data.formato || '',
    cor: data.cor || '',
    texto1: data.texto1 || '',
    texto2: data.texto2 || '',
    texto3: data.texto3 || '',
    subtexto: data.subtexto || '',
    tag: data.tag || '',
    imagem_prompt: data.imagemPrompt || '',
    logo_variante: data.logoVariante || 'selo',
    caption: data.caption || '',
    image_url: data.imageUrl || '',
    ig_post_id: data.igPostId || '',
    ig_account: data.igAccount || 'easy4u',
    post_type: data.postType || 'story',
  };

  try {
    const { error } = await s.from('brand_posts').insert(row);
    if (error) log.ai.warn({ err: error.message }, 'BrandPatterns: erro ao salvar');
    else {
      log.ai.info({ estilo: row.estilo, tipo: row.post_type }, 'BrandPatterns: post salvo');
      cachedPattern = null;
    }
  } catch (e) {
    log.ai.warn({ err: e.message }, 'BrandPatterns: falha no insert');
  }
}

export async function getPattern(brand = 'easy4u') {
  if (cachedPattern && Date.now() - cacheTime < CACHE_TTL) return cachedPattern;

  const s = getSb();
  if (!s) return null;

  try {
    const { data: posts } = await s.from('brand_posts')
      .select('estilo, formato, cor, texto1, texto2, texto3, subtexto, tag, imagem_prompt, logo_variante, post_type, caption')
      .eq('brand', brand)
      .order('posted_at', { ascending: false })
      .limit(30);

    if (!posts || posts.length === 0) return null;

    const estilos = {};
    const formatos = {};
    const cores = {};
    const tags = {};
    const logos = {};
    const tipos = {};
    const frases = [];
    const prompts = [];
    const captions = [];

    for (const p of posts) {
      if (p.estilo) estilos[p.estilo] = (estilos[p.estilo] || 0) + 1;
      if (p.formato) formatos[p.formato] = (formatos[p.formato] || 0) + 1;
      if (p.cor) cores[p.cor] = (cores[p.cor] || 0) + 1;
      if (p.tag) tags[p.tag] = (tags[p.tag] || 0) + 1;
      if (p.logo_variante) logos[p.logo_variante] = (logos[p.logo_variante] || 0) + 1;
      if (p.post_type) tipos[p.post_type] = (tipos[p.post_type] || 0) + 1;
      if (p.texto1 || p.texto2 || p.texto3) {
        frases.push({ t1: p.texto1, t2: p.texto2, t3: p.texto3, sub: p.subtexto });
      }
      if (p.imagem_prompt) prompts.push(p.imagem_prompt);
      if (p.caption) captions.push(p.caption);
    }

    const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v}x)`);

    const pattern = {
      totalPosts: posts.length,
      estiloFavorito: top(estilos)[0] || 'clean',
      formatoFavorito: top(formatos)[0] || 'story',
      corFavorita: top(cores)[0] || 'preto',
      estilos: top(estilos),
      formatos: top(formatos),
      cores: top(cores),
      tags: top(tags),
      logos: top(logos),
      tipos: top(tipos),
      ultimasFrases: frases.slice(0, 5),
      ultimosPrompts: prompts.slice(0, 3),
      ultimasCaptions: captions.slice(0, 3),
    };

    cachedPattern = pattern;
    cacheTime = Date.now();
    return pattern;
  } catch (e) {
    log.ai.warn({ err: e.message }, 'BrandPatterns: falha ao carregar');
    return null;
  }
}

export function formatPatternForPrompt(pattern) {
  if (!pattern || pattern.totalPosts === 0) return '';

  let text = `\n\nPADRÃO APRENDIDO DA EASY4U (${pattern.totalPosts} posts já publicados no Instagram):\n`;
  text += `MODELOS JÁ USADOS (mostre estes como opções ao criar):\n`;

  // Lista estilos como opções numeradas com contagem
  for (let i = 0; i < pattern.estilos.length; i++) {
    const descMap = {
      'pessoa': 'Pessoa realista IA (NanoBanana) + texto na área inferior',
      'clean': 'Fundo sólido preto/branco, só texto bold com linha laranja',
      'editorial': 'Tipografia grande estilo campanha/anúncio, fontes mistas',
      'minimalista': 'Objeto temático grande + texto bold',
      'chat': 'Balão de conversa WhatsApp + objeto na direita',
      'pergunta': 'Card central com ? no meio, fundo sólido',
    };
    const estilo = pattern.estilos[i].replace(/\(\d+x\)/, '').trim();
    const desc = descMap[estilo] || estilo;
    text += `  ${i+1}) ${pattern.estilos[i]} — ${desc}\n`;
  }

  text += `\nCONFIG MAIS FREQUENTE: estilo=${pattern.estiloFavorito} | formato=${pattern.formatoFavorito} | cor=${pattern.corFavorita}\n`;

  if (pattern.tags.length > 0) text += `Tags usadas: ${pattern.tags.join(', ')}\n`;

  if (pattern.ultimasFrases.length > 0) {
    text += `\nEXEMPLOS DE FRASES JÁ POSTADAS (use como referência de tom):\n`;
    for (const f of pattern.ultimasFrases.slice(0, 4)) {
      text += `  • "${f.t1}" / "${f.t2}" / "${f.t3}"${f.sub ? ` — ${f.sub}` : ''}\n`;
    }
  }

  if (pattern.ultimasCaptions.length > 0) {
    text += `EXEMPLOS DE CAPTIONS:\n`;
    for (const c of pattern.ultimasCaptions.slice(0, 2)) {
      text += `  • "${c.slice(0, 150)}"\n`;
    }
  }

  text += `\nUSE ESTES DADOS para apresentar os modelos já postados como opções numeradas ao criar conteúdo Easy4u.`;
  text += `\nSe ele disser "no padrão" → use: estilo=${pattern.estiloFavorito}, formato=${pattern.formatoFavorito}, cor=${pattern.corFavorita}`;

  return text;
}
