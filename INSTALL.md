# ZAYA PLUS — Guia de Instalacao

## Requisitos

Antes de comecar, voce precisa ter instalado:

- **Node.js 18+** — Baixe em https://nodejs.org (clique no botao verde LTS)
- **Git** — Baixe em https://git-scm.com

Para verificar se ja tem, abra o Terminal e digite:

```
node -v
```

Se aparecer `v18` ou superior, esta OK. Se nao, instale pelo site acima.

```
git --version
```

Se aparecer a versao, esta OK.

---

## Passo 1 — Abrir o Terminal

**Mac:** Pressione `Cmd + Espaco`, digite `Terminal` e pressione Enter.

**Windows:** Pressione `Win + R`, digite `cmd` e pressione Enter. Ou procure por "Git Bash" se instalou o Git.

**Linux:** Pressione `Ctrl + Alt + T`.

---

## Passo 2 — Baixar a Zaya Plus

Cole este comando no terminal e pressione Enter:

```
git clone https://github.com/Shelbyys/zaya-plus.git
```

Aguarde terminar. Vai aparecer algo como:

```
Cloning into 'zaya-plus'...
remote: Enumerating objects: 200, done.
Resolving deltas: 100%, done.
```

---

## Passo 3 — Entrar na pasta

```
cd zaya-plus
```

---

## Passo 4 — Ativar sua licenca

Voce recebeu um token por email apos a compra. Cole o comando abaixo substituindo pelo SEU token:

```
npm install
```

Aguarde instalar (pode demorar 1-2 minutos). Depois:

```
node activate.js SEU-TOKEN-AQUI
```

Exemplo:

```
node activate.js TRIAL-D4E95CCA-CBD0-41A5
```

Vai aparecer:

```
ZAYA PLUS — Ativando licenca...

✓ Licenca ativada com sucesso!
✓ Plano: ENTERPRISE

Agora rode: npm start
```

---

## Passo 5 — Iniciar a Zaya

```
npm start
```

Vai aparecer:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ZAYA PLUS  ● ONLINE

  http://localhost:3001

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Passo 6 — Abrir no navegador

Abra o Google Chrome e acesse:

```
http://localhost:3001
```

O Setup Wizard vai te guiar na configuracao:

1. Escolha a mente da Zaya (ChatGPT, Groq ou Claude)
2. Digite seu nome e telefone
3. Escolha a voz (OpenAI TTS ou ElevenLabs)
4. Selecione os modulos que quer usar
5. Clique em "Ativar Zaya!"
6. A Zaya vai te conhecer (perguntas sobre voce)
7. Dashboard principal abre automaticamente

---

## Comandos do dia a dia

| O que fazer | Comando |
|-------------|---------|
| Iniciar a Zaya | `cd ~/zaya-plus && npm start` |
| Atualizar | `cd ~/zaya-plus && bash update.sh` |
| Parar a Zaya | Pressione `Ctrl + C` no terminal |

---

## Dicas

- A Zaya roda enquanto o terminal estiver aberto. Se fechar o terminal, ela para.
- Para deixar rodando em segundo plano: `cd ~/zaya-plus && npm start &`
- Todos os seus dados ficam NO SEU computador, na pasta `~/zaya-plus/`
- Para reconfigurar tudo do zero: `cd ~/zaya-plus && rm .env .license && cp .env.example .env && npm start`

---

## Problemas comuns

**"command not found: node"**
Instale o Node.js: https://nodejs.org

**"command not found: git"**
Instale o Git: https://git-scm.com

**"EADDRINUSE: address already in use"**
A porta 3001 ja esta em uso. Mate o processo:
```
lsof -ti:3001 | xargs kill -9
```
Depois rode `npm start` novamente.

**"Token invalido"**
Verifique se copiou o token completo, sem espacos extras.

**"Token ja ativado em outro computador"**
Cada token funciona em apenas 1 computador. Entre em contato com o suporte.

---

## Suporte

Precisa de ajuda? Entre em contato:
- Email: suporte@zayaplus.com
