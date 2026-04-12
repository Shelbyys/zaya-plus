// ================================================================
// PINTEREST — Busca referências visuais no Pinterest
// Usa Puppeteer (Chrome do usuário) pra acessar e extrair imagens
// ================================================================
import { log } from '../logger.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { TMP_DIR } from '../config.js';
import { ensureChromeDebug, injectCookies } from './chrome.js';

/**
 * Busca pins no Pinterest por termo.
 * Retorna array de { url, imageUrl, title }
 */
export async function buscarPinterest(query, limit = 8) {
  log.ai.info({ query, limit }, 'Pinterest: buscando referências');

  let browser, page;
  try {
    browser = await ensureChromeDebug();
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Injeta cookies do Pinterest se tiver
    try { await injectCookies(page, 'pinterest.com'); } catch {}

    const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000)); // espera renderizar

    // Scroll pra carregar mais pins
    await page.evaluate(() => window.scrollBy(0, 1500));
    await new Promise(r => setTimeout(r, 2000));

    // Extrai imagens dos pins
    const pins = await page.evaluate((maxPins) => {
      const results = [];
      const imgs = document.querySelectorAll('img[src*="pinimg.com"]');
      for (const img of imgs) {
        if (results.length >= maxPins) break;
        let src = img.src || '';
        // Converte pra resolução maior
        src = src.replace(/\/\d+x\//g, '/736x/');
        if (src.includes('75x75') || src.includes('50x50')) continue; // skip thumbnails
        const alt = img.alt || '';
        const pin = img.closest('a');
        const href = pin ? pin.href : '';
        if (src && !results.find(r => r.imageUrl === src)) {
          results.push({ imageUrl: src, title: alt.slice(0, 100), url: href });
        }
      }
      return results;
    }, limit);

    log.ai.info({ found: pins.length, query }, 'Pinterest: pins encontrados');
    await page.close();
    return pins;
  } catch (e) {
    log.ai.error({ err: e.message }, 'Pinterest: erro na busca');
    if (page) try { await page.close(); } catch {}
    return [];
  }
}

/**
 * Baixa imagens dos pins pra /tmp
 */
export async function baixarPins(pins, maxDownload = 5) {
  const dir = join(TMP_DIR, 'pinterest');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const downloaded = [];
  for (let i = 0; i < Math.min(pins.length, maxDownload); i++) {
    try {
      const res = await fetch(pins[i].imageUrl);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5000) continue; // skip tiny
      const path = join(dir, `pin_${Date.now()}_${i}.jpg`);
      writeFileSync(path, buf);
      downloaded.push({ ...pins[i], localPath: path, size: buf.length });
    } catch {}
  }

  log.ai.info({ downloaded: downloaded.length }, 'Pinterest: imagens baixadas');
  return downloaded;
}

/**
 * Busca + baixa + analisa com GPT-4o Vision pra extrair estilo
 */
export async function buscarReferencias(query, limit = 6) {
  const pins = await buscarPinterest(query, limit);
  if (pins.length === 0) {
    // Fallback: busca via fetch simples (sem Puppeteer)
    return await buscarPinterestSimples(query, limit);
  }
  const downloaded = await baixarPins(pins, limit);
  return downloaded;
}

/**
 * Fallback: busca Pinterest sem Puppeteer (menos resultados)
 */
async function buscarPinterestSimples(query, limit = 6) {
  log.ai.info({ query }, 'Pinterest: fallback simples (sem Puppeteer)');
  try {
    const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    const html = await res.text();

    // Extrai URLs de imagens
    const matches = html.match(/https:\/\/i\.pinimg\.com\/[^"'\s\\]+/g) || [];
    const unique = [...new Set(matches)]
      .filter(u => !u.includes('75x75') && !u.includes('50x50') && u.length > 40)
      .map(u => u.replace(/\/\d+x\//g, '/736x/'))
      .slice(0, limit);

    if (unique.length === 0) return [];

    const dir = join(TMP_DIR, 'pinterest');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const results = [];
    for (let i = 0; i < unique.length; i++) {
      try {
        const imgRes = await fetch(unique[i]);
        if (!imgRes.ok) continue;
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.length < 5000) continue;
        const path = join(dir, `pin_simple_${Date.now()}_${i}.jpg`);
        writeFileSync(path, buf);
        results.push({ imageUrl: unique[i], localPath: path, title: '', size: buf.length });
      } catch {}
    }
    return results;
  } catch (e) {
    log.ai.warn({ err: e.message }, 'Pinterest fallback falhou');
    return [];
  }
}
