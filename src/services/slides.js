import { exec } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import { openai } from '../state.js';
import { AI_MODEL_MINI } from '../config.js';
import { messagesDB } from '../database.js';
import { log } from '../logger.js';

const PALETAS = {
  azul_executivo:    { dom: '#1B2A4A', sup: '#F0F4F8', ace: '#3B82F6', txt: '#6B7280', domHex: '1B2A4A', aceHex: '3B82F6' },
  verde_confianca:   { dom: '#1A3C34', sup: '#F5F7F2', ace: '#22C55E', txt: '#6B7280', domHex: '1A3C34', aceHex: '22C55E' },
  grafite_moderno:   { dom: '#2D2D2D', sup: '#F8F8F8', ace: '#F59E0B', txt: '#9CA3AF', domHex: '2D2D2D', aceHex: 'F59E0B' },
  terracota_elegante:{ dom: '#8B4513', sup: '#FFF8F0', ace: '#D97706', txt: '#9CA3AF', domHex: '8B4513', aceHex: 'D97706' },
  violeta_criativo:  { dom: '#4C1D95', sup: '#F5F3FF', ace: '#A78BFA', txt: '#9CA3AF', domHex: '4C1D95', aceHex: 'A78BFA' },
  oceano_profundo:   { dom: '#0C4A6E', sup: '#F0F9FF', ace: '#06B6D4', txt: '#6B7280', domHex: '0C4A6E', aceHex: '06B6D4' },
};

// ================================================================
// GERAR HTML (padrão) — slides acessíveis via link no navegador
// ================================================================
export async function createSlides(args) {
  const tema = args.tema;
  const publico = args.publico || 'geral';
  const numSlides = args.num_slides || 10;
  const paleta = args.paleta || 'azul_executivo';
  const topicos = args.topicos || '';
  const formato = args.formato || 'html';
  const cor = PALETAS[paleta] || PALETAS.azul_executivo;

  const outputDir = '/tmp/slides-' + Date.now();
  mkdirSync(outputDir, { recursive: true });

  try {
    // 1. Gerar conteúdo com IA
    const contentRes = await openai.chat.completions.create({
      model: AI_MODEL_MINI, max_tokens: 2500,
      messages: [
        { role: 'system', content: `Gere conteúdo para uma apresentação de ${numSlides} slides sobre "${tema}" para ${publico}. ${topicos ? 'Tópicos: ' + topicos + '.' : ''} Responda em JSON array: [{"titulo":"...","subtitulo":"...","bullets":["..."],"tipo":"capa|conteudo|kpi|encerramento","kpi_valor":"","kpi_label":""}]. Capa como primeiro, encerramento como último. Para slides KPI, coloque um número grande em kpi_valor. Bullets: máximo 4 itens curtos. Tudo em português brasileiro.` },
        { role: 'user', content: `Crie ${numSlides} slides sobre: ${tema}` },
      ],
    });

    let slidesData;
    const raw = contentRes.choices[0].message.content.trim();
    try {
      slidesData = JSON.parse(raw.replace(/```json?\n?/g, '').replace(/```/g, ''));
    } catch {
      return `Erro ao parsear conteúdo dos slides: ${raw.slice(0, 500)}`;
    }

    // 2. Se formato é pptx ou pdf, gera PPTX
    if (formato === 'pptx' || formato === 'pdf') {
      return await createPptx(tema, slidesData, paleta, publico, cor, outputDir, formato);
    }

    // 3. Padrão: gerar HTML com Reveal.js
    return await createHtmlSlides(tema, slidesData, paleta, publico, cor, outputDir);

  } catch (e) {
    return `Erro ao criar slides: ${e.message}`;
  }
}

// ================================================================
// HTML SLIDES (Reveal.js CDN) — abre no navegador
// ================================================================
async function createHtmlSlides(tema, slidesData, paleta, publico, cor, outputDir) {
  const slidesHtml = slidesData.map((s, i) => {
    if (s.tipo === 'capa') {
      return `<section data-background="${cor.dom}">
        <h1 style="color:#fff;font-size:2.5em;text-shadow:2px 2px 8px rgba(0,0,0,0.3)">${s.titulo}</h1>
        ${s.subtitulo ? `<h3 style="color:${cor.ace};font-weight:300">${s.subtitulo}</h3>` : ''}
        <p style="color:rgba(255,255,255,0.5);font-size:0.5em;margin-top:2em">${new Date().toLocaleDateString('pt-BR')} — ${publico}</p>
      </section>`;
    }
    if (s.tipo === 'encerramento') {
      return `<section data-background="${cor.dom}">
        <h2 style="color:#fff">${s.titulo}</h2>
        ${s.subtitulo ? `<p style="color:${cor.ace};font-size:0.9em">${s.subtitulo}</p>` : ''}
        ${s.bullets?.length ? `<ul style="color:rgba(255,255,255,0.8);font-size:0.7em;list-style:none">${s.bullets.map(b => `<li>✦ ${b}</li>`).join('')}</ul>` : ''}
      </section>`;
    }
    if (s.tipo === 'kpi' && s.kpi_valor) {
      return `<section data-background="${cor.sup}">
        <h3 style="color:${cor.dom};border-left:4px solid ${cor.ace};padding-left:16px">${s.titulo}</h3>
        <div style="font-size:4em;font-weight:700;color:${cor.ace};margin:0.3em 0">${s.kpi_valor}</div>
        <p style="color:${cor.txt};font-size:0.8em">${s.kpi_label || s.subtitulo || ''}</p>
        ${s.bullets?.length ? `<ul style="color:${cor.dom};font-size:0.6em;list-style:none;margin-top:1em">${s.bullets.map(b => `<li>→ ${b}</li>`).join('')}</ul>` : ''}
      </section>`;
    }
    // conteudo (padrão)
    return `<section data-background="${cor.sup}">
      <h3 style="color:${cor.dom};border-left:4px solid ${cor.ace};padding-left:16px">${s.titulo}</h3>
      ${s.subtitulo ? `<p style="color:${cor.txt};font-size:0.7em">${s.subtitulo}</p>` : ''}
      ${s.bullets?.length ? `<div style="display:flex;flex-wrap:wrap;gap:16px;justify-content:center;margin-top:1em">${s.bullets.map(b => `<div style="background:#fff;border-radius:8px;padding:20px;width:200px;box-shadow:0 2px 12px rgba(0,0,0,0.08);font-size:0.6em;color:${cor.dom};text-align:left">${b}</div>`).join('')}</div>` : ''}
    </section>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${tema}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css">
<style>
  .reveal{font-family:'Segoe UI',system-ui,-apple-system,sans-serif}
  .reveal h1,.reveal h2,.reveal h3{font-weight:700;letter-spacing:-0.02em}
  .reveal section{text-align:left}
  .reveal ul{list-style:none;padding:0}
  .reveal ul li{margin:0.4em 0}
  .slide-number{font-family:monospace;font-size:12px!important}
</style>
</head>
<body>
<div class="reveal">
<div class="slides">
${slidesHtml}
</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"><\/script>
<script>
Reveal.initialize({
  hash:true,
  slideNumber:true,
  transition:'slide',
  backgroundTransition:'fade',
  width:1280,
  height:720,
  margin:0.08,
  center:true
});
<\/script>
</body>
</html>`;

  const outputFile = join(outputDir, 'apresentacao.html');
  writeFileSync(outputFile, html);

  const msg = {
    id: crypto.randomUUID(),
    type: 'file',
    title: `Apresentação: ${tema}`,
    content: `Apresentação "${tema}" — ${slidesData.length} slides (paleta: ${paleta}, público: ${publico}). HTML interativo com Reveal.js.`,
    filePath: outputFile,
    fileName: 'apresentacao.html',
    timestamp: new Date().toISOString(),
    source: 'slides-html',
  };
  messagesDB.add(msg);

  // Link que funciona: serve pelo próprio servidor (não Supabase, que não renderiza HTML)
  const relativePath = outputFile.replace('/tmp/', '');
  const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`;
  const viewUrl = `${baseUrl}/files/${relativePath}`;
  return `Apresentação criada! "${tema}" — ${slidesData.length} slides.\nLink: ${viewUrl}`;
}

// ================================================================
// PPTX (quando explicitamente pedido)
// ================================================================
async function createPptx(tema, slidesData, paleta, publico, cor, outputDir, formato) {
  const pptxCor = {
    dom: cor.domHex,
    sup: cor.sup.replace('#', ''),
    ace: cor.aceHex,
    txt: cor.txt.replace('#', ''),
  };
  const outputFile = join(outputDir, 'apresentacao.pptx');

  const scriptFile = join(outputDir, 'gerar.cjs');
  const scriptContent = `
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.author = 'ZAYA';
pres.title = ${JSON.stringify(tema)};

const slides = ${JSON.stringify(slidesData)};
const cor = ${JSON.stringify(pptxCor)};

slides.forEach((s, i) => {
  const slide = pres.addSlide();
  const makeShadow = () => ({ type: 'outer', blur: 6, offset: 2, angle: 135, color: '000000', opacity: 0.1 });

  if (s.tipo === 'capa' || s.tipo === 'encerramento') {
    slide.background = { fill: cor.dom };
    slide.addText(s.titulo, { x: 0.8, y: 1.5, w: 8.4, h: 1.8, fontSize: 44, bold: true, color: 'FFFFFF', fontFace: 'Arial', align: 'left' });
    if (s.subtitulo) slide.addText(s.subtitulo, { x: 0.8, y: 3.5, w: 8.4, h: 1, fontSize: 20, color: cor.ace, fontFace: 'Calibri', align: 'left' });
    if (s.tipo === 'capa') slide.addText(new Date().toLocaleDateString('pt-BR'), { x: 0.8, y: 5, w: 4, h: 0.5, fontSize: 12, color: cor.txt, fontFace: 'Calibri' });
    if (s.tipo === 'encerramento' && s.bullets && s.bullets.length > 0) {
      slide.addText(s.bullets.map(b => ({ text: b, options: { bullet: true, color: 'FFFFFF', fontSize: 16, fontFace: 'Calibri', breakLine: true } })), { x: 0.8, y: 3.8, w: 8.4, h: 2, color: 'FFFFFF' });
    }
  } else if (s.tipo === 'kpi' && s.kpi_valor) {
    slide.background = { fill: cor.sup };
    slide.addText(s.titulo, { x: 0.8, y: 0.4, w: 8.4, h: 0.8, fontSize: 28, bold: true, color: cor.dom, fontFace: 'Arial' });
    slide.addShape('rect', { x: 0.06, y: 0.4, w: 0.08, h: 0.8, fill: { color: cor.ace } });
    slide.addText(s.kpi_valor, { x: 1, y: 1.8, w: 8, h: 2, fontSize: 72, bold: true, color: cor.ace, fontFace: 'Arial', align: 'center' });
    slide.addText(s.kpi_label || s.subtitulo || '', { x: 1, y: 3.8, w: 8, h: 0.8, fontSize: 18, color: cor.txt, fontFace: 'Calibri', align: 'center' });
    if (s.bullets && s.bullets.length > 0) {
      slide.addText(s.bullets.map(b => ({ text: b, options: { bullet: true, color: cor.dom, fontSize: 14, fontFace: 'Calibri', breakLine: true } })), { x: 1.5, y: 4.5, w: 7, h: 1.5 });
    }
  } else {
    slide.background = { fill: cor.sup };
    slide.addText(s.titulo, { x: 0.8, y: 0.4, w: 8.4, h: 0.8, fontSize: 28, bold: true, color: cor.dom, fontFace: 'Arial' });
    slide.addShape('rect', { x: 0.06, y: 0.4, w: 0.08, h: 0.8, fill: { color: cor.ace } });
    if (s.subtitulo) slide.addText(s.subtitulo, { x: 0.8, y: 1.3, w: 8.4, h: 0.6, fontSize: 16, color: cor.txt, fontFace: 'Calibri' });
    if (s.bullets && s.bullets.length > 0) {
      const cardW = s.bullets.length <= 2 ? 4 : 2.5;
      const gap = 0.3;
      const totalW = s.bullets.length * cardW + (s.bullets.length - 1) * gap;
      const startX = (10 - totalW) / 2;
      s.bullets.forEach((b, j) => {
        const cx = startX + j * (cardW + gap);
        slide.addShape('roundRect', { x: cx, y: 2.2, w: cardW, h: 2.8, fill: { color: 'FFFFFF' }, shadow: makeShadow(), rectRadius: 0.1 });
        slide.addText(b, { x: cx + 0.2, y: 2.5, w: cardW - 0.4, h: 2.4, fontSize: 13, color: cor.dom, fontFace: 'Calibri', valign: 'top', wrap: true });
      });
    }
  }
});

pres.writeFile({ fileName: ${JSON.stringify(outputFile)} }).then(() => {
  console.log('OK');
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
`;
  writeFileSync(scriptFile, scriptContent);

  const result = await new Promise((resolve) => {
    const projectNodeModules = join(import.meta.dirname, '..', '..', 'node_modules');
    exec(`node "${scriptFile}"`, { timeout: 30000, env: { ...process.env, NODE_PATH: projectNodeModules } }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });

  if (!existsSync(outputFile)) {
    return `Erro ao gerar PPTX: ${result.stderr || result.stdout}`;
  }

  // Se pediu PDF, converte de PPTX para PDF (requer LibreOffice)
  if (formato === 'pdf') {
    try {
      const pdfPath = outputFile.replace('.pptx', '.pdf');
      await new Promise((resolve, reject) => {
        exec(`/Applications/LibreOffice.app/Contents/MacOS/soffice --headless --convert-to pdf --outdir "${outputDir}" "${outputFile}"`, { timeout: 60000 }, (err) => err ? reject(err) : resolve());
      });
      if (existsSync(pdfPath)) {
        const msg = {
          id: crypto.randomUUID(), type: 'file',
          title: `Apresentação PDF: ${tema}`,
          content: `Apresentação "${tema}" — ${slidesData.length} slides em PDF.`,
          filePath: pdfPath, fileName: 'apresentacao.pdf',
          timestamp: new Date().toISOString(), source: 'slides-pdf',
        };
        messagesDB.add(msg);
        return `Apresentação PDF criada! "${tema}" — ${slidesData.length} slides.\nSalvo em: ${pdfPath}`;
      }
    } catch (e) {
      log.ai.warn({ err: e.message }, 'Conversão PDF falhou, retornando PPTX');
    }
  }

  const msg = {
    id: crypto.randomUUID(), type: 'file',
    title: `Apresentação: ${tema}`,
    content: `Apresentação "${tema}" — ${slidesData.length} slides (paleta: ${paleta}, público: ${publico}).`,
    filePath: outputFile, fileName: 'apresentacao.pptx',
    downloadUrl: `/api/download?path=${encodeURIComponent(outputFile)}`,
    timestamp: new Date().toISOString(), source: 'slides-pptx',
  };
  messagesDB.add(msg);

  return `Apresentação PPTX criada! "${tema}" — ${slidesData.length} slides.\nSalvo em: ${outputFile}`;
}
