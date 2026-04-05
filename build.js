#!/usr/bin/env node
// ================================================================
// ZAYA PLUS — Build Script
// Ofusca o codigo e gera versao distribuivel em /dist
// Rode: node build.js
// ================================================================

import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'fs';
import { join, extname, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = __dirname;
const DIST = join(__dirname, 'dist');

console.log('\n  \x1b[35m\x1b[1mZAYA PLUS\x1b[0m — Build\n');

// Limpar dist
if (existsSync(DIST)) {
  import('child_process').then(cp => cp.execSync(`rm -rf ${DIST}`));
}
mkdirSync(DIST, { recursive: true });

// Arquivos e pastas para copiar
const COPY_LIST = [
  'package.json',
  'package-lock.json',
  '.env.example',
  '.gitignore',
  'activate.js',
  'start.sh',
  'update.sh',
  'install.sh',
  'README.md',
  'INSTALL.md',
  'public',
  'video-tools',
  'supabase',
  'tests',
  'data',
  'music',
  'skills-lock.json',
];

// Pastas JS para ofuscar
const OBFUSCATE_DIRS = ['src'];
const OBFUSCATE_FILES = ['server.js'];

// Config do obfuscator
const OBF_CONFIG = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  target: 'node',
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

// Copiar arquivos/pastas sem modificar
function copyRecursive(src, dest) {
  if (!existsSync(src)) return;
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const item of readdirSync(src)) {
      if (item === 'node_modules' || item === '.git' || item === 'dist') continue;
      copyRecursive(join(src, item), join(dest, item));
    }
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

// Ofuscar um arquivo JS
function obfuscateFile(srcPath, destPath) {
  const code = readFileSync(srcPath, 'utf-8');

  // Pular arquivos muito pequenos ou nao-JS
  if (extname(srcPath) !== '.js' || code.length < 50) {
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(srcPath, destPath);
    return false;
  }

  try {
    const result = JavaScriptObfuscator.obfuscate(code, OBF_CONFIG);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, result.getObfuscatedCode(), 'utf-8');
    return true;
  } catch (e) {
    // Se falhar, copiar original
    console.log(`  \x1b[33m!\x1b[0m Nao conseguiu ofuscar: ${relative(SRC, srcPath)} — ${e.message.slice(0, 50)}`);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(srcPath, destPath);
    return false;
  }
}

// Ofuscar pasta recursivamente
function obfuscateDir(srcDir, destDir) {
  let count = 0;
  if (!existsSync(srcDir)) return count;

  for (const item of readdirSync(srcDir)) {
    const srcPath = join(srcDir, item);
    const destPath = join(destDir, item);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      count += obfuscateDir(srcPath, destPath);
    } else if (extname(item) === '.js') {
      if (obfuscateFile(srcPath, destPath)) count++;
    } else {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }
  return count;
}

// ===== BUILD =====
console.log('  \x1b[36m1.\x1b[0m Copiando arquivos...');
for (const item of COPY_LIST) {
  const src = join(SRC, item);
  const dest = join(DIST, item);
  copyRecursive(src, dest);
}
console.log('  \x1b[32m✓\x1b[0m Arquivos copiados');

console.log('  \x1b[36m2.\x1b[0m Ofuscando codigo...');
let totalObfuscated = 0;

// Ofuscar arquivos raiz
for (const file of OBFUSCATE_FILES) {
  const src = join(SRC, file);
  const dest = join(DIST, file);
  if (obfuscateFile(src, dest)) {
    totalObfuscated++;
    console.log(`  \x1b[32m✓\x1b[0m ${file}`);
  }
}

// Ofuscar pastas
for (const dir of OBFUSCATE_DIRS) {
  const count = obfuscateDir(join(SRC, dir), join(DIST, dir));
  totalObfuscated += count;
  console.log(`  \x1b[32m✓\x1b[0m ${dir}/ — ${count} arquivos ofuscados`);
}

// Remover devDependencies do package.json
const pkg = JSON.parse(readFileSync(join(DIST, 'package.json'), 'utf-8'));
delete pkg.devDependencies;
pkg.scripts = { start: 'node server.js' };
writeFileSync(join(DIST, 'package.json'), JSON.stringify(pkg, null, 2), 'utf-8');

console.log('');
console.log('  \x1b[35m\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
console.log(`  \x1b[32m\x1b[1m✓ Build completo!\x1b[0m ${totalObfuscated} arquivos ofuscados`);
console.log(`  \x1b[36m  Saida: ${DIST}\x1b[0m`);
console.log('  \x1b[35m\x1b[1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
console.log('');
console.log('  Para distribuir:');
console.log('  \x1b[36m  cd dist && npm install --production\x1b[0m');
console.log('');
