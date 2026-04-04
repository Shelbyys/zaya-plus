#!/bin/bash
# ================================================================
# ZAYA PLUS — Instalador Inteligente
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
# Detectar sistema operacional
# ================================================================
OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="mac"
elif [[ "$OSTYPE" == "linux"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    OS="windows"
fi

# ================================================================
# Funcao: instalar Homebrew (Mac)
# ================================================================
install_homebrew() {
    if ! command -v brew &> /dev/null; then
        echo -e "  ${YELLOW}→${NC} Instalando Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Adicionar ao PATH
        if [[ -f "/opt/homebrew/bin/brew" ]]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        elif [[ -f "/usr/local/bin/brew" ]]; then
            eval "$(/usr/local/bin/brew shellenv)"
        fi
        echo -e "  ${GREEN}✓${NC} Homebrew instalado"
    fi
}

# ================================================================
# 1. Verificar e instalar requisitos
# ================================================================
echo -e "${PURPLE}[1/5]${NC} Verificando requisitos..."
echo ""

# --- Node.js ---
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -ge 18 ]; then
        echo -e "  ${GREEN}✓${NC} Node.js $(node -v) — instalado"
    else
        echo -e "  ${YELLOW}!${NC} Node.js $(node -v) encontrado, mas precisa v18+"
        echo -e "  ${CYAN}→${NC} Atualizando Node.js..."
        if [[ "$OS" == "mac" ]]; then
            install_homebrew
            brew install node 2>/dev/null || brew upgrade node 2>/dev/null
        elif [[ "$OS" == "linux" ]]; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
            sudo apt-get install -y nodejs 2>/dev/null
        fi
        echo -e "  ${GREEN}✓${NC} Node.js $(node -v) — atualizado"
    fi
else
    echo -e "  ${YELLOW}!${NC} Node.js nao encontrado"
    echo -e "  ${CYAN}→${NC} Instalando Node.js automaticamente..."
    echo ""

    if [[ "$OS" == "mac" ]]; then
        install_homebrew
        brew install node
        echo -e "  ${GREEN}✓${NC} Node.js $(node -v) — instalado via Homebrew"

    elif [[ "$OS" == "linux" ]]; then
        # Detectar distro
        if command -v apt-get &> /dev/null; then
            echo -e "  ${CYAN}→${NC} Detectado: Debian/Ubuntu"
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt-get install -y nodejs
        elif command -v dnf &> /dev/null; then
            echo -e "  ${CYAN}→${NC} Detectado: Fedora/RHEL"
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
            sudo dnf install -y nodejs
        elif command -v pacman &> /dev/null; then
            echo -e "  ${CYAN}→${NC} Detectado: Arch Linux"
            sudo pacman -S --noconfirm nodejs npm
        elif command -v apk &> /dev/null; then
            echo -e "  ${CYAN}→${NC} Detectado: Alpine"
            sudo apk add --no-cache nodejs npm
        else
            echo -e "  ${RED}✗${NC} Distro nao reconhecida. Instale Node.js 20 manualmente:"
            echo "     https://nodejs.org/en/download"
            exit 1
        fi
        echo -e "  ${GREEN}✓${NC} Node.js $(node -v) — instalado"

    elif [[ "$OS" == "windows" ]]; then
        echo -e "  ${CYAN}→${NC} Tentando instalar via winget..."
        if command -v winget &> /dev/null; then
            winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
            echo -e "  ${GREEN}✓${NC} Node.js instalado via winget"
            echo -e "  ${YELLOW}!${NC} Feche e reabra o terminal, depois rode este script novamente"
            exit 0
        else
            echo -e "  ${RED}✗${NC} Baixe e instale o Node.js manualmente:"
            echo "     https://nodejs.org/en/download"
            echo ""
            echo "  Depois rode este script novamente."
            exit 1
        fi
    fi
fi

echo ""

# --- Git ---
if command -v git &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Git $(git --version | cut -d' ' -f3) — instalado"
else
    echo -e "  ${YELLOW}!${NC} Git nao encontrado"
    echo -e "  ${CYAN}→${NC} Instalando Git automaticamente..."

    if [[ "$OS" == "mac" ]]; then
        # No Mac, xcode-select instala o git
        xcode-select --install 2>/dev/null || true
        # Ou via homebrew
        if command -v brew &> /dev/null; then
            brew install git
        fi
        echo -e "  ${GREEN}✓${NC} Git instalado"

    elif [[ "$OS" == "linux" ]]; then
        if command -v apt-get &> /dev/null; then
            sudo apt-get install -y git
        elif command -v dnf &> /dev/null; then
            sudo dnf install -y git
        elif command -v pacman &> /dev/null; then
            sudo pacman -S --noconfirm git
        elif command -v apk &> /dev/null; then
            sudo apk add --no-cache git
        fi
        echo -e "  ${GREEN}✓${NC} Git $(git --version | cut -d' ' -f3) — instalado"

    elif [[ "$OS" == "windows" ]]; then
        if command -v winget &> /dev/null; then
            winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
            echo -e "  ${GREEN}✓${NC} Git instalado via winget"
            echo -e "  ${YELLOW}!${NC} Feche e reabra o terminal, depois rode este script novamente"
            exit 0
        else
            echo -e "  ${RED}✗${NC} Baixe e instale o Git manualmente:"
            echo "     https://git-scm.com/downloads"
            exit 1
        fi
    fi
fi

echo ""

# --- Chrome (opcional) ---
if [[ "$OS" == "mac" ]]; then
    if [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
        echo -e "  ${GREEN}✓${NC} Google Chrome — instalado"
    else
        echo -e "  ${YELLOW}~${NC} Google Chrome nao encontrado (opcional)"
    fi
elif command -v google-chrome &> /dev/null || command -v google-chrome-stable &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Google Chrome — instalado"
else
    echo -e "  ${YELLOW}~${NC} Google Chrome nao encontrado (opcional)"
fi

# --- FFmpeg (opcional) ---
if command -v ffmpeg &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} FFmpeg — instalado"
else
    echo -e "  ${YELLOW}~${NC} FFmpeg nao encontrado (opcional, para videos)"
fi

echo ""
echo -e "  ${GREEN}${BOLD}Todos os requisitos OK!${NC}"
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

if [ -d "$INSTALL_DIR/.git" ]; then
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

npm install --production 2>&1 | tail -3

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
    echo -e "  ${YELLOW}~${NC} .env ja existe, mantendo configuracao atual"
fi

echo ""

# ================================================================
# Finalizado!
# ================================================================
echo "  ─────────────────────────────────────"
echo ""
echo -e "${GREEN}${BOLD}  ✓ Zaya Plus instalada com sucesso!${NC}"
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
