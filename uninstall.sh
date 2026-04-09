#!/bin/bash
# ================================================================
# ZAYA PLUS — Desinstalador
# Remove: pasta, aliases, scripts, sessoes WhatsApp
# Uso: bash ~/zaya-plus/uninstall.sh
# ================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}" 2>/dev/null || echo "$HOME/zaya-plus")" && pwd)"

echo ""
echo -e "${PURPLE}${BOLD}  ZAYA PLUS — Desinstalador${NC}"
echo ""
echo "  ─────────────────────────────────────"
echo ""
echo -e "  Isso vai remover:"
echo -e "  ${YELLOW}•${NC} Pasta $INSTALL_DIR"
echo -e "  ${YELLOW}•${NC} Atalho 'zaya' do terminal"
echo -e "  ${YELLOW}•${NC} Scripts em /usr/local/bin e ~/.local/bin"
echo -e "  ${YELLOW}•${NC} Sessoes WhatsApp locais"
echo ""
echo -e "  ${RED}${BOLD}Seus dados (.env, banco de dados) serao perdidos!${NC}"
echo ""

read -p "  Tem certeza? (s/n) [n]: " CONFIRM
CONFIRM=${CONFIRM:-n}

if [[ ! "$CONFIRM" =~ ^[sS] ]]; then
  echo ""
  echo -e "  ${GREEN}Cancelado.${NC} Nada foi removido."
  echo ""
  exit 0
fi

echo ""

# ================================================================
# 1. Parar servidor se rodando
# ================================================================
echo -e "${PURPLE}[1/5]${NC} Parando servidor..."

PORT="${PORT:-3001}"
if command -v lsof &>/dev/null; then
  PID=$(lsof -ti:"$PORT" 2>/dev/null)
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} Servidor parado (PID $PID)"
  else
    echo -e "  ${YELLOW}~${NC} Servidor nao estava rodando"
  fi
elif command -v netstat &>/dev/null; then
  # Windows/Linux fallback
  netstat -tlnp 2>/dev/null | grep ":$PORT " | awk '{print $7}' | cut -d'/' -f1 | xargs kill 2>/dev/null || true
fi

# ================================================================
# 2. Desativar licenca (se possivel)
# ================================================================
echo -e "${PURPLE}[2/5]${NC} Desativando licenca..."

if [ -f "$INSTALL_DIR/.license" ]; then
  # Tenta desativar online
  TOKEN=$(cat "$INSTALL_DIR/.license" 2>/dev/null | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$TOKEN" ]; then
    LICENSE_API=$(grep LICENSE_API_URL "$INSTALL_DIR/.env" 2>/dev/null | cut -d'=' -f2 || echo "https://zaya-plus.onrender.com")
    LICENSE_API=${LICENSE_API:-"https://zaya-plus.onrender.com"}
    curl -sX POST "$LICENSE_API/api/license/deactivate" \
      -H "Content-Type: application/json" \
      -d "{\"token\":\"$TOKEN\"}" >/dev/null 2>&1 || true
    echo -e "  ${GREEN}✓${NC} Licenca desativada"
  fi
else
  echo -e "  ${YELLOW}~${NC} Nenhuma licenca encontrada"
fi

# ================================================================
# 3. Remover aliases e scripts
# ================================================================
echo -e "${PURPLE}[3/5]${NC} Removendo atalhos..."

# Limpa de todos os rc files possiveis
for RC_FILE in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$RC_FILE" ]; then
    # Remove linhas do Zaya
    sed -i.bak '/# Zaya Plus/d;/alias zaya=/d;/function zaya/d' "$RC_FILE" 2>/dev/null || true
    rm -f "${RC_FILE}.bak"
  fi
done

# Remove scripts executaveis
rm -f /usr/local/bin/zaya 2>/dev/null || true
rm -f "$HOME/.local/bin/zaya" 2>/dev/null || true

echo -e "  ${GREEN}✓${NC} Atalhos removidos"

# ================================================================
# 4. Backup opcional
# ================================================================
echo -e "${PURPLE}[4/5]${NC} Backup..."

read -p "  Salvar backup do .env e banco de dados? (s/n) [s]: " BACKUP
BACKUP=${BACKUP:-s}

if [[ "$BACKUP" =~ ^[sS] ]]; then
  BACKUP_DIR="$HOME/zaya-backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  [ -f "$INSTALL_DIR/.env" ] && cp "$INSTALL_DIR/.env" "$BACKUP_DIR/"
  [ -f "$INSTALL_DIR/zaya.db" ] && cp "$INSTALL_DIR/zaya.db" "$BACKUP_DIR/"
  [ -f "$INSTALL_DIR/.license" ] && cp "$INSTALL_DIR/.license" "$BACKUP_DIR/"
  [ -d "$INSTALL_DIR/data" ] && cp -r "$INSTALL_DIR/data" "$BACKUP_DIR/"
  echo -e "  ${GREEN}✓${NC} Backup salvo em $BACKUP_DIR"
fi

# ================================================================
# 5. Remover pasta
# ================================================================
echo -e "${PURPLE}[5/5]${NC} Removendo arquivos..."

# Sai da pasta antes de deletar
cd "$HOME"
rm -rf "$INSTALL_DIR"

echo -e "  ${GREEN}✓${NC} Pasta removida"

# ================================================================
# Fim
# ================================================================
echo ""
echo "  ─────────────────────────────────────"
echo ""
echo -e "${GREEN}${BOLD}  ✓ Zaya Plus desinstalada com sucesso!${NC}"
if [[ "$BACKUP" =~ ^[sS] ]]; then
  echo -e "  Backup em: ${CYAN}$BACKUP_DIR${NC}"
fi
echo ""
echo "  ─────────────────────────────────────"
echo ""
