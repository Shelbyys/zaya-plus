#!/bin/bash
echo ""
echo -e "\033[0;35m\033[1m  ZAYA PLUS\033[0m — Atualizando..."
echo ""
cd "$(dirname "$0")"

# Descarta mudanças locais em arquivos rastreados (mantém .env e arquivos novos)
git checkout -- . 2>/dev/null
git clean -fd --exclude=.env --exclude=whatsapp-sessions --exclude=zaya.db --exclude=zaya.db-shm --exclude=zaya.db-wal --exclude=node_modules 2>/dev/null

# Puxa as atualizações
git pull origin main 2>&1 | grep -v "^$"

# Instala dependências
npm install --production --silent 2>&1

echo ""
echo -e "\033[0;32m  ✓ Atualizada!\033[0m Rode: \033[0;36mnpm start\033[0m"
echo ""
