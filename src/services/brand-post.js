// ================================================================
// BRAND POST — Gera posts branded da Easy4u (pipeline completa)
// Fluxo: NanoBanana gera fundo → sharp compõe texto + logo + selo
// ================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { TMP_DIR } from '../config.js';
import { log } from '../logger.js';
import { uploadToStorage } from './supabase.js';

const BRAND_DIR = '/Volumes/KINGSTON/ARQUIVOS IDV EASY4U/PNG';

// Prompts FIXOS testados — não deixar a IA inventar
const PROMPTS_FIXOS = {
  pessoa: {
    preto: 'Professional cinematic portrait of a confident young Brazilian professional in dark blazer, holding smartphone, in a modern dark office. Dark moody atmosphere with warm orange accent lighting on face. Person in upper 55% of frame, lower part completely dark. Ultra realistic photography, natural skin texture, 8K, shallow depth of field.',
    branco: 'Professional bright portrait of a young Brazilian professional in casual dark shirt, working in a modern bright white minimalist office. Natural daylight, clean. Person in upper 55% of frame, lower part white. Ultra realistic photography, 8K.',
  },
  minimalista: {
    preto: 'Professional dark product photography of a single modern smartphone with screen OFF showing subtle reflections, lying on a dark matte black surface. Orange warm rim lighting from behind. Dark black background. Minimalist, single subject in lower half, upper half completely dark empty. Ultra realistic, 8K.',
    branco: 'Professional bright product photography of a single modern smartphone with screen OFF, standing on a clean white surface. Soft natural lighting. White background. Minimalist, single subject in lower center, upper half empty white. Ultra realistic, 8K.',
  },
  editorial: {
    preto: 'Professional advertising photograph, portrait orientation. A confident young Brazilian businesswoman in elegant dark blazer, sitting in a modern orange designer armchair, holding smartphone and smiling. Around her, floating holographic smartphone screens with orange glowing interfaces. Dark black background with subtle orange atmospheric fog at bottom. Person centered in middle, upper 30% dark empty space. Cinematic orange accent lighting. Ultra realistic, 8K.',
    branco: 'Professional advertising photograph, portrait orientation. A confident young Brazilian businessman in dark casual attire, standing in a bright modern office, interacting with floating holographic orange screens. White bright background, clean. Person centered, upper 30% bright empty space. Natural lighting with orange accents. Ultra realistic, 8K.',
  },
  chat: {
    preto: 'Dark dramatic photograph of a single glass hourglass with glowing orange sand on a dark reflective surface, positioned on the RIGHT side of frame taking 50%. LEFT side completely dark black empty space. Orange warm backlight. Cinematic, moody. Ultra realistic, 8K.',
    branco: 'Clean bright photograph of a single modern alarm clock with orange accents on a white reflective surface, positioned on the RIGHT side of frame. LEFT side clean white empty space. Soft natural studio lighting. Ultra realistic, 8K.',
  },
};

async function loadLogos() {
  const logos = {};
  const files = { selo: '06.png', icone: '08.png', horizontal: '04.png', branca: '05.png' };
  for (const [name, file] of Object.entries(files)) {
    const path = join(BRAND_DIR, file);
    if (existsSync(path)) {
      logos[name] = {
        small: await sharp(path).resize(55, 55, { fit: 'inside' }).png().toBuffer(),
        medium: await sharp(path).resize(180, null, { fit: 'inside' }).png().toBuffer(),
      };
    }
  }
  return logos;
}

// ================================================================
// GERAR POST EASY4U COMPLETO
// ================================================================
export async function criarPostEasy4u(opts = {}) {
  let {
    texto1 = '',
    texto2 = '',
    texto3 = '',
    subtexto = '',
    estilo = 'clean',
    formato = 'story',
    cor = 'preto',
    imagemPrompt = null,
    imagemPath = null,
    tag = null,
    logoVariante = 'selo',
  } = opts;

  const dir = join(TMP_DIR, 'brand');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const dims = {
    story: { w: 1080, h: 1920 },
    feed: { w: 1080, h: 1080 },
    feed45: { w: 1080, h: 1350 },
  };
  const { w, h } = dims[formato] || dims.story;
  const isDark = cor === 'preto';

  const logos = await loadLogos();
  const logoToUse = logos[logoVariante] || logos.selo;

  log.ai.info({ estilo, formato, cor, texto1: texto1.slice(0, 40) }, 'BrandPost: gerando');

  // ================================================================
  // GERAR FUNDO
  // ================================================================
  let bgBuffer;

  if (estilo === 'clean' || estilo === 'pergunta') {
    // Fundo sólido SVG — sem IA
    const bgColor = isDark ? '#0A0A0A' : '#FFFFFF';
    const gridColor = isDark ? 'rgba(255,255,255,0.012)' : 'rgba(0,0,0,0.015)';
    const bgSvg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${w}" height="${h}" fill="${bgColor}"/>
      <defs><pattern id="g" width="60" height="60" patternUnits="userSpaceOnUse"><rect width="60" height="60" fill="none" stroke="${gridColor}" stroke-width="0.5"/></pattern></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
    </svg>`);
    bgBuffer = await sharp(bgSvg).png().toBuffer();

  } else if (imagemPrompt) {
    // Prompt custom — NanoBanana gera a cena descrita (prioridade sobre imagemPath)
    const { gerarImagemNanoBanana } = await import('./google-ai.js');
    log.ai.info({ prompt: imagemPrompt.slice(0, 100) }, 'BrandPost: NanoBanana com prompt custom');
    const result = await gerarImagemNanoBanana(imagemPrompt);
    if (!result.success) throw new Error('NanoBanana falhou: ' + (result.error || ''));
    bgBuffer = await sharp(result.path).resize(w, h, { fit: 'cover', position: 'top' }).png().toBuffer();

  } else if (imagemPath && existsSync(imagemPath)) {
    // Usa imagem fornecida direto como fundo
    bgBuffer = await sharp(imagemPath).resize(w, h, { fit: 'cover', position: 'top' }).png().toBuffer();

  } else {
    // Usa prompt FIXO testado por estilo
    const fixo = PROMPTS_FIXOS[estilo]?.[cor];
    const prompt = fixo || PROMPTS_FIXOS.pessoa[cor];

    const { gerarImagemNanoBanana } = await import('./google-ai.js');
    const result = await gerarImagemNanoBanana(prompt);
    if (!result.success) throw new Error('NanoBanana falhou: ' + (result.error || ''));
    bgBuffer = await sharp(result.path).resize(w, h, { fit: 'cover', position: 'top' }).png().toBuffer();
  }

  // ================================================================
  // COMPOSIÇÃO DE TEXTO + LOGO (SVG)
  // ================================================================
  const textColor = isDark ? '#FFFFFF' : '#1A1A1A';
  const subColor = '#909090';
  const sloganColor = isDark ? 'rgba(255,255,255,0.2)' : '#CCCCCC';
  const accentColor = '#EF641D';

  // Largura útil para texto (margem de 90px cada lado)
  const textMaxW = w - 180;
  const charWidthFactor = 0.55;

  // Auto-wrap: quebra texto em múltiplas linhas SVG se não cabe na largura
  function wrapText(text, maxChars) {
    if (!text) return [''];
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (test.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [''];
  }

  // Calcula máximo de chars que cabem na largura com dado fontSize
  function maxCharsForWidth(fSize, maxWidth) {
    const avgCharW = fSize * charWidthFactor;
    return Math.floor(maxWidth / avgCharW);
  }

  // Gera múltiplas linhas SVG <text> com word-wrap
  function svgTextWrapped(text, x, startY, lineHeight, fSize, attrs, maxWidth) {
    const mc = maxCharsForWidth(fSize, maxWidth || textMaxW);
    const lines = wrapText(text, mc);
    return lines.map((line, i) =>
      `<text x="${x}" y="${startY + i * lineHeight}" ${attrs} font-size="${fSize}">${line}</text>`
    ).join('\n    ');
  }

  const hasImage = !['clean', 'pergunta'].includes(estilo);
  const isEditorial = estilo === 'editorial';

  // Posições por estilo
  let titleY, lineH, fontSize;
  if (isEditorial) {
    titleY = formato === 'story' ? 250 : 180;
    lineH = formato === 'story' ? 85 : 70;
    fontSize = formato === 'story' ? 70 : 58;
  } else if (estilo === 'pergunta') {
    titleY = Math.round(h * 0.42);
    lineH = formato === 'story' ? 65 : 55;
    fontSize = formato === 'story' ? 36 : 30;
  } else if (hasImage) {
    titleY = formato === 'story' ? h - 480 : h - 300;
    lineH = formato === 'story' ? 70 : 60;
    fontSize = formato === 'story' ? 50 : 46;
    // Se tem tag, empurra título pra baixo pra não sobrepor
    if (tag) titleY += 30;
  } else {
    titleY = formato === 'story' ? Math.round(h * 0.35) : Math.round(h * 0.33);
    lineH = formato === 'story' ? 75 : 65;
    fontSize = formato === 'story' ? 62 : 52;
  }

  // Overlay gradient
  let overlayGradient = '';
  if (hasImage) {
    if (isEditorial) {
      overlayGradient = `<defs><linearGradient id="ov" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="black" stop-opacity="0.75"/>
        <stop offset="25%" stop-color="black" stop-opacity="0.1"/>
        <stop offset="75%" stop-color="black" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="black" stop-opacity="0.8"/>
      </linearGradient></defs><rect width="${w}" height="${h}" fill="url(#ov)"/>`;
    } else if (isDark) {
      overlayGradient = `<defs><linearGradient id="ov" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="black" stop-opacity="0"/>
        <stop offset="50%" stop-color="black" stop-opacity="0.1"/>
        <stop offset="72%" stop-color="black" stop-opacity="0.92"/>
        <stop offset="100%" stop-color="black" stop-opacity="0.98"/>
      </linearGradient></defs><rect width="${w}" height="${h}" fill="url(#ov)"/>`;
    } else {
      overlayGradient = `<defs><linearGradient id="ov" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="white" stop-opacity="0"/>
        <stop offset="50%" stop-color="white" stop-opacity="0"/>
        <stop offset="72%" stop-color="white" stop-opacity="0.93"/>
        <stop offset="100%" stop-color="white" stop-opacity="0.98"/>
      </linearGradient></defs><rect width="${w}" height="${h}" fill="url(#ov)"/>`;
    }
  }

  // Tag badge
  let tagSvg = '';
  if (tag && !isEditorial) {
    const tagX = 90;
    const tagY = hasImage ? titleY - 80 : titleY - 100;
    tagSvg = `<rect x="${tagX}" y="${tagY}" width="${tag.length * 12 + 30}" height="32" rx="16" fill="${isDark ? 'rgba(239,100,29,0.15)' : 'rgba(239,100,29,0.1)'}" stroke="${isDark ? 'rgba(239,100,29,0.4)' : 'rgba(239,100,29,0.3)'}" stroke-width="1"/>
    <text x="${tagX + 15}" y="${tagY + 22}" font-family="Helvetica Neue, Arial" font-weight="600" font-size="13" fill="${accentColor}" letter-spacing="1">${tag}</text>`;
  }

  // Monta título por estilo
  let titleSvg = '';

  if (isEditorial) {
    // EDITORIAL: header + serif italic + sans bold + laranja — CENTRALIZADO
    const edMaxW = w - 120;
    const edSub = subtexto ? wrapText(subtexto, maxCharsForWidth(22, edMaxW)) : [];
    titleSvg = `
    <text x="${w/2}" y="${titleY - 80}" text-anchor="middle" font-family="Helvetica Neue, Arial" font-weight="300" font-size="18" fill="rgba(255,255,255,0.5)" letter-spacing="8">EASY4U  ·  SOLUÇÕES EMPRESARIAIS</text>
    ${svgTextWrapped(texto1, w/2, titleY, lineH * 0.6, Math.round(fontSize * 0.6), `text-anchor="middle" font-family="Helvetica Neue, Arial" font-weight="300" fill="${textColor}" letter-spacing="2"`, edMaxW)}
    ${svgTextWrapped(texto2, w/2, titleY + lineH, lineH, Math.round(fontSize * 1.3), `text-anchor="middle" font-family="Georgia, Times, serif" font-weight="700" fill="${textColor}" font-style="italic"`, edMaxW)}
    ${svgTextWrapped(texto3, w/2, titleY + lineH * 2, lineH, Math.round(fontSize * 1.2), `text-anchor="middle" font-family="Helvetica Neue, Arial" font-weight="800" fill="${accentColor}"`, edMaxW)}
    ${edSub.map((line, i) => `<text x="${w/2}" y="${titleY + lineH * 2 + 50 + i * 28}" text-anchor="middle" font-family="Helvetica Neue, Arial" font-weight="400" font-size="22" fill="${subColor}">${line}</text>`).join('\n    ')}`;
  } else if (estilo === 'pergunta') {
    // PERGUNTA: ? no centro + card
    const cardY = titleY - 30;
    const cardH = lineH * 4 + 40;
    titleSvg = `
    <circle cx="${w/2}" cy="${cardY - 50}" r="38" fill="${isDark ? 'rgba(239,100,29,0.2)' : 'rgba(239,100,29,0.1)'}" stroke="${accentColor}" stroke-width="2"/>
    <text x="${w/2}" y="${cardY - 30}" text-anchor="middle" font-family="Helvetica Neue, Arial" font-weight="800" font-size="44" fill="${accentColor}">?</text>
    <rect x="${w/2 - 420}" y="${cardY}" width="840" height="${cardH}" rx="20" fill="${isDark ? 'rgba(25,25,30,0.6)' : 'rgba(245,245,245,0.8)'}" stroke="${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'}" stroke-width="1"/>
    <text x="${w/2}" y="${cardY + lineH}" text-anchor="middle" font-family="Helvetica Neue, Arial" font-weight="400" font-size="${fontSize}" fill="${isDark ? 'rgba(255,255,255,0.75)' : '#666666'}">${texto1}</text>
    <text x="${w/2}" y="${cardY + lineH * 2}" text-anchor="middle" font-family="Helvetica Neue, Arial" font-weight="800" font-size="${fontSize + 4}" fill="${textColor}">${texto2}</text>
    <text x="${w/2}" y="${cardY + lineH * 3}" text-anchor="middle" font-family="Helvetica Neue, Arial" font-weight="800" font-size="${fontSize + 8}" fill="${accentColor}">${texto3}</text>`;
  } else if (estilo === 'chat') {
    // CHAT: balão de conversa no lado esquerdo
    const chatY = hasImage ? titleY - 80 : titleY;
    titleSvg = `
    <rect x="50" y="${chatY}" width="520" height="320" rx="18" fill="${isDark ? 'rgba(20,20,25,0.88)' : 'rgba(245,245,245,0.9)'}" stroke="${isDark ? 'rgba(239,100,29,0.15)' : 'rgba(0,0,0,0.05)'}" stroke-width="1"/>
    <polygon points="100,${chatY+320} 80,${chatY+355} 130,${chatY+320}" fill="${isDark ? 'rgba(20,20,25,0.88)' : 'rgba(245,245,245,0.9)'}"/>
    <text x="85" y="${chatY+50}" font-family="Helvetica Neue, Arial" font-weight="700" font-size="24" fill="${accentColor}">✦</text>
    <text x="85" y="${chatY+100}" font-family="Helvetica Neue, Arial" font-weight="400" font-size="30" fill="${isDark ? 'rgba(255,255,255,0.85)' : '#555555'}">${texto1}</text>
    <text x="85" y="${chatY+145}" font-family="Helvetica Neue, Arial" font-weight="800" font-size="30" fill="${textColor}">${texto2}</text>
    <text x="85" y="${chatY+195}" font-family="Helvetica Neue, Arial" font-weight="800" font-size="30" fill="${accentColor}">${texto3}</text>
    <text x="85" y="${chatY+245}" font-family="Helvetica Neue, Arial" font-weight="400" font-size="18" fill="${subColor}">${subtexto}</text>`;
  } else {
    // CLEAN, PESSOA, MINIMALISTA: padrão com linha acento
    const mc = maxCharsForWidth(fontSize, textMaxW);
    const t1Lines = wrapText(texto1, mc);
    const t2Lines = wrapText(texto2, mc);
    const t3Lines = wrapText(texto3, mc);
    const totalTitleLines = t1Lines.length + t2Lines.length + t3Lines.length;
    const accentH = totalTitleLines * lineH + 10;

    let yOff = titleY;
    let titleParts = '';
    // Linha acento
    titleParts += `<rect x="${90 - 30}" y="${titleY - 50}" width="4" height="${accentH}" rx="2" fill="${accentColor}"/>`;
    // Texto 1
    for (const line of t1Lines) {
      titleParts += `\n    <text x="90" y="${yOff}" font-family="Helvetica Neue, Arial" font-weight="800" font-size="${fontSize}" fill="${textColor}">${line}</text>`;
      yOff += lineH;
    }
    // Texto 2
    for (const line of t2Lines) {
      titleParts += `\n    <text x="90" y="${yOff}" font-family="Helvetica Neue, Arial" font-weight="800" font-size="${fontSize}" fill="${textColor}">${line}</text>`;
      yOff += lineH;
    }
    // Texto 3 (laranja)
    for (const line of t3Lines) {
      titleParts += `\n    <text x="90" y="${yOff}" font-family="Helvetica Neue, Arial" font-weight="800" font-size="${fontSize}" fill="${accentColor}">${line}</text>`;
      yOff += lineH;
    }
    // Subtexto (word-wrap, nunca corta palavra)
    if (subtexto) {
      const subMc = maxCharsForWidth(22, textMaxW);
      const subLines = wrapText(subtexto, subMc);
      yOff += 20;
      for (const line of subLines.slice(0, 2)) {
        titleParts += `\n    <text x="90" y="${yOff}" font-family="Helvetica Neue, Arial" font-weight="400" font-size="22" fill="${subColor}">${line}</text>`;
        yOff += 28;
      }
    }
    titleSvg = titleParts;
  }

  const textSvg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    ${overlayGradient}
    ${tagSvg}
    ${titleSvg}
    <!-- Rodapé -->
    <text x="90" y="${h - 70}" font-family="Helvetica Neue, Arial" font-weight="300" font-size="16" fill="${sloganColor}" font-style="italic">IA simples. Resultados reais.  ·  @suaeasy4u</text>
  </svg>`);

  // ================================================================
  // COMPOR TUDO
  // ================================================================
  const outputPath = join(dir, `easy4u_${estilo}_${cor}_${Date.now()}.png`);

  const composites = [{ input: textSvg, top: 0, left: 0 }];

  if (logoToUse) {
    if (logoVariante === 'selo') {
      composites.push({ input: logoToUse.small, top: 55, left: w - 115 });
    } else if (logoVariante === 'icone') {
      composites.push({ input: logoToUse.small, top: h - 100, left: w - 100 });
    } else {
      composites.push({ input: logoToUse.medium, top: h - 100, left: 90 });
    }
  }

  await sharp(bgBuffer).composite(composites).png({ quality: 95 }).toFile(outputPath);

  log.ai.info({ path: outputPath, estilo, formato, cor }, 'BrandPost: gerado');

  let publicUrl = '';
  try {
    const upload = await uploadToStorage(outputPath, 'zaya-files', 'imagens');
    publicUrl = upload.publicUrl || '';
  } catch (e) {
    log.ai.warn({ err: e.message }, 'BrandPost: upload falhou');
  }

  // Salva params pra reutilização (editar_post_easy4u)
  global._lastPostEasy4u = {
    texto1, texto2, texto3, subtexto, estilo, formato, cor,
    imagemPrompt: imagemPrompt || PROMPTS_FIXOS[estilo]?.[cor] || null,
    imagemPath, tag, logoVariante,
    outputPath, publicUrl,
    createdAt: Date.now(),
  };

  return { success: true, path: outputPath, url: publicUrl, estilo, formato, cor };
}
