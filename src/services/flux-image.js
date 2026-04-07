// ================================================================
// FLUX.1 — Geração de imagens via HuggingFace Inference API
// Substitui DALL-E 3 ($0.04-0.12/img) por free tier ou ~$0.001/img
// ================================================================
import { log } from '../logger.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const HF_TOKEN = () => process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || '';

/**
 * Gera imagem com FLUX.1-schnell via HuggingFace
 * @param {string} prompt - Descrição da imagem
 * @param {object} options - Opções extras
 * @returns {Promise<{path: string, buffer: Buffer}>}
 */
export async function generateImage(prompt, options = {}) {
  const token = HF_TOKEN();
  if (!token) throw new Error('HUGGINGFACE_API_KEY não configurada');

  const model = options.model || 'black-forest-labs/FLUX.1-schnell';

  try {
    log.ai.info({ prompt: prompt.slice(0, 60), model }, 'FLUX gerando imagem...');

    const response = await fetch(
      `https://router.huggingface.co/hf-inference/models/${model}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            width: options.width || 1024,
            height: options.height || 1024,
          }
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`FLUX ${response.status}: ${err.slice(0, 200)}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const fileName = `flux-${Date.now()}.png`;
    const filePath = join('/tmp', fileName);
    writeFileSync(filePath, buffer);

    log.ai.info({ size: buffer.length, path: filePath }, 'FLUX imagem gerada');
    return { path: filePath, buffer, fileName };
  } catch (e) {
    log.ai.error({ err: e.message, prompt: prompt.slice(0, 60) }, 'Erro FLUX');
    throw e;
  }
}

/**
 * Gera imagem e retorna como base64
 */
export async function generateImageBase64(prompt, options = {}) {
  const { buffer } = await generateImage(prompt, options);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

export function isFluxEnabled() {
  return !!HF_TOKEN();
}
