// ================================================================
// APIFY — Scraping e extração de dados via Apify Platform
// Actors: Instagram, TikTok, YouTube, Google Maps, Web Crawler, etc.
// ================================================================
import { log } from '../logger.js';

const API_BASE = 'https://api.apify.com/v2';

function getToken() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN não configurado. Pegue em https://console.apify.com/settings/integrations');
  return token;
}

// Actors mais úteis (IDs oficiais do Apify Store)
// Marketplaces Brasil
const ACTORS = {
  instagram_profile: 'apify/instagram-profile-scraper',
  instagram_posts: 'apify/instagram-post-scraper',
  instagram_hashtag: 'apify/instagram-hashtag-scraper',
  instagram_comments: 'apify/instagram-comment-scraper',
  instagram_followers: 'apify/instagram-follower-count-scraper',
  tiktok_scraper: 'clockworks/free-tiktok-scraper',
  youtube_scraper: 'bernardo/youtube-scraper',
  google_maps: 'compass/crawler-google-places',
  google_search: 'apify/google-search-scraper',
  website_crawler: 'apify/website-content-crawler',
  facebook_posts: 'apify/facebook-posts-scraper',
  linkedin_profile: 'anchor/linkedin-profile-scraper',
  mercado_livre: 'karamelo/mercadolivre-scraper-brasil-portugues',
  shopee: 'gio21/shopee-scraper',
  amazon_br: 'viralanalyzer/amazon-brazil-intelligence',
  aliexpress: 'piotrv1001/aliexpress-listings-scraper',
  facebook_marketplace: 'apify/facebook-marketplace-scraper',
  twitter_scraper: 'quacker/twitter-scraper',
};

async function apiCall(path, method = 'GET', body = null) {
  const token = getToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Apify API ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

// Roda um actor e espera o resultado (sync)
async function runActorSync(actorId, input, timeout = 120) {
  const token = getToken();
  const url = `${API_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${token}&timeout=${timeout}`;

  log.ai.info({ actor: actorId, input: JSON.stringify(input).slice(0, 100) }, 'Apify: rodando actor');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Apify run falhou (${res.status}): ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  log.ai.info({ actor: actorId, results: Array.isArray(data) ? data.length : 1 }, 'Apify: resultado');
  return data;
}

// Roda actor async (pra jobs longos) — retorna runId pra checar depois
async function runActorAsync(actorId, input) {
  const data = await apiCall(`/acts/${encodeURIComponent(actorId)}/runs`, 'POST', input);
  return data.data;
}

// Checa status de um run
async function getRunStatus(runId) {
  const data = await apiCall(`/actor-runs/${runId}`);
  return data.data;
}

// Pega items do dataset de um run
async function getDatasetItems(datasetId, limit = 50) {
  const data = await apiCall(`/datasets/${datasetId}/items?limit=${limit}`);
  return data;
}

// ================================================================
// FUNÇÕES DE ALTO NÍVEL (usadas pela tool)
// ================================================================

export async function scrapeInstagramProfile(usernames) {
  const input = {
    usernames: Array.isArray(usernames) ? usernames : [usernames],
  };
  const data = await runActorSync(ACTORS.instagram_profile, input);
  return (data || []).map(p => ({
    username: p.username,
    fullName: p.fullName,
    bio: p.biography,
    followers: p.followersCount,
    following: p.followsCount,
    posts: p.postsCount,
    isVerified: p.verified,
    isPrivate: p.private,
    profilePic: p.profilePicUrl,
    externalUrl: p.externalUrl,
  }));
}

export async function scrapeInstagramPosts(url, limit = 20) {
  const input = { directUrls: [url], resultsLimit: limit };
  const data = await runActorSync(ACTORS.instagram_posts, input, 180);
  return (data || []).map(p => ({
    type: p.type,
    caption: (p.caption || '').slice(0, 200),
    likes: p.likesCount,
    comments: p.commentsCount,
    date: p.timestamp,
    url: p.url,
    imageUrl: p.displayUrl,
    videoUrl: p.videoUrl,
    hashtags: p.hashtags,
  }));
}

export async function scrapeInstagramHashtag(hashtag, limit = 30) {
  const input = { hashtags: [hashtag.replace('#', '')], resultsLimit: limit };
  const data = await runActorSync(ACTORS.instagram_hashtag, input, 180);
  return (data || []).slice(0, limit).map(p => ({
    caption: (p.caption || '').slice(0, 150),
    likes: p.likesCount,
    comments: p.commentsCount,
    url: p.url,
    imageUrl: p.displayUrl,
  }));
}

export async function scrapeTikTok(query, limit = 20) {
  const input = {
    searchQueries: [query],
    resultsPerPage: limit,
    shouldDownloadVideos: false,
  };
  const data = await runActorSync(ACTORS.tiktok_scraper, input, 120);
  return (data || []).slice(0, limit).map(v => ({
    description: (v.text || '').slice(0, 200),
    author: v.authorMeta?.name || v.author,
    likes: v.diggCount || v.likes,
    comments: v.commentCount || v.comments,
    shares: v.shareCount || v.shares,
    views: v.playCount || v.views,
    url: v.webVideoUrl || v.url,
    music: v.musicMeta?.musicName,
    hashtags: v.hashtags?.map(h => h.name),
  }));
}

export async function scrapeYouTube(query, limit = 10) {
  const input = {
    searchKeywords: query,
    maxResults: limit,
  };
  const data = await runActorSync(ACTORS.youtube_scraper, input, 120);
  return (data || []).slice(0, limit).map(v => ({
    title: v.title,
    channel: v.channelName,
    views: v.viewCount,
    likes: v.likes,
    date: v.date || v.uploadDate,
    url: v.url,
    duration: v.duration,
    description: (v.description || '').slice(0, 200),
  }));
}

export async function scrapeGoogleMaps(query, location, limit = 20) {
  const input = {
    searchStringsArray: [query],
    locationQuery: location || 'Brazil',
    maxCrawledPlacesPerSearch: limit,
    language: 'pt-BR',
  };
  const data = await runActorSync(ACTORS.google_maps, input, 180);
  return (data || []).slice(0, limit).map(p => ({
    name: p.title,
    rating: p.totalScore,
    reviews: p.reviewsCount,
    address: p.address,
    phone: p.phone,
    website: p.website,
    category: p.categoryName,
    hours: p.openingHours,
    location: p.location,
    url: p.url,
  }));
}

export async function scrapeGoogleSearch(query, limit = 10) {
  const input = {
    queries: query,
    maxPagesPerQuery: 1,
    resultsPerPage: limit,
    languageCode: 'pt-br',
    countryCode: 'br',
  };
  const data = await runActorSync(ACTORS.google_search, input, 60);
  return (data || []).slice(0, limit).map(r => ({
    title: r.title,
    url: r.url,
    description: r.description,
    position: r.position,
  }));
}

export async function scrapeWebsite(url, limit = 10) {
  const input = {
    startUrls: [{ url }],
    maxCrawlPages: limit,
    crawlerType: 'cheerio',
  };
  const data = await runActorSync(ACTORS.website_crawler, input, 120);
  return (data || []).slice(0, limit).map(p => ({
    url: p.url,
    title: p.metadata?.title,
    text: (p.text || '').slice(0, 2000),
  }));
}

export async function scrapeFacebook(url, limit = 20) {
  const input = { startUrls: [{ url }], resultsLimit: limit };
  const data = await runActorSync(ACTORS.facebook_posts, input, 120);
  return (data || []).slice(0, limit).map(p => ({
    text: (p.text || '').slice(0, 200),
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    date: p.time,
    url: p.url,
    type: p.type,
  }));
}

export async function scrapeTwitter(query, limit = 20) {
  const input = { searchTerms: [query], maxTweets: limit };
  const data = await runActorSync(ACTORS.twitter_scraper, input, 120);
  return (data || []).slice(0, limit).map(t => ({
    text: (t.full_text || t.text || '').slice(0, 280),
    author: t.user?.screen_name,
    likes: t.favorite_count,
    retweets: t.retweet_count,
    date: t.created_at,
    url: t.url,
  }));
}

// ================================================================
// MARKETPLACES
// ================================================================

export async function scrapeMercadoLivre(keyword, limit = 20) {
  const data = await runActorSync(ACTORS.mercado_livre, { keyword, maxItems: limit }, 90);
  return (data || []).slice(0, limit).map(p => ({
    nome: p.eTituloProduto || p.title,
    preco: p.novoPreco || p.price,
    precoAnterior: p.precoAnterior,
    desconto: p.precoDiscount,
    frete: p.envio,
    destaque: p.highlight,
    vendedor: p.Vendedor || p.seller,
    imagem: p.imagemLink,
    link: p.zProdutoLink || p.url,
    sku: p.SKU,
    categoria: p.produtoDomainID,
    promocao: p.promocoes,
    variantes: p.disponivelEm,
  }));
}

export async function scrapeShopee(keyword, limit = 20) {
  const data = await runActorSync(ACTORS.shopee, { keyword, limit }, 90);
  return (data || []).slice(0, limit).map(p => ({
    nome: p.name || p.title || p.item_name,
    preco: p.price || p.final_price,
    vendidos: p.sold || p.historical_sold || p.sales,
    avaliacao: p.rating || p.item_rating,
    loja: p.shop_name || p.seller,
    link: p.url || p.link,
    imagem: p.image || p.img,
    localizacao: p.shop_location || p.location,
  }));
}

export async function scrapeAmazonBR(keyword, limit = 20) {
  const data = await runActorSync(ACTORS.amazon_br, { keyword, maxItems: limit }, 90);
  return (data || []).slice(0, limit).map(p => ({
    nome: p.title || p.name,
    preco: p.price || p.current_price,
    avaliacao: p.rating || p.stars,
    reviews: p.reviewsCount || p.reviews,
    prime: p.isPrime || p.prime,
    link: p.url || p.link,
    imagem: p.image || p.thumbnail,
    vendedor: p.seller,
  }));
}

export async function scrapeAliExpress(keyword, limit = 20) {
  const data = await runActorSync(ACTORS.aliexpress, { searchTerms: [keyword], maxItems: limit }, 90);
  return (data || []).slice(0, limit).map(p => ({
    nome: p.title || p.name,
    preco: p.price || p.salePrice,
    pedidos: p.orders || p.totalOrders,
    avaliacao: p.rating || p.stars,
    frete: p.shipping || p.freeShipping ? 'Gratis' : '',
    loja: p.storeName || p.seller,
    link: p.url || p.link,
    imagem: p.image || p.imageUrl,
  }));
}

// Genérico: roda qualquer actor por ID
export async function runCustomActor(actorId, input, timeout = 120) {
  return await runActorSync(actorId, input, timeout);
}

export { ACTORS };
