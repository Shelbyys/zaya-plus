// ================================================================
// BATCH GENERATOR — Gera múltiplas imagens/vídeos em paralelo
// Zaya pergunta quantos, gera todos, retorna links
// ================================================================
import { log } from '../logger.js';
import { io } from '../state.js';
import { generatePersonalizedImage } from './video-pipeline.js';
import { gerarImagemNanoBanana } from './google-ai.js';
import { generateImage } from './media.js';
import { gerarVideoDeImagem } from './video-ai.js';
import { uploadToStorage } from './supabase.js';

// ================================================================
// GERAR MÚLTIPLAS IMAGENS
// ================================================================
export async function batchImages(prompts, options = {}) {
  const isPersonal = options.personal || false;
  const maxConcurrent = options.concurrent || 3; // max paralelo
  const statusCb = options.statusCallback || (() => {});

  const results = [];
  const total = prompts.length;

  statusCb(`Iniciando geração de ${total} imagens...`);
  io?.emit('zaya-executing', { text: `Gerando ${total} imagens...`, timestamp: Date.now() });

  // Processa em lotes de maxConcurrent
  for (let i = 0; i < total; i += maxConcurrent) {
    const batch = prompts.slice(i, i + maxConcurrent);
    const batchNum = Math.floor(i / maxConcurrent) + 1;

    statusCb(`Lote ${batchNum}: gerando ${batch.length} imagens (${i + 1}-${Math.min(i + batch.length, total)} de ${total})...`);

    const batchResults = await Promise.allSettled(
      batch.map(async (prompt, idx) => {
        const imgNum = i + idx + 1;
        try {
          let result;

          if (isPersonal) {
            // Pipeline personalizado com fotos de referência
            const sceneJson = {
              scene: prompt,
              mood: 'natural',
              style: 'cinematic photography, ultra-realistic',
              lighting: { type: 'natural', quality: 'soft', color_temperature: 'warm' },
              camera: { angle: 'eye-level', distance: 'medium', depth_of_field: 'shallow' },
            };
            result = await generatePersonalizedImage(sceneJson, prompt);
          } else {
            // NanoBanana padrão
            result = await gerarImagemNanoBanana(prompt);
          }

          if (!result.success && !result.path) throw new Error(result.error || 'Sem resultado');

          // Upload
          let url = '';
          try {
            const upload = await uploadToStorage(result.path, 'zaya-files', 'imagens');
            url = upload.publicUrl || '';
          } catch {}

          log.ai.info({ num: imgNum, path: result.path }, `Batch: imagem ${imgNum}/${total} OK`);
          return { success: true, num: imgNum, path: result.path, url, prompt };
        } catch (e) {
          log.ai.warn({ num: imgNum, err: e.message }, `Batch: imagem ${imgNum}/${total} FALHOU`);

          // Fallback: DALL-E 3
          try {
            const fallbackPath = await generateImage(prompt);
            if (fallbackPath) {
              let url = '';
              try { const u = await uploadToStorage(fallbackPath, 'zaya-files', 'imagens'); url = u.publicUrl || ''; } catch {}
              return { success: true, num: imgNum, path: fallbackPath, url, prompt, fallback: 'dall-e' };
            }
          } catch {}

          return { success: false, num: imgNum, error: e.message, prompt };
        }
      })
    );

    // Coleta resultados
    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({ success: false, error: r.reason?.message || 'Erro desconhecido' });
      }
    }

    // Rate limit entre lotes (evita quota)
    if (i + maxConcurrent < total) {
      statusCb(`Aguardando antes do próximo lote...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  const ok = results.filter(r => r.success).length;
  const fail = results.filter(r => !r.success).length;

  statusCb(`Pronto! ${ok} de ${total} imagens geradas${fail > 0 ? ` (${fail} falharam)` : ''}.`);
  log.ai.info({ ok, fail, total }, 'Batch de imagens concluído');

  // Salva último arquivo gerado
  const lastOk = results.filter(r => r.success).pop();
  if (lastOk) global._lastGeneratedFile = lastOk.path;

  return {
    success: ok > 0,
    total,
    generated: ok,
    failed: fail,
    results,
    summary: results.filter(r => r.success).map(r => `Imagem ${r.num}: ${r.url || r.path}`).join('\n'),
    urls: results.filter(r => r.success).map(r => r.url || r.path),
    paths: results.filter(r => r.success).map(r => r.path),
  };
}

// ================================================================
// GERAR MÚLTIPLOS VÍDEOS (a partir de imagens)
// ================================================================
export async function batchVideos(items, options = {}) {
  // items = [{ imagePath, prompt, modelo, duracao, aspecto }]
  const statusCb = options.statusCallback || (() => {});
  const results = [];
  const total = items.length;

  statusCb(`Iniciando geração de ${total} vídeos...`);

  // Vídeos são mais pesados — processa 1 por vez
  for (let i = 0; i < total; i++) {
    const item = items[i];
    statusCb(`Vídeo ${i + 1}/${total}: gerando...`);

    try {
      const result = await gerarVideoDeImagem(
        item.prompt || 'Smooth cinematic motion',
        item.imagePath || item.imageUrl,
        {
          modelo: item.modelo || 'kling-std',
          duracao: item.duracao || '5',
          aspecto: item.aspecto || '16:9',
        }
      );

      if (!result.success) throw new Error(result.error || 'Falha no vídeo');

      let url = result.url || '';
      if (!url && result.path) {
        try { const u = await uploadToStorage(result.path, 'zaya-files', 'videos'); url = u.publicUrl || ''; } catch {}
      }

      results.push({ success: true, num: i + 1, path: result.path, url });
      log.ai.info({ num: i + 1, path: result.path }, `Batch: vídeo ${i + 1}/${total} OK`);
    } catch (e) {
      results.push({ success: false, num: i + 1, error: e.message });
      log.ai.warn({ num: i + 1, err: e.message }, `Batch: vídeo ${i + 1}/${total} FALHOU`);
    }

    // Rate limit entre vídeos
    if (i < total - 1) await new Promise(r => setTimeout(r, 2000));
  }

  const ok = results.filter(r => r.success).length;
  const fail = results.filter(r => !r.success).length;

  statusCb(`Pronto! ${ok} de ${total} vídeos gerados${fail > 0 ? ` (${fail} falharam)` : ''}.`);

  return {
    success: ok > 0,
    total,
    generated: ok,
    failed: fail,
    results,
    summary: results.filter(r => r.success).map(r => `Vídeo ${r.num}: ${r.url || r.path}`).join('\n'),
    urls: results.filter(r => r.success).map(r => r.url || r.path),
  };
}

// ================================================================
// GERAR VARIAÇÕES (mesma cena, estilos diferentes)
// ================================================================
export function generateVariationPrompts(basePrompt, count, options = {}) {
  const styles = [
    'cinematic photography, golden hour lighting, shallow depth of field',
    'studio portrait, soft box lighting, clean background',
    'street photography style, natural ambient light, candid feel',
    'editorial magazine style, dramatic lighting, bold colors',
    'lifestyle photography, warm tones, cozy atmosphere',
    'professional headshot, neutral background, confident pose',
    'dramatic noir style, high contrast, moody shadows',
    'bright and airy, pastel tones, minimalist composition',
    'vintage film photography, grain texture, warm color grading',
    'modern corporate, clean lines, professional environment',
  ];

  const angles = ['eye-level', 'slightly above', 'low angle heroic', 'three-quarter view', 'profile view'];
  const distances = ['close-up', 'medium shot', 'full body', 'waist-up', 'environmental portrait'];

  const prompts = [];
  for (let i = 0; i < count; i++) {
    const style = styles[i % styles.length];
    const angle = angles[i % angles.length];
    const distance = distances[i % distances.length];
    prompts.push(`${basePrompt}. Style: ${style}. Camera: ${angle}, ${distance}.`);
  }

  return prompts;
}
