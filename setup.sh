#!/bin/bash
# ================================================================
# ZAYA PLUS — Wrapper de compatibilidade
# Redireciona para o instalador unificado (install.sh)
# Uso: curl -sL URL/setup.sh | bash -s TOKEN
# ================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null || echo ".")" && pwd)"

# Se rodando de dentro do projeto, usa o install.sh local
if [ -f "$SCRIPT_DIR/install.sh" ]; then
  exec bash "$SCRIPT_DIR/install.sh" "$@"
fi

# Se rodando via curl (sem arquivo local), baixa e executa
curl -sL https://raw.githubusercontent.com/Shelbyys/zaya-plus/main/install.sh | bash -s "$@"
