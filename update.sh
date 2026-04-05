#!/bin/bash
echo ""
echo -e "\033[0;35m\033[1m  ZAYA PLUS\033[0m — Atualizando..."
echo ""
cd "$(dirname "$0")"
git pull origin main 2>&1 | grep -v "^$"
npm install --production --silent 2>&1
echo ""
echo -e "\033[0;32m  ✓ Atualizada!\033[0m Rode: \033[0;36mnpm start\033[0m"
echo ""
