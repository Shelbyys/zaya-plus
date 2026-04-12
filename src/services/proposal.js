// ================================================================
// PROPOSTA COMERCIAL — Gera PDFs branded da Easy4u
// ================================================================
import { log } from '../logger.js';
import { TMP_DIR } from '../config.js';
import { getSupabase } from './supabase.js';
import { uploadToStorage } from './supabase.js';
import { runClaudeCode } from './exec.js';
import { join } from 'path';

// ================================================================
// GERAR PROPOSTA
// ================================================================

export async function generateProposal({ companyName, services, pricing, contactName, contactEmail, contactPhone, notes, validDays = 15 }) {
  try {
    const now = new Date();
    const validUntil = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000);
    const proposalId = `EASY4U-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${Date.now().toString(36).toUpperCase()}`;

    // Formata tabela de serviços
    const servicesTable = (services || []).map((s, i) => ({
      num: i + 1,
      name: s.name || s.nome || 'Serviço',
      description: s.description || s.descricao || '',
      price: s.price || s.preco || 0,
    }));

    const total = servicesTable.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0);

    // Monta tabela formatada para o prompt
    const tableRows = servicesTable.map(s =>
      `| ${s.num} | ${s.name} | ${s.description} | R$ ${parseFloat(s.price).toFixed(2)} |`
    ).join('\n');

    const pdfFilename = `proposta_${proposalId}.pdf`;
    const pdfPath = join(TMP_DIR, pdfFilename);

    // Usa Claude Code com skill /pdf-official para gerar PDF branded
    const prompt = `/pdf-official

Crie uma proposta comercial profissional em PDF com o seguinte conteúdo:

IDENTIDADE VISUAL:
- Logo: Easy4u (Easy Solutions LTDA)
- Cor principal: #EF641D (laranja)
- Cor secundária: #1a1a2e (azul escuro)
- Fonte: moderna e clean
- Estilo: profissional, moderno, corporativo

CABEÇALHO:
- Logo Easy4u no topo
- "PROPOSTA COMERCIAL" em destaque
- Nº: ${proposalId}
- Data: ${now.toLocaleDateString('pt-BR')}
- Válida até: ${validUntil.toLocaleDateString('pt-BR')}

DESTINATÁRIO:
- Empresa: ${companyName}
${contactName ? `- A/C: ${contactName}` : ''}
${contactEmail ? `- Email: ${contactEmail}` : ''}
${contactPhone ? `- Tel: ${contactPhone}` : ''}

INTRODUÇÃO:
"A Easy Solutions LTDA tem o prazer de apresentar nossa proposta de serviços sob medida para ${companyName}. Nossa equipe especializada em tecnologia e automação está preparada para elevar o potencial digital do seu negócio."

SERVIÇOS PROPOSTOS (tabela com borda laranja):
| # | Serviço | Descrição | Valor |
|---|---------|-----------|-------|
${tableRows}
| | | **TOTAL** | **R$ ${total.toFixed(2)}** |

${notes ? `OBSERVAÇÕES:\n${notes}` : ''}

CONDIÇÕES:
- Pagamento: 50% na aprovação, 50% na entrega
- Prazo de execução: a combinar conforme escopo
- Validade desta proposta: ${validDays} dias
- Suporte pós-implantação incluso por 30 dias

CONTATO:
Easy Solutions LTDA
Instagram: @suaeasy4u
Email: contato@easy4u.com.br

RODAPÉ:
"Transformando ideias em soluções digitais" | Easy Solutions LTDA

Salve o PDF em: ${pdfPath}
Use cores #EF641D para destaques e #1a1a2e para textos principais.
Tamanho A4, margens adequadas, design limpo e profissional.`;

    log.ai.info({ proposalId, companyName }, 'Proposta: Gerando PDF via Claude Code');

    const result = await runClaudeCode(prompt, TMP_DIR, 300000);

    // Upload para Supabase Storage
    let publicUrl = null;
    try {
      const upload = await uploadToStorage(pdfPath, 'zaya-files', 'propostas');
      publicUrl = upload.publicUrl;
      log.ai.info({ proposalId, url: publicUrl }, 'Proposta: Upload OK');
    } catch (e) {
      log.ai.warn({ err: e.message }, 'Proposta: Upload falhou, PDF disponível apenas localmente');
    }

    // Salva metadados no Supabase
    await saveProposalMetadata({
      proposal_id: proposalId,
      company_name: companyName,
      contact_name: contactName,
      contact_email: contactEmail,
      contact_phone: contactPhone,
      services: servicesTable,
      total,
      valid_until: validUntil.toISOString(),
      pdf_path: pdfPath,
      pdf_url: publicUrl,
      status: 'enviada',
    });

    return {
      proposalId,
      companyName,
      total,
      pdfPath,
      publicUrl,
      validUntil: validUntil.toLocaleDateString('pt-BR'),
      services: servicesTable,
    };
  } catch (e) {
    log.ai.error({ err: e.message }, 'Proposta: Erro ao gerar');
    throw new Error(`Erro ao gerar proposta: ${e.message}`);
  }
}

// ================================================================
// SALVAR METADADOS
// ================================================================

async function saveProposalMetadata(data) {
  const sb = getSupabase();
  if (!sb) return;

  try {
    // Tenta inserir — se tabela não existe, loga SQL de criação
    const { error } = await sb.from('proposals').insert(data);
    if (error && error.code === '42P01') {
      log.db.warn(`Tabela "proposals" não existe. Crie via SQL:

CREATE TABLE IF NOT EXISTS proposals (
  id BIGSERIAL PRIMARY KEY,
  proposal_id TEXT UNIQUE NOT NULL,
  company_name TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  services JSONB,
  total NUMERIC(10,2),
  valid_until TIMESTAMPTZ,
  pdf_path TEXT,
  pdf_url TEXT,
  status TEXT DEFAULT 'enviada',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service access" ON proposals FOR ALL USING (true);
`);
    } else if (error) {
      log.db.error({ err: error.message }, 'Proposta: Erro ao salvar metadados');
    }
  } catch (e) {
    log.db.error({ err: e.message }, 'Proposta: Erro ao salvar metadados');
  }
}

// ================================================================
// LISTAR PROPOSTAS
// ================================================================

export async function listProposals(filters = {}) {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    let query = sb.from('proposals').select('*').order('created_at', { ascending: false });
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.company) query = query.ilike('company_name', `%${filters.company}%`);
    if (filters.limit) query = query.limit(filters.limit);
    else query = query.limit(20);

    const { data, error } = await query;
    return error ? [] : (data || []);
  } catch { return []; }
}

// ================================================================
// ATUALIZAR STATUS
// ================================================================

export async function updateProposalStatus(proposalId, status) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase não configurado');

  const { data, error } = await sb.from('proposals')
    .update({ status })
    .eq('proposal_id', proposalId)
    .select()
    .single();

  if (error) throw new Error(`Erro ao atualizar proposta: ${error.message}`);
  return data;
}
