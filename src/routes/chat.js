import { Router } from 'express';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, extname } from 'path';
import multer from 'multer';
import { openai, conversationHistory, io } from '../state.js';
import { processVoiceChat, processVoiceVision } from '../services/ai.js';
import { doResearch } from '../services/research.js';
import { messagesDB } from '../database.js';
import { TMP_DIR, AI_MODEL_MINI, ADMIN_NAME } from '../config.js';
import { uploadToStorage } from '../services/supabase.js';

const router = Router();

const uploadDir = join(TMP_DIR, 'uploads');
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB max

function getUploadPasta(ext) {
  const map = { '.mp4': 'videos', '.mov': 'videos', '.avi': 'videos', '.webm': 'videos', '.mp3': 'audios', '.wav': 'audios', '.ogg': 'audios', '.pdf': 'documentos', '.pptx': 'slides', '.docx': 'documentos', '.xlsx': 'documentos' };
  return map[ext] || 'uploads';
}

// Upload de arquivos (multipart FormData via multer)
router.post('/upload-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo recebido' });

    const filePath = req.file.path;
    const fileName = req.file.filename;
    const fileSize = req.file.size;

    // Upload para Supabase Storage
    let publicUrl = '';
    try {
      const pasta = getUploadPasta(extname(req.file.originalname).toLowerCase());
      const result = await uploadToStorage(filePath, 'zaya-files', pasta);
      publicUrl = result.publicUrl || '';
    } catch (e) { console.warn('[UPLOAD] Supabase falhou:', e.message); }

    res.json({ path: filePath, name: fileName, url: publicUrl, size: fileSize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/chat', async (req, res) => {
  try {
    const { message, stream } = req.body;

    if (!stream) {
      // Modo normal — function calling resolve tudo
      const response = await processVoiceChat(message);
      return res.json({ response });
    }

    // === STREAMING MODE ===
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch(e) {} };

    // Keep-alive: envia ping a cada 15s para não morrer a conexão
    const keepAlive = setInterval(() => send('ping', { ts: Date.now() }), 15000);

    send('stage', { stage: 'thinking', text: 'Processando...' });

    const statusCb = async (stage, detail) => {
      send('stage', { stage, text: detail || (stage === 'executing' ? 'Executando ferramenta...' : 'Processando...') });
    };

    try {
      const response = await processVoiceChat(message, statusCb);
      send('stage', { stage: 'done', text: response });
      send('result', { response });
    } catch (e) {
      send('error', { error: e.message });
    } finally {
      clearInterval(keepAlive);
      res.end();
    }
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else { res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`); res.end(); }
  }
});

router.post('/vision', async (req, res) => {
  try {
    const { image, message } = req.body;
    const response = await processVoiceVision(image, message);
    res.json({ response });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/reset', (req, res) => {
  conversationHistory.length = 0;
  res.json({ ok: true });
});

router.post('/pesquisa', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query vazia' });

    console.log(`[API Pesquisa] Iniciando: "${query}"`);
    const research = await doResearch(query);

    if (!research.success) {
      conversationHistory.push({ role: 'assistant', content: `Não consegui pesquisar sobre "${query}". ${research.summary}` });
      return res.json({ spoken: `Desculpe ${ADMIN_NAME || 'chefe'}, tive um problema na pesquisa. ${research.summary}` });
    }

    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      title: `Pesquisa: ${query}`,
      content: research.content,
      type: 'pesquisa',
    };
    messagesDB.add(msg);
    io?.emit('new-message', msg);

    const summaryRes = await openai.chat.completions.create({
      model: AI_MODEL_MINI, max_tokens: 200,
      messages: [
        { role: 'system', content: `Voce e a ZAYA, assistente do ${ADMIN_NAME || 'usuario'}. Resuma em 2-3 frases CURTAS o que encontrou na pesquisa. Fale de forma natural. Diga que mandou os detalhes no painel de mensagens.` },
        { role: 'user', content: `Pesquisa sobre "${query}". Resumo:\n${research.content.slice(0, 2000)}` },
      ],
    });

    const spoken = summaryRes.choices[0].message.content;
    conversationHistory.push({ role: 'assistant', content: spoken });
    res.json({ spoken, filename: research.filename });
  } catch (e) {
    console.error('[API Pesquisa] Erro:', e.message);
    res.json({ spoken: `Vixe, deu um erro na pesquisa, ${ADMIN_NAME || 'chefe'}. ${e.message}` });
  }
});

// ================================================================
// VR — recebe áudio, transcreve, processa, retorna texto + áudio
// ================================================================
router.post('/vr/ask', upload.single('audio'), async (req, res) => {
  try {
    let text = req.body.text || '';

    // Se recebeu áudio, transcreve com Whisper API
    if (req.file) {
      const fileData = require('fs').readFileSync(req.file.path);
      const blob = new Blob([fileData], { type: 'audio/webm' });
      const fd = new FormData();
      fd.append('file', blob, 'audio.webm');
      fd.append('model', 'whisper-1');
      fd.append('language', 'pt');
      fd.append('response_format', 'json');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: fd,
      });

      if (whisperRes.ok) {
        const data = await whisperRes.json();
        text = data.text || '';
      }
      try { require('fs').unlinkSync(req.file.path); } catch {}
    }

    if (!text) return res.json({ text: '', reply: 'Não entendi. Pode repetir?', audioUrl: '' });

    // Processa com IA
    const response = await processVoiceChat(text);

    // Gera URL de áudio (ElevenLabs via /api/speak)
    const audioUrl = `/api/speak?text=${encodeURIComponent(response.slice(0, 500))}`;

    res.json({ text, reply: response, audioUrl });
  } catch (e) {
    res.json({ text: '', reply: `Erro: ${e.message}`, audioUrl: '' });
  }
});

export default router;
