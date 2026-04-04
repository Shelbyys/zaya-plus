// ================================================================
// SCREEN MONITOR — Monitora tela do Mac e registra atividades
// ================================================================
import { exec } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { TMP_DIR, AI_MODEL_MINI } from '../config.js';
import { openai, io } from '../state.js';
import { log } from '../logger.js';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';

let sb = null;
function getSb() {
  if (!sb && SUPABASE_URL && SUPABASE_KEY) sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  return sb;
}

let monitorActive = false;
let monitorInterval = null;
let activityLog = [];

// ================================================================
// CAPTURA SCREENSHOT DA TELA
// ================================================================
function captureScreen() {
  return new Promise((resolve) => {
    const dir = join(TMP_DIR, 'screenshots');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, `screen_${Date.now()}.jpg`);
    // screencapture nativo do macOS
    exec(`/usr/sbin/screencapture -x -t jpg -C "${path}"`, { timeout: 10000 }, (err) => {
      if (err) { resolve(null); return; }
      try {
        const data = readFileSync(path);
        const base64 = `data:image/jpeg;base64,${data.toString('base64')}`;
        unlinkSync(path); // limpa arquivo temp
        resolve(base64);
      } catch (e) { resolve(null); }
    });
  });
}

// ================================================================
// PEGA APP ATIVO + TÍTULO DA JANELA
// ================================================================
function getActiveApp() {
  return new Promise((resolve) => {
    exec(`osascript -e 'tell application "System Events" to get {name, title of first window} of first application process whose frontmost is true' 2>/dev/null || osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
    { timeout: 5000 }, (err, stdout) => {
      resolve(stdout?.trim() || 'Desconhecido');
    });
  });
}

// ================================================================
// ANALISA SCREENSHOT COM GPT-4O VISION
// ================================================================
async function analyzeScreen(screenshot, activeApp) {
  try {
    const response = await openai.chat.completions.create({
      model: AI_MODEL_MINI, max_tokens: 150,
      messages: [
        { role: 'system', content: `Você é um assistente de produtividade. Analise a captura de tela e descreva em 1-2 frases CURTAS o que o usuário está fazendo. Classifique como: TRABALHO, ESTUDO, LAZER, COMUNICAÇÃO, PROGRAMAÇÃO, NAVEGAÇÃO, REDE_SOCIAL, OUTRO. Formato: [CATEGORIA] Descrição curta. App ativo: ${activeApp}` },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: screenshot, detail: 'low' } },
          { type: 'text', text: 'O que estou fazendo?' }
        ] },
      ],
    });
    return response.choices[0].message.content || '[OUTRO] Não identificado';
  } catch (e) {
    return `[OUTRO] App: ${activeApp}`;
  }
}

// ================================================================
// REGISTRA ATIVIDADE
// ================================================================
async function logActivity(analysis, activeApp) {
  const entry = {
    timestamp: new Date().toISOString(),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    app: activeApp,
    analise: analysis,
    categoria: analysis.match(/\[(\w+)\]/)?.[1] || 'OUTRO',
  };

  activityLog.push(entry);

  // Salva no Supabase
  const s = getSb();
  if (s) {
    try {
      await s.from('activity_log').insert({
        action: 'screen_monitor',
        details: entry,
        source: 'monitor',
      });
    } catch (e) {}
  }

  // Limita log em memória
  if (activityLog.length > 200) activityLog = activityLog.slice(-100);

  log.ai.info({ app: activeApp, cat: entry.categoria }, `[MONITOR] ${analysis.slice(0, 60)}`);
}

// ================================================================
// INICIAR MONITORAMENTO
// ================================================================
export function startScreenMonitor(intervalMinutes = 5) {
  if (monitorActive) return { status: 'já ativo', interval: intervalMinutes };
  monitorActive = true;

  log.ai.info({ interval: intervalMinutes }, 'Screen Monitor iniciado');

  monitorInterval = setInterval(async () => {
    if (!monitorActive) return;
    try {
      const screenshot = await captureScreen();
      if (!screenshot) return;
      const activeApp = await getActiveApp();
      const analysis = await analyzeScreen(screenshot, activeApp);
      await logActivity(analysis, activeApp);
    } catch (e) {
      log.ai.warn({ err: e.message }, 'Monitor: erro na captura');
    }
  }, intervalMinutes * 60 * 1000);

  // Primeira captura após 10s
  setTimeout(async () => {
    try {
      const screenshot = await captureScreen();
      if (!screenshot) return;
      const activeApp = await getActiveApp();
      const analysis = await analyzeScreen(screenshot, activeApp);
      await logActivity(analysis, activeApp);
    } catch (e) {}
  }, 10000);

  return { status: 'ativado', interval: intervalMinutes };
}

// ================================================================
// PARAR MONITORAMENTO
// ================================================================
export function stopScreenMonitor() {
  monitorActive = false;
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  log.ai.info('Screen Monitor parado');
  return { status: 'desativado' };
}

// ================================================================
// GERAR RELATÓRIO DE PRODUTIVIDADE
// ================================================================
export async function gerarRelatorioTela(periodo = 'hoje') {
  const s = getSb();
  let entries = activityLog;

  // Busca do Supabase se tiver
  if (s) {
    try {
      let dateFilter = new Date();
      if (periodo === 'hoje') dateFilter.setHours(0, 0, 0, 0);
      else if (periodo === 'ontem') { dateFilter.setDate(dateFilter.getDate() - 1); dateFilter.setHours(0, 0, 0, 0); }
      else if (periodo === 'semana') dateFilter.setDate(dateFilter.getDate() - 7);

      const { data } = await s.from('activity_log')
        .select('details, created_at')
        .eq('action', 'screen_monitor')
        .gte('created_at', dateFilter.toISOString())
        .order('created_at', { ascending: true });

      if (data && data.length > 0) {
        entries = data.map(d => d.details);
      }
    } catch (e) {}
  }

  if (entries.length === 0) return 'Nenhuma atividade registrada. Ative o monitoramento com: "Zaya, monitora minha tela"';

  // Conta categorias
  const cats = {};
  const apps = {};
  for (const e of entries) {
    const cat = e.categoria || 'OUTRO';
    cats[cat] = (cats[cat] || 0) + 1;
    const app = e.app?.split(',')[0]?.trim() || 'Desconhecido';
    apps[app] = (apps[app] || 0) + 1;
  }

  const total = entries.length;
  const trabalho = (cats.TRABALHO || 0) + (cats.PROGRAMAÇÃO || 0) + (cats.ESTUDO || 0);
  const lazer = (cats.LAZER || 0) + (cats.REDE_SOCIAL || 0) + (cats.NAVEGAÇÃO || 0);
  const foco = total > 0 ? Math.round((trabalho / total) * 100) : 0;

  let report = `RELATÓRIO DE PRODUTIVIDADE (${periodo})\n`;
  report += `Total de capturas: ${total}\n`;
  report += `Foco produtivo: ${foco}%\n\n`;

  report += `CATEGORIAS:\n`;
  for (const [cat, count] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
    const pct = Math.round((count / total) * 100);
    report += `  ${cat}: ${count}x (${pct}%)\n`;
  }

  report += `\nAPPS MAIS USADOS:\n`;
  for (const [app, count] of Object.entries(apps).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    report += `  ${app}: ${count}x\n`;
  }

  report += `\nATIVIDADES RECENTES:\n`;
  for (const e of entries.slice(-10)) {
    report += `  ${e.hora || '??:??'} — ${e.analise || 'N/A'}\n`;
  }

  return report;
}

// ================================================================
// STATUS DO MONITOR
// ================================================================
export function getMonitorStatus() {
  return {
    ativo: monitorActive,
    capturas: activityLog.length,
    ultima: activityLog[activityLog.length - 1] || null,
  };
}
