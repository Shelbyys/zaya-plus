import { Router } from 'express';
import { calendarDB, CATEGORIES } from '../services/calendar.js';

const router = Router();

// Categorias disponíveis
router.get('/categories', (req, res) => {
  res.json(CATEGORIES);
});

// Listar eventos (com filtros)
router.get('/events', (req, res) => {
  const { date, start, end, q } = req.query;
  if (q) return res.json(calendarDB.search(q));
  if (date) return res.json(calendarDB.getByDate(date));
  if (start && end) return res.json(calendarDB.getByRange(start, end));
  res.json(calendarDB.getAll());
});

// Eventos de hoje
router.get('/today', (req, res) => {
  res.json(calendarDB.getToday());
});

// Eventos de amanhã
router.get('/tomorrow', (req, res) => {
  res.json(calendarDB.getTomorrow());
});

// Próximos eventos
router.get('/upcoming', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  res.json(calendarDB.getUpcoming(limit));
});

// Eventos da semana
router.get('/week', (req, res) => {
  res.json(calendarDB.getWeek());
});

// Criar evento
router.post('/events', (req, res) => {
  const id = calendarDB.add(req.body);
  res.json({ ok: true, id });
});

// Atualizar evento
router.put('/events/:id', (req, res) => {
  const ok = calendarDB.update(parseInt(req.params.id), req.body);
  res.json({ ok });
});

// Deletar evento
router.delete('/events/:id', (req, res) => {
  calendarDB.delete(parseInt(req.params.id));
  res.json({ ok: true });
});

// Cancelar evento (soft delete)
router.post('/events/:id/cancel', (req, res) => {
  calendarDB.cancel(parseInt(req.params.id));
  res.json({ ok: true });
});

export default router;
