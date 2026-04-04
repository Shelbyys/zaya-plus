import { Router } from 'express';
import Database from 'better-sqlite3';
import { join } from 'path';
import { ROOT_DIR } from '../config.js';
import { log } from '../logger.js';

const router = Router();
const db = new Database(join(ROOT_DIR, 'zaya.db'));

// ================================================================
// SCHEMA — Agentes + Logs
// ================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'dev',
    status TEXT DEFAULT 'active',
    description TEXT,
    current_task TEXT,
    tasks_completed INTEGER DEFAULT 0,
    room TEXT DEFAULT 'dev',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER,
    agent_name TEXT,
    action TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  CREATE INDEX IF NOT EXISTS idx_agent_logs_created ON agent_logs(created_at DESC);
`);

// Migration: add room column if missing
try {
  db.prepare("SELECT room FROM agents LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE agents ADD COLUMN room TEXT DEFAULT 'dev'");
}

// ================================================================
// PREPARED STATEMENTS
// ================================================================
const stmts = {
  getAll: db.prepare("SELECT * FROM agents ORDER BY (status = 'active') DESC, updated_at DESC"),
  getById: db.prepare('SELECT * FROM agents WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO agents (name, role, status, description, current_task, room)
    VALUES (@name, @role, @status, @description, @current_task, @room)
  `),
  update: db.prepare(`
    UPDATE agents SET name = @name, role = @role, status = @status,
    description = @description, current_task = @current_task, room = @room,
    updated_at = datetime('now')
    WHERE id = @id
  `),
  updateStatus: db.prepare(`
    UPDATE agents SET status = @status, updated_at = datetime('now') WHERE id = @id
  `),
  complete: db.prepare(`
    UPDATE agents SET tasks_completed = tasks_completed + 1,
    current_task = NULL, updated_at = datetime('now') WHERE id = ?
  `),
  delete: db.prepare('DELETE FROM agents WHERE id = ?'),
  insertLog: db.prepare(`
    INSERT INTO agent_logs (agent_id, agent_name, action, message)
    VALUES (@agent_id, @agent_name, @action, @message)
  `),
  getLogs: db.prepare('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT 50'),
};

function addLog(agentId, agentName, action, message) {
  stmts.insertLog.run({ agent_id: agentId, agent_name: agentName, action, message });
}

// ================================================================
// ROUTES
// ================================================================

router.get('/', (req, res) => {
  const agents = stmts.getAll.all();
  res.json({ agents });
});

router.get('/logs', (req, res) => {
  const logs = stmts.getLogs.all();
  res.json({ logs });
});

router.get('/:id', (req, res) => {
  const agent = stmts.getById.get(parseInt(req.params.id));
  if (!agent) return res.status(404).json({ error: 'Agente nao encontrado' });
  res.json({ agent });
});

router.post('/', (req, res) => {
  try {
    const { name, role, status, description, current_task, room } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });

    const result = stmts.insert.run({
      name, role: role || 'dev', status: status || 'active',
      description: description || null, current_task: current_task || null,
      room: room || 'dev'
    });

    addLog(result.lastInsertRowid, name, 'created', `Agente "${name}" contratado para ${room || 'dev'}`);
    log.server.info({ agentId: result.lastInsertRowid, name }, 'Agente criado');

    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = stmts.getById.get(id);
    if (!existing) return res.status(404).json({ error: 'Agente nao encontrado' });

    const { name, role, status, description, current_task, room } = req.body;

    if (status && !name && !role && !description && current_task === undefined && !room) {
      stmts.updateStatus.run({ id, status });
      addLog(id, existing.name, status === 'active' ? 'started' : 'paused',
        `"${existing.name}" mudou para ${status}`);
    } else {
      stmts.update.run({
        id,
        name: name || existing.name,
        role: role || existing.role,
        status: status || existing.status,
        description: description !== undefined ? description : existing.description,
        current_task: current_task !== undefined ? current_task : existing.current_task,
        room: room || existing.room || 'dev'
      });

      if (current_task && current_task !== existing.current_task) {
        addLog(id, name || existing.name, 'started', `Nova tarefa: "${current_task}"`);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/complete', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = stmts.getById.get(id);
    if (!existing) return res.status(404).json({ error: 'Agente nao encontrado' });

    stmts.complete.run(id);
    addLog(id, existing.name, 'completed', `Tarefa concluida: "${existing.current_task || 'sem nome'}"`);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = stmts.getById.get(id);
    if (!existing) return res.status(404).json({ error: 'Agente nao encontrado' });

    stmts.delete.run(id);
    addLog(null, existing.name, 'error', `"${existing.name}" demitido por ZAYA`);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
