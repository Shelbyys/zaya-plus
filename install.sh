#!/bin/bash
# ================================================================
# ZAYA PLUS — Instalador Universal
# Funciona em Mac, Linux e Windows (Git Bash/WSL)
# Uso: curl -sL URL/install.sh | bash
# Uso com token: curl -sL URL/install.sh | bash -s TOKEN
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

TOKEN="${1:-}"
INSTALL_DIR="${ZAYA_INSTALL_DIR:-$HOME/zaya-plus}"
REPO="https://github.com/Shelbyys/zaya-plus.git"
MIN_NODE=18
MIN_DISK_MB=500

# ================================================================
# Banner
# ================================================================
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
echo -e "${BOLD}  Instalador Universal v2.0${NC}"
echo ""
echo "  ─────────────────────────────────────"
echo ""

# ================================================================
# Detectar OS
# ================================================================
detect_os() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "mac"
  elif [[ "$OSTYPE" == "linux"* ]]; then
    echo "linux"
  elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    echo "windows"
  else
    echo "unknown"
  fi
}

OS=$(detect_os)
echo -e "  ${CYAN}Sistema:${NC} $OS ($(uname -m))"
echo ""

# ================================================================
# Helpers
# ================================================================
fail() { echo -e "  ${RED}✗ $1${NC}"; exit 1; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "  ${CYAN}→${NC} $1"; }

# ================================================================
# 1. Verificar espaco em disco
# ================================================================
echo -e "${PURPLE}[1/6]${NC} Verificando espaco em disco..."

check_disk() {
  local dir="$HOME"
  local available_mb=0
  if [[ "$OS" == "mac" ]]; then
    available_mb=$(df -m "$dir" | tail -1 | awk '{print $4}')
  elif [[ "$OS" == "linux" ]]; then
    available_mb=$(df -m "$dir" | tail -1 | awk '{print $4}')
  elif [[ "$OS" == "windows" ]]; then
    available_mb=$(df -m "$dir" 2>/dev/null | tail -1 | awk '{print $4}' || echo "9999")
  fi
  echo "$available_mb"
}

DISK_MB=$(check_disk)
if [[ "$DISK_MB" -lt "$MIN_DISK_MB" ]] 2>/dev/null; then
  fail "Espaco em disco insuficiente (${DISK_MB}MB). Precisa de pelo menos ${MIN_DISK_MB}MB."
fi
ok "Espaco em disco: ${DISK_MB}MB disponivel"
echo ""

# ================================================================
# 2. Instalar Node.js (se necessario)
# ================================================================
echo -e "${PURPLE}[2/6]${NC} Verificando Node.js..."

install_node_mac() {
  # Tenta Homebrew primeiro
  if command -v brew &>/dev/null; then
    info "Instalando via Homebrew..."
    brew install node 2>/dev/null || brew upgrade node 2>/dev/null
    return
  fi
  # Instala Homebrew e depois Node
  info "Instalando Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -f "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -f "/usr/local/bin/brew" ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  brew install node
}

install_node_linux() {
  # Tenta nvm (funciona sem sudo)
  info "Instalando via nvm..."
  export NVM_DIR="$HOME/.nvm"
  # Cria rc file se nao existir
  local RC_FILE="$HOME/.bashrc"
  [[ "$SHELL" == */zsh ]] && RC_FILE="$HOME/.zshrc"
  touch "$RC_FILE"

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh 2>/dev/null | bash >/dev/null 2>&1
  fi
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  if command -v nvm &>/dev/null; then
    nvm install --lts >/dev/null 2>&1
    nvm use --lts >/dev/null 2>&1
    # Garante auto-load em novos terminais
    if ! grep -q 'NVM_DIR' "$RC_FILE" 2>/dev/null; then
      echo '' >> "$RC_FILE"
      echo '# Node Version Manager' >> "$RC_FILE"
      echo 'export NVM_DIR="$HOME/.nvm"' >> "$RC_FILE"
      echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' >> "$RC_FILE"
    fi
    return
  fi

  # Fallback: package manager com sudo
  if command -v apt-get &>/dev/null; then
    info "Instalando via apt (NodeSource)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null
    sudo apt-get install -y nodejs 2>/dev/null
  elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - 2>/dev/null
    sudo dnf install -y nodejs 2>/dev/null
  elif command -v pacman &>/dev/null; then
    sudo pacman -S --noconfirm nodejs npm 2>/dev/null
  elif command -v apk &>/dev/null; then
    sudo apk add --no-cache nodejs npm 2>/dev/null
  else
    fail "Nao foi possivel instalar Node.js automaticamente. Instale manualmente: https://nodejs.org"
  fi
}

install_node_windows() {
  if command -v winget &>/dev/null; then
    info "Instalando via winget..."
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements 2>/dev/null
    export PATH="$PATH:/c/Program Files/nodejs"
  else
    fail "Instale Node.js manualmente: https://nodejs.org"
  fi
}

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VER" -ge "$MIN_NODE" ] 2>/dev/null; then
    ok "Node.js $(node -v)"
  else
    warn "Node.js $(node -v) muito antigo (precisa v${MIN_NODE}+)"
    case "$OS" in
      mac)     install_node_mac ;;
      linux)   install_node_linux ;;
      windows) install_node_windows ;;
    esac
    ok "Node.js $(node -v) instalado"
  fi
else
  warn "Node.js nao encontrado"
  case "$OS" in
    mac)     install_node_mac ;;
    linux)   install_node_linux ;;
    windows) install_node_windows ;;
    *)       fail "OS nao suportado. Instale Node.js manualmente: https://nodejs.org" ;;
  esac
  # Recarrega PATH
  command -v node &>/dev/null || fail "Node.js nao encontrado apos instalacao. Feche e reabra o terminal."
  ok "Node.js $(node -v) instalado"
fi

# Verifica npm
command -v npm &>/dev/null || fail "npm nao encontrado. Reinstale o Node.js: https://nodejs.org"
echo ""

# ================================================================
# 3. Verificar Git
# ================================================================
echo -e "${PURPLE}[3/6]${NC} Verificando Git..."

if command -v git &>/dev/null; then
  ok "Git $(git --version | cut -d' ' -f3)"
else
  warn "Git nao encontrado"
  case "$OS" in
    mac)
      info "Instalando via xcode-select..."
      xcode-select --install 2>/dev/null || true
      if command -v brew &>/dev/null; then brew install git 2>/dev/null; fi
      ;;
    linux)
      if command -v apt-get &>/dev/null; then sudo apt-get install -y git 2>/dev/null
      elif command -v dnf &>/dev/null; then sudo dnf install -y git 2>/dev/null
      elif command -v pacman &>/dev/null; then sudo pacman -S --noconfirm git 2>/dev/null
      elif command -v apk &>/dev/null; then sudo apk add --no-cache git 2>/dev/null
      fi
      ;;
    windows)
      if command -v winget &>/dev/null; then
        winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements 2>/dev/null
      else
        fail "Instale Git manualmente: https://git-scm.com"
      fi
      ;;
  esac
  command -v git &>/dev/null || fail "Git nao encontrado apos instalacao."
  ok "Git $(git --version | cut -d' ' -f3) instalado"
fi

# Opcionais
if [[ "$OS" == "mac" ]]; then
  [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && ok "Google Chrome (opcional)" || warn "Google Chrome nao encontrado (opcional)"
fi
command -v ffmpeg &>/dev/null && ok "FFmpeg (opcional)" || warn "FFmpeg nao encontrado (opcional, para videos)"
echo ""

# ================================================================
# 4. Baixar / Atualizar
# ================================================================
echo -e "${PURPLE}[4/6]${NC} Baixando Zaya Plus..."

if [ -d "$INSTALL_DIR/.git" ]; then
  warn "Pasta ja existe. Atualizando..."
  cd "$INSTALL_DIR"
  git pull origin main 2>/dev/null || true
else
  if ! git clone "$REPO" "$INSTALL_DIR" 2>&1 | grep -v "^$"; then
    fail "Falha ao clonar repositorio. Verifique sua conexao."
  fi
  cd "$INSTALL_DIR"
fi

ok "Codigo baixado em $INSTALL_DIR"
echo ""

# ================================================================
# 5. Instalar dependencias
# ================================================================
echo -e "${PURPLE}[5/6]${NC} Instalando dependencias (pode demorar)..."

# Verifica se build tools estao disponiveis (para better-sqlite3)
if [[ "$OS" == "mac" ]]; then
  if ! xcode-select -p &>/dev/null; then
    warn "Xcode Command Line Tools nao instalado. Instalando..."
    xcode-select --install 2>/dev/null || true
  fi
elif [[ "$OS" == "linux" ]]; then
  if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
    warn "Build tools nao encontrados. Instalando..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y build-essential python3 2>/dev/null || true
    elif command -v dnf &>/dev/null; then
      sudo dnf groupinstall -y "Development Tools" 2>/dev/null || true
    fi
  fi
fi

if npm install --production 2>&1 | tail -5; then
  ok "Dependencias instaladas"
else
  fail "Falha ao instalar dependencias. Verifique os erros acima."
fi

# Configura .env
if [ ! -f ".env" ]; then
  [ -f ".env.example" ] && cp .env.example .env
  ok "Arquivo .env criado"
else
  warn ".env ja existe, mantendo configuracao atual"
fi

echo ""

# ================================================================
# 6. Ativar licenca (se token fornecido)
# ================================================================
echo -e "${PURPLE}[6/6]${NC} Configurando..."

if [ -n "$TOKEN" ]; then
  info "Ativando licenca..."
  if node activate.js "$TOKEN"; then
    ok "Licenca ativada!"
  else
    warn "Falha ao ativar licenca. Voce pode ativar depois pelo dashboard."
  fi
else
  # Verificar se ja tem licenca
  if [ -f ".license" ]; then
    ok "Licenca ja ativada"
  else
    warn "Nenhum token fornecido. Ative pelo dashboard ou rode:"
    echo -e "    ${CYAN}node activate.js SEU-TOKEN${NC}"
  fi
fi

# ================================================================
# Criar atalho "zaya" no terminal
# ================================================================
create_alias() {
  local SHELL_RC=""
  if [ -n "$ZSH_VERSION" ] || [ "$SHELL" = "/bin/zsh" ]; then
    SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
  elif [ -f "$HOME/.bash_profile" ]; then
    SHELL_RC="$HOME/.bash_profile"
  fi

  if [ -n "$SHELL_RC" ]; then
    # Remove alias/function antigos
    sed -i.bak '/# Zaya Plus/d;/alias zaya=/d;/function zaya/d' "$SHELL_RC" 2>/dev/null || true
    rm -f "${SHELL_RC}.bak"

    # NVM prefix se necessario
    local NVM_PREFIX=""
    if [ -d "$HOME/.nvm" ]; then
      NVM_PREFIX='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '
    fi

    echo "# Zaya Plus" >> "$SHELL_RC"
    echo "alias zaya='${NVM_PREFIX}cd $INSTALL_DIR && npm start'" >> "$SHELL_RC"
    ok "Atalho 'zaya' criado no terminal"
  fi

  # Script executavel
  if [[ "$OS" == "mac" ]]; then
    mkdir -p /usr/local/bin 2>/dev/null || true
    cat > /usr/local/bin/zaya 2>/dev/null << SCRIPT || true
#!/bin/bash
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
cd "$INSTALL_DIR" && npm start
SCRIPT
    chmod +x /usr/local/bin/zaya 2>/dev/null || true
  elif [[ "$OS" == "linux" ]]; then
    mkdir -p "$HOME/.local/bin" 2>/dev/null || true
    cat > "$HOME/.local/bin/zaya" << SCRIPT
#!/bin/bash
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
cd "$INSTALL_DIR" && npm start
SCRIPT
    chmod +x "$HOME/.local/bin/zaya"
  elif [[ "$OS" == "windows" ]]; then
    local CMD_DIR="$HOME/AppData/Local/Microsoft/WindowsApps"
    if [ -d "$CMD_DIR" ]; then
      echo "@echo off" > "$CMD_DIR/zaya.cmd"
      echo "cd /d \"$INSTALL_DIR\" && npm start" >> "$CMD_DIR/zaya.cmd"
    fi
  fi
}

create_alias

# ================================================================
# Verificar porta
# ================================================================
PORT="${PORT:-3001}"
if command -v lsof &>/dev/null && lsof -ti:"$PORT" &>/dev/null; then
  warn "Porta $PORT ja esta em uso. A Zaya vai tentar usar ela mesmo assim."
  warn "Se der erro, mate o processo: lsof -ti:$PORT | xargs kill -9"
fi

# ================================================================
# Finalizado!
# ================================================================
echo ""
echo "  ─────────────────────────────────────"
echo ""
echo -e "${GREEN}${BOLD}  ✓ Zaya Plus instalada com sucesso!${NC}"
echo ""
echo -e "  Para iniciar:"
echo -e "  ${CYAN}${BOLD}  zaya${NC}     (ou: cd $INSTALL_DIR && npm start)"
echo ""
echo -e "  Acesse: ${BOLD}http://localhost:$PORT${NC}"
echo ""
echo -e "  Para desinstalar:"
echo -e "  ${CYAN}  bash $INSTALL_DIR/uninstall.sh${NC}"
echo ""
echo "  ─────────────────────────────────────"
echo ""

# Perguntar se quer iniciar
read -p "  Iniciar agora? (s/n) [s]: " START_NOW
START_NOW=${START_NOW:-s}

if [[ "$START_NOW" =~ ^[sS] ]]; then
  echo ""
  echo -e "  ${PURPLE}Iniciando Zaya Plus...${NC}"
  echo ""
  npm start
fi
