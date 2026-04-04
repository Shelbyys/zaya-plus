import { Router } from 'express';
import {
  checkLocalLicense,
  activateLicense,
  deactivateLicense,
  generateLicense,
  listLicenses,
} from '../services/license.js';
import { log } from '../logger.js';

const router = Router();

const ADMIN_PASSWORD = process.env.LICENSE_ADMIN_PASSWORD || null;

// --- Public endpoints ---

// GET /status — Check if this machine is licensed
router.get('/status', async (req, res) => {
  try {
    const result = await checkLocalLicense();
    if (result.valid) {
      // Mask token: show first 8 chars + ...
      const masked = result.token
        ? result.token.slice(0, 8) + '...' + result.token.slice(-4)
        : 'unknown';
      return res.json({ licensed: true, plan: result.plan, token: masked });
    }
    return res.json({ licensed: false, plan: null, token: null });
  } catch (err) {
    log.server.error(`License status error: ${err.message}`);
    return res.status(500).json({ licensed: false, error: err.message });
  }
});

// POST /activate — Activate a license token on this machine
router.post('/activate', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, error: 'Token obrigatorio' });
    }

    const result = await activateLicense(token.trim());
    if (result.valid) {
      return res.json({ success: true, plan: result.plan });
    }
    return res.status(403).json({ success: false, error: result.error });
  } catch (err) {
    log.server.error(`License activation error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /deactivate — Deactivate license (for support/transfers)
router.post('/deactivate', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, error: 'Token obrigatorio' });
    }

    const result = await deactivateLicense(token.trim());
    return res.json({ success: result.success });
  } catch (err) {
    log.server.error(`License deactivation error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- Admin endpoints (password-protected) ---

function checkAdmin(password) {
  // If LICENSE_ADMIN_PASSWORD is not set in env, ALL admin ops are blocked
  if (!ADMIN_PASSWORD) return false;
  return password === ADMIN_PASSWORD;
}

// POST /admin/generate — Generate a new license token
router.post('/admin/generate', async (req, res) => {
  try {
    if (!ADMIN_PASSWORD) {
      return res.status(403).json({ error: 'LICENSE_ADMIN_PASSWORD nao configurada no ambiente' });
    }

    const { plan, email, name, password } = req.body;

    if (!checkAdmin(password)) {
      return res.status(401).json({ error: 'Senha admin invalida' });
    }

    if (!plan || !email || !name) {
      return res.status(400).json({ error: 'plan, email e name sao obrigatorios' });
    }

    const validPlans = ['basic', 'pro', 'enterprise'];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({ error: `Plan invalido. Use: ${validPlans.join(', ')}` });
    }

    const token = await generateLicense(plan, email, name);
    return res.json({ token, plan });
  } catch (err) {
    log.server.error(`License generation error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// GET /admin/list — List all licenses
router.get('/admin/list', async (req, res) => {
  try {
    if (!ADMIN_PASSWORD) {
      return res.status(403).json({ error: 'LICENSE_ADMIN_PASSWORD nao configurada no ambiente' });
    }

    const { password } = req.query;

    if (!checkAdmin(password)) {
      return res.status(401).json({ error: 'Senha admin invalida' });
    }

    const licenses = await listLicenses();
    return res.json(licenses);
  } catch (err) {
    log.server.error(`License list error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
