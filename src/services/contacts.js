import { contactsDB } from '../database.js';

export function searchContact(query) {
  const found = contactsDB.search(query);
  if (found.length === 0) return { success: false, output: `Nenhum contato encontrado com "${query}"` };

  // Ordena por relevância: match exato > começa com > contém
  const q = query.toLowerCase().trim();
  const sorted = found.sort((a, b) => {
    const an = a.nome.toLowerCase();
    const bn = b.nome.toLowerCase();
    // Match exato (ignora emojis)
    const aClean = an.replace(/[^\w\s]/g, '').trim();
    const bClean = bn.replace(/[^\w\s]/g, '').trim();
    const aExact = aClean === q ? 0 : 1;
    const bExact = bClean === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    // Começa com a query
    const aStarts = aClean.startsWith(q) ? 0 : 1;
    const bStarts = bClean.startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    // Mais curto = mais relevante
    return an.length - bn.length;
  });

  return { success: true, output: sorted.map(c => `${c.nome} -> ${c.telefone}`).join('\n') };
}
