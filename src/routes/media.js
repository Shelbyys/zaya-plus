import { Router } from 'express';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { TMP_DIR } from '../config.js';
import { runCommand } from '../services/exec.js';
import { sanitizeCommand } from '../middleware/security.js';
import { settingsDB } from '../database.js';

const router = Router();

// Voz persistida no SQLite — sobrevive a restarts
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
let currentVoiceId = settingsDB.get('elevenlabs_voice_id', DEFAULT_VOICE);

router.post('/exec', (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Comando vazio' });
  const check = sanitizeCommand(command);
  if (!check.allowed) return res.status(403).json({ error: check.reason });
  res.json(runCommand(command));
});

router.get('/voices', async (req, res) => {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const response = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey } });
    const data = await response.json();
    res.json({ voices: data.voices.map(v => ({ id: v.voice_id, name: v.name, gender: v.labels?.gender, preview: v.preview_url })), current: currentVoiceId });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/voice', (req, res) => {
  if (!req.body.voiceId) return res.status(400).json({ error: 'voiceId obrigatório' });
  currentVoiceId = req.body.voiceId;
  settingsDB.set('elevenlabs_voice_id', currentVoiceId); // persiste no SQLite
  res.json({ ok: true, current: currentVoiceId });
});

router.post('/speak', async (req, res) => {
  try {
    const text = req.body.text;
    if (!text) return res.status(400).json({ error: 'text obrigatorio' });

    // OpenAI TTS (so funciona com OpenAI real, nao Groq/outros)
    const isGroq = (process.env.OPENAI_BASE_URL || '').includes('groq');
    const isRealOpenAI = process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-placeholder' && !isGroq;
    const useOpenAI = isRealOpenAI && (!process.env.ELEVENLABS_API_KEY || process.env.TTS_PROVIDER === 'openai');

    if (useOpenAI) {
      const openaiBase = 'https://api.openai.com/v1';
      const response = await fetch(`${openaiBase}/audio/speech`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: process.env.OPENAI_TTS_VOICE || 'nova',
          response_format: 'mp3'
        })
      });
      if (!response.ok) {
        const err = await response.text();
        console.log('[TTS] OpenAI erro:', response.status, err.slice(0, 200));
        // Fallback silencioso — retorna audio vazio em vez de erro
        return res.status(204).end();
      }
      res.set('Content-Type', 'audio/mpeg');
      return res.send(Buffer.from(await response.arrayBuffer()));
    }

    // ElevenLabs TTS
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return res.status(204).end(); // Sem voz — silencioso
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${currentVoiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.4 } }),
    });
    if (!response.ok) return res.status(response.status).json({ error: 'Erro ElevenLabs' });
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/transcribe', async (req, res) => {
  try {
    const { audio } = req.body;
    if (!audio) return res.status(400).json({ error: 'audio obrigatorio' });
    const buf = Buffer.from(audio.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
    const tmpFile = join(TMP_DIR, `mic-${Date.now()}.webm`);
    writeFileSync(tmpFile, buf);

    const boundary = '----ZayaMic' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\npt\r\n`),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const result = await response.json();
    try { unlinkSync(tmpFile); } catch {}
    res.json({ text: result.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
  if (!filePath.startsWith('/tmp/')) return res.status(403).json({ error: 'Acesso negado' });
  res.download(filePath);
});

export default router;
