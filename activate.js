#!/usr/bin/env node
// ================================================================
// ZAYA PLUS — Ativacao de Licenca
// Uso: node activate.js SEU-TOKEN-AQUI
// ================================================================

import 'dotenv/config';
import { activateLicense } from './src/services/license.js';

const token = process.argv[2];

if (!token) {
  console.log('\n  \x1b[35m\x1b[1mZAYA PLUS\x1b[0m — Ativacao de Licenca\n');
  console.log('  Uso: node activate.js SEU-TOKEN-AQUI\n');
  process.exit(1);
}

console.log('\n  \x1b[35m\x1b[1mZAYA PLUS\x1b[0m — Ativando licenca...\n');

const result = await activateLicense(token);

if (result.valid) {
  console.log(`  \x1b[32m✓\x1b[0m Licenca ativada com sucesso!`);
  console.log(`  \x1b[32m✓\x1b[0m Plano: \x1b[1m${result.plan.toUpperCase()}\x1b[0m`);
  console.log(`\n  Agora rode: \x1b[36mnpm start\x1b[0m\n`);
} else {
  console.log(`  \x1b[31m✗\x1b[0m ${result.error}`);
  console.log(`\n  Verifique seu token e tente novamente.\n`);
  process.exit(1);
}
