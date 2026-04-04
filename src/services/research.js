import { writeFileSync } from 'fs';
import { join } from 'path';
import { PESQUISAS_DIR, AI_MODEL } from '../config.js';
import { openai } from '../state.js';
import { log } from '../logger.js';

async function webSearch(query, limit = 8) {
  const results = [];
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    const html = await r.text();
    const regex = /<a rel="nofollow" class="result__a" href="([^"]+)">(.+?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>(.+?)<\/a>/g;
    let m;
    while ((m = regex.exec(html)) && results.length < limit) {
      results.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, ''), snippet: m[3].replace(/<[^>]+>/g, '') });
    }
  } catch (e) { log.research.warn({ err: e.message }, 'Search falhou'); }
  return results;
}

async function scrapeUrl(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return '';
    return (await r.text()).replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000);
  } catch { return ''; }
}

export async function doResearch(query) {
  const ts = Date.now();
  const slug = query.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_').slice(0, 50).toLowerCase();
  const filename = `pesquisa_${slug}_${ts}.md`;
  const filepath = join(PESQUISAS_DIR, filename);

  log.research.info(`[Pesquisa] Iniciando: "${query}"`);
  try {
    const results = await webSearch(query, 8);
    log.research.info(`${results.length} resultados`);

    const scraped = [];
    for (const r of results.slice(0, 3)) {
      const t = await scrapeUrl(r.url);
      if (t.length > 100) scraped.push({ url: r.url, title: r.title, content: t.slice(0, 3000) });
    }

    let ctx = results.map(r => `- ${r.title}: ${r.snippet} (${r.url})`).join('\n');
    if (scraped.length) ctx += '\n\n' + scraped.map(s => `--- ${s.title} ---\n${s.content}`).join('\n\n');

    const res = await openai.chat.completions.create({
      model: AI_MODEL, max_tokens: 4096,
      messages: [
        { role: 'system', content: 'Crie relatório COMPLETO em português brasileiro. Tópicos, dados concretos.' },
        { role: 'user', content: `PESQUISA: "${query}"\n\n${ctx}\n\n# ${query}\n**Data:** ${new Date().toLocaleDateString('pt-BR')}` },
      ],
    });

    const content = res.choices[0].message.content || '';
    writeFileSync(filepath, content);
    return { success: true, content, filepath, filename, summary: content.slice(0, 3000) };
  } catch (e) {
    log.research.error({ err: e.message }, 'Erro pesquisa');
    return { success: false, content: '', filepath: '', filename: '', summary: `Erro: ${e.message}` };
  }
}
