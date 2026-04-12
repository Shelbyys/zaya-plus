// ================================================================
// ROTAS /api/ig-schedule — Gerenciar agendamentos Instagram
// ================================================================
import { Router } from 'express';
import { createScheduledPost, createBulkSchedule, listScheduledPosts, cancelScheduledPost, cancelCampaign } from '../services/ig-scheduler.js';
import { uploadToStorage } from '../services/supabase.js';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// POST /api/ig-schedule — Agendar um post
router.post('/', async (req, res) => {
  try {
    const result = await createScheduledPost(req.body);
    res.json({ success: true, post: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/ig-schedule/bulk — Agendar vários posts de uma vez
router.post('/bulk', async (req, res) => {
  try {
    const { posts } = req.body;
    if (!posts?.length) return res.status(400).json({ error: 'posts[] obrigatório' });
    const results = await createBulkSchedule(posts);
    const ok = results.filter(r => r.success).length;
    res.json({ success: true, total: posts.length, created: ok, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ig-schedule/upload — Upload de mídia + agendar
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo obrigatório' });

    // Salva temporário e upload pro Supabase
    const tmpPath = join('/tmp', `ig_upload_${Date.now()}_${req.file.originalname}`);
    writeFileSync(tmpPath, req.file.buffer);

    const folder = req.file.mimetype?.startsWith('video') ? 'videos' : 'imagens';
    const uploadResult = await uploadToStorage(tmpPath, 'zaya-files', folder);
    try { unlinkSync(tmpPath); } catch {}

    if (!uploadResult?.publicUrl) return res.status(500).json({ error: 'Upload falhou' });

    // Se tem dados de agendamento, cria o post
    if (req.body.scheduled_at) {
      const post = await createScheduledPost({
        type: req.body.type || 'feed',
        media_url: uploadResult.publicUrl,
        caption: req.body.caption || '',
        hashtags: req.body.hashtags || '',
        scheduled_at: req.body.scheduled_at,
        campaign_name: req.body.campaign_name || '',
      });
      res.json({ success: true, url: uploadResult.publicUrl, post });
    } else {
      // Só upload, sem agendar
      res.json({ success: true, url: uploadResult.publicUrl });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ig-schedule — Listar agendamentos
router.get('/', async (req, res) => {
  try {
    const posts = await listScheduledPosts({
      status: req.query.status || undefined,
      campaign: req.query.campaign || undefined,
      type: req.query.type || undefined,
      limit: parseInt(req.query.limit) || 50,
    });
    res.json({ posts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/ig-schedule/:id — Cancelar um agendamento
router.delete('/:id', async (req, res) => {
  try {
    await cancelScheduledPost(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/ig-schedule/campaign/:name — Cancelar campanha inteira
router.delete('/campaign/:name', async (req, res) => {
  try {
    const count = await cancelCampaign(req.params.name);
    res.json({ success: true, cancelled: count });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
