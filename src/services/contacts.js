import { contactsDB } from '../database.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ROOT_DIR } from '../config.js';

export function searchContact(query) {
  // 1. Busca no banco SQLite
  const found = contactsDB.search(query);

  // 2. Se não achou, tenta no arquivo data/contatos.json
  if (found.length === 0) {
    try {
      const filePath = join(ROOT_DIR, 'data', 'contatos.json');
      if (existsSync(filePath)) {
        const agenda = JSON.parse(readFileSync(filePath, 'utf-8'));
        const q = query.toLowerCase().trim();
        const matches = agenda.filter(c => {
          const nome = (c.nome || '').toLowerCase();
          const push = (c.pushname || '').toLowerCase();
          return nome.includes(q) || push.includes(q) || (c.telefone || '').includes(q);
        });
        if (matches.length > 0) {
          return { success: true, output: matches.map(c => `${c.nome} -> ${c.telefone}`).join('\n') };
        }
      }
    } catch {}
  }

  if (found.length === 0) return { success: false, output: `Nenhum contato encontrado com "${query}"` };

  // Ordena por relevância: match exato > começa com > contém
  const q = query.toLowerCase().trim();
  const sorted = found.sort((a, b) => {
    const an = a.nome.toLowerCase();
    const bn = b.nome.toLowerCase();
    const aClean = an.replace(/[^\w\s]/g, '').trim();
    const bClean = bn.replace(/[^\w\s]/g, '').trim();
    const aExact = aClean === q ? 0 : 1;
    const bExact = bClean === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const aStarts = aClean.startsWith(q) ? 0 : 1;
    const bStarts = bClean.startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return an.length - bn.length;
  });

  return { success: true, output: sorted.map(c => `${c.nome} -> ${c.telefone}`).join('\n') };
}
