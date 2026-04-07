import { execSync, spawn } from 'child_process';
import os from 'os';
import { ADMIN_NAME } from '../config.js';
import { log } from '../logger.js';

const HOME = os.homedir();
let CLAUDE_BIN = 'claude';
try { const cmd = process.platform === 'win32' ? 'where claude' : 'which claude'; CLAUDE_BIN = execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['pipe','pipe','ignore'] }).trim().split('\n')[0] || 'claude'; } catch(e) {}

export function runCommand(cmd) {
  try {
    log.ai.info({ cmd: cmd.slice(0, 100) }, 'EXEC');
    const output = execSync(cmd, {
      encoding: 'utf-8', timeout: 30000, cwd: HOME, shell: '/bin/zsh',
      env: { ...process.env, HOME, PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' },
    });
    return { success: true, output: output.trim() };
  } catch (error) {
    return { success: false, output: error.stderr || error.message };
  }
}

export function runClaudeCode(prompt, dir, timeout) {
  const cwd = dir || HOME;
  const maxTime = timeout || 300000;
  log.ai.info({ cwd, timeout: maxTime/1000 }, `Claude Code: ${prompt.slice(0, 100)}`);

  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, [
      '-p', '--dangerously-skip-permissions',
      '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch'
    ], {
      cwd, timeout: maxTime, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME,
      },
    });

    let output = '';
    child.stdout.on('data', d => { output += d.toString(); });
    child.stderr.on('data', d => { output += d.toString(); });

    child.on('close', (code) => {
      log.ai.info({ code, outputLen: output.length }, 'Claude Code finalizado');
      resolve({ success: code === 0 || output.length > 0, output: output.slice(0, 12000) || '(sem saida)' });
    });

    child.on('error', (e) => {
      log.ai.error({ err: e.message }, 'Claude Code erro');
      resolve({ success: false, output: `Erro: ${e.message}` });
    });

    child.stdin.write(`Voce e a ZAYA, assistente do ${ADMIN_NAME}. Responda em portugues brasileiro.\nVoce tem acesso TOTAL ao Mac dele: terminal, arquivos, internet, tudo.\nExecute o que for pedido. Seja direto e eficiente.\n\n${prompt}`);
    child.stdin.end();
  });
}
