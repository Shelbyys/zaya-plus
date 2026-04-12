// ================================================================
// VIDEO PIPELINE — Vídeo personalizado com rosto do Sr. Alisson
// Fluxo: Referência → Análise GPT-4o → Imagem NanoBanana + Face → Vídeo Freepik
// ================================================================
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, extname } from 'path';
import { TMP_DIR } from '../config.js';
import { log } from '../logger.js';
import { openai, io } from '../state.js';
import { GoogleGenAI } from '@google/genai';
import { gerarVideoDeImagem } from './video-ai.js';
import { uploadToStorage } from './supabase.js';

const FACE_REF_DIR = '/Volumes/KINGSTON/claude-code/jarvis/data/face-reference';

// ================================================================
// UTILS
// ================================================================
function getGenAI() {
  const key = process.env.GOOGLE_AI_STUDIO_KEY;
  if (!key) throw new Error('GOOGLE_AI_STUDIO_KEY não configurada');
  return new GoogleGenAI({ apiKey: key });
}

function imageToBase64(filePath) {
  return readFileSync(filePath).toString('base64');
}

function getMimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
  return map[ext] || 'image/png';
}

function loadFaceReferences(maxPhotos = 3) {
  if (!existsSync(FACE_REF_DIR)) {
    throw new Error(`Diretório de fotos de referência não encontrado: ${FACE_REF_DIR}`);
  }
  // Prefere JPEGs redimensionados (menores, aceitos pelo Gemini)
  const preferred = ['alisson_03.jpg', 'alisson_04.jpg', 'alisson_02.jpg', 'alisson_09.jpg', 'alisson_05.jpg'];
  const allFiles = readdirSync(FACE_REF_DIR).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
  const files = preferred.filter(f => allFiles.includes(f)).slice(0, maxPhotos);
  if (files.length === 0) {
    throw new Error('Nenhuma foto de referência encontrada em ' + FACE_REF_DIR);
  }

  log.ai.info({ count: files.length, files }, 'VideoPipeline: fotos de referência carregadas');

  // Redimensiona pra max 512px (Gemini não aceita imagens muito grandes com inlineData)
  return files.map(f => {
    const fullPath = join(FACE_REF_DIR, f);
    let base64 = imageToBase64(fullPath);

    // Se muito grande (>500KB base64 ≈ 375KB imagem), redimensiona via sips
    if (base64.length > 500000) {
      try {
        const tmpResized = join(TMP_DIR, `face_resized_${f.replace('.png', '.jpg')}`);
        execSync(`sips -s format jpeg -Z 512 "${fullPath}" --out "${tmpResized}" 2>/dev/null`, { timeout: 10000 });
        if (existsSync(tmpResized)) {
          base64 = readFileSync(tmpResized).toString('base64');
          return { inlineData: { mimeType: 'image/jpeg', data: base64 } };
        }
      } catch {}
    }

    return { inlineData: { mimeType: getMimeType(fullPath), data: base64 } };
  });
}

// ================================================================
// STEP 1: Analisar imagem de referência com GPT-4o Vision → JSON
// ================================================================
export async function analyzeReferenceImage(imagePath) {
  log.ai.info({ imagePath }, 'VideoPipeline Step 1: analisando imagem de referência');

  const base64 = imageToBase64(imagePath);
  const mime = getMimeType(imagePath);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Analyze this image in extreme detail for recreation purposes. Return a JSON object with ALL of these fields filled with rich descriptions:

{
  "scene": "detailed overall scene description",
  "setting": "indoor/outdoor, specific location type",
  "background": "detailed background elements",
  "foreground": "detailed foreground elements",
  "lighting": {
    "type": "natural/artificial/mixed",
    "direction": "front/back/side/overhead/golden-hour",
    "quality": "soft/hard/diffused/dramatic",
    "color_temperature": "warm/cool/neutral",
    "shadows": "description of shadow patterns"
  },
  "camera": {
    "angle": "eye-level/low-angle/high-angle/bird-eye/dutch",
    "distance": "close-up/medium/wide/extreme-wide",
    "lens_mm": "estimated focal length",
    "depth_of_field": "shallow/medium/deep",
    "motion": "static/pan/tracking"
  },
  "colors": {
    "palette": ["list of dominant colors"],
    "mood_colors": "warm/cool/vibrant/muted/pastel",
    "contrast": "high/medium/low"
  },
  "mood": "emotional tone of the scene",
  "atmosphere": "atmospheric conditions or feeling",
  "style": "photographic style (cinematic/editorial/candid/etc)",
  "time_of_day": "morning/afternoon/golden-hour/night/etc",
  "weather": "if applicable",
  "clothing_style": "if person visible, describe ideal clothing for the scene",
  "pose_suggestion": "natural pose that fits the scene",
  "objects": ["list of key objects/props in scene"],
  "textures": ["notable textures visible"],
  "composition": "rule of thirds/centered/diagonal/etc"
}

Be extremely detailed. This will be used to generate a new image with a specific person placed in this exact scene.`,
        },
        {
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${base64}` },
        },
      ],
    }],
  });

  const content = response.choices[0].message.content;
  const sceneJson = JSON.parse(content);

  log.ai.info({ scene: sceneJson.scene?.slice(0, 80), mood: sceneJson.mood }, 'VideoPipeline Step 1: análise concluída');
  return sceneJson;
}

// ================================================================
// STEP 2: Gerar imagem com NanoBanana (Gemini) + fotos de rosto
// ================================================================
export async function generatePersonalizedImage(sceneJson, customPrompt = '') {
  const genai = getGenAI();
  const dir = join(TMP_DIR, 'images');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  log.ai.info({ hasJson: !!sceneJson, hasCustom: !!customPrompt }, 'VideoPipeline Step 2: gerando imagem personalizada');

  // Carrega fotos de referência do rosto (max 5 para não estourar contexto)
  const faceRefs = loadFaceReferences(5);

  // Monta prompt descritivo a partir do JSON da cena
  let sceneDescription = '';
  if (sceneJson) {
    const s = sceneJson;
    sceneDescription = [
      s.scene,
      s.setting ? `Setting: ${s.setting}` : '',
      s.background ? `Background: ${s.background}` : '',
      s.foreground ? `Foreground: ${s.foreground}` : '',
      s.lighting ? `Lighting: ${s.lighting.type} ${s.lighting.direction} light, ${s.lighting.quality}, ${s.lighting.color_temperature} temperature, shadows: ${s.lighting.shadows}` : '',
      s.camera ? `Camera: ${s.camera.angle} angle, ${s.camera.distance} shot, ${s.camera.lens_mm} lens, ${s.camera.depth_of_field} DoF` : '',
      s.colors ? `Colors: ${s.colors.palette?.join(', ')}, ${s.colors.mood_colors} mood, ${s.colors.contrast} contrast` : '',
      s.mood ? `Mood: ${s.mood}` : '',
      s.atmosphere ? `Atmosphere: ${s.atmosphere}` : '',
      s.style ? `Style: ${s.style}` : '',
      s.time_of_day ? `Time: ${s.time_of_day}` : '',
      s.weather ? `Weather: ${s.weather}` : '',
      s.clothing_style ? `Clothing: ${s.clothing_style}` : '',
      s.pose_suggestion ? `Pose: ${s.pose_suggestion}` : '',
      s.objects?.length ? `Objects: ${s.objects.join(', ')}` : '',
      s.textures?.length ? `Textures: ${s.textures.join(', ')}` : '',
      s.composition ? `Composition: ${s.composition}` : '',
    ].filter(Boolean).join('. ');
  }

  // Prompt final — CENA é prioridade, rosto das referências
  const finalPrompt = `GENERATE THIS EXACT SCENE with the face from the reference photos:

${sceneDescription ? `SCENE TO REPRODUCE EXACTLY: ${sceneDescription}\n` : ''}
${customPrompt ? `ADDITIONAL INSTRUCTIONS: ${customPrompt}\n` : ''}

PERSON REFERENCE (from attached photos — Alisson Silva):
- Use the FULL BODY as reference: face, body type, skin tone, build, height proportions
- Face: round face shape, brown eyes, short dark hair, goatee/thin facial hair, warm brown skin tone
- Body: stocky/strong build, broad shoulders, medium height
- HANDS: normal proportioned hands, correct number of fingers (5 per hand), natural size matching the body. DO NOT make hands too large, too small, or distorted. Hands must look anatomically correct and proportional.
- IGNORE accessories from reference photos (watch, bracelet) — use ONLY accessories from the SCENE description
- If the scene image has a watch → add watch. If not → no watch.

SCENE RULES:
- Reproduce the EXACT scene described: setting, lighting, colors, mood, clothing, pose, accessories
- Clothing and accessories come from the SCENE DESCRIPTION, not from the reference photos
- Follow the scene description EXACTLY — same environment, same style, same mood.

Ultra-realistic photograph, 8K, cinematic, professional photography.`;

  log.ai.info({ promptLen: finalPrompt.length }, 'VideoPipeline Step 2: prompt montado');

  // Monta contents: texto + fotos de referência
  const contents = [
    { text: finalPrompt },
    ...faceRefs,
  ];

  // Tenta modelos na ordem de preferência
  const modelos = ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image', 'gemini-3-pro-image-preview'];
  let response = null;
  let modelUsed = '';

  for (const modelo of modelos) {
    try {
      log.ai.info({ modelo }, 'VideoPipeline Step 2: tentando modelo');
      response = await genai.models.generateContent({
        model: modelo,
        contents: contents,
        config: { responseModalities: ['image', 'text'] },
      });
      modelUsed = modelo;
      log.ai.info({ modelo }, 'VideoPipeline Step 2: modelo respondeu');
      break;
    } catch (e) {
      log.ai.warn({ modelo, err: e.message?.slice(0, 120) }, 'VideoPipeline Step 2: modelo falhou');
      continue;
    }
  }

  if (!response) {
    throw new Error('Todos os modelos de imagem falharam ao gerar imagem personalizada.');
  }

  // Extrai imagem da resposta
  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      const ext = part.inlineData.mimeType?.includes('png') ? 'png' : 'jpg';
      const timestamp = Date.now();
      const filePath = join(dir, `pipeline_face_${timestamp}.${ext}`);
      const buffer = Buffer.from(part.inlineData.data, 'base64');
      writeFileSync(filePath, buffer);

      log.ai.info({ path: filePath, size: buffer.length, model: modelUsed }, 'VideoPipeline Step 2: imagem personalizada salva');

      return {
        success: true,
        path: filePath,
        mimeType: part.inlineData.mimeType,
        model: modelUsed,
        size: buffer.length,
      };
    }
  }

  // Se não gerou imagem, pega texto de erro
  const textPart = parts.find(p => p.text);
  throw new Error(`Gemini não gerou imagem: ${textPart?.text || 'sem resposta'}`);
}

// ================================================================
// STEP 3: Gerar vídeo com Freepik Kling a partir da imagem
// ================================================================
export async function generateVideoFromImage(imagePath, movements, duration = '5', aspect = '16:9') {
  log.ai.info({ imagePath, movements: movements?.slice(0, 80), duration, aspect }, 'VideoPipeline Step 3: gerando vídeo');

  const prompt = movements || 'Subtle natural movements: person breathes naturally, slight head movement, environment has gentle motion like wind or light changes. Cinematic slow camera movement.';

  const result = await gerarVideoDeImagem(prompt, imagePath, {
    modelo: 'kling-pro',
    aspecto: aspect,
    duracao: duration,
  });

  if (!result.success) {
    // Fallback para modelo standard
    log.ai.warn({ err: result.error }, 'VideoPipeline Step 3: kling-pro falhou, tentando kling-std');
    const fallback = await gerarVideoDeImagem(prompt, imagePath, {
      modelo: 'kling-std',
      aspecto: aspect,
      duracao: duration,
    });
    if (!fallback.success) {
      throw new Error(`Vídeo falhou em todos os modelos: ${fallback.error}`);
    }
    return fallback;
  }

  return result;
}

// ================================================================
// STEP 4: Gerar narração com voz do Alisson + combinar com vídeo
// ================================================================
async function generateSFX(prompt, duration = '5') {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    log.ai.warn('VideoPipeline: sem ElevenLabs key — pulando SFX');
    return null;
  }

  const durationSec = parseFloat(duration) || 5;
  log.ai.info({ prompt: prompt.slice(0, 80), duration: durationSec }, 'VideoPipeline: gerando SFX');

  try {
    const sfxRes = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt, duration_seconds: durationSec, prompt_influence: 0.4 }),
    });
    if (!sfxRes.ok) throw new Error(`HTTP ${sfxRes.status}`);

    const sfxPath = join(TMP_DIR, 'videos', `sfx_${Date.now()}.mp3`);
    writeFileSync(sfxPath, Buffer.from(await sfxRes.arrayBuffer()));
    log.ai.info({ path: sfxPath }, 'VideoPipeline: SFX gerado');
    return sfxPath;
  } catch (e) {
    log.ai.warn({ err: e.message }, 'VideoPipeline: SFX falhou');
    return null;
  }
}

async function generateNarration(text, durationSec = 5) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  // Usa voz clonada do Alisson para vídeos pessoais, fallback para voz padrão da Zaya
  const voiceId = process.env.ELEVENLABS_ALISSON_VOICE_ID || process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    log.ai.warn('VideoPipeline: sem ElevenLabs key ou voice ID — pulando narração');
    return null;
  }

  const isAlissonVoice = voiceId === process.env.ELEVENLABS_ALISSON_VOICE_ID;
  // Voz clonada do Alisson usa v2.5 (melhor fidelidade), Zaya usa v3
  const model = isAlissonVoice ? 'eleven_multilingual_v2' : 'eleven_v3';
  log.ai.info({ text: text.slice(0, 80), voiceId, voice: isAlissonVoice ? 'Alisson' : 'Zaya', model }, 'VideoPipeline Step 4: gerando narração');

  const voiceSettings = isAlissonVoice
    ? { stability: 0.45, similarity_boost: 0.92, style: 0.35, use_speaker_boost: true }
    : { stability: 0.3, similarity_boost: 0.75, style: 0.55, use_speaker_boost: true };

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: text.slice(0, 1000),
      model_id: model,
      voice_settings: voiceSettings,
    }),
  });

  if (!res.ok) {
    log.ai.warn({ status: res.status }, 'VideoPipeline: ElevenLabs narração falhou');
    return null;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const audioPath = join(TMP_DIR, 'videos', `narration_${Date.now()}.mp3`);
  writeFileSync(audioPath, buffer);
  log.ai.info({ path: audioPath, size: buffer.length }, 'VideoPipeline: narração gerada');
  return audioPath;
}

async function mergeVideoAudio(videoPath, audioPath, outputPath, audioVolume = 1.0) {
  log.ai.info({ videoPath, audioPath, outputPath, audioVolume }, 'VideoPipeline: mesclando vídeo + áudio');

  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
    const origVol = audioVolume >= 0.8 ? 0.3 : 0.5; // Se áudio novo é alto, abaixa o original
    const cmd = `"${ffmpegPath}" -i "${videoPath}" -i "${audioPath}" -filter_complex "[0:a]volume=${origVol}[va];[1:a]volume=${audioVolume}[na];[va][na]amix=inputs=2:duration=shortest[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${outputPath}" -y 2>/dev/null || "${ffmpegPath}" -i "${videoPath}" -i "${audioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -shortest "${outputPath}" -y`;

    execSync(cmd, { timeout: 60000 });
    if (existsSync(outputPath)) {
      log.ai.info({ path: outputPath }, 'VideoPipeline: vídeo com narração pronto');
      resolve(outputPath);
    } else {
      reject(new Error('FFmpeg não gerou o arquivo final'));
    }
  });
}

// ================================================================
// PIPELINE COMPLETO: referência → análise → imagem → vídeo → narração
// ================================================================
export async function runVideoPipeline(options = {}) {
  const {
    referenceImage = null,
    sceneDescription = '',
    movements = '',
    duration = '5',
    aspect = '16:9',
    narration = '',
    statusCallback = null,
  } = options;

  const report = (msg) => {
    log.ai.info({}, `VideoPipeline: ${msg}`);
    if (statusCallback) statusCallback(msg);
    // Emite direto pro dashboard (amarelo + ação)
    io?.emit('zaya-executing', { text: msg, timestamp: Date.now() });
  };

  const result = {
    steps: [],
    sceneJson: null,
    imagePath: null,
    videoPath: null,
    videoUrl: null,
    imageUrl: null,
  };

  try {
    // ── STEP 1: Analisar referência (se houver) ──
    let sceneJson = null;
    if (referenceImage && existsSync(referenceImage)) {
      report('Etapa 1/3: Analisando imagem de referência com GPT-4o Vision...');
      sceneJson = await analyzeReferenceImage(referenceImage);
      result.sceneJson = sceneJson;
      result.steps.push({ step: 1, status: 'ok', detail: 'Imagem analisada' });
    } else if (sceneDescription) {
      // Sem imagem de referência — cria JSON a partir da descrição do usuário
      report('Etapa 1/3: Montando cena a partir da descrição...');
      sceneJson = {
        scene: sceneDescription,
        mood: 'natural',
        style: 'cinematic photography',
        lighting: { type: 'natural', quality: 'soft', color_temperature: 'warm' },
        camera: { angle: 'eye-level', distance: 'medium', depth_of_field: 'shallow' },
      };
      result.sceneJson = sceneJson;
      result.steps.push({ step: 1, status: 'ok', detail: 'Cena montada da descrição' });
    } else {
      throw new Error('Forneça uma imagem de referência OU uma descrição da cena.');
    }

    // ── STEP 2: Gerar imagem com rosto do Alisson ──
    report('Etapa 2/3: Gerando imagem personalizada com seu rosto via NanoBanana...');
    // Combina análise JSON + descrição do usuário pra máxima fidelidade
    const fullSceneDesc = sceneDescription + (sceneJson?.scene ? '\nDetailed scene: ' + sceneJson.scene : '') + (sceneJson?.clothing_style ? '\nClothing: ' + sceneJson.clothing_style : '') + (sceneJson?.pose_suggestion ? '\nPose: ' + sceneJson.pose_suggestion : '');
    const imageResult = await generatePersonalizedImage(sceneJson, fullSceneDesc);
    if (!imageResult.success) {
      throw new Error('Falha ao gerar imagem personalizada: ' + (imageResult.error || 'sem detalhes'));
    }
    result.imagePath = imageResult.path;
    result.steps.push({ step: 2, status: 'ok', detail: `Imagem gerada (${imageResult.model})` });

    // Upload da imagem para Supabase
    try {
      const imgUpload = await uploadToStorage(imageResult.path, 'zaya-files', 'pipeline');
      result.imageUrl = imgUpload.publicUrl;
    } catch (e) {
      log.ai.warn({ err: e.message }, 'VideoPipeline: upload imagem falhou (continua)');
    }

    // ── STEP 3: Gerar vídeo a partir da imagem ──
    report('Etapa 3/3: Gerando vídeo com Freepik Kling (pode demorar 2-5 min)...');
    const videoResult = await generateVideoFromImage(imageResult.path, movements, duration, aspect);
    result.videoPath = videoResult.path;
    result.steps.push({ step: 3, status: 'ok', detail: `Vídeo gerado (${videoResult.engine})` });

    // Upload do vídeo para Supabase
    try {
      const vidUpload = await uploadToStorage(videoResult.path, 'zaya-files', 'videos');
      result.videoUrl = vidUpload.publicUrl;
    } catch (e) {
      log.ai.warn({ err: e.message }, 'VideoPipeline: upload vídeo falhou');
      result.videoUrl = videoResult.url || null;
    }

    // ── STEP 4: Efeitos sonoros ambientais (SFX) via ElevenLabs ──
    if (options.sfx !== false) {
      report('Etapa 4: Gerando efeitos sonoros ambientais...');
      try {
        const sfxPrompt = sceneJson?.scene
          ? `Ambient sound effects for: ${sceneJson.scene.slice(0, 150)}. Subtle, cinematic, immersive background`
          : 'Subtle cinematic ambient background, atmospheric, immersive';
        const sfxPath = await generateSFX(sfxPrompt, duration);
        if (sfxPath) {
          report('Mesclando vídeo + efeitos sonoros...');
          const withSfxPath = join(TMP_DIR, 'videos', `pipeline_sfx_${Date.now()}.mp4`);
          await mergeVideoAudio(result.videoPath, sfxPath, withSfxPath, 0.5);
          result.videoPath = withSfxPath;
          result.steps.push({ step: 4, status: 'ok', detail: 'SFX adicionado' });
        } else {
          result.steps.push({ step: 4, status: 'skip', detail: 'SFX indisponível' });
        }
      } catch (e) {
        log.ai.warn({ err: e.message }, 'VideoPipeline: SFX falhou (continua sem)');
        result.steps.push({ step: 4, status: 'warn', detail: `SFX falhou: ${e.message}` });
      }
    }

    // ── STEP 5: Narração com voz do Alisson (se tiver texto) ──
    if (narration && narration.trim()) {
      report('Etapa 5: Gerando narração com sua voz...');
      try {
        const audioPath = await generateNarration(narration);
        if (audioPath) {
          report('Mesclando vídeo + narração...');
          const finalPath = join(TMP_DIR, 'videos', `pipeline_final_${Date.now()}.mp4`);
          await mergeVideoAudio(result.videoPath, audioPath, finalPath);
          result.videoPath = finalPath;
          result.steps.push({ step: 5, status: 'ok', detail: 'Narração adicionada com voz do Alisson' });

          // Re-upload do vídeo final
          try {
            const vidUpload = await uploadToStorage(finalPath, 'zaya-files', 'videos');
            result.videoUrl = vidUpload.publicUrl;
          } catch {}
        } else {
          result.steps.push({ step: 5, status: 'skip', detail: 'Narração indisponível (sem API key)' });
        }
      } catch (e) {
        log.ai.warn({ err: e.message }, 'VideoPipeline: narração falhou (vídeo continua sem)');
        result.steps.push({ step: 5, status: 'warn', detail: `Narração falhou: ${e.message}` });
      }
    }

    report('Pipeline concluído com sucesso!');
    return result;

  } catch (error) {
    log.ai.error({ err: error.message, steps: result.steps }, 'VideoPipeline: falha no pipeline');
    result.error = error.message;
    result.steps.push({ step: result.steps.length + 1, status: 'error', detail: error.message });
    return result;
  }
}
