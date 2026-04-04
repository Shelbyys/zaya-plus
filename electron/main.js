const { app, BrowserWindow, systemPreferences, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow = null;
let tray = null;
let serverProcess = null;
const SERVER_PORT = 3001;
const PROJECT_DIR = '/Volumes/KINGSTON/claude-code/jarvis';
const SERVER_SCRIPT = path.join(PROJECT_DIR, 'server.js');

// ================================================================
// PERMISSÕES (mic + camera automáticos no macOS)
// ================================================================
async function requestPermissions() {
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus !== 'granted') {
      await systemPreferences.askForMediaAccess('microphone');
    }
    const camStatus = systemPreferences.getMediaAccessStatus('camera');
    if (camStatus !== 'granted') {
      await systemPreferences.askForMediaAccess('camera');
    }
  }
}

// ================================================================
// SERVIDOR (spawn em vez de fork — compatível com ES modules)
// ================================================================
async function isServerRunning() {
  try {
    const http = require('http');
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${SERVER_PORT}/api/contacts`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
  } catch { return false; }
}

function startServer() {
  return new Promise(async (resolve) => {
    if (await isServerRunning()) {
      console.log('[SERVER] Já rodando na porta ' + SERVER_PORT);
      resolve();
      return;
    }

    console.log('[SERVER] Iniciando Zaya server...');
    serverProcess = spawn('node', [SERVER_SCRIPT], {
      cwd: PROJECT_DIR,
      env: { ...process.env, ELECTRON: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolved = false;

    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      console.log('[SERVER]', msg.trim());
      if (!resolved && (msg.includes('online') || msg.includes('localhost'))) {
        resolved = true;
        setTimeout(resolve, 1000);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('[SERVER ERR]', data.toString().trim());
    });

    serverProcess.on('exit', (code) => {
      console.log('[SERVER] Saiu com código', code);
      serverProcess = null;
      if (!app.isQuitting) {
        console.log('[SERVER] Reiniciando em 3s...');
        setTimeout(() => startServer(), 3000);
      }
    });

    // Timeout de segurança
    setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 12000);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

// ================================================================
// JANELA PRINCIPAL
// ================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'ZAYA',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#0d0b09',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
      // Mantém background throttling desligado para o mic nunca morrer
      backgroundThrottling: false,
    },
    icon: path.join(PROJECT_DIR, 'public', 'logo.png'),
  });

  // Permissão automática total — mic, camera, áudio
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
  mainWindow.webContents.session.setPermissionCheckHandler(() => true);

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Injeta JS para forçar mic ativo e pular overlay
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.on('console-message', (e, level, msg) => {
      if (msg.includes('[ZAYA]') || msg.includes('[Electron]') || msg.includes('[Mic]') || msg.includes('[SleepLoop]')) {
        console.log('[RENDERER]', msg);
      }
    });

    mainWindow.webContents.executeJavaScript(`
      (function forceStart() {
        console.log('[Electron] Inject rodando...');

        // Força mic
        navigator.mediaDevices.getUserMedia({ audio: true })
          .then(s => { s.getTracks().forEach(t => t.stop()); console.log('[Electron] Mic OK'); })
          .catch(e => console.log('[Electron] Mic erro:', e.message));

        // Espera app.js carregar
        let tries = 0;
        const check = setInterval(() => {
          tries++;
          if (typeof startZaya === 'function') {
            if (!zayaStarted) {
              clearInterval(check);
              console.log('[Electron] Forçando startZaya()');
              startZaya();
            } else {
              clearInterval(check);
              console.log('[Electron] Zaya já iniciada');
            }
          } else if (tries > 100) {
            clearInterval(check);
            console.log('[Electron] ERRO: startZaya não encontrado após 10s');
            document.body.click();
          }
        }, 100);
      })();
    `).catch(e => console.error('[INJECT ERROR]', e));
  });

  // Carrega com retry agressivo
  async function tryLoad(retries) {
    try {
      console.log(`[LOAD] Tentando http://localhost:${SERVER_PORT} (tentativa ${11 - retries}/10)`);
      await mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);
      console.log('[LOAD] Página carregada com sucesso!');
    } catch (e) {
      console.error('[LOAD] Falhou:', e.message);
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 2000));
        return tryLoad(retries - 1);
      }
    }
  }
  tryLoad(10);

  // Esconder no tray em vez de fechar
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ================================================================
// TRAY (ícone na barra de menu)
// ================================================================
function createTray() {
  const iconPath = path.join(__dirname, '..', 'public', 'logo.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('ZAYA - IA Assistente');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir ZAYA', click: () => { if (mainWindow) mainWindow.show(); } },
    { label: 'Ativar Conversa', click: () => activateConversation() },
    { type: 'separator' },
    { label: 'Calendário', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.loadURL(`http://localhost:${SERVER_PORT}/calendar.html`); } } },
    { type: 'separator' },
    { label: 'Reiniciar Servidor', click: () => { stopServer(); startServer(); } },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.focus();
      else mainWindow.show();
    }
  });
}

// ================================================================
// ATIVAR CONVERSA (de qualquer lugar)
// ================================================================
function activateConversation() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.executeJavaScript(`
    if (typeof mode !== 'undefined' && mode === 'sleeping' && typeof conversationLoop === 'function') {
      if (typeof stopListening === 'function') stopListening();
      mode = 'conversation';
      if (typeof wakeDot !== 'undefined') wakeDot.classList.add('active');
      try { new Audio('zaya-activate.mp3').play(); } catch {}
      setTimeout(() => conversationLoop(''), 300);
    }
  `).catch(() => {});
}

// ================================================================
// ATALHOS GLOBAIS
// ================================================================
function registerShortcuts() {
  // Cmd+Shift+Z — abre/foca a Zaya e ativa conversa
  globalShortcut.register('CommandOrControl+Shift+Z', () => {
    activateConversation();
  });

  // Cmd+Shift+C — abre calendário
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.loadURL(`http://localhost:${SERVER_PORT}/calendar.html`);
    }
  });

  // Escape — desativa conversa (volta a dormir)
  globalShortcut.register('Escape', () => {
    if (mainWindow && mainWindow.isFocused()) {
      mainWindow.webContents.executeJavaScript(`
        if (typeof mode !== 'undefined' && mode === 'conversation') {
          mode = 'sleeping';
          try { new Audio('zaya-deactivate.mp3').play(); } catch {}
        }
      `).catch(() => {});
    }
  });
}

// ================================================================
// FLAGS DO CHROMIUM
// ================================================================
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Desliga power throttling para o mic não morrer em background
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// ================================================================
// LIFECYCLE
// ================================================================
app.whenReady().then(async () => {
  await requestPermissions();
  await startServer();
  createTray();
  createWindow();
  registerShortcuts();
  console.log('[ZAYA] App pronto! Cmd+Shift+Z para ativar de qualquer lugar.');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
  else mainWindow.show();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopServer();
});
