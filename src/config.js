import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

const HOME = process.env.HOME || os.homedir();
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// --- Helper: find a binary via `which` (unix) or `where` (win), fallback to common paths ---
function findBinary(name, fallbacks = []) {
  try {
    const cmd = IS_WIN ? `where ${name}` : `which ${name}`;
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0];
  } catch {
    for (const p of fallbacks) {
      if (existsSync(p)) return p;
    }
    return name; // bare name — let PATH resolve at runtime
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  // 1. Chrome/Chromium instalado no sistema
  const candidates = IS_MAC
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : IS_WIN
      ? [
          join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'google-chrome';
}

// --- General ---
export const PORT = process.env.PORT || 3001;
export const SENHA = process.env.BOT_PASSWORD || 'admin';
export const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '';
export const ADMIN_LID = process.env.ADMIN_LID || '';
export const ADMIN_NAME = process.env.ADMIN_NAME || '';
export const ADMIN_JID = process.env.ADMIN_JID || '';
export const SESSION_TIMEOUT = 60 * 60 * 1000; // 1 hora

// --- External binaries (auto-detected) ---
export const TMP_DIR = process.env.TMP_DIR || '/tmp/whatsapp-bot';

export const WHISPER_BIN = process.env.WHISPER_BIN || findBinary('whisper', [
  join(HOME, '.local', 'bin', 'whisper'),
  join(HOME, 'Library', 'Python', '3.9', 'bin', 'whisper'),
  join(HOME, 'Library', 'Python', '3.11', 'bin', 'whisper'),
  join(HOME, 'Library', 'Python', '3.12', 'bin', 'whisper'),
]);

export const FFMPEG = process.env.FFMPEG || findBinary('ffmpeg', [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
]);

export const FFPROBE = process.env.FFPROBE || findBinary('ffprobe', [
  '/opt/homebrew/bin/ffprobe',
  '/usr/local/bin/ffprobe',
  '/usr/bin/ffprobe',
]);

export const CHROME_PATH = findChrome();
export const CHROME_PROFILE = process.env.CHROME_PROFILE || 'Default';
export const CHROME_DEBUG_PORT = parseInt(process.env.CHROME_DEBUG_PORT, 10) || 9222;
export const CHROME_BOT_DATA_DIR = join(TMP_DIR, 'chrome-bot-profile');

export const PYTHON3 = process.env.PYTHON3 || findBinary('python3', [
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3',
]);

// --- Project paths ---
export const MUSIC_DIR = join(ROOT_DIR, 'music');
export const TOOLS_DIR = join(ROOT_DIR, 'video-tools');
export const HISTORY_FILE = join(ROOT_DIR, 'chat-history.json');
export const VAULT_FILE = join(ROOT_DIR, 'credentials.vault');
export const CONTACTS_FILE = join(ROOT_DIR, 'contatos.json');
export const MSGS_FILE = join(ROOT_DIR, 'messages.json');
export const INBOX = join(ROOT_DIR, 'inbox.json');
export const OUTBOX = join(ROOT_DIR, 'outbox.json');
export const PESQUISAS_DIR = join(ROOT_DIR, 'pesquisas');
export const FC_SCRIPT = join(ROOT_DIR, 'fc_tool.py');
export const SPEAKER_VERIFY_SCRIPT = join(TOOLS_DIR, 'speaker_verify.py');
export const VOICE_PROFILES_DIR = join(ROOT_DIR, 'data', 'voice-profiles');

export const WA_DIR = join(ROOT_DIR, 'whatsapp-sessions');
export const WA_CONFIG = join(WA_DIR, 'instances.json');

export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// AI Model — centralizado para trocar facil entre provedores
export const AI_MODEL = process.env.AI_MODEL || 'gpt-4o';
export const AI_MODEL_MINI = process.env.AI_MODEL_MINI || 'gpt-4o-mini';

// Meta / Facebook
export const META_ACCESS_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN || '';

export { ROOT_DIR };

// Garante que diretorios existem
[TMP_DIR, PESQUISAS_DIR, MUSIC_DIR, WA_DIR, VOICE_PROFILES_DIR].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});
