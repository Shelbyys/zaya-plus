import { exec, execSync, spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'fs';
import os from 'os';
import { join, basename, extname, dirname } from 'path';
import { FFMPEG, FFPROBE, WHISPER_BIN, TMP_DIR, MUSIC_DIR, TOOLS_DIR } from '../config.js';
import { openai } from '../state.js';

const HOME = os.homedir();
let CLAUDE_BIN = 'claude';
try { const cmd = process.platform === 'win32' ? 'where claude' : 'which claude'; CLAUDE_BIN = execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe','pipe','ignore'] }).trim().split('\n')[0] || 'claude'; } catch(e) {}

// ================================================================
// WHISPER / TRANSCRIÇÃO
// ================================================================
export async function whisperTranscribe(audioPath, outputFormat = 'json') {
  // Tenta OpenAI Whisper API primeiro (muito mais preciso)
  if (process.env.OPENAI_API_KEY) {
    try {
      const fileData = readFileSync(audioPath);
      const fileBlob = new Blob([fileData], { type: 'audio/wav' });
      const fd = new FormData();
      fd.append('file', fileBlob, basename(audioPath));
      fd.append('model', 'whisper-1');
      fd.append('language', 'pt');
      fd.append('response_format', 'json');

      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: fd,
      });

      if (r.ok) {
        const data = await r.json();
        console.log('[WHISPER-API] Transcrito:', data.text?.slice(0, 80));
        return { text: data.text || '' };
      }
      console.log('[WHISPER-API] Falhou:', r.status, await r.text().catch(() => ''));
    } catch (e) {
      console.log('[WHISPER-API] Erro:', e.message);
    }
  }

  // Fallback: Whisper local
  return new Promise((resolve, reject) => {
    const outDir = dirname(audioPath);
    exec(`${WHISPER_BIN} "${audioPath}" --model base --language pt --output_format ${outputFormat} --output_dir "${outDir}"`, {
      timeout: 120000,
      env: { ...process.env, PATH: `${process.env.PATH || ''}:${HOME}/Library/Python/3.9/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
    }, (err) => {
      if (err) { reject(err); return; }
      const baseName = basename(audioPath, extname(audioPath));
      const outFile = join(outDir, `${baseName}.${outputFormat}`);
      if (existsSync(outFile)) {
        try {
          const data = readFileSync(outFile, 'utf-8');
          resolve(outputFormat === 'json' ? JSON.parse(data) : data);
        } catch (e) { reject(e); }
      } else { reject(new Error('Whisper sem output')); }
    });
  });
}

// ================================================================
// VIDEO EDITING
// ================================================================
function formatASS(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const cs = Math.floor((seconds % 1) * 100).toString().padStart(2, '0');
  return `${h}:${m}:${s}.${cs}`;
}

async function transcribeVideoAudio(videoPath, resolution) {
  try {
    const audioPath = videoPath.replace(/\.[^.]+$/, '_audio.wav');
    await new Promise((resolve, reject) => {
      exec(`${FFMPEG} -y -i "${videoPath}" -vn -ar 16000 -ac 1 -c:a pcm_s16le "${audioPath}"`, { timeout: 60000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    if (!existsSync(audioPath)) return null;

    const transcription = await whisperTranscribe(audioPath, 'json');
    try { unlinkSync(audioPath); } catch {}

    if (!transcription.segments || transcription.segments.length === 0) return null;

    const assPath = videoPath.replace(/\.[^.]+$/, '.ass');
    const [w, h] = (resolution || '1280x720').split('x').map(Number);
    const fontSize = Math.round(h * 0.045);
    const marginV = Math.round(h * 0.06);
    const outlineSize = Math.max(2, Math.round(fontSize * 0.12));
    const shadowSize = Math.max(1, Math.round(fontSize * 0.06));

    let ass = `[Script Info]\nTitle: Auto Subtitles\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Helvetica Neue,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,1.5,0,1,${outlineSize},${shadowSize},2,40,40,${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    transcription.segments.forEach((seg) => {
      const start = formatASS(seg.start);
      const end = formatASS(seg.end);
      const text = seg.text.trim().replace(/\n/g, '\\N');
      ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\fad(150,150)}${text}\n`;
    });

    writeFileSync(assPath, ass);
    return { assPath, text: transcription.text, segments: transcription.segments };
  } catch { return null; }
}

async function getVideoInfo(videoPath) {
  return new Promise((resolve) => {
    exec(`${FFPROBE} -v quiet -print_format json -show_format -show_streams "${videoPath}"`, { timeout: 15000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

function listMusic() {
  try { return readdirSync(MUSIC_DIR).filter(f => /\.(mp3|m4a|ogg|wav|aac)$/i.test(f)); } catch { return []; }
}

export async function editVideo(videoBuffer, mimetype, instruction, statusCallback) {
  try {
    const ts = Date.now();
    const ext = mimetype.includes('mp4') ? 'mp4' : mimetype.includes('quicktime') ? 'mov' : 'mp4';
    const inputPath = join(TMP_DIR, `video_in_${ts}.${ext}`);
    const outputPath = join(TMP_DIR, `video_out_${ts}.mp4`);
    writeFileSync(inputPath, videoBuffer);

    const fileSize = (statSync(inputPath).size / 1024 / 1024).toFixed(1);
    if (statusCallback) await statusCallback('Analisando vídeo...');
    const videoInfo = await getVideoInfo(inputPath);
    const duration = videoInfo?.format?.duration ? parseFloat(videoInfo.format.duration).toFixed(1) : '?';
    const videoStream = videoInfo?.streams?.find(s => s.codec_type === 'video');
    const resolution = videoStream ? `${videoStream.width}x${videoStream.height}` : '?';

    let subtitleInfo = '';
    if (/legenda|subtitle|caption|transcrição|transcrever/i.test(instruction)) {
      if (statusCallback) await statusCallback('Transcrevendo áudio para legendas...');
      const subs = await transcribeVideoAudio(inputPath, resolution);
      if (subs) {
        subtitleInfo = `\nLEGENDAS ASS: ${subs.assPath}\nTexto: "${subs.text}"\nSegmentos: ${subs.segments.length}\nQueimar: ass=${subs.assPath}`;
      }
    }

    const needsMusic = /música|musica|music|trilha|fundo musical/i.test(instruction);
    let musicFiles = listMusic();
    const musicInfo = musicFiles.length > 0
      ? `\nMÚSICAS: ${musicFiles.map(f => join(MUSIC_DIR, f)).join(', ')}`
      : '';

    if (statusCallback) await statusCallback('Editando com IA...');

    const prompt = `Editor de vídeo CINEMATOGRÁFICO profissional.\nENTRADA: ${inputPath}\nSAÍDA: ${outputPath}\nDURAÇÃO: ${duration}s | RES: ${resolution} | ${fileSize}MB\nFFMPEG: ${FFMPEG}\nFFPROBE: ${FFPROBE}\nPYTHON TOOLS: ${TOOLS_DIR}/\n${subtitleInfo}${musicInfo}\n\nINSTRUÇÃO: "${instruction}"\n\nAplique: color grading, vinheta, fade, loudnorm, scale max 1280x720.\nCodec: -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 192k -movflags +faststart\nExecute via Bash. Responda APENAS "OK" ou mensagem de erro.`;

    return new Promise((resolve) => {
      const child = spawn(CLAUDE_BIN, ['-p', '--dangerously-skip-permissions', '--allowedTools', 'Bash,Read'], {
        cwd: TMP_DIR, timeout: 600000, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME },
      });
      let output = '';
      child.stdout.on('data', d => { output += d.toString(); });
      child.stderr.on('data', d => { output += d.toString(); });
      child.on('close', () => {
        if (existsSync(outputPath)) {
          try { unlinkSync(inputPath); } catch {}
          resolve({ path: outputPath, message: output.slice(0, 500) });
        } else {
          try { unlinkSync(inputPath); } catch {}
          resolve({ path: null, message: output.slice(0, 1000) || 'Erro na edição' });
        }
      });
      child.on('error', () => resolve({ path: null, message: 'Erro ao iniciar Claude Code' }));
      child.stdin.write(prompt);
      child.stdin.end();
    });
  } catch (e) {
    return { path: null, message: e.message };
  }
}

// ================================================================
// IMAGE GENERATION (DALL-E 3)
// ================================================================
let _imageGenActive = 0;
const MAX_CONCURRENT_IMAGES = 2;

export async function generateImage(prompt) {
  if (_imageGenActive >= MAX_CONCURRENT_IMAGES) {
    console.warn(`DALL-E: limite de ${MAX_CONCURRENT_IMAGES} gerações simultâneas atingido`);
    return null;
  }
  _imageGenActive++;
  try {
    const response = await openai.images.generate({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024' });
    const imageUrl = response.data[0].url;
    const imagePath = join(TMP_DIR, `img_${Date.now()}.png`);
    const res = await fetch(imageUrl);
    writeFileSync(imagePath, Buffer.from(await res.arrayBuffer()));
    return imagePath;
  } catch (e) {
    console.error('Erro DALL-E:', e.message);
    return null;
  } finally {
    _imageGenActive--;
  }
}

// ================================================================
// VIDEO SESSION (questionário interativo)
// ================================================================
import { videoSessions } from '../state.js';

const VIDEO_QUESTIONS = [
  { key: 'objetivo', question: '*Vídeo recebido!*\n\n*1. Qual o objetivo?*\nEx: Reels, TikTok, YouTube, apresentação...' },
  { key: 'legendas', question: '*2. Legendas?*\n\n1 Padrão (branco)\n2 Neon (ciano/magenta)\n3 Karaokê\n4 Minimal\n5 Sem legendas' },
  { key: 'musica', question: '*3. Música de fundo?*\n\n1 Sim, automática\n2 Não, manter áudio\n3 Só música (remove áudio)' },
  { key: 'cortes', question: '*4. Cortes?*\n\n1 Vídeo inteiro\n2 Sim (descreva)\n3 Remover silêncios' },
  { key: 'efeitos', question: '*5. Efeitos?*\n\n1 Cinematográfico\n2 Sem efeitos\n3 Acelerar 2x\n4 Câmera lenta\n5 Outro' },
  { key: 'extras', question: '*6. Algo mais?* (ou "pronto" para editar)' },
];

export function startVideoSession(jid, videoBuffer, mimetype) {
  videoSessions[jid] = { videoBuffer, mimetype, step: 0, answers: {}, createdAt: Date.now() };
  setTimeout(() => { delete videoSessions[jid]; }, 10 * 60 * 1000);
  return VIDEO_QUESTIONS[0].question;
}

export function processVideoAnswer(jid, answer) {
  const session = videoSessions[jid];
  if (!session) return null;
  session.answers[VIDEO_QUESTIONS[session.step].key] = answer;
  session.step++;
  if (session.step >= VIDEO_QUESTIONS.length || /^pronto$/i.test(answer)) {
    return { done: true, answers: session.answers };
  }
  return { done: false, question: VIDEO_QUESTIONS[session.step].question };
}

export function buildInstruction(answers) {
  const parts = [];
  if (answers.objetivo) parts.push(`Objetivo: ${answers.objetivo}`);
  const legMap = { '1': 'legendas padrão', '2': 'legendas neon', '3': 'legendas karaokê', '4': 'legendas minimal' };
  if (legMap[answers.legendas?.trim()]) parts.push(legMap[answers.legendas.trim()]);
  const musMap = { '1': 'música automática', '2': 'manter áudio', '3': 'só música' };
  if (musMap[answers.musica?.trim()]) parts.push(musMap[answers.musica.trim()]);
  const efMap = { '1': 'cinematográfico', '2': 'sem efeitos', '3': 'acelerar 2x', '4': 'câmera lenta' };
  if (efMap[answers.efeitos?.trim()]) parts.push(efMap[answers.efeitos.trim()]);
  if (answers.extras && !/^pronto$/i.test(answers.extras)) parts.push(answers.extras);
  return parts.join('. ') || 'edição cinematográfica completa';
}
