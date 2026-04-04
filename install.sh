#!/bin/bash
# ================================================================
# ZAYA PLUS — Instalador
# Rode: curl -sL https://raw.githubusercontent.com/Shelbyys/zaya-plus/main/install.sh | bash
# ================================================================

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

clear
echo ""
echo -e "${PURPLE}${BOLD}"
echo "  ███████╗ █████╗ ██╗   ██╗ █████╗ "
echo "  ╚══███╔╝██╔══██╗╚██╗ ██╔╝██╔══██╗"
echo "    ███╔╝ ███████║ ╚████╔╝ ███████║"
echo "   ███╔╝  ██╔══██║  ╚██╔╝  ██╔══██║"
echo "  ███████╗██║  ██║   ██║   ██║  ██║"
echo "  ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝"
echo -e "${CYAN}           P L U S${NC}"
echo ""
echo -e "${BOLD}  Sua assistente pessoal de IA${NC}"
echo ""
echo "  ─────────────────────────────────────"
echo ""

# ================================================================
# 1. Verificar requisitos
# ================================================================
echo -e "${PURPLE}[1/5]${NC} Verificando requisitos..."

# Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -ge 18 ]; then
        echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"
    else
        echo -e "  ${RED}✗${NC} Node.js $(node -v) — precisa v18+"
        echo -e "  ${YELLOW}→${NC} Instale: https://nodejs.org"
        exit 1
    fi
else
    echo -e "  ${RED}✗${NC} Node.js nao encontrado"
    echo ""
    echo -e "  ${YELLOW}Instale o Node.js primeiro:${NC}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "  brew install node"
        echo "  ou baixe em https://nodejs.org"
    else
        echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
        echo "  sudo apt-get install -y nodejs"
    fi
    exit 1
fi

# Git
if command -v git &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Git $(git --version | cut -d' ' -f3)"
else
    echo -e "  ${RED}✗${NC} Git nao encontrado"
    echo -e "  ${YELLOW}→${NC} Instale: https://git-scm.com"
    exit 1
fi

# Chrome (opcional)
if [[ "$OSTYPE" == "darwin"* ]]; then
    if [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
        echo -e "  ${GREEN}✓${NC} Google Chrome"
    else
        echo -e "  ${YELLOW}~${NC} Google Chrome nao encontrado (opcional)"
    fi
elif command -v google-chrome &> /dev/null || command -v google-chrome-stable &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Google Chrome"
else
    echo -e "  ${YELLOW}~${NC} Google Chrome nao encontrado (opcional)"
fi

# FFmpeg (opcional)
if command -v ffmpeg &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} FFmpeg"
else
    echo -e "  ${YELLOW}~${NC} FFmpeg nao encontrado (opcional, para videos)"
fi

echo ""

# ================================================================
# 2. Escolher diretorio de instalacao
# ================================================================
echo -e "${PURPLE}[2/5]${NC} Onde instalar?"
echo ""

DEFAULT_DIR="$HOME/zaya-plus"
read -p "  Diretorio [$DEFAULT_DIR]: " INSTALL_DIR
INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_DIR}

# Expandir ~
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

echo ""

# ================================================================
# 3. Clonar repositorio
# ================================================================
echo -e "${PURPLE}[3/5]${NC} Baixando Zaya Plus..."

if [ -d "$INSTALL_DIR" ]; then
    echo -e "  ${YELLOW}!${NC} Pasta ja existe. Atualizando..."
    cd "$INSTALL_DIR"
    git pull origin main 2>/dev/null || true
else
    git clone https://github.com/Shelbyys/zaya-plus.git "$INSTALL_DIR" 2>&1 | grep -v "^$"
    cd "$INSTALL_DIR"
fi

echo -e "  ${GREEN}✓${NC} Codigo baixado"
echo ""

# ================================================================
# 4. Instalar dependencias
# ================================================================
echo -e "${PURPLE}[4/5]${NC} Instalando dependencias (pode demorar)..."

npm install --production 2>&1 | tail -1

echo -e "  ${GREEN}✓${NC} Dependencias instaladas"
echo ""

# ================================================================
# 5. Configurar .env
# ================================================================
echo -e "${PURPLE}[5/5]${NC} Configurando..."

if [ ! -f ".env" ]; then
    cp .env.example .env
    echo -e "  ${GREEN}✓${NC} Arquivo .env criado"
else
    echo -e "  ${YELLOW}~${NC} .env ja existe, mantendo"
fi

echo ""

# ================================================================
# Finalizado!
# ================================================================
echo "  ─────────────────────────────────────"
echo ""
echo -e "${GREEN}${BOLD}  Zaya Plus instalada com sucesso!${NC}"
echo ""
echo -e "  Para iniciar:"
echo -e "  ${CYAN}cd $INSTALL_DIR${NC}"
echo -e "  ${CYAN}npm start${NC}"
echo ""
echo -e "  Depois acesse: ${BOLD}http://localhost:3001${NC}"
echo -e "  O Setup Wizard vai te guiar na configuracao."
echo ""
echo "  ─────────────────────────────────────"
echo ""

# Perguntar se quer iniciar agora
read -p "  Iniciar agora? (s/n) [s]: " START_NOW
START_NOW=${START_NOW:-s}

if [[ "$START_NOW" == "s" || "$START_NOW" == "S" || "$START_NOW" == "sim" ]]; then
    echo ""
    echo -e "  ${PURPLE}Iniciando Zaya Plus...${NC}"
    echo ""
    npm start
fi
