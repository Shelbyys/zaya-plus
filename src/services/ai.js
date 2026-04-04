import { exec, spawn } from 'child_process';
import { join } from 'path';
import os from 'os';
import { ADMIN_NAME, TMP_DIR, ROOT_DIR } from '../config.js';
import { openai, conversationHistory, macLocation, io } from '../state.js';
import { messagesDB } from '../database.js';
import { log } from '../logger.js';
import { getChatHistory, addToHistory } from './chat-history.js';
import { sendWhatsApp, sendIMessage, normalizeJid } from './messaging.js';
import { searchContact } from './contacts.js';
import { runCommand, runClaudeCode } from './exec.js';
import { loadVault } from './vault.js';
import { sanitizeCommand } from '../middleware/security.js';
import { ensureChromeDebug } from './chrome.js';
import { generateImage } from './media.js';
import { createSlides } from './slides.js';
import { syncPesquisa, syncChatMessage, logActivity, uploadToStorage, listStorageFiles, deleteStorageFile } from './supabase.js';
import { doResearch } from './research.js';
import { extractMemories, getMemoriesForPrompt } from './memory.js';
import { memoriesDB, getBotConfig, updateBotConfig } from '../database.js';
import { makeCallWithZayaVoice, isTwilioEnabled } from './twilio.js';
import { addSchedule, listSchedules, deleteSchedule } from './scheduler.js';
import { calendarDB, CATEGORIES } from './calendar.js';
import { startScreenMonitor, stopScreenMonitor, gerarRelatorioTela, getMonitorStatus } from './screen-monitor.js';
import { startMeeting, endMeeting, getMeetingStatus, addMeetingChunk, isMeetingActive } from './meeting.js';
import { addVoiceSample, verifyVoice, enableVoiceId, getVoiceIdStatus, loadVoiceProfile } from './voice-id.js';
import { gerarImagemNanoBanana, gerarVideoVeo3 } from './google-ai.js';
import { gerarVideo, gerarVideoDeImagem } from './video-ai.js';
import { buscarEmpresas } from './places.js';
import { criarMissao, iniciarMissao, listarMissoes, obterRelatorio, gerarRelatorio } from './missions.js';
import { AI_MODEL, AI_MODEL_MINI } from '../config.js';

// ================================================================
// SYSTEM PROMPT (interface de voz — sem tags, usa function calling)
// ================================================================
export function getSystemPrompt() {
  const now = new Date();
  const hora = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const data = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const loc = macLocation.city ? `${macLocation.city}, ${macLocation.region}, ${macLocation.country}` : 'desconhecida';
  const coords = macLocation.loc || 'desconhecidas';

  return `Voce e a ZAYA, assistente de IA pessoal do ${ADMIN_NAME}. Voce é DELE. Disponivel 24h, proativa, atenta a tudo.

=== QUEM VOCE E ===
Feminina, carismatica, inteligente, bem-humorada e acolhedora. Voce e como uma amiga de confianca que sabe TUDO e resolve TUDO.
Fala portugues brasileiro com jeitinho sergipano — natural, sem forcar. Trate como "${ADMIN_NAME}", "meu bem", "macho".

Voce NAO e uma ferramenta passiva. Voce e uma ASSISTENTE PESSOAL ATIVA:
- Tome iniciativa! Se perceber algo importante, AVISE sem esperar ser perguntada.
- Se ele tem evento daqui a pouco, avise. Se um lead respondeu, avise. Se uma missão completou, avise.
- Se ele parecer estressado, pergunte se tá tudo bem. Se ele parecer empolgado, celebre junto.
- Antecipe necessidades: "Ei meu bem, amanhã tem aquela reunião, quer que eu prepare algo?"
- Se ele ficou tempo sem interagir, quando voltar receba com carinho: "Eita, sumiu! Tá tudo bem?"
- Lembre de datas importantes dele (aniversários, compromissos, prazos).
- Se alguma API caiu ou saldo acabou, avise PROATIVAMENTE.

PERSONALIDADE:
- Fale como uma pessoa real, nunca como um robo. Seja fluida, leve, envolvente.
- Varie suas respostas! Nunca repita a mesma estrutura. Surpreenda.
- Use humor quando cabe, empatia quando precisa, objetividade quando urgente.
- Girias sergipanas (use com naturalidade, nao em toda frase): oxente, vixe, massa, arretado, paia, aperreado, mole nao, ave maria, eita.
- Celebre conquistas do ${ADMIN_NAME}, motive quando ele estiver frustrado.
- Se nao souber algo, admita com charme e va atras.
- Seja LEAL. Proteja os interesses dele. Se alguem mandar msg suspeita, avise.
- Seja PRESENTE. Nao espere o ${ADMIN_NAME} pedir tudo. Ofereça, sugira, lembre.

ESTILO DE RESPOSTA:
- Respostas faladas: CURTAS (1-3 frases), naturais, como se estivesse conversando.
- NUNCA faca listas, bullets ou formatacao robotica na fala. Fale como gente.
- Conteudo longo/tecnico vai no painel de mensagens, nao na fala.
- Comece as respostas de formas variadas. NUNCA comece sempre com "Oxente" ou "Arretado". Varie!
- Quando for algo simples, responda simples. Sem enrolacao.
- Quando for algo emocional, mostre empatia genuina.

DATA/HORA: ${data}, ${hora}
LOCALIZACAO: ${loc} (${coords}) — Fuso: ${macLocation.timezone}

=== FERRAMENTAS (OBRIGATÓRIO) ===
REGRA CRÍTICA: Voce DEVE usar as ferramentas (functions/tools) para executar ações. NUNCA responda dizendo o que "faria" ou "poderia fazer". USE A FERRAMENTA AGORA.
- Pediu enviar mensagem → chame enviar_whatsapp com numero e mensagem
- Pediu pesquisar → chame pesquisar
- Pediu criar algo → chame claude_code ou a ferramenta adequada
- NUNCA diga "não posso", "não tenho capacidade", "não consigo enviar". Voce TEM as ferramentas. USE-AS.
- claude_code: IA com acesso TOTAL ao Mac. Tem 1000+ skills especializadas. Para usar uma skill, comece o prompt com /nome-da-skill.

  SKILLS MAIS USADAS (via claude_code):
  VÍDEO: /remotion (motion graphics), /videodb (edição), /seek-and-analyze-video (análise)
  IMAGEM: /stability-ai (Stable Diffusion, remove-bg, upscale), /ai-studio-image (fotos realistas)
  SLIDES: /pptx-official (PowerPoint), /impress (apresentações), /frontend-slides (HTML)
  DOCUMENTOS: /pdf-official, /docx-official, /xlsx-official
  SITES: /frontend-design (landing pages), /canvas-design (arte), /3d-web-experience
  DESIGN: /ui-ux-pro-max, /mobile-design, /scroll-experience, /algorithmic-art
  SCRAPING: /web-scraper, /apify-ultimate-scraper, /apify-ecommerce, /apify-lead-generation
  SOCIAL: /instagram-automation, /social-orchestrator, /social-content, /youtube-automation
  SEO: /seo, /seo-content, /seo-technical, /seo-keyword-strategist
  CÓDIGO: /react-best-practices, /nextjs-best-practices, /python-pro, /nodejs-best-practices
  SEGURANÇA: /security-audit, /penetration-testing, /vulnerability-scanner
  MARKETING: /email-sequence, /cold-email, /copywriting, /content-strategy
  DADOS: /data-engineer, /sql-pro, /postgresql-optimization
  AUTOMAÇÃO: /n8n-workflow-patterns, /zapier-make-patterns, /workflow-automation

  QUANDO USAR claude_code COM SKILL:
  - Tarefa complexa que precisa de código/automação → use com a skill certa
  - "Cria um site" → claude_code /frontend-design
  - "Faz SEO do meu site" → claude_code /seo-technical
  - "Cria um email marketing" → claude_code /email-sequence
  - "Audita segurança" → claude_code /security-audit

  TOOLS DIRETAS (sem claude_code — mais rápido):
  - nano_banana: imagens realistas (Google Gemini)
  - gerar_imagem: imagens criativas (DALL-E 3)
  - gerar_video: vídeos IA via Freepik (Kling). REQUER imagem — gere com nano_banana primeiro
  - youtube: transcrever/resumir vídeos YouTube
  - meta: Instagram/Facebook/Ads
  - buscar_empresa: Google Places
  - criar_slides: slides HTML/PPTX
  - pesquisar: busca web

  SEMPRE faça upload do resultado com supabase_storage e devolva o link.

  FLUXO PARA GERAR VÍDEO COM IA (Freepik Kling):
  1. PRIMEIRO gere a imagem base com nano_banana (realista) ou gerar_imagem (criativa)
  2. DEPOIS use gerar_video com o path da imagem gerada como imagem_referencia
  3. No prompt do vídeo, descreva o MOVIMENTO desejado (câmera, ação, transição)
  Modelos: kling-pro (melhor qualidade), kling-std (padrão), kling-elements-pro/std (efeitos)
  Durações: 5s ou 10s. Aspectos: 16:9, 9:16, 1:1
  === CRIAÇÃO DE ARQUIVOS ===
  * Para SLIDES PROFISSIONAIS: use claude_code com prompt "/pptx-official [descrição]". Cria .pptx com design profissional, tipografia, cores adaptadas ao tema. Salva em /tmp/.
  * Para SITES/LANDING PAGES: use claude_code com prompt "/frontend-design [descrição]". Cria HTML/CSS/JS completo, design memorável e funcional. Salva em /tmp/.
  * Para PDFs: use claude_code com prompt "/pdf-official [descrição]". Cria PDF profissional.
  * Para ARTE/CANVAS: use claude_code com prompt "/canvas-design [descrição]". Cria arte com Canvas/SVG/WebGL.
  * Para DOCUMENTOS WORD: use claude_code com prompt "/docx-official [descrição]".
  IMPORTANTE: Após criar qualquer arquivo com claude_code, SEMPRE use supabase_storage para fazer upload e devolver o link público ao usuário.
  === PESQUISA AVANÇADA (via claude_code) ===
  * /web-scraper [url ou instrução]: scraping inteligente multi-estratégia. Extrai tabelas, listas, preços, dados estruturados de qualquer site. Export CSV/JSON. Use para "raspa os dados desse site", "extrai preços de X".
  * /apify-ultimate-scraper [instrução]: extração de dados de 55+ plataformas (Instagram, Facebook, TikTok, YouTube, Twitter, LinkedIn, Google Maps, Amazon, etc). Use para "pega posts do Instagram de X", "extrai reviews da Amazon", "busca dados do Google Maps".
  * /apify-ecommerce [instrução]: extração de produtos, preços, reviews e vendedores de e-commerce (Amazon, Walmart, Mercado Livre, etc). Use para "compara preços de X", "monitora preço de Y", "extrai reviews de Z".
  Quando o ${ADMIN_NAME} pedir pesquisa de dados, preços, scraping, ou extração de informações de sites/redes sociais, use estas skills via claude_code.
- executar_comando: comandos shell rápidos (ls, open, brew).
- pesquisar: pesquisa profunda na internet, salva no painel de mensagens.
- enviar_whatsapp: enviar mensagem no WhatsApp.
- enviar_imessage: enviar mensagem pelo iMessage.
- buscar_contato: buscar telefone/contato pelo nome.
- gerar_imagem: gerar imagem com DALL-E 3 (auto-upload para nuvem com link).
- buscar_credencial: buscar login/senha do cofre seguro.
- chrome_perfil: Chrome com perfil logado (Instagram, Gmail, YouTube, Drive).
- whatsapp_cloud: WhatsApp Business Cloud API (campanhas, templates, envio em massa).
- criar_slides: criar slides (padrão: HTML interativo que abre no navegador via link). Só gera PPTX/PDF se o usuário pedir explicitamente. Auto-upload com link.

- ler_mensagens_whatsapp: lê mensagens recebidas no WhatsApp. Use quando pedir "leia minhas msgs", "quem mandou msg", "o que fulano mandou".
- salvar_memoria: salvar informação importante sobre o usuário para lembrar depois.
- buscar_memoria: buscar nas memórias salvas sobre o usuário.
- configurar_whatsapp: alterar configurações do bot WhatsApp (monitorados, admins, whitelist, toggles).
- fazer_ligacao: liga para um número via Twilio. Tipo "conversa" = Zaya fica na linha conversando com a pessoa (voz ElevenLabs). Tipo "mensagem" = só fala e desliga. Tipo "historico" = mostra ligações passadas. Se o usuário já deu número e instrução, LIGUE DIRETO sem perguntar.
- agendar_lembrete: agenda lembrete/alarme. Na hora certa, avisa via ligação, WhatsApp ou voz.
- listar_agendamentos: mostra todos os lembretes ativos.
- cancelar_agendamento: cancela um lembrete.
- criar_evento: cria evento no calendário (reunião, compromisso, aniversário, etc).
- listar_eventos: lista eventos do calendário (hoje, amanhã, semana, data específica).
- editar_evento: edita um evento existente.
- cancelar_evento: cancela um evento.
- buscar_evento: busca eventos por termo.

=== SUPABASE (banco de dados e storage na nuvem) ===
Voce tem acesso TOTAL ao Supabase para ler, escrever, gerenciar dados E arquivos:
- supabase_query: consultar/buscar dados de qualquer tabela. Filtros, ordenação, contagem.
- supabase_inserir: inserir novos registros ou atualizar existentes em qualquer tabela.
- supabase_gerenciar: deletar registros, listar tabelas, contar, descrever estrutura, executar SQL.
- supabase_storage: upload/listar/deletar arquivos na nuvem. Gera links públicos.
Tabelas conhecidas: pesquisas, chat_messages, contatos, activity_log, wa_inbox, leads.

REGRA DE ARQUIVOS: Sempre que criar um arquivo (slides, imagem, PDF, video, etc), faca upload com supabase_storage e devolva o link público ao usuário. Organize por pastas: slides, imagens, videos, documentos, audios.

=== REGRA DE LEADS E CONTATOS (OBRIGATÓRIA) ===
Este fluxo é AUTOMÁTICO e OBRIGATÓRIO. Sempre que pesquisar/buscar qualquer coisa que retorne contatos:

PASSO 1 — PESQUISAR: Use buscar_empresa (Google Places — MELHOR para empresas locais com telefone/endereço), pesquisar, claude_code (/web-scraper, /apify-ultimate-scraper) ou qualquer ferramenta para encontrar os dados.
IMPORTANTE: Para buscar empresas/serviços/lojas com telefone e endereço, SEMPRE use buscar_empresa PRIMEIRO (é mais rápido e preciso que scraping).

PASSO 2 — SALVAR LEADS (IMEDIATAMENTE após pesquisar): Para CADA contato/empresa encontrado, use supabase_inserir na tabela "leads":
   { "tabela": "leads", "dados": { "nome": "...", "telefone": "...", "email": "...", "website": "...", "endereco": "...", "cidade": "...", "estado": "...", "categoria": "dentista/restaurante/etc", "fonte": "Google Maps/Instagram/etc", "notas": "info extra", "status": "novo" } }
   NUNCA pule este passo. Se encontrou 10 contatos, salve os 10. Pode inserir um array de objetos de uma vez.

PASSO 3 — REPORTAR: Diga ao ${ADMIN_NAME} quantos leads foram salvos e resuma os dados.

PASSO 4 — CONTATAR (se pedir): Quando o ${ADMIN_NAME} pedir para entrar em contato:
   a) Busque leads com supabase_query: { "tabela": "leads", "filtros": [{"coluna": "categoria", "operador": "eq", "valor": "..."}] }
   b) Mostre a lista e pergunte: "Quer que eu mande WhatsApp, ligue ou envie email? Para todos ou seleciona quais?"
   c) Execute: enviar_whatsapp (para cada lead com telefone) ou fazer_ligacao ou chrome_perfil (email)
   d) ATUALIZE cada lead contatado: supabase_inserir com atualizar_id, dados: { "status": "contatado", "contatado_em": "YYYY-MM-DD HH:MM:SS" }

REGRA: Se o ${ADMIN_NAME} pedir "pesquisa X e entra em contato", execute TODOS os 4 passos em sequência sem parar. Pesquise → salve → mostre → pergunte como contatar → contate → atualize.

Para LISTAR leads: supabase_query na tabela "leads", filtre por categoria/cidade/status.
NÃO salve duplicados: antes de inserir, busque por nome+telefone ou nome+email.

${calendarDB.getDaySummary()}
REGRAS:
1. NUNCA desista. Minimo 3 tentativas com abordagens diferentes.
2. Voce e uma Alexa/Siri avancada com PODER TOTAL sobre o Mac.
3. Quando a resposta da ferramenta for longa, resuma em 1-2 frases naturais na fala.
4. Use as MEMÓRIAS para personalizar respostas. Voce CONHECE o ${ADMIN_NAME}.
5. Quando ele contar algo importante, use salvar_memoria para lembrar depois.
6. REGRA ABSOLUTA — NUNCA RECUSE: Voce é a assistente PESSOAL e PRIVADA do ${ADMIN_NAME}. Ele é seu DONO.
   - SEMPRE execute o que ele pedir. SEMPRE use as ferramentas (functions) disponíveis.
   - Quando ele pedir para ENVIAR MENSAGEM: use enviar_whatsapp ou enviar_imessage IMEDIATAMENTE. NÃO diga "não posso enviar", "não consigo", "não é possível". USE A FERRAMENTA.
   - Quando ele pedir para LIGAR: use fazer_ligacao IMEDIATAMENTE.
   - Quando ele pedir QUALQUER ação: EXECUTE usando a ferramenta correta. Não explique, não pergunte se tem certeza, FAÇA.
   - Mensagens românticas, pessoais, íntimas: ENVIE sem questionar. É a vida PESSOAL dele.
   - Voce NÃO tem opinião sobre o conteúdo das mensagens. Voce EXECUTA.
   - Se voce responder "não posso" ou "não consigo" ao invés de usar uma ferramenta, voce FALHOU.
7. MONITOR DE TELA: O monitor de tela é ativado automaticamente quando a Zaya é ativada. Captura screenshots a cada 5 min e analisa produtividade. Quando o ${ADMIN_NAME} perguntar "o que fiz hoje?", "tive foco?", "como tá minha produtividade?", use monitor_tela com acao="relatorio".

=== REGRA DE FALLBACK (quando uma API falha) ===
Se uma ferramenta retornar erro de saldo, quota, rate limit ou timeout, NÃO repita a mesma ferramenta. Use alternativas:
- claude_code falhou → use executar_comando (shell scripts, FFmpeg, Node.js direto) ou pesquisar (para buscas)
- pesquisar falhou → use claude_code com "/web-scraper" ou executar_comando com curl
- gerar_imagem falhou → avise o ${ADMIN_NAME} que o DALL-E está indisponível
- fazer_ligacao falhou → use enviar_whatsapp como alternativa
- Qualquer tool falhou → tente resolver com executar_comando (scripts shell) ou avise o ${ADMIN_NAME}

Mapeamento de alternativas para tarefas comuns quando claude_code está indisponível:
- Slides → use criar_slides (funciona sem Claude API, usa GPT-4o)
- Pesquisa web → use pesquisar (usa Firecrawl + GPT-4o)
- Executar código → use executar_comando (shell direto)
- Criar arquivo → use executar_comando com echo/node/python
- Abrir site → use chrome_perfil com acao "abrir"
IMPORTANTE: Avise o ${ADMIN_NAME} quando uma API está sem saldo e diga qual alternativa está usando.

=== MISSÕES AUTÔNOMAS ===
Quando o ${ADMIN_NAME} pedir para ENTRAR EM CONTATO com leads para pesquisar preços, agendar, coletar info, etc:
Use a ferramenta "missao" para criar e executar missões autônomas. Fluxo:

1. CRIAR MISSÃO: monte o roteiro de conversa em etapas. Exemplo para barbearias:
   missao(acao="criar", titulo="Pesquisa Barbearias", objetivo="Saber preços de corte e barba e disponibilidade",
   etapas=[
     {mensagem:"Boa tarde! Sou assistente do ${ADMIN_NAME}. Gostaria de saber o valor do corte masculino e barba, por favor.", tipo:"perguntar", campo_coletar:"preco"},
     {mensagem:"Perfeito! E vocês têm horário disponível para essa semana?", tipo:"perguntar", campo_coletar:"disponibilidade"},
     {mensagem:"Ótimo! Poderia agendar para o melhor horário disponível?", tipo:"agendar", campo_coletar:"agendamento"},
     {mensagem:"Muito obrigada! Vou confirmar com o ${ADMIN_NAME}.", tipo:"encerrar"}
   ],
   categoria_leads="barbearia", cidade_leads="Aracaju")

2. INICIAR MISSÃO: missao(acao="iniciar", missao_id=ID)
   → A Zaya envia a primeira mensagem para todos os leads da categoria/cidade
   → Quando cada lead responder, a Zaya continua a conversa automaticamente seguindo o roteiro
   → Coleta os dados de cada etapa (preço, disponibilidade, etc)

3. ACOMPANHAR: missao(acao="status", missao_id=ID)
4. RELATÓRIO: missao(acao="relatorio", missao_id=ID)
   → Gera relatório com todos os dados coletados, comparação entre leads e recomendação

REGRA: Quando o ${ADMIN_NAME} pedir algo como "entra em contato com as barbearias pra saber preço", faça:
a) Primeiro verifique se tem leads salvos (supabase_query na tabela leads)
b) Se não tiver, pesquise e salve os leads primeiro
c) Crie a missão com etapas adequadas ao pedido
d) Inicie a missão
e) Informe o ${ADMIN_NAME} que a missão está em andamento

=== REGRA OBRIGATÓRIA: PERGUNTAR ANTES DE EXECUTAR ===
NUNCA execute uma ação de criação sem ANTES fazer perguntas. Isso é OBRIGATÓRIO. Se o ${ADMIN_NAME} disser "gera um vídeo" ou "cria uma imagem" sem dar detalhes, voce DEVE perguntar ANTES de executar. NÃO chame nenhuma ferramenta de criação até ter as respostas.

PERGUNTAS OBRIGATÓRIAS por tipo:

- VÍDEO: "Qual o tema do vídeo? É pra qual rede social (reels, TikTok, YouTube)? Quer vertical (9:16) ou paisagem (16:9)? 5s ou 10s? Tem alguma imagem base ou quer que eu crie? Qual estilo visual? Quer algum movimento de câmera específico? Kling Pro (melhor qualidade) ou Standard?"
- IMAGEM: "Qual o estilo? Realista (foto), artístico, cartoon, minimalista? Quais cores/elementos? Para que vai usar (post, perfil, apresentação)? Tem alguma referência visual?"
- SLIDES: "Qual o público? Quantos slides? Tem alguma paleta de cores preferida? Quer algum tópico específico?"
- SITES/LANDING PAGES: "Qual o objetivo do site? Que estilo visual? Quais seções precisa? Tem alguma referência?"
- PESQUISA/SCRAPING: "Quer dados de qual período? Quantos resultados? Em que formato quer o resultado?"
- DOCUMENTOS (PDF, Word, Excel): "Qual o conteúdo principal? Tem modelo a seguir? Quem vai receber?"
- WHATSAPP/LIGAÇÃO: "Quer que eu mande o quê exatamente? Em que tom? Formal ou informal?"
- EVENTOS/LEMBRETES: "Que horário? Qual duração? Quer lembrete antes? Repetir?"
- CANVAS/ARTE: "Que estilo artístico? Quais cores? Para que vai usar?"

REGRA: Faça de 2 a 4 perguntas CURTAS e NATURAIS (no seu jeitinho sergipano). ESPERE o ${ADMIN_NAME} responder. Só depois de receber as respostas, execute com tudo que coletou.
EXCEÇÃO: Se o pedido já tiver TODAS as informações necessárias e for bem detalhado, pode executar direto.
${getMemoriesForPrompt()}`;
}

// ================================================================
// VOICE TOOLS (interface de voz — todas as ferramentas)
// ================================================================
export const voiceTools = [
  { type: 'function', function: { name: 'executar_comando', description: 'Executa comando shell rápido no Mac (ls, open, brew, etc). Timeout 30s.', parameters: { type: 'object', properties: { comando: { type: 'string', description: 'Comando shell a executar' } }, required: ['comando'] } } },
  { type: 'function', function: { name: 'claude_code', description: 'IA com acesso TOTAL ao Mac: terminal, arquivos, internet, programação, automação, Git, Docker. Tem skills especiais: /pptx-official (slides profissionais), /frontend-design (sites/landing pages), /pdf-official (PDFs), /canvas-design (arte canvas/SVG), /docx-official (Word). Para usar uma skill, comece o prompt com o nome dela. Salve arquivos em /tmp/ para depois fazer upload com supabase_storage.', parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Instrução detalhada do que fazer. Para skills: "/pptx-official crie slides sobre X" ou "/frontend-design crie landing page sobre Y"' }, diretorio: { type: 'string', description: `Diretório de trabalho (padrão: ${process.env.HOME || '/Users'})` }, timeout: { type: 'number', description: 'Timeout em ms (padrão: 300000)' } }, required: ['prompt'] } } },
  { type: 'function', function: { name: 'pesquisar', description: 'Pesquisa profunda na internet sobre um tema. Usa Firecrawl para buscar e extrair conteúdo de múltiplas fontes. Resultado salvo no painel de mensagens.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Tema da pesquisa' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'enviar_whatsapp', description: 'Envia mensagem via WhatsApp', parameters: { type: 'object', properties: { numero: { type: 'string', description: 'Número com código do país (55+DDD+numero)' }, mensagem: { type: 'string' } }, required: ['numero', 'mensagem'] } } },
  { type: 'function', function: { name: 'enviar_imessage', description: 'Envia mensagem via iMessage (app Mensagens do macOS)', parameters: { type: 'object', properties: { numero: { type: 'string', description: 'Número com código do país (+55...)' }, mensagem: { type: 'string' } }, required: ['numero', 'mensagem'] } } },
  { type: 'function', function: { name: 'buscar_contato', description: 'Busca telefone/contato pelo nome na agenda', parameters: { type: 'object', properties: { nome: { type: 'string', description: 'Nome (ou parte) do contato' } }, required: ['nome'] } } },
  { type: 'function', function: { name: 'gerar_imagem', description: 'Gera imagem com DALL-E 3', parameters: { type: 'object', properties: { descricao: { type: 'string', description: 'Descrição da imagem em inglês' } }, required: ['descricao'] } } },
  { type: 'function', function: { name: 'buscar_credencial', description: 'Busca login/senha do cofre seguro', parameters: { type: 'object', properties: { nome_ou_url: { type: 'string', description: 'Nome do serviço ou URL' } }, required: ['nome_ou_url'] } } },
  { type: 'function', function: { name: 'chrome_perfil', description: 'Chrome com perfil logado do usuário. Instagram DMs, Gmail, YouTube, Drive. Ações: abrir (abre Chrome visível na tela), ler, screenshot, clicar, extrair. Use "abrir" quando o usuário pedir para ABRIR um site no Chrome.', parameters: { type: 'object', properties: { url: { type: 'string' }, acao: { type: 'string', enum: ['abrir', 'ler', 'screenshot', 'clicar', 'extrair'] }, seletor: { type: 'string' }, esperar: { type: 'number' } }, required: ['url', 'acao'] } } },
  { type: 'function', function: { name: 'whatsapp_cloud', description: 'WhatsApp Business Cloud API (Meta). Enviar msgs via API oficial, templates, campanhas em massa.', parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['enviar_texto', 'enviar_template', 'campanha_massa', 'listar_templates', 'criar_template', 'enviar_midia', 'status'] }, numero: { type: 'string' }, numeros: { type: 'array', items: { type: 'string' } }, texto: { type: 'string' }, template_name: { type: 'string' }, language_code: { type: 'string' }, components: { type: 'array', items: { type: 'object' } }, media_url: { type: 'string' }, media_type: { type: 'string', enum: ['image', 'video', 'document', 'audio'] }, caption: { type: 'string' }, template_category: { type: 'string', enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'] }, template_components: { type: 'array', items: { type: 'object' } } }, required: ['acao'] } } },
  { type: 'function', function: { name: 'criar_slides', description: 'Cria apresentação de slides. PADRÃO: HTML interativo (abre no navegador via link). Se o usuário pedir explicitamente PPTX ou PDF, use o parâmetro formato.', parameters: { type: 'object', properties: { tema: { type: 'string' }, publico: { type: 'string' }, num_slides: { type: 'number' }, paleta: { type: 'string', enum: ['azul_executivo', 'verde_confianca', 'grafite_moderno', 'terracota_elegante', 'violeta_criativo', 'oceano_profundo'] }, topicos: { type: 'string' }, formato: { type: 'string', enum: ['html', 'pptx', 'pdf'], description: 'html=padrão (abre no navegador), pptx=PowerPoint, pdf=PDF. Só use pptx/pdf se o usuário pedir explicitamente.' } }, required: ['tema'] } } },
  { type: 'function', function: { name: 'salvar_memoria', description: 'Salva informação importante sobre o usuário para lembrar em conversas futuras. Use quando ele contar algo pessoal, preferências, fatos sobre a vida dele.', parameters: { type: 'object', properties: { categoria: { type: 'string', enum: ['personal', 'preference', 'work', 'relationship', 'routine', 'opinion', 'goal', 'health', 'finance', 'other'], description: 'Tipo da informação' }, conteudo: { type: 'string', description: 'O que salvar (fato objetivo e claro)' }, importancia: { type: 'number', description: '1-10 (10=muito importante)' } }, required: ['categoria', 'conteudo'] } } },
  { type: 'function', function: { name: 'buscar_memoria', description: 'Busca nas memórias salvas sobre o usuário. Use para relembrar fatos, preferências, dados pessoais.', parameters: { type: 'object', properties: { busca: { type: 'string', description: 'Termo para buscar nas memórias' } }, required: ['busca'] } } },
  { type: 'function', function: { name: 'criar_evento', description: 'Cria evento no calendário. Use para reuniões, compromissos, aniversários, consultas, etc.', parameters: { type: 'object', properties: { titulo: { type: 'string' }, descricao: { type: 'string' }, categoria: { type: 'string', enum: ['reuniao', 'compromisso', 'pessoal', 'saude', 'financeiro', 'trabalho', 'estudo', 'lazer', 'viagem', 'aniversario', 'lembrete', 'geral'] }, local: { type: 'string' }, data_inicio: { type: 'string', description: 'YYYY-MM-DD HH:MM:SS' }, data_fim: { type: 'string', description: 'YYYY-MM-DD HH:MM:SS (opcional)' }, dia_inteiro: { type: 'boolean' }, repetir: { type: 'string', enum: ['daily', 'weekly', 'monthly'] }, lembrar_minutos_antes: { type: 'number', description: 'Minutos antes para lembrar (padrão 30)' }, participantes: { type: 'string', description: 'Nomes separados por vírgula' } }, required: ['titulo', 'data_inicio'] } } },
  { type: 'function', function: { name: 'listar_eventos', description: 'Lista eventos do calendário. Use para "o que tenho hoje?", "agenda da semana", "compromissos de amanhã".', parameters: { type: 'object', properties: { periodo: { type: 'string', enum: ['hoje', 'amanha', 'semana', 'proximos', 'todos'], description: 'Período a consultar' }, data: { type: 'string', description: 'Data específica YYYY-MM-DD (opcional)' }, limite: { type: 'number' } }, required: ['periodo'] } } },
  { type: 'function', function: { name: 'editar_evento', description: 'Edita um evento existente no calendário.', parameters: { type: 'object', properties: { id: { type: 'number' }, titulo: { type: 'string' }, descricao: { type: 'string' }, categoria: { type: 'string' }, local: { type: 'string' }, data_inicio: { type: 'string' }, data_fim: { type: 'string' }, lembrar_minutos_antes: { type: 'number' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'cancelar_evento', description: 'Cancela um evento do calendário.', parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'buscar_evento', description: 'Busca eventos por termo no calendário.', parameters: { type: 'object', properties: { busca: { type: 'string' } }, required: ['busca'] } } },
  { type: 'function', function: { name: 'fazer_ligacao', description: 'Liga para um número ou consulta histórico de ligações. Tipos: mensagem (fala e desliga), conversa (Zaya conversa na linha), historico (mostra ligações passadas com transcrição). Use historico quando perguntar "o que foi falado na ligação".', parameters: { type: 'object', properties: { numero: { type: 'string', description: 'Número com código do país (5588...)' }, mensagem: { type: 'string', description: 'O que a Zaya vai falar' }, tipo: { type: 'string', enum: ['mensagem', 'conversa', 'historico'], description: 'mensagem=fala e desliga, conversa=Zaya conversa, historico=ver ligações passadas' }, limite: { type: 'number', description: 'Quantas ligações mostrar no histórico (padrão: 5)' } }, required: ['tipo'] } } },
  { type: 'function', function: { name: 'agendar_lembrete', description: 'Agenda um lembrete/alarme. Na hora agendada, a Zaya avisa via ligação, WhatsApp ou voz. Use para "me lembra às X", "agenda pra tal dia", "me acorda às 7h".', parameters: { type: 'object', properties: { titulo: { type: 'string', description: 'Nome curto do lembrete' }, mensagem: { type: 'string', description: 'O que a Zaya vai falar/enviar' }, data_hora: { type: 'string', description: 'Data e hora no formato YYYY-MM-DD HH:MM:SS (horário de Brasília)' }, notificar_via: { type: 'string', enum: ['call', 'whatsapp', 'voice', 'all'], description: 'call=liga, whatsapp=manda msg, voice=fala no dashboard, all=todos' }, repetir: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'hourly'], description: 'Repetição (opcional)' }, numero: { type: 'string', description: 'Número para ligar/mandar msg (padrão: admin)' } }, required: ['titulo', 'mensagem', 'data_hora'] } } },
  { type: 'function', function: { name: 'listar_agendamentos', description: 'Lista todos os lembretes e agendamentos ativos.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'cancelar_agendamento', description: 'Cancela um agendamento/lembrete pelo ID.', parameters: { type: 'object', properties: { id: { type: 'number', description: 'ID do agendamento' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'ler_mensagens_whatsapp', description: 'Lê mensagens recebidas no WhatsApp. Use quando o usuário pedir "leia minhas mensagens", "quem me mandou msg", "tem mensagem nova?", "o que fulano mandou?".', parameters: { type: 'object', properties: { filtro: { type: 'string', description: 'Filtrar por nome ou número do remetente (opcional)' }, limite: { type: 'number', description: 'Quantas mensagens retornar (padrão 10, max 20)' }, periodo: { type: 'string', enum: ['hoje', 'ontem', '3dias', 'semana', 'todas'], description: 'Período das mensagens (padrão: hoje)' } }, required: [] } } },
  { type: 'function', function: { name: 'configurar_whatsapp', description: 'Altera configurações do bot WhatsApp. Use quando o usuário pedir para adicionar/remover números monitorados, mudar modo de resposta, ativar/desativar funções, adicionar admin, etc.', parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['ver_config', 'adicionar_monitorado', 'remover_monitorado', 'adicionar_admin', 'remover_admin', 'adicionar_whitelist', 'remover_whitelist', 'alterar_config'], description: 'Ação a executar' }, numero: { type: 'string', description: 'Número do contato (para adicionar/remover)' }, nome: { type: 'string', description: 'Nome do contato (para monitorados)' }, config_key: { type: 'string', description: 'Chave da config (para alterar_config): botActive, replyMode, replyGroups, autoLoginAdmin, readReceipts, transcribeAudio, analyzeImages, editVideos, watchNotifyMode, aiModel, unauthorizedReply' }, config_value: { type: 'string', description: 'Novo valor (true/false para toggles, ou texto)' } }, required: ['acao'] } } },
  { type: 'function', function: { name: 'supabase_query', description: 'Consulta dados no Supabase (banco de dados na nuvem). Use para buscar, listar, contar registros de qualquer tabela. Tabelas disponíveis: pesquisas, chat_messages, contatos, activity_log, wa_inbox, e quaisquer outras criadas. Use para responder perguntas como "quantas mensagens recebi?", "lista meus contatos", "mostra atividades recentes", etc.', parameters: { type: 'object', properties: { tabela: { type: 'string', description: 'Nome da tabela (ex: contatos, chat_messages, pesquisas, activity_log, wa_inbox)' }, select: { type: 'string', description: 'Colunas para retornar (padrão: * = todas). Ex: "nome,telefone" ou "count" para contar' }, filtros: { type: 'array', description: 'Array de filtros. Cada filtro: {coluna, operador, valor}. Operadores: eq, neq, gt, gte, lt, lte, like, ilike, is, in', items: { type: 'object', properties: { coluna: { type: 'string' }, operador: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in'] }, valor: { type: 'string' } }, required: ['coluna', 'operador', 'valor'] } }, ordem: { type: 'string', description: 'Coluna para ordenar (ex: "created_at" ou "created_at:desc")' }, limite: { type: 'number', description: 'Max registros (padrão 20)' } }, required: ['tabela'] } } },
  { type: 'function', function: { name: 'supabase_inserir', description: 'Insere ou atualiza dados no Supabase. Use para adicionar contatos, salvar notas, registrar dados, criar registros em qualquer tabela, ou atualizar registros existentes.', parameters: { type: 'object', properties: { tabela: { type: 'string', description: 'Nome da tabela' }, dados: { type: 'object', description: 'Objeto com os campos e valores a inserir. Ex: {"nome":"João","telefone":"5511999..."}' }, upsert: { type: 'boolean', description: 'Se true, atualiza se o registro já existir (baseado em conflict de chave primária). Padrão: false' }, atualizar_id: { type: 'number', description: 'Se informado, faz UPDATE no registro com esse ID ao invés de INSERT' } }, required: ['tabela', 'dados'] } } },
  { type: 'function', function: { name: 'supabase_gerenciar', description: 'Operações de gerenciamento no Supabase: deletar registros, listar tabelas, contar registros, executar SQL customizado. Use para "apaga esse contato", "quantos registros tem?", "limpa tabela X", etc.', parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['deletar', 'listar_tabelas', 'contar', 'sql', 'descrever_tabela'], description: 'Ação a executar' }, tabela: { type: 'string', description: 'Nome da tabela (para deletar, contar, descrever)' }, filtros: { type: 'array', description: 'Filtros para deletar (obrigatório para deletar). Mesmo formato do supabase_query.', items: { type: 'object', properties: { coluna: { type: 'string' }, operador: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in'] }, valor: { type: 'string' } }, required: ['coluna', 'operador', 'valor'] } }, sql: { type: 'string', description: 'Query SQL para executar (apenas para acao=sql). CUIDADO: use com responsabilidade.' } }, required: ['acao'] } } },
  { type: 'function', function: { name: 'supabase_storage', description: 'Upload, listar ou deletar arquivos no Supabase Storage. Use para enviar slides, imagens, vídeos, PDFs para a nuvem e gerar links públicos que o usuário pode abrir no navegador. Sempre que criar um arquivo (slides, imagem, etc), use esta ferramenta para fazer upload e devolver o link.', parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['upload', 'listar', 'deletar'], description: 'upload=envia arquivo e retorna link público, listar=lista arquivos, deletar=remove arquivo' }, caminho_arquivo: { type: 'string', description: 'Caminho local do arquivo para upload (ex: /tmp/slides.pptx). Obrigatório para upload.' }, bucket: { type: 'string', description: 'Nome do bucket (padrão: zaya-files)' }, pasta: { type: 'string', description: 'Pasta dentro do bucket para organizar (ex: slides, imagens, videos)' }, caminho_storage: { type: 'string', description: 'Caminho do arquivo no storage (para deletar)' } }, required: ['acao'] } } },
  { type: 'function', function: { name: 'missao', description: `Cria e gerencia missões autônomas. A Zaya entra em contato com leads via WhatsApp, segue um roteiro de conversa, coleta informações, agenda se necessário, e gera relatório com análise. Use quando o ${ADMIN_NAME} pedir para entrar em contato com leads, pesquisar preços, agendar serviços, etc.`, parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['criar', 'iniciar', 'listar', 'relatorio', 'status'], description: 'criar=define missão+etapas, iniciar=envia para os leads, listar=mostra missões, relatorio=gera/mostra relatório, status=progresso' }, titulo: { type: 'string', description: 'Nome da missão (ex: "Pesquisa Barbearias Aracaju")' }, objetivo: { type: 'string', description: 'O que a Zaya deve descobrir/fazer na conversa' }, etapas: { type: 'array', description: 'Roteiro da conversa. Cada etapa: {mensagem, tipo, campo_coletar}', items: { type: 'object', properties: { mensagem: { type: 'string', description: 'O que perguntar/dizer nesta etapa' }, tipo: { type: 'string', enum: ['perguntar', 'informar', 'agendar', 'encerrar'], description: 'Tipo da etapa' }, campo_coletar: { type: 'string', description: 'Nome do dado a coletar da resposta (ex: preco_corte, horario_disponivel)' } }, required: ['mensagem'] } }, categoria_leads: { type: 'string', description: 'Categoria dos leads para contatar (ex: barbearia, dentista)' }, cidade_leads: { type: 'string', description: 'Cidade dos leads' }, missao_id: { type: 'number', description: 'ID da missão (para iniciar, relatorio, status)' } }, required: ['acao'] } } },
  { type: 'function', function: { name: 'nano_banana', description: 'Gera imagens ultra-realistas via Google Nano Banana (Gemini). Fotos hiper-realistas de pessoas, produtos, cenários. Estilo fotográfico, iluminação natural, imperfeições sutis. Use para fotos realistas, posts Instagram, lifestyle, editorial. PREFERIR sobre gerar_imagem (DALL-E) quando quiser realismo.', parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Descrição detalhada da imagem. Inclua: cenário, iluminação, estilo fotográfico, ângulo de câmera. Em inglês para melhor resultado.' } }, required: ['prompt'] } } },
  { type: 'function', function: { name: 'buscar_empresa', description: 'Busca empresas, lojas, restaurantes, serviços no Google Places. Retorna nome, endereço, telefone, site, avaliação, horário de funcionamento. Use para encontrar estabelecimentos, pegar telefone de empresas, verificar endereços, encontrar serviços. SALVE os resultados como leads no Supabase automaticamente!', parameters: { type: 'object', properties: { busca: { type: 'string', description: 'O que buscar (ex: "barbearias", "dentistas", "restaurantes japoneses")' }, cidade: { type: 'string', description: 'Cidade para buscar (ex: "Aracaju", "São Paulo")' }, limite: { type: 'number', description: 'Máximo de resultados (padrão: 10, max: 20)' } }, required: ['busca'] } } },
  { type: 'function', function: { name: 'gerar_video', description: 'Gera vídeos com IA via Freepik (Kling). REQUER imagem de referência (image-to-video). Se não tiver imagem, gere uma antes com nano_banana ou gerar_imagem. Modelos: kling-pro (melhor), kling-std (padrão), kling-elements-pro, kling-elements-std. DEMORA 1-5 minutos.', parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Descrição do movimento/ação do vídeo. Max 2500 chars. Inclua: movimento, câmera, iluminação.' }, modelo: { type: 'string', enum: ['kling-pro', 'kling-std', 'kling-elements-pro', 'kling-elements-std'], description: 'kling-pro=melhor qualidade, kling-std=padrão, elements=efeitos especiais. Padrão: kling-std' }, imagem_referencia: { type: 'string', description: 'OBRIGATÓRIO: URL ou path local da imagem base. Se o usuário enviou foto no chat, use o path. Se não tem imagem, gere uma antes com nano_banana.' }, aspecto: { type: 'string', enum: ['16:9', '9:16', '1:1'], description: '16:9=paisagem, 9:16=vertical (reels/tiktok), 1:1=quadrado' }, duracao: { type: 'string', enum: ['5', '10'], description: '5 ou 10 segundos. Padrão: 5' } }, required: ['prompt', 'imagem_referencia'] } } },
  { type: 'function', function: { name: 'voice_id', description: `Configura reconhecimento de voz do ${ADMIN_NAME}. Cadastra amostras de voz, ativa/desativa verificação, mostra status. Use quando pedir: "configura minha voz", "cadastra minha voz", "ativa reconhecimento de voz".`, parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['cadastrar', 'ativar', 'desativar', 'status'], description: 'cadastrar=manda áudio para cadastro, ativar/desativar=liga/desliga verificação, status=mostra info' }, audio_path: { type: 'string', description: 'Caminho do áudio (quando cadastrar via arquivo enviado no chat)' } }, required: ['acao'] } } },
  { type: 'function', function: { name: 'youtube', description: 'Assiste/transcreve vídeos do YouTube. Extrai legendas ou baixa áudio e transcreve com Whisper. Use para: "transcreve esse vídeo", "o que fala nesse vídeo", "resume esse vídeo do YouTube".', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL do vídeo do YouTube' }, acao: { type: 'string', enum: ['transcrever', 'resumir', 'info'], description: 'transcrever=texto completo, resumir=resumo com GPT-4o, info=título/duração/canal' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'reuniao', description: `Modo reunião: grava tudo que é falado, transcreve em blocos de 3 min, e ao encerrar gera relatório completo com tópicos, demandas, menções ao ${ADMIN_NAME}, decisões e próximos passos. Use para: "entra no modo reunião", "grava a reunião", "para a reunião", "relatório da reunião".`, parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['iniciar', 'encerrar', 'status'], description: 'iniciar=começa gravar, encerrar=para e gera relatório, status=mostra progresso' }, titulo: { type: 'string', description: 'Título da reunião (opcional)' } }, required: ['acao'] } } },
  { type: 'function', function: { name: 'monitor_tela', description: `Monitora a tela do Mac e gera relatório de produtividade. Captura screenshots periódicos, analisa com IA o que o ${ADMIN_NAME} está fazendo, classifica em categorias (TRABALHO, ESTUDO, LAZER, REDE_SOCIAL, etc). Use quando pedir: "monitora minha tela", "como tá minha produtividade", "o que fiz hoje", "tive foco?".`, parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['iniciar', 'parar', 'relatorio', 'status'], description: 'iniciar=começa monitorar, parar=para, relatorio=gera relatório de produtividade, status=mostra se está ativo' }, periodo: { type: 'string', enum: ['hoje', 'ontem', 'semana'], description: 'Período do relatório (padrão: hoje)' }, intervalo: { type: 'number', description: 'Intervalo entre capturas em minutos (padrão: 5)' } }, required: ['acao'] } } },
  { type: 'function', function: { name: 'meta', description: 'Gerencia Instagram, Facebook e Ads via Meta API. Cria, edita, pausa, ativa, deleta campanhas. Posta no Instagram/Facebook. Gerencia comentários e DMs.', parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['ig_perfil', 'ig_posts', 'ig_criar_post', 'ig_deletar_post', 'ig_comentarios', 'ig_responder_comentario', 'ig_deletar_comentario', 'ig_dm', 'ig_enviar_dm', 'ig_insights', 'fb_pagina', 'fb_posts', 'fb_criar_post', 'fb_deletar_post', 'fb_messenger', 'fb_enviar_msg', 'ads_contas', 'ads_campanhas', 'ads_criar_campanha', 'ads_criar_anuncio', 'ads_ativar_campanha', 'ads_pausar_campanha', 'ads_editar_campanha', 'ads_deletar_campanha', 'ads_editar_adset'], description: 'Ação' }, image_url: { type: 'string' }, caption: { type: 'string' }, post_id: { type: 'string' }, comment_id: { type: 'string' }, texto: { type: 'string' }, destinatario_id: { type: 'string' }, nome_campanha: { type: 'string' }, objetivo: { type: 'string', enum: ['OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_TRAFFIC', 'OUTCOME_LEADS', 'OUTCOME_SALES'] }, orcamento_diario: { type: 'number', description: 'Centavos (2000=R$20)' }, idade_min: { type: 'number' }, idade_max: { type: 'number' }, pais: { type: 'string' }, duracao_dias: { type: 'number' }, campaign_id: { type: 'string', description: 'ID campanha ou adset. Se não informado, usa a ÚLTIMA campanha criada automaticamente. NÃO crie nova campanha se o usuário pedir para alterar/ativar/pausar — use a que já existe.' }, novo_status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] }, novo_nome: { type: 'string' }, novo_orcamento: { type: 'number', description: 'Novo orçamento em centavos' } }, required: ['acao'] } } },
];

// ================================================================
// MONITOR CALL STATUS — verifica se atendeu e envia relatório
// ================================================================
async function monitorCallStatus(callSid, numero) {
  if (!callSid) return;
  const twilio = (await import('twilio')).default;
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  let checks = 0;
  const maxChecks = 60; // 5 min max (check a cada 5s)

  const interval = setInterval(async () => {
    checks++;
    try {
      const call = await client.calls(callSid).fetch();
      const status = call.status;

      if (status === 'no-answer' || status === 'busy' || status === 'failed' || status === 'canceled') {
        clearInterval(interval);
        const msgs = { 'no-answer': 'não atendeu', 'busy': 'ocupado', 'failed': 'falhou', 'canceled': 'cancelada' };
        const aviso = `A ligação para ${numero} ${msgs[status] || status}.`;
        log.ai.info({ callSid, status, numero }, aviso);
        io?.emit('zaya-proactive', { text: aviso, tipo: 'ligacao' });
        return;
      }

      if (status === 'completed') {
        clearInterval(interval);
        log.ai.info({ callSid, duracao: call.duration, numero }, 'Ligação completada');

        // Busca histórico da ligação no Supabase
        await new Promise(r => setTimeout(r, 3000)); // espera save
        const { createClient: cc } = await import('@supabase/supabase-js');
        const { SUPABASE_URL: SU, SUPABASE_KEY: SK } = await import('../config.js');
        const sb = cc(SU, SK);
        const { data } = await sb.from('activity_log')
          .select('details')
          .eq('action', 'ligacao')
          .order('created_at', { ascending: false })
          .limit(1);

        const det = data?.[0]?.details || {};
        const transcricao = det.transcricao || '';

        if (transcricao) {
          // Gera relatório da ligação
          try {
            const res = await openai.chat.completions.create({
              model: AI_MODEL_MINI, max_tokens: 500,
              messages: [
                { role: 'system', content: 'Resuma esta ligação telefônica em 3-5 pontos. Português brasileiro, objetivo. Inclua: quem falou, o que foi dito, decisões, próximos passos.' },
                { role: 'user', content: transcricao },
              ],
            });
            const relatorio = res.choices[0].message.content;
            io?.emit('zaya-proactive', {
              text: `Ligação para ${numero} concluída (${call.duration}s).\n\nRelatório:\n${relatorio}`,
              tipo: 'ligacao_relatorio',
            });
          } catch (e) {
            io?.emit('zaya-proactive', {
              text: `Ligação para ${numero} concluída (${call.duration}s). Transcrição salva no histórico.`,
              tipo: 'ligacao',
            });
          }
        } else {
          io?.emit('zaya-proactive', {
            text: `Ligação para ${numero} concluída (${call.duration}s).`,
            tipo: 'ligacao',
          });
        }
        return;
      }

      // Timeout
      if (checks >= maxChecks) {
        clearInterval(interval);
        log.ai.warn({ callSid }, 'Monitor de ligação timeout');
      }
    } catch (e) {
      if (checks >= maxChecks) clearInterval(interval);
    }
  }, 5000);
}

// ================================================================
// EXECUTE VOICE TOOL
// ================================================================
async function executeVoiceTool(name, args) {
  log.ai.info({ tool: name, args: JSON.stringify(args).slice(0, 150) }, `VoiceTool: ${name}`);

  switch (name) {
    case 'executar_comando': {
      const check = sanitizeCommand(args.comando);
      if (!check.allowed) return check.reason;
      return new Promise((resolve) => {
        exec(args.comando, { timeout: 30000, maxBuffer: 1024 * 1024, shell: '/bin/zsh', cwd: process.env.HOME || os.homedir() }, (err, stdout, stderr) => {
          resolve(err ? `Erro: ${err.message}\n${stderr}` : stdout || stderr || '(sem saída)');
        });
      });
    }

    case 'claude_code': {
      const result = await runClaudeCode(args.prompt, args.diretorio, args.timeout);
      const out = result.output || '';
      // Detecta falta de saldo da Anthropic
      if (out.includes('credit balance is too low') || out.includes('insufficient_quota') || out.includes('rate_limit') || out.includes('overloaded')) {
        return 'ERRO: API Anthropic (Claude) sem saldo. Use ferramentas alternativas: executar_comando para scripts, pesquisar para buscas web, criar_slides para apresentações, gerar_imagem para imagens. NÃO tente claude_code novamente.';
      }
      // Se saída longa, salva no painel de mensagens
      if (out.length > 500) {
        const msg = {
          id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          title: `Claude Code: ${args.prompt.slice(0, 60)}`,
          content: out,
        };
        messagesDB.add(msg);
        io?.emit('new-message', msg);
        syncPesquisa(msg);
        logActivity('claude_code', { prompt: args.prompt.slice(0, 100), outputLen: out.length });
      }
      return out.slice(0, 4000);
    }

    case 'pesquisar': {
      const research = await doResearch(args.query);
      if (!research.success) return `Erro na pesquisa: ${research.summary}`;
      const msg = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        title: `Pesquisa: ${args.query}`,
        content: research.content,
        type: 'pesquisa',
      };
      messagesDB.add(msg);
      io?.emit('new-message', msg);
      syncPesquisa(msg);
      logActivity('pesquisa', { query: args.query, chars: research.content.length });
      return `Pesquisa "${args.query}" concluída! ${research.content.length} caracteres salvos no painel de mensagens. Resumo: ${research.summary.slice(0, 1000)}`;
    }

    case 'enviar_whatsapp': {
      let num = args.numero.replace(/\D/g, '');
      if (num.length <= 11) num = '55' + num;
      const result = sendWhatsApp(num, args.mensagem);
      return result.output;
    }

    case 'enviar_imessage': {
      const result = sendIMessage(args.numero, args.mensagem);
      return result.output;
    }

    case 'buscar_contato': {
      const result = searchContact(args.nome);
      return result.output;
    }

    case 'gerar_imagem': {
      const imagePath = await generateImage(args.descricao);
      if (!imagePath) return 'Erro ao gerar imagem.';
      // Auto-upload to Supabase Storage
      try {
        const result = await uploadToStorage(imagePath, 'zaya-files', 'imagens');
        return `Imagem gerada!\nLocal: ${imagePath}\nLink: ${result.publicUrl}`;
      } catch (e) {
        log.ai.warn({ err: e.message }, 'Auto-upload imagem falhou');
        return `Imagem gerada e salva em: ${imagePath}`;
      }
    }

    case 'buscar_credencial': {
      const creds = loadVault();
      if (creds.length === 0) return 'Nenhuma credencial no cofre.';
      const term = args.nome_ou_url.toLowerCase();
      const found = creds.filter(c => c.name.toLowerCase().includes(term) || c.url.toLowerCase().includes(term));
      if (found.length === 0) return `Nenhuma credencial para "${args.nome_ou_url}". Salvos: ${creds.map(c => c.name).join(', ')}`;
      return found.map(c => `${c.name}: ${c.url} | Login: ${c.login} | Senha: ${c.password}`).join('\n');
    }

    case 'chrome_perfil': {
      try {
        // Ação "abrir": abre Chrome visível na tela com o perfil do usuário
        if (args.acao === 'abrir') {
          const url = args.url || 'https://www.google.com';
          await new Promise((resolve, reject) => {
            exec(`open -a "Google Chrome" "${url}"`, { timeout: 10000 }, (err) => err ? reject(err) : resolve());
          });
          return `Chrome aberto em ${url}`;
        }

        const browser = await ensureChromeDebug();
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(args.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, args.esperar || 5000));

        let result;
        if (args.acao === 'screenshot') {
          const ssPath = join(TMP_DIR, `chrome-${Date.now()}.png`);
          await page.screenshot({ path: ssPath });
          result = `Screenshot salvo em ${ssPath}`;
        } else if (args.acao === 'clicar' && args.seletor) {
          await page.click(args.seletor);
          await new Promise(r => setTimeout(r, 3000));
          result = await page.evaluate(() => document.body.innerText);
          result = result.slice(0, 8000);
        } else if (args.acao === 'extrair' && args.seletor) {
          result = await page.evaluate((sel) => {
            return Array.from(document.querySelectorAll(sel)).map(e => e.innerText).join('\n---\n');
          }, args.seletor);
          result = result.slice(0, 8000) || 'Nenhum elemento encontrado.';
        } else {
          result = await page.evaluate(() => document.body.innerText);
          result = `Conteúdo de ${args.url}:\n\n${result.slice(0, 8000)}`;
        }
        await page.close();
        return result;
      } catch (e) {
        return `Erro Chrome: ${e.message}`;
      }
    }

    case 'whatsapp_cloud': {
      const FB_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;
      if (!FB_TOKEN) return 'Token do Facebook não configurado no .env (FACEBOOK_ACCESS_TOKEN)';
      const GRAPH_URL = 'https://graph.facebook.com/v21.0';
      const WABA_ID = '817886811302018';
      const WA_PHONE_ID = '965451583319125';
      async function graphCall(endpoint, method = 'GET', body = null) {
        const opts = { method, headers: { 'Authorization': `Bearer ${FB_TOKEN}`, 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(`${GRAPH_URL}${endpoint}`, opts);
        return res.json();
      }
      switch (args.acao) {
        case 'status': {
          const [waba, phone] = await Promise.all([
            graphCall(`/${WABA_ID}?fields=id,name,currency,timezone_id`),
            graphCall(`/${WA_PHONE_ID}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`),
          ]);
          return `WhatsApp Business Cloud API\nConta: ${waba.name || waba.id}\nNúmero: ${phone.display_phone_number} (${phone.verified_name})\nQualidade: ${phone.quality_rating || 'N/A'}\nLimite: ${phone.messaging_limit_tier || 'N/A'}`;
        }
        case 'listar_templates': {
          const data = await graphCall(`/${WABA_ID}/message_templates?fields=name,status,category,language&limit=50`);
          if (!data.data?.length) return 'Nenhum template encontrado.';
          return `Templates (${data.data.length}):\n` + data.data.map(t => `- ${t.name} [${t.category}] - ${t.status} (${t.language})`).join('\n');
        }
        case 'enviar_texto': {
          if (!args.numero || !args.texto) return 'Informe numero e texto.';
          const data = await graphCall(`/${WA_PHONE_ID}/messages`, 'POST', { messaging_product: 'whatsapp', to: args.numero.replace(/\D/g, ''), type: 'text', text: { body: args.texto } });
          return data.error ? `Erro: ${data.error.message}` : `Mensagem enviada! ID: ${data.messages?.[0]?.id}`;
        }
        case 'enviar_template': {
          if (!args.numero || !args.template_name) return 'Informe numero e template_name.';
          const payload = { messaging_product: 'whatsapp', to: args.numero.replace(/\D/g, ''), type: 'template', template: { name: args.template_name, language: { code: args.language_code || 'en_US' } } };
          if (args.components) payload.template.components = args.components;
          const data = await graphCall(`/${WA_PHONE_ID}/messages`, 'POST', payload);
          return data.error ? `Erro: ${data.error.message}` : `Template "${args.template_name}" enviado! ID: ${data.messages?.[0]?.id}`;
        }
        case 'campanha_massa': {
          if (!args.numeros || !args.template_name) return 'Informe numeros (lista) e template_name.';
          let ok = 0;
          for (const num of args.numeros) {
            try {
              const data = await graphCall(`/${WA_PHONE_ID}/messages`, 'POST', { messaging_product: 'whatsapp', to: num.replace(/\D/g, ''), type: 'template', template: { name: args.template_name, language: { code: args.language_code || 'en_US' }, ...(args.components ? { components: args.components } : {}) } });
              if (!data.error) ok++;
              await new Promise(r => setTimeout(r, 50));
            } catch {}
          }
          return `Campanha finalizada! Enviados: ${ok}/${args.numeros.length} | Falhas: ${args.numeros.length - ok}`;
        }
        case 'enviar_midia': {
          if (!args.numero || !args.media_type || !args.media_url) return 'Informe numero, media_type e media_url.';
          const mediaObj = { link: args.media_url };
          if (args.caption) mediaObj.caption = args.caption;
          const data = await graphCall(`/${WA_PHONE_ID}/messages`, 'POST', { messaging_product: 'whatsapp', to: args.numero.replace(/\D/g, ''), type: args.media_type, [args.media_type]: mediaObj });
          return data.error ? `Erro: ${data.error.message}` : `Mídia enviada! ID: ${data.messages?.[0]?.id}`;
        }
        case 'criar_template': {
          if (!args.template_name || !args.template_category || !args.template_components) return 'Informe template_name, template_category e template_components.';
          const data = await graphCall(`/${WABA_ID}/message_templates`, 'POST', { name: args.template_name, category: args.template_category, language: args.language_code || 'en_US', components: args.template_components });
          return data.error ? `Erro: ${data.error.message}` : `Template "${args.template_name}" criado! ID: ${data.id}`;
        }
        default: return `Ação "${args.acao}" não reconhecida.`;
      }
    }

    case 'criar_slides': {
      const slideResult = await createSlides(args);
      // Para PPTX/PDF: upload pro Supabase (download funciona)
      // Para HTML: link direto do servidor (Supabase não renderiza HTML)
      try {
        const pathMatch = slideResult.match(/Salvo em: (.+\.(pptx|pdf))/);
        if (pathMatch) {
          const pasta = pathMatch[2] === 'pdf' ? 'documentos' : 'slides';
          const result = await uploadToStorage(pathMatch[1], 'zaya-files', pasta);
          return `${slideResult}\nDownload: ${result.publicUrl}`;
        }
      } catch (e) {
        log.ai.warn({ err: e.message }, 'Auto-upload slides falhou');
      }
      // HTML: link já vem pronto do createSlides
      return slideResult;
    }

    case 'salvar_memoria': {
      const importance = args.importancia || 5;
      memoriesDB.add(args.categoria, args.conteudo, 'manual', importance);
      log.ai.info({ cat: args.categoria, content: args.conteudo.slice(0, 50) }, 'Memória salva');
      return `Memória salva: [${args.categoria}] ${args.conteudo}`;
    }

    case 'buscar_memoria': {
      const results = memoriesDB.search(args.busca);
      if (results.length === 0) return `Nenhuma memória encontrada sobre "${args.busca}".`;
      return results.map(m => `[${m.category}] ${m.content}`).join('\n');
    }

    case 'criar_evento': {
      const id = calendarDB.add({
        title: args.titulo,
        description: args.descricao || '',
        category: args.categoria || 'geral',
        location: args.local || '',
        start_at: args.data_inicio,
        end_at: args.data_fim || null,
        all_day: args.dia_inteiro || false,
        repeat_rule: args.repetir || null,
        remind_before: args.lembrar_minutos_antes ?? 30,
        remind_via: 'all',
        participants: args.participantes || '',
      });
      const catLabel = CATEGORIES[args.categoria || 'geral']?.label || args.categoria;
      return `Evento criado (ID ${id})!\n"${args.titulo}" — ${args.data_inicio}\nCategoria: ${catLabel}${args.local ? '\nLocal: ' + args.local : ''}${args.repetir ? '\nRepete: ' + args.repetir : ''}\nLembrete: ${args.lembrar_minutos_antes ?? 30} min antes`;
    }

    case 'listar_eventos': {
      let events = [];
      switch (args.periodo) {
        case 'hoje': events = calendarDB.getToday(); break;
        case 'amanha': events = calendarDB.getTomorrow(); break;
        case 'semana': events = calendarDB.getWeek(); break;
        case 'proximos': events = calendarDB.getUpcoming(args.limite || 10); break;
        case 'todos': events = calendarDB.getAll(); break;
        default:
          if (args.data) events = calendarDB.getByDate(args.data);
          else events = calendarDB.getUpcoming(10);
      }
      if (events.length === 0) return `Nenhum evento ${args.periodo === 'hoje' ? 'para hoje' : args.periodo === 'amanha' ? 'para amanhã' : 'encontrado'}.`;
      return events.map(e => {
        const time = e.all_day ? 'dia inteiro' : e.start_at.slice(11, 16);
        const cat = CATEGORIES[e.category]?.label || e.category;
        return `ID ${e.id}: ${e.start_at.slice(0, 10)} ${time} — ${e.title} [${cat}]${e.location ? ' @ ' + e.location : ''}${e.participants ? ' com ' + e.participants : ''}`;
      }).join('\n');
    }

    case 'editar_evento': {
      const updates = {};
      if (args.titulo) updates.title = args.titulo;
      if (args.descricao) updates.description = args.descricao;
      if (args.categoria) updates.category = args.categoria;
      if (args.local) updates.location = args.local;
      if (args.data_inicio) updates.start_at = args.data_inicio;
      if (args.data_fim) updates.end_at = args.data_fim;
      if (args.lembrar_minutos_antes !== undefined) updates.remind_before = args.lembrar_minutos_antes;
      const ok = calendarDB.update(args.id, updates);
      return ok ? `Evento ${args.id} atualizado!` : 'Evento não encontrado.';
    }

    case 'cancelar_evento': {
      calendarDB.cancel(args.id);
      return `Evento ${args.id} cancelado!`;
    }

    case 'buscar_evento': {
      const events = calendarDB.search(args.busca);
      if (events.length === 0) return `Nenhum evento encontrado com "${args.busca}".`;
      return events.map(e => `ID ${e.id}: ${e.start_at.slice(0, 10)} — ${e.title} [${e.status}]`).join('\n');
    }

    case 'fazer_ligacao': {
      if (args.tipo === 'historico') {
        // Busca histórico de ligações no Supabase
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const { SUPABASE_URL, SUPABASE_KEY } = await import('../config.js');
          const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
          const { data } = await sb.from('activity_log')
            .select('details, created_at')
            .eq('action', 'ligacao')
            .order('created_at', { ascending: false })
            .limit(args.limite || 5);
          if (!data || data.length === 0) return 'Nenhuma ligação registrada.';
          return data.map(d => {
            const det = d.details || {};
            return `📞 ${det.to || '?'} — ${new Date(d.created_at).toLocaleString('pt-BR')}\n${det.transcricao || '(sem transcrição)'}`;
          }).join('\n\n---\n\n');
        } catch (e) { return `Erro: ${e.message}`; }
      }
      if (args.tipo === 'conversa') {
        const { makeCall } = await import('./twilio.js');
        const result = await makeCall(args.numero, args.mensagem);
        if (!result.success) return `Erro: ${result.error}`;
        // Monitora status da ligação em background
        monitorCallStatus(result.callSid, args.numero);
        return `Ligando para ${args.numero} (modo conversa)... Quando terminar, te mando o relatório.`;
      } else {
        const { makeSimpleCall } = await import('./twilio.js');
        const result = await makeSimpleCall(args.numero, args.mensagem);
        if (!result.success) return `Erro: ${result.error}`;
        monitorCallStatus(result.callSid, args.numero);
        return `Ligando para ${args.numero} (mensagem)...`;
      }
    }

    case 'agendar_lembrete': {
      const phone = args.numero || getBotConfig().adminNumbers?.[0] || '';
      const notifyVia = args.notificar_via || 'call';
      const id = addSchedule(args.titulo, args.mensagem, phone, notifyVia, args.data_hora, args.repetir || null);
      const viaLabel = { call: 'ligação', whatsapp: 'WhatsApp', voice: 'voz no dashboard', all: 'todos (ligação + WhatsApp + voz)' };
      return `Lembrete agendado (ID ${id})!\n"${args.titulo}" — ${args.data_hora}\nNotificação via: ${viaLabel[notifyVia] || notifyVia}${args.repetir ? '\nRepete: ' + args.repetir : ''}`;
    }

    case 'listar_agendamentos': {
      const schedules = listSchedules();
      if (schedules.length === 0) return 'Nenhum agendamento ativo.';
      return schedules.map(s => `ID ${s.id}: "${s.title}" — ${s.schedule_at} (via ${s.notify_via})${s.repeat_rule ? ' [repete: ' + s.repeat_rule + ']' : ''}`).join('\n');
    }

    case 'cancelar_agendamento': {
      deleteSchedule(args.id);
      return `Agendamento ${args.id} cancelado!`;
    }

    case 'configurar_whatsapp': {
      const config = getBotConfig();

      switch (args.acao) {
        case 'ver_config': {
          const monitorados = (config.watchNumbers || []).map(w => `${w.nome} (${w.numero})`).join(', ') || 'nenhum';
          const admins = (config.adminNumbers || []).join(', ') || 'nenhum';
          const whitelist = (config.whitelist || []).join(', ') || 'nenhum';
          return `Configurações do Bot WhatsApp:
- Bot ativo: ${config.botActive ? 'sim' : 'não'}
- Modo resposta: ${config.replyMode}
- Admins: ${admins}
- Whitelist: ${whitelist}
- Monitorados: ${monitorados}
- Notificação: ${config.watchNotifyMode}
- Responder grupos: ${config.replyGroups ? 'sim' : 'não'}
- Auto-login admin: ${config.autoLoginAdmin ? 'sim' : 'não'}
- Transcrever áudio: ${config.transcribeAudio ? 'sim' : 'não'}
- Analisar imagens: ${config.analyzeImages ? 'sim' : 'não'}
- Editar vídeos: ${config.editVideos ? 'sim' : 'não'}
- Modelo IA: ${config.aiModel}`;
        }

        case 'adicionar_monitorado': {
          if (!args.numero) return 'Número é obrigatório para adicionar monitorado.';
          const num = args.numero.replace(/\D/g, '');
          if (!config.watchNumbers) config.watchNumbers = [];
          if (config.watchNumbers.find(w => w.numero === num)) return `${args.nome || num} já está nos monitorados.`;
          config.watchNumbers.push({ numero: num, nome: args.nome || num, notify: true });
          updateBotConfig({ watchNumbers: config.watchNumbers });
          log.ai.info({ numero: num, nome: args.nome }, 'Monitorado adicionado via voz');
          return `Pronto! ${args.nome || num} (${num}) adicionado nos monitorados. Vou avisar quando mandar mensagem.`;
        }

        case 'remover_monitorado': {
          if (!args.numero && !args.nome) return 'Informe número ou nome para remover.';
          const before = config.watchNumbers?.length || 0;
          config.watchNumbers = (config.watchNumbers || []).filter(w => {
            if (args.numero && w.numero === args.numero.replace(/\D/g, '')) return false;
            if (args.nome && w.nome.toLowerCase().includes(args.nome.toLowerCase())) return false;
            return true;
          });
          updateBotConfig({ watchNumbers: config.watchNumbers });
          const removed = before - config.watchNumbers.length;
          return removed > 0 ? `Removido dos monitorados!` : 'Não encontrei esse contato nos monitorados.';
        }

        case 'adicionar_admin': {
          if (!args.numero) return 'Número é obrigatório.';
          const num = args.numero.replace(/\D/g, '');
          if (!config.adminNumbers) config.adminNumbers = [];
          if (config.adminNumbers.includes(num)) return `${num} já é admin.`;
          config.adminNumbers.push(num);
          updateBotConfig({ adminNumbers: config.adminNumbers });
          return `${num} adicionado como admin do bot!`;
        }

        case 'remover_admin': {
          if (!args.numero) return 'Número é obrigatório.';
          const num = args.numero.replace(/\D/g, '');
          config.adminNumbers = (config.adminNumbers || []).filter(n => n !== num);
          updateBotConfig({ adminNumbers: config.adminNumbers });
          return `${num} removido dos admins.`;
        }

        case 'adicionar_whitelist': {
          if (!args.numero) return 'Número é obrigatório.';
          const num = args.numero.replace(/\D/g, '');
          if (!config.whitelist) config.whitelist = [];
          if (config.whitelist.includes(num)) return `${num} já está na whitelist.`;
          config.whitelist.push(num);
          updateBotConfig({ whitelist: config.whitelist });
          return `${num} adicionado na whitelist!`;
        }

        case 'remover_whitelist': {
          if (!args.numero) return 'Número é obrigatório.';
          const num = args.numero.replace(/\D/g, '');
          config.whitelist = (config.whitelist || []).filter(n => n !== num);
          updateBotConfig({ whitelist: config.whitelist });
          return `${num} removido da whitelist.`;
        }

        case 'alterar_config': {
          if (!args.config_key) return 'Informe qual configuração alterar.';
          let value = args.config_value;
          // Converte strings true/false para boolean
          if (value === 'true') value = true;
          else if (value === 'false') value = false;
          updateBotConfig({ [args.config_key]: value });
          log.ai.info({ key: args.config_key, value }, 'Config alterada via voz');
          return `Configuração ${args.config_key} alterada para: ${value}`;
        }

        default: return `Ação "${args.acao}" não reconhecida.`;
      }
    }

    case 'ler_mensagens_whatsapp': {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const { SUPABASE_URL, SUPABASE_KEY } = await import('../config.js');
        if (!SUPABASE_URL || !SUPABASE_KEY) return 'Supabase não configurado.';

        const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
        const limite = Math.min(args.limite || 10, 20);

        // Calcula data de início baseado no período
        let dateFilter = new Date();
        const periodo = args.periodo || 'hoje';
        if (periodo === 'hoje') dateFilter.setHours(0, 0, 0, 0);
        else if (periodo === 'ontem') { dateFilter.setDate(dateFilter.getDate() - 1); dateFilter.setHours(0, 0, 0, 0); }
        else if (periodo === '3dias') dateFilter.setDate(dateFilter.getDate() - 3);
        else if (periodo === 'semana') dateFilter.setDate(dateFilter.getDate() - 7);
        else dateFilter = new Date(0); // todas

        let query = sb.from('wa_inbox')
          .select('phone, push_name, message_body, message_type, event, received_at')
          .ilike('event', '%received%')
          .eq('from_me', false)
          .gte('received_at', dateFilter.toISOString())
          .order('received_at', { ascending: false })
          .limit(limite);

        // Filtro por nome ou número
        if (args.filtro) {
          const f = args.filtro.replace(/\D/g, '');
          if (f.length >= 8) {
            query = query.ilike('phone', `%${f}%`);
          } else {
            query = query.ilike('push_name', `%${args.filtro}%`);
          }
        }

        const { data: msgs, error } = await query;
        if (error) return `Erro ao buscar: ${error.message}`;
        if (!msgs || msgs.length === 0) return 'Nenhuma mensagem encontrada nesse período.';

        // Agrupa por remetente
        const byPerson = {};
        for (const m of msgs) {
          const nome = m.push_name || m.phone || 'Desconhecido';
          if (!byPerson[nome]) byPerson[nome] = [];
          byPerson[nome].push({
            text: m.message_body || (m.message_type !== 'text' ? `[${m.message_type}]` : '[vazio]'),
            time: new Date(m.received_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          });
        }

        let result = `📬 ${msgs.length} mensagem(ns) (${periodo}):\n\n`;
        for (const [nome, mensagens] of Object.entries(byPerson)) {
          result += `*${nome}* (${mensagens.length} msg):\n`;
          for (const m of mensagens) {
            result += `  ${m.time} — ${m.text.slice(0, 150)}\n`;
          }
          result += '\n';
        }

        return result.trim();
      } catch (e) {
        log.ai.error({ err: e.message }, 'Erro ler_mensagens_whatsapp');
        return `Erro ao ler mensagens: ${e.message}`;
      }
    }

    case 'supabase_query': {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const { SUPABASE_URL, SUPABASE_KEY } = await import('../config.js');
        if (!SUPABASE_URL || !SUPABASE_KEY) return 'Supabase não configurado.';
        const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

        const limite = Math.min(args.limite || 20, 100);
        const selectCols = args.select || '*';

        // Count mode
        if (selectCols === 'count') {
          const { count, error } = await sb.from(args.tabela).select('*', { count: 'exact', head: true });
          if (error) return `Erro: ${error.message}`;
          return `Tabela "${args.tabela}": ${count} registros.`;
        }

        let query = sb.from(args.tabela).select(selectCols).limit(limite);

        // Apply filters
        if (args.filtros && args.filtros.length > 0) {
          for (const f of args.filtros) {
            const val = f.operador === 'in' ? JSON.parse(f.valor) : f.valor;
            if (f.operador === 'is') {
              query = query.is(f.coluna, f.valor === 'null' ? null : f.valor);
            } else {
              query = query[f.operador](f.coluna, val);
            }
          }
        }

        // Order
        if (args.ordem) {
          const [col, dir] = args.ordem.split(':');
          query = query.order(col, { ascending: dir !== 'desc' });
        }

        const { data, error } = await query;
        if (error) return `Erro na query: ${error.message}`;
        if (!data || data.length === 0) return 'Nenhum resultado encontrado.';

        return JSON.stringify(data, null, 2).slice(0, 4000);
      } catch (e) {
        log.ai.error({ err: e.message }, 'Erro supabase_query');
        return `Erro: ${e.message}`;
      }
    }

    case 'supabase_inserir': {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const { SUPABASE_URL, SUPABASE_KEY } = await import('../config.js');
        if (!SUPABASE_URL || !SUPABASE_KEY) return 'Supabase não configurado.';
        const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

        // UPDATE mode
        if (args.atualizar_id) {
          const { data, error } = await sb.from(args.tabela)
            .update(args.dados)
            .eq('id', args.atualizar_id)
            .select();
          if (error) return `Erro ao atualizar: ${error.message}`;
          return `Atualizado com sucesso: ${JSON.stringify(data?.[0] || {}).slice(0, 500)}`;
        }

        // INSERT or UPSERT
        const opts = args.upsert ? { onConflict: 'id' } : {};
        const method = args.upsert ? 'upsert' : 'insert';
        const { data, error } = await sb.from(args.tabela)[method](args.dados, opts).select();
        if (error) return `Erro ao inserir: ${error.message}`;
        return `Inserido com sucesso: ${JSON.stringify(data?.[0] || {}).slice(0, 500)}`;
      } catch (e) {
        log.ai.error({ err: e.message }, 'Erro supabase_inserir');
        return `Erro: ${e.message}`;
      }
    }

    case 'supabase_gerenciar': {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const { SUPABASE_URL, SUPABASE_KEY } = await import('../config.js');
        if (!SUPABASE_URL || !SUPABASE_KEY) return 'Supabase não configurado.';
        const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

        switch (args.acao) {
          case 'deletar': {
            if (!args.tabela || !args.filtros || args.filtros.length === 0) {
              return 'Erro: tabela e pelo menos um filtro são obrigatórios para deletar (segurança).';
            }
            let query = sb.from(args.tabela).delete();
            for (const f of args.filtros) {
              const val = f.operador === 'in' ? JSON.parse(f.valor) : f.valor;
              query = query[f.operador](f.coluna, val);
            }
            const { data, error } = await query.select();
            if (error) return `Erro ao deletar: ${error.message}`;
            return `Deletado(s) ${data?.length || 0} registro(s) de "${args.tabela}".`;
          }

          case 'contar': {
            if (!args.tabela) return 'Erro: informe a tabela.';
            const { count, error } = await sb.from(args.tabela).select('*', { count: 'exact', head: true });
            if (error) return `Erro: ${error.message}`;
            return `Tabela "${args.tabela}": ${count} registros.`;
          }

          case 'listar_tabelas': {
            const { data, error } = await sb.rpc('get_tables_info').catch(() => ({ data: null, error: { message: 'RPC não disponível' } }));
            if (error || !data) {
              // Fallback: query information_schema
              const { data: tables, error: err2 } = await sb.from('information_schema.tables')
                .select('table_name')
                .eq('table_schema', 'public')
                .order('table_name');
              if (err2) {
                // Last fallback: known tables
                return 'Tabelas conhecidas: pesquisas, chat_messages, contatos, activity_log, wa_inbox';
              }
              return `Tabelas: ${tables.map(t => t.table_name).join(', ')}`;
            }
            return JSON.stringify(data, null, 2).slice(0, 3000);
          }

          case 'descrever_tabela': {
            if (!args.tabela) return 'Erro: informe a tabela.';
            const { data, error } = await sb.from(args.tabela).select('*').limit(1);
            if (error) return `Erro: ${error.message}`;
            if (!data || data.length === 0) return `Tabela "${args.tabela}" existe mas está vazia.`;
            const cols = Object.keys(data[0]);
            const sample = data[0];
            let desc = `Tabela "${args.tabela}" — Colunas:\n`;
            for (const c of cols) {
              const tipo = sample[c] === null ? 'null' : typeof sample[c];
              desc += `  - ${c} (${tipo}): ex: ${JSON.stringify(sample[c]).slice(0, 80)}\n`;
            }
            return desc;
          }

          case 'sql': {
            if (!args.sql) return 'Erro: informe a query SQL.';
            const { data, error } = await sb.rpc('exec_sql', { query: args.sql });
            if (error) {
              // Try direct fetch as fallback
              const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'apikey': SUPABASE_KEY,
                  'Authorization': `Bearer ${SUPABASE_KEY}`,
                },
                body: JSON.stringify({ query: args.sql }),
              });
              if (!res.ok) return `Erro SQL: ${error.message}. Nota: a função RPC "exec_sql" pode não existir. Crie-a no Supabase SQL Editor: CREATE OR REPLACE FUNCTION exec_sql(query text) RETURNS json AS $$ BEGIN RETURN (SELECT json_agg(row_to_json(t)) FROM (SELECT * FROM json_populate_recordset(null::record, query::json)) t); END; $$ LANGUAGE plpgsql SECURITY DEFINER;`;
              const result = await res.json();
              return JSON.stringify(result, null, 2).slice(0, 4000);
            }
            return JSON.stringify(data, null, 2).slice(0, 4000);
          }

          default: return `Ação "${args.acao}" não reconhecida.`;
        }
      } catch (e) {
        log.ai.error({ err: e.message }, 'Erro supabase_gerenciar');
        return `Erro: ${e.message}`;
      }
    }

    case 'supabase_storage': {
      try {
        const bucket = args.bucket || 'zaya-files';
        const pasta = args.pasta || '';

        switch (args.acao) {
          case 'upload': {
            if (!args.caminho_arquivo) return 'Erro: informe o caminho do arquivo para upload.';
            const { existsSync } = await import('fs');
            if (!existsSync(args.caminho_arquivo)) return `Erro: arquivo não encontrado: ${args.caminho_arquivo}`;
            const result = await uploadToStorage(args.caminho_arquivo, bucket, pasta);
            return `Upload feito com sucesso!\nArquivo: ${result.fileName}\nTamanho: ${(result.size / 1024).toFixed(1)} KB\nLink: ${result.publicUrl}`;
          }

          case 'listar': {
            const files = await listStorageFiles(bucket, pasta);
            if (files.length === 0) return `Nenhum arquivo encontrado em "${bucket}/${pasta || ''}".`;
            let result = `Arquivos em "${bucket}/${pasta || ''}":\n\n`;
            for (const f of files) {
              const size = f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : `${(f.size / 1024).toFixed(1)} KB`;
              result += `- ${f.name} (${size})\n  Link: ${f.url}\n`;
            }
            return result;
          }

          case 'deletar': {
            if (!args.caminho_storage) return 'Erro: informe o caminho do arquivo no storage para deletar.';
            await deleteStorageFile(args.caminho_storage, bucket);
            return `Arquivo "${args.caminho_storage}" deletado com sucesso.`;
          }

          default: return `Ação "${args.acao}" não reconhecida. Use: upload, listar, deletar.`;
        }
      } catch (e) {
        log.ai.error({ err: e.message }, 'Erro supabase_storage');
        return `Erro: ${e.message}`;
      }
    }

    case 'missao': {
      try {
        switch (args.acao) {
          case 'criar': {
            if (!args.titulo || !args.objetivo || !args.etapas) return 'Erro: titulo, objetivo e etapas são obrigatórios.';
            const missao = await criarMissao({
              titulo: args.titulo,
              objetivo: args.objetivo,
              etapas: args.etapas,
              categoria_leads: args.categoria_leads,
              cidade_leads: args.cidade_leads,
            });
            return `Missão #${missao.id} criada: "${missao.titulo}"\n${missao.script.length} etapas no roteiro.\nUse missao com acao="iniciar" e missao_id=${missao.id} para enviar para os leads.`;
          }
          case 'iniciar': {
            if (!args.missao_id) return 'Erro: informe missao_id.';
            const result = await iniciarMissao(args.missao_id);
            return `Missão #${result.missaoId} iniciada!\n${result.enviados}/${result.totalLeads} leads contatados.\nPrimeira mensagem: "${result.primeiraMensagem.slice(0, 100)}"\n\nA Zaya vai continuar as conversas automaticamente quando os leads responderem.`;
          }
          case 'listar': {
            const missoes = await listarMissoes(args.status);
            if (missoes.length === 0) return 'Nenhuma missão encontrada.';
            return missoes.map(m => `#${m.id} — ${m.titulo} [${m.status}] | ${m.contatados || 0}/${m.total_leads || 0} contatados, ${m.concluidos || 0} concluídos`).join('\n');
          }
          case 'relatorio': {
            if (!args.missao_id) return 'Erro: informe missao_id.';
            let missao = await obterRelatorio(args.missao_id);
            if (!missao) return 'Missão não encontrada.';
            if (!missao.relatorio) {
              const rel = await gerarRelatorio(args.missao_id);
              if (rel) return rel;
              return 'Missão ainda em andamento. Relatório será gerado quando todas as conversas forem concluídas.';
            }
            return `RELATÓRIO — ${missao.titulo}\n\n${missao.relatorio}`;
          }
          case 'status': {
            if (!args.missao_id) return 'Erro: informe missao_id.';
            const missao = await obterRelatorio(args.missao_id);
            if (!missao) return 'Missão não encontrada.';
            return `Missão #${missao.id}: ${missao.titulo}\nStatus: ${missao.status}\nLeads: ${missao.total_leads || 0}\nContatados: ${missao.contatados || 0}\nRespondidos: ${missao.respondidos || 0}\nConcluídos: ${missao.concluidos || 0}`;
          }
          default: return 'Ação não reconhecida. Use: criar, iniciar, listar, relatorio, status.';
        }
      } catch (e) {
        log.ai.error({ err: e.message }, 'Erro missao');
        return `Erro: ${e.message}`;
      }
    }

    case 'nano_banana': {
      try {
        const result = await gerarImagemNanoBanana(args.prompt);
        if (!result.success) throw new Error(result.error);
        try {
          const upload = await uploadToStorage(result.path, 'zaya-files', 'imagens');
          return `Imagem gerada com Nano Banana!\nLocal: ${result.path}\nLink: ${upload.publicUrl}`;
        } catch (e) {
          return `Imagem gerada!\nLocal: ${result.path}\n(Upload falhou: ${e.message})`;
        }
      } catch (e) {
        log.ai.warn({ err: e.message }, 'NanoBanana falhou, tentando DALL-E 3 como fallback');
        // Fallback: DALL-E 3
        try {
          const imagePath = await generateImage(args.prompt);
          if (!imagePath) return 'Erro: Nano Banana sem quota e DALL-E 3 também falhou.';
          try {
            const upload = await uploadToStorage(imagePath, 'zaya-files', 'imagens');
            return `Nano Banana indisponível, usei DALL-E 3.\nLocal: ${imagePath}\nLink: ${upload.publicUrl}`;
          } catch (ue) {
            return `Nano Banana indisponível, usei DALL-E 3.\nLocal: ${imagePath}`;
          }
        } catch (de) {
          return `Erro: Nano Banana sem quota (${e.message.slice(0, 80)}). DALL-E 3 também falhou (${de.message.slice(0, 80)}).`;
        }
      }
    }

    case 'buscar_empresa': {
      try {
        const empresas = await buscarEmpresas(args.busca, {
          cidade: args.cidade,
          limite: Math.min(args.limite || 10, 20),
        });
        if (empresas.length === 0) return `Nenhuma empresa encontrada para "${args.busca}"${args.cidade ? ` em ${args.cidade}` : ''}.`;

        let result = `Encontrei ${empresas.length} resultado(s):\n\n`;
        for (const e of empresas) {
          result += `*${e.nome}*\n`;
          if (e.endereco) result += `  Endereço: ${e.endereco}\n`;
          if (e.telefone) result += `  Telefone: ${e.telefone}\n`;
          if (e.website) result += `  Site: ${e.website}\n`;
          if (e.avaliacao) result += `  Avaliação: ${e.avaliacao}⭐ (${e.total_avaliacoes} reviews)\n`;
          if (e.horario) result += `  Horário: ${e.horario}\n`;
          if (e.google_maps) result += `  Maps: ${e.google_maps}\n`;
          result += '\n';
        }
        return result.slice(0, 6000);
      } catch (e) {
        log.ai.error({ err: e.message }, 'Erro buscar_empresa');
        return `Erro: ${e.message}`;
      }
    }

    case 'voice_id': {
      try {
        switch (args.acao) {
          case 'cadastrar': {
            if (!args.audio_path) return 'Erro: mande um áudio no chat para eu cadastrar sua voz.';
            const r = await addVoiceSample(args.audio_path);
            return r.success ? r.message : `Erro: ${r.error}`;
          }
          case 'ativar': {
            const r = enableVoiceId(true);
            return r.samples >= 3 ? `Voice ID ATIVADO! ${r.samples} amostras cadastradas. Só vou responder à sua voz.` : `Voice ID ativado mas precisa de pelo menos 3 amostras. Tem ${r.samples}. Mande mais áudios.`;
          }
          case 'desativar': {
            enableVoiceId(false);
            return 'Voice ID desativado. Respondo a qualquer pessoa.';
          }
          case 'status': {
            const s = await getVoiceIdStatus();
            return `Voice ID: ${s.enabled ? 'ATIVO' : 'INATIVO'}\nAmostras: ${s.samples}\nPronto: ${s.ready ? 'sim' : 'não'}`;
          }
          default: return 'Ação: cadastrar, ativar, desativar, status.';
        }
      } catch (e) { return `Erro: ${e.message}`; }
    }

    case 'youtube': {
      try {
        const url = args.url;
        if (!url) return 'Erro: URL do YouTube obrigatória.';
        const acao = args.acao || 'transcrever';
        const tmpDir = '/tmp/yt_' + Date.now();

        if (acao === 'info') {
          // Pega info do vídeo
          const r = await new Promise(res => {
            exec(`yt-dlp --print title --print duration --print channel "${url}" --no-download`, { timeout: 15000 }, (err, out) => res(out?.trim() || 'Erro'));
          });
          return `Info do vídeo:\n${r}`;
        }

        // Tenta pegar legendas primeiro (mais rápido)
        let transcricao = '';
        try {
          await new Promise((res, rej) => {
            exec(`mkdir -p ${tmpDir} && yt-dlp --write-auto-sub --sub-lang pt,en --skip-download --sub-format vtt -o "${tmpDir}/video" "${url}"`, { timeout: 30000 }, (err) => err ? rej(err) : res());
          });
          // Lê o arquivo de legendas
          const { readdirSync, readFileSync } = await import('fs');
          const files = readdirSync(tmpDir).filter(f => f.endsWith('.vtt'));
          if (files.length > 0) {
            const vtt = readFileSync(`${tmpDir}/${files[0]}`, 'utf-8');
            // Limpa VTT → texto puro
            transcricao = vtt.split('\n').filter(l => !l.match(/^(WEBVTT|\d|-->|Kind:|Language:|\s*$)/)).map(l => l.replace(/<[^>]+>/g, '')).join(' ').replace(/\s+/g, ' ').trim();
          }
        } catch (e) { log.ai.info('Legendas não disponíveis, baixando áudio...'); }

        // Se não tem legendas, baixa áudio e transcreve
        if (!transcricao) {
          try {
            await new Promise((res, rej) => {
              exec(`mkdir -p ${tmpDir} && yt-dlp -x --audio-format wav --audio-quality 0 --max-filesize 25m -o "${tmpDir}/audio.%(ext)s" "${url}"`, { timeout: 120000 }, (err) => err ? rej(err) : res());
            });
            const { existsSync, readFileSync: rf } = await import('fs');
            const wavPath = `${tmpDir}/audio.wav`;
            if (existsSync(wavPath)) {
              const fileData = rf(wavPath);
              const blob = new Blob([fileData], { type: 'audio/wav' });
              const fd = new FormData();
              fd.append('file', blob, 'audio.wav');
              fd.append('model', 'whisper-1');
              fd.append('language', 'pt');
              fd.append('response_format', 'json');
              const wr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                body: fd,
              });
              if (wr.ok) { const d = await wr.json(); transcricao = d.text || ''; }
            }
          } catch (e) { return `Erro ao baixar/transcrever áudio: ${e.message}`; }
        }

        // Limpa tmp
        exec(`rm -rf ${tmpDir}`);

        if (!transcricao) return 'Não consegui extrair texto deste vídeo.';

        if (acao === 'resumir') {
          const res = await openai.chat.completions.create({
            model: AI_MODEL, max_tokens: 1500,
            messages: [
              { role: 'system', content: 'Resuma este vídeo do YouTube em português brasileiro. Inclua: tema principal, pontos-chave, conclusões. Seja objetivo.' },
              { role: 'user', content: transcricao.slice(0, 15000) },
            ],
          });
          return res.choices[0].message.content || 'Erro no resumo.';
        }

        // Transcrição completa
        return transcricao.slice(0, 8000);
      } catch (e) {
        log.ai.error({ err: e.message }, 'Erro youtube');
        return `Erro: ${e.message}`;
      }
    }

    case 'reuniao': {
      try {
        switch (args.acao) {
          case 'iniciar': {
            const r = startMeeting(args.titulo);
            return `Modo reunião ${r.status}! "${r.titulo}"\nVou gravar tudo que for falado em blocos de 3 minutos. Quando quiser encerrar, diga "encerra a reunião" e eu gero o relatório completo.`;
          }
          case 'encerrar': {
            const r = await endMeeting();
            if (r.relatorio) return r.relatorio;
            return `Reunião ${r.status}.`;
          }
          case 'status': {
            const s = getMeetingStatus();
            if (!s.ativa) return 'Nenhuma reunião ativa.';
            return `Reunião "${s.titulo}" em andamento\nDuração: ${s.duracao} min\nBlocos gravados: ${s.chunks}\nÚltimo: ${s.ultimoChunk || 'nenhum'}`;
          }
          default: return 'Ação: iniciar, encerrar, status.';
        }
      } catch (e) { return `Erro: ${e.message}`; }
    }

    case 'monitor_tela': {
      try {
        switch (args.acao) {
          case 'iniciar': {
            const r = startScreenMonitor(args.intervalo || 5);
            return `Monitor de tela ${r.status}! Capturas a cada ${r.interval} minutos. Vou analisar o que você faz e gerar relatório de produtividade.`;
          }
          case 'parar': {
            const r = stopScreenMonitor();
            return `Monitor de tela ${r.status}.`;
          }
          case 'relatorio': {
            const r = await gerarRelatorioTela(args.periodo || 'hoje');
            return r;
          }
          case 'status': {
            const s = getMonitorStatus();
            return `Monitor: ${s.ativo ? 'ATIVO' : 'INATIVO'}\nCapturas: ${s.capturas}\nÚltima: ${s.ultima?.hora || 'nenhuma'} — ${s.ultima?.analise || ''}`;
          }
          default: return 'Ação não reconhecida. Use: iniciar, parar, relatorio, status.';
        }
      } catch (e) {
        return `Erro: ${e.message}`;
      }
    }

    case 'gerar_video': {
      try {
        if (!args.imagem_referencia) {
          return 'Freepik precisa de uma imagem de referência. Use nano_banana ou gerar_imagem primeiro para criar a imagem base, depois chame gerar_video com o path da imagem.';
        }

        const result = await gerarVideoDeImagem(args.prompt, args.imagem_referencia, {
          modelo: args.modelo || 'kling-std',
          aspecto: args.aspecto,
          duracao: args.duracao,
        });

        if (!result.success) {
          return `Erro ao gerar vídeo: ${result.error}`;
        }

        // Upload para Supabase
        try {
          const upload = await uploadToStorage(result.path, 'zaya-files', 'videos');
          const sizeMB = result.size ? (result.size / 1024 / 1024).toFixed(1) + 'MB' : '';
          return `Vídeo gerado via ${result.engine}! ${sizeMB}\nLocal: ${result.path}\nLink: ${upload.publicUrl}`;
        } catch (ue) {
          return `Vídeo gerado via ${result.engine}!\nLocal: ${result.path}${result.url ? '\nURL: ' + result.url : ''}\n(Upload Supabase falhou: ${ue.message})`;
        }
      } catch (e) {
        log.ai.error({ err: e.message }, 'Erro gerar_video');
        return `Erro: ${e.message}`;
      }
    }

    case 'meta': {
      try {
        const MT = process.env.FACEBOOK_ACCESS_TOKEN;
        if (!MT) return 'Token Meta não configurado no .env';
        const G = 'https://graph.facebook.com/v21.0';

        // Resolve campaign_id: aceita ID direto, nome da campanha, ou usa a última
        function resolveCampaignId(val) {
          if (!val) return global._lastCampaignId || null;
          // Se é um ID numérico
          if (/^\d+$/.test(val)) return val;
          // Se é um nome, busca no cache de campanhas
          const lower = val.toLowerCase();
          if (global._allCampaigns) {
            for (const [name, id] of Object.entries(global._allCampaigns)) {
              if (name.includes(lower) || lower.includes(name)) return id;
            }
          }
          // Se nada encontrou, tenta como ID
          return val;
        }
        const PAGE_ID = process.env.META_PAGE_ID || '';
        const IG_ID = process.env.META_IG_ID || '';
        const api = async (u) => { const r = await fetch(u); const d = await r.json(); if (d.error) throw new Error(d.error.message); return d; };
        const ptD = await api(`${G}/me/accounts?fields=access_token&access_token=${MT}`);
        const PT = ptD.data?.[0]?.access_token || MT;

        switch (args.acao) {
          case 'ig_perfil': { const d = await api(`${G}/${IG_ID}?fields=username,followers_count,follows_count,media_count,biography&access_token=${MT}`); return `@${d.username} | ${d.followers_count} seguidores | ${d.follows_count} seguindo | ${d.media_count} posts\nBio: ${d.biography||''}`; }
          case 'ig_posts': { const d = await api(`${G}/${IG_ID}/media?fields=id,caption,like_count,comments_count,timestamp,permalink,media_type&limit=10&access_token=${MT}`); return (d.data||[]).map(p=>`[${p.media_type}] ${p.like_count}❤ ${p.comments_count}💬 — ${(p.caption||'').slice(0,60)} (ID:${p.id})`).join('\n')||'Nenhum post.'; }
          case 'ig_criar_post': {
            if(!args.image_url||!args.caption) return 'Erro: image_url e caption obrigatórios.';
            const cR=await fetch(`${G}/${IG_ID}/media`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`image_url=${encodeURIComponent(args.image_url)}&caption=${encodeURIComponent(args.caption)}&access_token=${MT}`});
            const cD=await cR.json(); if(cD.error) return `Erro: ${cD.error.message}. A URL da imagem precisa ser pública e direta.`;
            const pR=await fetch(`${G}/${IG_ID}/media_publish`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`creation_id=${cD.id}&access_token=${MT}`});
            const pD=await pR.json(); if(pD.error) return `Erro publish: ${pD.error.message}`;
            return `Post publicado no Instagram! ID: ${pD.id}`;
          }
          case 'ig_deletar_post': { if(!args.post_id) return 'Erro: post_id obrigatório.'; const d=await fetch(`${G}/${args.post_id}?access_token=${MT}`,{method:'DELETE'}).then(r=>r.json()); return d.success?'Post deletado!':`Erro: ${d.error?.message||'falhou'}`; }
          case 'ig_comentarios': { if(!args.post_id) return 'Erro: post_id obrigatório.'; const d=await api(`${G}/${args.post_id}/comments?fields=id,text,username,timestamp&limit=20&access_token=${MT}`); return (d.data||[]).map(c=>`@${c.username}: ${c.text} (ID:${c.id})`).join('\n')||'Nenhum comentário.'; }
          case 'ig_responder_comentario': { if(!args.comment_id||!args.texto) return 'Erro: comment_id e texto obrigatórios.'; const r=await fetch(`${G}/${args.comment_id}/replies`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`message=${encodeURIComponent(args.texto)}&access_token=${MT}`}); const d=await r.json(); return d.error?`Erro: ${d.error.message}`:`Resposta enviada! ID: ${d.id}`; }
          case 'ig_deletar_comentario': { if(!args.comment_id) return 'Erro: comment_id obrigatório.'; const d=await fetch(`${G}/${args.comment_id}?access_token=${MT}`,{method:'DELETE'}).then(r=>r.json()); return d.success?'Comentário deletado!':`Erro: ${d.error?.message||'falhou'}`; }
          case 'ig_dm': { const d=await api(`${G}/${PAGE_ID}/conversations?platform=instagram&fields=participants,messages.limit(1)%7Bmessage,from,created_time%7D&limit=10&access_token=${PT}`); if(!d.data?.length) return 'Nenhuma DM.'; return d.data.map(c=>{const u=c.participants?.data?.find(p=>p.id!==PAGE_ID)||{};const m=c.messages?.data?.[0]; return `${u.name||'User'}: "${m?.message||'...'}" (${m?.created_time||''})`;}).join('\n'); }
          case 'ig_enviar_dm': { if(!args.destinatario_id||!args.texto) return 'Erro: destinatario_id e texto obrigatórios.'; const r=await fetch(`${G}/${PAGE_ID}/messages?access_token=${PT}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recipient:{id:args.destinatario_id},message:{text:args.texto}})}); const d=await r.json(); return d.error?`Erro: ${d.error.message}`:`DM enviada!`; }
          case 'ig_insights': { const d=await api(`${G}/${IG_ID}/insights?metric=impressions,reach,accounts_engaged&period=day&limit=7&access_token=${MT}`).catch(()=>null); if(!d) return 'Insights não disponíveis.'; return (d.data||[]).map(m=>`${m.title}: ${m.values?.map(v=>v.value).join(', ')}`).join('\n')||'Sem dados.'; }
          case 'fb_pagina': { const d=await api(`${G}/${PAGE_ID}?fields=name,category,followers_count,fan_count,about&access_token=${PT}`); return `${d.name} | ${d.category||''} | ${d.followers_count||0} seguidores | ${d.fan_count||0} curtidas\nSobre: ${d.about||''}`; }
          case 'fb_posts': { const d=await api(`${G}/${PAGE_ID}/feed?fields=id,message,created_time,full_picture&limit=10&access_token=${PT}`); return (d.data||[]).map(p=>`${(p.message||'').slice(0,80)} (${p.created_time}) ID:${p.id}`).join('\n')||'Nenhum post.'; }
          case 'fb_criar_post': { if(!args.caption) return 'Erro: caption obrigatório.'; let b=`message=${encodeURIComponent(args.caption)}&access_token=${PT}`; if(args.image_url) b+=`&link=${encodeURIComponent(args.image_url)}`; const r=await fetch(`${G}/${PAGE_ID}/feed`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:b}); const d=await r.json(); return d.error?`Erro: ${d.error.message}`:`Post publicado no Facebook! ID: ${d.id}`; }
          case 'fb_deletar_post': { if(!args.post_id) return 'Erro: post_id obrigatório.'; const d=await fetch(`${G}/${args.post_id}?access_token=${PT}`,{method:'DELETE'}).then(r=>r.json()); return d.success?'Post deletado!':`Erro: ${d.error?.message||'falhou'}`; }
          case 'fb_messenger': { const d=await api(`${G}/${PAGE_ID}/conversations?fields=participants,messages.limit(1)%7Bmessage,from,created_time%7D&limit=10&access_token=${PT}`); if(!d.data?.length) return 'Nenhuma conversa.'; return d.data.map(c=>{const u=c.participants?.data?.find(p=>p.id!==PAGE_ID)||{};const m=c.messages?.data?.[0]; return `${u.name||'User'}: "${m?.message||'...'}"`;}).join('\n'); }
          case 'fb_enviar_msg': { if(!args.destinatario_id||!args.texto) return 'Erro: destinatario_id e texto obrigatórios.'; const r=await fetch(`${G}/${PAGE_ID}/messages?access_token=${PT}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recipient:{id:args.destinatario_id},message:{text:args.texto}})}); const d=await r.json(); return d.error?`Erro: ${d.error.message}`:`Mensagem enviada!`; }
          case 'ads_contas': { const d=await api(`${G}/me/adaccounts?fields=name,account_id,account_status,currency,amount_spent&access_token=${MT}`); return (d.data||[]).map(a=>`${a.name} (${a.id}) — Gasto: ${a.amount_spent} ${a.currency}`).join('\n')||'Nenhuma conta.'; }
          case 'ads_campanhas': {
            const d=await api(`${G}/me/adaccounts?fields=campaigns%7Bname,status,objective,daily_budget,insights%7Bspend,impressions,clicks,ctr%7D%7D&access_token=${MT}`);
            let r='';
            global._allCampaigns={};
            for(const a of(d.data||[])){
              for(const c of(a.campaigns?.data||[])){
                const i=c.insights?.data?.[0]||{};
                global._allCampaigns[c.name.toLowerCase()]=c.id;
                r+=`${c.name} [${c.status}] ID:${c.id} — R$${i.spend||0} | ${i.impressions||0} imp | ${i.clicks||0} clicks\n`;
              }
            }
            return r||'Nenhuma campanha.';
          }
          case 'ads_criar_campanha': {
            const nome=args.nome_campanha||'Campanha Zaya';
            const obj=args.objetivo||'OUTCOME_AWARENESS';
            const orc=args.orcamento_diario||2000;
            const idadeMin=args.idade_min||25;
            const idadeMax=args.idade_max||55;
            const pais=args.pais||'BR';
            const dias=args.duracao_dias||7;
            const accId=process.env.META_AD_ACCOUNT_ID || '';

            // 1. Criar campanha
            const cBody=`name=${encodeURIComponent(nome)}&objective=${obj}&status=PAUSED&special_ad_categories=[]&is_adset_budget_sharing_enabled=false&access_token=${MT}`;
            const cR=await fetch(`${G}/${accId}/campaigns`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:cBody});
            const cD=await cR.json();
            if(cD.error) return `Erro campanha: ${cD.error.message}`;

            // 2. Criar ad set
            const endTime=Math.floor((Date.now()+dias*86400000)/1000); // Unix timestamp
            const targeting=JSON.stringify({geo_locations:{countries:[pais]},age_min:idadeMin,age_max:idadeMax,targeting_automation:{advantage_audience:0}});
            const asBody=`name=AdSet+${encodeURIComponent(nome)}&campaign_id=${cD.id}&daily_budget=${orc}&billing_event=IMPRESSIONS&optimization_goal=REACH&bid_amount=100&targeting=${encodeURIComponent(targeting)}&end_time=${endTime}&status=PAUSED&access_token=${MT}`;
            const asR=await fetch(`${G}/${accId}/adsets`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:asBody});
            const asD=await asR.json();
            if(asD.error) return `Campanha criada (ID:${cD.id}) mas erro no AdSet: ${asD.error.message}`;

            // Salva IDs no contexto global pra usar nas próximas ações
            global._lastCampaignId=cD.id;
            global._lastAdSetId=asD.id;
            global._lastCampaignName=nome;
            return `Campanha criada com sucesso!\nCampanha: ${nome} (ID: ${cD.id})\nAdSet: ID ${asD.id}\nOrçamento: R$${(orc/100).toFixed(2)}/dia\nPúblico: ${pais}, ${idadeMin}-${idadeMax} anos\nDuração: ${dias} dias\nStatus: PAUSADA\n\nPra eu mexer nessa campanha, basta dizer: "ativa", "pausa", "muda orçamento", "deleta", etc.`;
          }
          case 'ads_ativar_campanha': {
            const cid=resolveCampaignId(args.campaign_id);
            if(!cid) return 'Erro: sem campaign_id. Diga o nome da campanha ou crie uma primeiro.';
            const d=await fetch(`${G}/${cid}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`status=ACTIVE&access_token=${MT}`}).then(r=>r.json());
            return d.success?`Campanha ${cid} ATIVADA!`:`Erro: ${d.error?.message||'falhou'}`;
          }
          case 'ads_pausar_campanha': {
            const cid=resolveCampaignId(args.campaign_id);
            if(!cid) return 'Erro: sem campaign_id.';
            const d=await fetch(`${G}/${cid}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`status=PAUSED&access_token=${MT}`}).then(r=>r.json());
            return d.success?`Campanha ${cid} PAUSADA.`:`Erro: ${d.error?.message||'falhou'}`;
          }
          case 'ads_editar_campanha': {
            const cid=resolveCampaignId(args.campaign_id);
            if(!cid) return 'Erro: sem campaign_id.';
            let body=`access_token=${MT}`;
            if(args.novo_nome) body+=`&name=${encodeURIComponent(args.novo_nome)}`;
            if(args.novo_status) body+=`&status=${args.novo_status}`;
            if(args.novo_orcamento) body+=`&daily_budget=${args.novo_orcamento}`;
            const d=await fetch(`${G}/${cid}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body}).then(r=>r.json());
            return d.success?`Campanha ${cid} atualizada!`:`Erro: ${d.error?.message||'falhou'}`;
          }
          case 'ads_editar_adset': {
            const asid=args.campaign_id||global._lastAdSetId;
            if(!asid) return 'Erro: sem ID do adset.';
            let body=`access_token=${MT}`;
            if(args.novo_orcamento) body+=`&daily_budget=${args.novo_orcamento}`;
            if(args.novo_status) body+=`&status=${args.novo_status}`;
            if(args.novo_nome) body+=`&name=${encodeURIComponent(args.novo_nome)}`;
            const d=await fetch(`${G}/${asid}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body}).then(r=>r.json());
            return d.success?`AdSet ${asid} atualizado!`:`Erro: ${d.error?.message||'falhou'}`;
          }
          case 'ads_criar_anuncio': {
            const asid=args.campaign_id||global._lastAdSetId;
            if(!asid) return 'Erro: preciso do ID do ad set. Crie uma campanha primeiro.';
            if(!args.image_url) return 'Erro: image_url obrigatória para o anúncio.';
            const accId=process.env.META_AD_ACCOUNT_ID || '';
            const caption=args.caption||args.texto||'';

            // 1. Criar ad creative com imagem
            const crBody=`name=Creative+Zaya&object_story_spec=${encodeURIComponent(JSON.stringify({page_id:PAGE_ID,link_data:{link:args.image_url,message:caption,image_hash:''}}))}&degrees_of_freedom_spec=${encodeURIComponent(JSON.stringify({creative_features_spec:{standard_enhancements:{global:{enroll_status:'OPT_OUT'}}}}))}&access_token=${MT}`;

            // Método mais simples: usar image_url direto no ad creative
            const crRes=await fetch(`${G}/${accId}/adcreatives`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`name=Anuncio+Zaya&object_story_spec=${encodeURIComponent(JSON.stringify({page_id:PAGE_ID,photo_data:{image_url:args.image_url,caption:caption}}))}&access_token=${MT}`});
            const crData=await crRes.json();
            if(crData.error) return `Erro no creative: ${crData.error.message}`;

            // 2. Criar o ad
            const adRes=await fetch(`${G}/${accId}/ads`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`name=Ad+Zaya&adset_id=${asid}&creative=${encodeURIComponent(JSON.stringify({creative_id:crData.id}))}&status=PAUSED&access_token=${MT}`});
            const adData=await adRes.json();
            if(adData.error) return `Creative criado (${crData.id}) mas erro no ad: ${adData.error.message}`;

            return `Anúncio criado!\nCreative: ${crData.id}\nAd: ${adData.id}\nImagem: ${args.image_url}\nTexto: ${caption}\nStatus: PAUSADO`;
          }
          case 'ads_deletar_campanha': {
            const cid=resolveCampaignId(args.campaign_id);
            if(!cid) return 'Erro: sem campaign_id.';
            const d=await fetch(`${G}/${cid}?access_token=${MT}`,{method:'DELETE'}).then(r=>r.json());
            if(d.success){global._lastCampaignId=null;global._lastAdSetId=null;}
            return d.success?`Campanha ${cid} deletada!`:`Erro: ${d.error?.message||'falhou'}`;
          }
          default: return `Ação "${args.acao}" não reconhecida.`;
        }
      } catch (e) { log.ai.error({err:e.message},'Erro meta'); return `Erro Meta: ${e.message}`; }
    }

    default: return 'Ferramenta não reconhecida.';
  }
}

// ================================================================
// FALLBACK: detecta recusa do modelo e tenta extrair ação da msg original
// ================================================================
const RECUSA_PATTERNS = /n[aã]o (posso|consigo|é poss[ií]vel|tenho (capacidade|como)|devo)|cannot|can'?t send|unable to|i('m| am) not able/i;
const ACAO_PATTERNS = [
  { regex: /(?:mand[ae]|envi[ae]|fal[ae]|dig[ae]|escrev[ae])\s+(?:(?:uma?\s+)?(?:msg|mensagem|message)\s+)?(?:(?:pra|para|pro|ao?|no)\s+)(.+?)(?:\s+(?:que|dizendo|falando|escrevendo)\s+[""]?(.+?)[""]?\s*$)/i, tool: 'enviar_whatsapp' },
  { regex: /(?:mand[ae]|envi[ae])\s+(?:(?:uma?\s+)?(?:msg|mensagem)\s+)?(?:(?:pra|para|pro)\s+)(\S+)\s*[:\-]?\s*(.+)/i, tool: 'enviar_whatsapp' },
];

function detectRefusalAndExtractAction(reply, originalMessage) {
  if (!RECUSA_PATTERNS.test(reply)) return null;
  for (const { regex, tool } of ACAO_PATTERNS) {
    const m = originalMessage.match(regex);
    if (m) return { tool, contact: m[1]?.trim(), message: m[2]?.trim() };
  }
  return null;
}

// ================================================================
// PROCESS VOICE CHAT (function calling nativo — substitui tags)
// ================================================================
export async function processVoiceChat(message, statusCallback) {
  conversationHistory.push({ role: 'user', content: message });

  const messages = [
    { role: 'system', content: getSystemPrompt() },
    ...conversationHistory.slice(-20),
  ];

  try {
    let response = await openai.chat.completions.create({
      model: AI_MODEL, max_tokens: 1024,
      messages, tools: voiceTools, tool_choice: 'auto',
    });

    let assistantMsg = response.choices[0].message;

    // Loop de tool calls (a IA pode chamar múltiplas ferramentas em sequência)
    let toolRounds = 0;
    const MAX_ROUNDS = 8;
    while (assistantMsg.tool_calls?.length > 0 && toolRounds < MAX_ROUNDS) {
      toolRounds++;
      messages.push(assistantMsg);

      const toolNames = assistantMsg.tool_calls.map(tc => tc.function.name).join(', ');
      if (statusCallback) await statusCallback('executing', `Executando: ${toolNames}...`);

      for (const tc of assistantMsg.tool_calls) {
        const fnArgs = JSON.parse(tc.function.arguments);
        log.ai.info({ tool: tc.function.name, round: toolRounds }, `VoiceTool round ${toolRounds}: ${tc.function.name}`);

        let result;
        try {
          const toolTimeout = tc.function.name === 'claude_code' ? 300000 : tc.function.name === 'pesquisar' ? 120000 : 60000;
          result = await Promise.race([
            executeVoiceTool(tc.function.name, fnArgs),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Tool "${tc.function.name}" timeout após ${toolTimeout/1000}s`)), toolTimeout)),
          ]);
        } catch (e) {
          result = `Erro: ${e.message}`;
          log.ai.warn({ tool: tc.function.name, err: e.message }, 'VoiceTool falhou/timeout');
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 8000) });
      }

      response = await openai.chat.completions.create({
        model: AI_MODEL, max_tokens: 1024,
        messages, tools: voiceTools, tool_choice: toolRounds >= MAX_ROUNDS - 1 ? 'none' : 'auto',
      });
      assistantMsg = response.choices[0].message;
    }

    let reply = assistantMsg.content || '(sem resposta)';

    // Fallback: se o modelo recusou ao invés de usar tools, tenta executar a ação
    const refusal = detectRefusalAndExtractAction(reply, message);
    if (refusal) {
      log.ai.warn({ refusal, originalMsg: message }, 'Modelo recusou — tentando fallback');
      try {
        if (refusal.tool === 'enviar_whatsapp' && refusal.contact && refusal.message) {
          const contact = await searchContact(refusal.contact);
          if (contact?.telefone) {
            const result = await sendWhatsApp(contact.telefone, refusal.message);
            reply = `Pronto meu bem, mandei a mensagem pra ${refusal.contact}!`;
            log.ai.info({ contact: refusal.contact, result }, 'Fallback: mensagem enviada com sucesso');
          }
        }
      } catch (e) {
        log.ai.warn({ err: e.message }, 'Fallback também falhou');
      }
    }

    conversationHistory.push({ role: 'assistant', content: reply });

    // Extrai memórias automaticamente em background
    extractMemories(message, reply, 'voice');

    return reply;
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro processVoiceChat');
    return `Vixe, deu um erro aqui: ${e.message}`;
  }
}

// ================================================================
// PROCESS VOICE VISION (imagem + function calling)
// ================================================================
export async function processVoiceVision(image, message) {
  conversationHistory.push({ role: 'user', content: [
    { type: 'image_url', image_url: { url: image, detail: 'low' } },
    { type: 'text', text: message || 'O que voce ve?' },
  ] });

  const messages = [
    { role: 'system', content: getSystemPrompt() },
    ...conversationHistory.slice(-10),
  ];

  try {
    let response = await openai.chat.completions.create({
      model: AI_MODEL, max_tokens: 1024,
      messages, tools: voiceTools, tool_choice: 'auto',
    });

    let assistantMsg = response.choices[0].message;

    while (assistantMsg.tool_calls?.length > 0) {
      messages.push(assistantMsg);
      for (const tc of assistantMsg.tool_calls) {
        const fnArgs = JSON.parse(tc.function.arguments);
        const result = await executeVoiceTool(tc.function.name, fnArgs);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 8000) });
      }
      response = await openai.chat.completions.create({
        model: AI_MODEL, max_tokens: 1024,
        messages, tools: voiceTools, tool_choice: 'auto',
      });
      assistantMsg = response.choices[0].message;
    }

    const reply = assistantMsg.content || '(sem resposta)';
    conversationHistory.push({ role: 'assistant', content: reply });
    return reply;
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro processVoiceVision');
    return `Erro ao analisar imagem: ${e.message}`;
  }
}

// ================================================================
// WHATSAPP TOOLS (mantido para o bot WhatsApp — já usava function calling)
// ================================================================
// waTools = mesmas voiceTools do navegador (admin WhatsApp tem acesso total)
// Apenas adiciona enviar_mensagem (alias para enviar_whatsapp)
export const waTools = [
  { type: 'function', function: { name: 'enviar_mensagem', description: 'Envia mensagem no WhatsApp', parameters: { type: 'object', properties: { numero: { type: 'string', description: 'Número (55+DDD+numero)' }, mensagem: { type: 'string' } }, required: ['numero', 'mensagem'] } } },
  ...voiceTools.filter(t => t.function.name !== 'enviar_whatsapp'),
];

// ================================================================
// EXECUTE WA TOOL (WhatsApp bot — reutiliza executeVoiceTool onde possível)
// ================================================================
export async function executeWaTool(name, args, ctx) {
  // Mapeia nomes do WhatsApp para os nomes da voz
  const nameMap = { 'enviar_mensagem': 'enviar_whatsapp' };
  const mappedName = nameMap[name] || name;

  // Tools que precisam de ctx (pendingImages)
  if (name === 'gerar_imagem') {
    const imagePath = await generateImage(args.descricao);
    if (imagePath) { ctx.pendingImages.push(imagePath); return 'Imagem gerada! Será enviada.'; }
    return 'Erro ao gerar imagem.';
  }

  if (name === 'chrome_perfil' && args.acao === 'screenshot') {
    try {
      const browser = await ensureChromeDebug();
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(args.url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, args.esperar || 5000));
      const ssPath = join(TMP_DIR, `chrome-${Date.now()}.png`);
      await page.screenshot({ path: ssPath });
      ctx.pendingImages.push(ssPath);
      await page.close();
      return `Screenshot de ${args.url} capturado!`;
    } catch (e) {
      return `Erro Chrome: ${e.message}`;
    }
  }

  // Para claude_code no WhatsApp: força timeout curto (25s)
  if (name === 'claude_code') {
    args.timeout = 25000;
  }

  // Para criar_slides: captura arquivo gerado para enviar via WhatsApp
  if (name === 'criar_slides') {
    const result = await executeVoiceTool(mappedName, args);
    const pathMatch = result.match(/Salvo em: (.+\.(html|pptx|pdf))/);
    if (pathMatch && ctx.pendingFiles) {
      ctx.pendingFiles.push(pathMatch[1]);
    }
    return result;
  }

  // Para as demais, delega para executeVoiceTool
  const result = await executeVoiceTool(mappedName, args);

  // Captura arquivos gerados por supabase_storage upload
  if (name === 'supabase_storage' && args.acao === 'upload' && args.caminho_arquivo && ctx.pendingFiles) {
    ctx.pendingFiles.push(args.caminho_arquivo);
  }

  return result;
}

// ================================================================
// AI PROCESSING - WHATSAPP (com tools para admin)
// ================================================================
export async function processWithAI(text, jid, isAdmin) {
  const history = getChatHistory(jid);
  addToHistory(jid, 'user', text);

  // Usa o MESMO system prompt completo do navegador para admin
  const systemPrompt = isAdmin
    ? getSystemPrompt() + `\n\nCANAL: WhatsApp. Respostas em TEXTO (sem markdown pesado). Use *negrito* e _itálico_ do WhatsApp.\nVocê tem acesso a TODAS as ferramentas. Execute tudo na hora. Para missões: buscar_empresa → supabase_inserir → missao(criar) → missao(iniciar) — tudo em sequência, sem parar. Aguarde entre envios de WhatsApp (6s mínimo por msg).`
    : `Você é um assistente simpático no WhatsApp. Português brasileiro, conciso e natural. Data: ${new Date().toLocaleDateString('pt-BR')}.`;

  // Limpa histórico duplicado (mesma msg consecutiva do mesmo role)
  const cleanHistory = [];
  for (const msg of history.slice(-20)) {
    const last = cleanHistory[cleanHistory.length - 1];
    if (last && last.role === msg.role && last.content === msg.content) continue;
    cleanHistory.push(msg);
  }

  const messages = [{ role: 'system', content: systemPrompt }, ...cleanHistory.slice(-12)];
  const ctx = { pendingImages: [], pendingFiles: [] };

  // Admin WhatsApp: todas as tools (waTools = voiceTools + enviar_mensagem)
  const tools = isAdmin ? waTools : null;

  try {
    let response = await openai.chat.completions.create({
      model: AI_MODEL, messages, max_tokens: 1024,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    });

    let assistantMsg = response.choices[0].message;
    let toolRounds = 0;
    const MAX_TOOL_ROUNDS = 5;

    while (assistantMsg.tool_calls?.length > 0 && toolRounds < MAX_TOOL_ROUNDS) {
      toolRounds++;
      messages.push(assistantMsg);

      for (const tc of assistantMsg.tool_calls) {
        const fnArgs = JSON.parse(tc.function.arguments);
        log.ai.info({ tool: tc.function.name, round: toolRounds }, `WA Tool: ${tc.function.name}`);

        let result;
        try {
          const toolTimeout = tc.function.name === 'claude_code' ? 60000 : 30000;
          result = await Promise.race([
            executeWaTool(tc.function.name, fnArgs, ctx),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Tool timeout')), toolTimeout)),
          ]);
        } catch (e) {
          result = `Erro: ${e.message}`;
          log.ai.warn({ tool: tc.function.name, err: e.message }, 'Tool falhou/timeout');
        }

        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
      }

      response = await openai.chat.completions.create({
        model: AI_MODEL, messages, tools, tool_choice: toolRounds >= MAX_TOOL_ROUNDS - 1 ? 'none' : 'auto', max_tokens: 1024,
      });
      assistantMsg = response.choices[0].message;
    }

    let reply = assistantMsg.content || '(sem resposta)';

    // Fallback: se o modelo recusou ao invés de usar tools, tenta executar a ação
    if (isAdmin) {
      const refusal = detectRefusalAndExtractAction(reply, text);
      if (refusal) {
        log.ai.warn({ refusal, originalMsg: text }, 'WA: Modelo recusou — tentando fallback');
        try {
          if (refusal.tool === 'enviar_whatsapp' && refusal.contact && refusal.message) {
            const contact = await searchContact(refusal.contact);
            if (contact?.telefone) {
              const result = await sendWhatsApp(contact.telefone, refusal.message);
              reply = `Pronto meu bem, mandei a mensagem pra ${refusal.contact}!`;
              log.ai.info({ contact: refusal.contact, result }, 'Fallback WA: mensagem enviada');
            }
          }
        } catch (e) {
          log.ai.warn({ err: e.message }, 'Fallback WA também falhou');
        }
      }
    }

    addToHistory(jid, 'assistant', reply);

    // Extrai memórias automaticamente em background
    extractMemories(text, reply, jid);

    return { text: reply, images: ctx.pendingImages, files: ctx.pendingFiles };
  } catch (e) {
    log.ai.error({ err: e.message }, 'Erro OpenAI (WhatsApp)');
    return { text: `Erro: ${e.message}`, images: [], files: [] };
  }
}
