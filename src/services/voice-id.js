// ================================================================
// VOICE ID — Reconhecimento de voz com embeddings reais (resemblyzer)
// Verificação local, sem API calls, ~100ms por verificação
// ================================================================
import { spawn } from 'child_process';
import { log } from '../logger.js';
import { PYTHON3, TOOLS_DIR } from '../config.js';
import { join } from 'path';
import { existsSync } from 'fs';

const SCRIPT = join(TOOLS_DIR, 'speaker_verify.py');
let voiceEnabled = true; // sempre ativo por padrão

// ================================================================
// CHAMAR SCRIPT PYTHON
// ================================================================
function runSpeakerVerify(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON3, [SCRIPT, ...args], {
      timeout: 15000,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      try {
        const result = JSON.parse(stdout.trim().split('\n').pop());
        resolve(result);
      } catch (e) {
        reject(new Error(`speaker_verify falhou (code ${code}): ${stderr.slice(-200)}`));
      }
    });
    proc.on('error', reject);
  });
}

// ================================================================
// CADASTRAR AMOSTRA DE VOZ (embedding real)
// ================================================================
export async function addVoiceSample(audioPath) {
  try {
    if (!existsSync(audioPath)) return { success: false, error: 'Arquivo não encontrado' };
    const result = await runSpeakerVerify(['enroll', '--audio', audioPath, '--profile', 'owner']);
    log.ai.info({ samples: result.total_samples }, 'Voice sample cadastrada (embedding)');
    return result;
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro voice sample');
    return { success: false, error: e.message };
  }
}

// ================================================================
// VERIFICAR SE É A VOZ DO DONO (embedding comparison, ~100ms)
// ================================================================
export async function verifyVoice(audioPath) {
  if (!voiceEnabled) return { verified: true, confidence: 1, reason: 'Voice ID desativado' };
  if (!existsSync(audioPath)) return { verified: false, confidence: 0, reason: 'Arquivo não encontrado' };

  try {
    const st = await runSpeakerVerify(['status', '--profile', 'owner']);
    if (!st.ready) return { verified: true, confidence: 1, reason: 'Sem perfil suficiente' };

    const result = await runSpeakerVerify(['verify', '--audio', audioPath, '--profile', 'owner']);
    log.ai.info({ match: result.match, confidence: result.confidence }, 'Voice verification (embedding)');

    return {
      verified: result.match,
      confidence: result.confidence,
      reason: result.reason,
    };
  } catch (e) {
    log.ai.warn({ err: e.message }, 'Erro voice verify');
    // Em caso de erro, REJEITA (fail-closed)
    return { verified: false, confidence: 0, reason: 'Erro na verificação' };
  }
}

// ================================================================
// ATIVAR/DESATIVAR VOICE ID
// ================================================================
export function enableVoiceId(enable = true) {
  voiceEnabled = enable;
  log.ai.info({ enabled: voiceEnabled }, 'Voice ID ' + (enable ? 'ativado' : 'desativado'));
  return { enabled: voiceEnabled };
}

// ================================================================
// STATUS DO VOICE ID
// ================================================================
export async function getVoiceIdStatus() {
  try {
    const st = await runSpeakerVerify(['status', '--profile', 'owner']);
    return {
      enabled: voiceEnabled,
      samples: st.samples,
      ready: st.ready && voiceEnabled,
      hasCentroid: st.has_centroid,
    };
  } catch {
    return { enabled: voiceEnabled, samples: 0, ready: false };
  }
}

// ================================================================
// CARREGAR PERFIL (startup — noop, perfil fica em disco)
// ================================================================
export async function loadVoiceProfile() {
  try {
    const st = await runSpeakerVerify(['status', '--profile', 'owner']);
    if (st.ready) {
      log.ai.info({ samples: st.samples }, 'Voice profile carregado (embeddings em disco)');
    }
  } catch {}
}
