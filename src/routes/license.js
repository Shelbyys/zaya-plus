import { Router } from 'express';
import {
  checkLocalLicense,
  activateLicense,
} from '../services/license.js';
import { log } from '../logger.js';

const router = Router();

// --- Public endpoints only (admin endpoints are on render-server) ---

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

// GET /fingerprint — Return this machine's fingerprint
router.get('/fingerprint', async (req, res) => {
  try {
    const { getMachineFingerprint } = await import('../services/license.js');
    res.json({ fingerprint: getMachineFingerprint() });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

export default router;
