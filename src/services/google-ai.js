// ================================================================
// GOOGLE AI — Nano Banana (imagens) + Veo 3 (vídeos)
// ================================================================
import { GoogleGenAI } from '@google/genai';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { TMP_DIR } from '../config.js';
import { log } from '../logger.js';

let ai = null;
function getAI() {
  if (!ai) {
    const key = process.env.GOOGLE_AI_STUDIO_KEY;
    if (!key) throw new Error('GOOGLE_AI_STUDIO_KEY não configurada no .env. Pegue em https://aistudio.google.com/apikey');
    ai = new GoogleGenAI({ apiKey: key });
  }
  return ai;
}

// ================================================================
// NANO BANANA — Gerar imagem ultra-realista
// ================================================================
export async function gerarImagemNanoBanana(prompt) {
  const genai = getAI();
  const dir = join(TMP_DIR, 'images');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  log.ai.info({ prompt: prompt.slice(0, 100) }, 'NanoBanana: gerando imagem');

  // Tenta modelos na ordem de preferência (os que geram imagem de fato)
  const modelos = ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'nano-banana-pro-preview'];
  let response = null;
  let modeloUsado = '';

  for (const modelo of modelos) {
    try {
      response = await genai.models.generateContent({
        model: modelo,
        contents: prompt,
        config: { responseModalities: ['image', 'text'] },
      });
      modeloUsado = modelo;
      log.ai.info({ modelo }, 'NanoBanana: modelo usado');
      break;
    } catch (e) {
      log.ai.warn({ modelo, err: e.message?.slice(0, 100) }, 'NanoBanana: modelo falhou, tentando próximo');
      continue;
    }
  }

  if (!response) throw new Error('Todos os modelos de imagem falharam. Verifique quota/billing em https://ai.google.dev/rate-limit');

  // Extrai imagem da resposta
  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      const ext = part.inlineData.mimeType?.includes('png') ? 'png' : 'jpg';
      const filePath = join(dir, `nanobanana_${Date.now()}.${ext}`);
      writeFileSync(filePath, Buffer.from(part.inlineData.data, 'base64'));
      log.ai.info({ path: filePath }, 'NanoBanana: imagem salva');
      return { success: true, path: filePath, mimeType: part.inlineData.mimeType };
    }
  }

  // Se não veio imagem, pega texto da resposta
  const text = parts.find(p => p.text)?.text || 'Sem resultado';
  return { success: false, error: text };
}

// ================================================================
// VEO 3 — Gerar vídeo hiper-realista
// ================================================================
export async function gerarVideoVeo3(prompt, modelo = 'veo-3.0-generate-001', imagemRef = null) {
  const genai = getAI();
  const dir = join(TMP_DIR, 'videos');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  log.ai.info({ prompt: prompt.slice(0, 100), modelo, hasImage: !!imagemRef }, 'Veo3: gerando vídeo');

  // Monta config
  const config = {
    numberOfVideos: 1,
    durationSeconds: 8,
    aspectRatio: '16:9',
  };

  // Se tem imagem de referência (image-to-video)
  const params = { model: modelo, prompt, config };
  if (imagemRef) {
    try {
      const { readFileSync } = await import('fs');
      const imgData = readFileSync(imagemRef);
      const ext = imagemRef.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      params.image = {
        imageBytes: imgData.toString('base64'),
        mimeType: ext,
      };
      log.ai.info({ image: imagemRef }, 'Veo3: usando imagem de referência');
    } catch (e) {
      log.ai.warn({ err: e.message }, 'Veo3: falha ao ler imagem, gerando sem referência');
    }
  }

  // Inicia geração (operação longa)
  let operation = await genai.models.generateVideos(params);

  // Polling até completar (máx 5 min)
  const maxWait = 5 * 60 * 1000;
  const start = Date.now();
  while (!operation.done && (Date.now() - start) < maxWait) {
    await new Promise(r => setTimeout(r, 10000)); // Espera 10s
    operation = await genai.operations.get({ operation });
    log.ai.info({ elapsed: Math.round((Date.now() - start) / 1000), done: operation.done }, 'Veo3: aguardando...');
  }

  if (!operation.done) {
    return { success: false, error: 'Timeout — vídeo demorou mais de 5 minutos. Tente novamente.' };
  }

  // Salva vídeos gerados
  const videos = operation.response?.generatedVideos || [];
  if (videos.length === 0) {
    return { success: false, error: 'Nenhum vídeo gerado. O prompt pode ter sido bloqueado por segurança.' };
  }

  const results = [];
  const apiKey = process.env.GOOGLE_AI_STUDIO_KEY;
  for (const video of videos) {
    try {
      // Download via URL direta com API key
      let downloadUrl = video.video.uri;
      if (!downloadUrl.includes('key=')) {
        downloadUrl += (downloadUrl.includes('?') ? '&' : '?') + `key=${apiKey}`;
      }
      log.ai.info({ url: downloadUrl.slice(0, 100) }, 'Veo3: baixando vídeo...');
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const filePath = join(dir, `veo3_${Date.now()}.mp4`);
      writeFileSync(filePath, buffer);
      results.push(filePath);
      log.ai.info({ path: filePath, size: buffer.length }, 'Veo3: vídeo salvo');
    } catch (e) {
      log.ai.warn({ err: e.message, uri: video.video?.uri?.slice(0, 80) }, 'Veo3: erro ao baixar vídeo');
    }
  }

  if (results.length === 0) {
    return { success: false, error: 'Vídeos gerados mas falha ao baixar.' };
  }

  return { success: true, paths: results };
}
