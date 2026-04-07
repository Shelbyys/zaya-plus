#!/bin/bash
# ================================================================
# ZAYA PLUS — Instalador Automatico (uso via admin panel)
# Uso: curl -sL https://raw.githubusercontent.com/Shelbyys/zaya-plus/main/setup.sh | bash -sTOKEN
# ================================================================

TOKEN="$1"
INSTALL_DIR="$HOME/zaya-plus"
REPO="https://github.com/Shelbyys/zaya-plus-app.git"

RED='\033[0;31m'
GREEN='\033[0;32m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

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

if [ -z "$TOKEN" ]; then
    echo -e "  ${YELLOW}!${NC} Token nao detectado no comando."
    echo ""
    printf "  Cole seu token aqui: "
    read -r TOKEN
    echo ""
    if [ -z "$TOKEN" ]; then
        echo -e "  ${RED}✗ Token obrigatorio!${NC}"
        exit 1
    fi
fi

echo -e "  ${CYAN}Token:${NC} ${TOKEN:0:8}...${TOKEN: -6}"
echo ""

# ================================================================
# 1. Instalar Node.js (se necessario)
# ================================================================
echo -e "${PURPLE}[1/4]${NC} Verificando Node.js..."

install_node() {
    echo -e "  ${CYAN}→${NC} Instalando Node.js via nvm..."
    export NVM_DIR="$HOME/.nvm"

    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        # Criar .zshrc ou .bashrc se nao existir (evita erro do nvm)
        if [ -n "$ZSH_VERSION" ] || [ "$SHELL" = "/bin/zsh" ]; then
            touch "$HOME/.zshrc"
        else
            touch "$HOME/.bashrc"
        fi
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh 2>/dev/null | bash > /dev/null 2>&1
    fi

    # Carregar nvm
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

    if ! command -v nvm &> /dev/null; then
        echo -e "  ${RED}✗ Falha ao instalar nvm${NC}"
        echo -e "  Instale o Node.js manualmente: https://nodejs.org"
        exit 1
    fi

    nvm install --lts > /dev/null 2>&1
    nvm use --lts > /dev/null 2>&1
}

if command -v node &> /dev/null; then
    NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VER" -ge 18 ]; then
        echo -e "  ${GREEN}✓${NC} Node.js $(node -v) encontrado"
    else
        echo -e "  ${YELLOW}!${NC} Node.js $(node -v) muito antigo (precisa v18+)"
        install_node
        echo -e "  ${GREEN}✓${NC} Node.js $(node -v) instalado"
    fi
else
    echo -e "  ${YELLOW}!${NC} Node.js nao encontrado"
    install_node
    echo -e "  ${GREEN}✓${NC} Node.js $(node -v) instalado"
fi

# Garantir que npm existe
if ! command -v npm &> /dev/null; then
    echo -e "  ${RED}✗ npm nao encontrado. Instale o Node.js manualmente: https://nodejs.org${NC}"
    exit 1
fi

echo ""

# ================================================================
# 2. Clonar repositorio
# ================================================================
echo -e "${PURPLE}[2/4]${NC} Baixando Zaya Plus..."

if [ -d "$INSTALL_DIR/.git" ]; then
    echo -e "  ${YELLOW}!${NC} Pasta ja existe. Atualizando..."
    cd "$INSTALL_DIR"
    git pull origin main 2>/dev/null || true
else
    if ! git clone "$REPO" "$INSTALL_DIR" 2>&1 | grep -v "^$"; then
        echo -e "  ${RED}✗ Falha ao clonar repositorio${NC}"
        exit 1
    fi
    cd "$INSTALL_DIR"
fi

echo -e "  ${GREEN}✓${NC} Codigo baixado"
echo ""

# ================================================================
# 3. Instalar dependencias
# ================================================================
echo -e "${PURPLE}[3/4]${NC} Instalando dependencias..."

npm install 2>&1 | tail -3

echo -e "  ${GREEN}✓${NC} Dependencias instaladas"
echo ""

# ================================================================
# 4. Ativar licenca
# ================================================================
echo -e "${PURPLE}[4/4]${NC} Ativando licenca..."

node activate.js "$TOKEN"

# ================================================================
# 5. Criar atalho "zaya" no terminal
# ================================================================
SHELL_RC=""
if [ -n "$ZSH_VERSION" ] || [ "$SHELL" = "/bin/zsh" ]; then
    SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
    SHELL_RC="$HOME/.bash_profile"
fi

if [ -n "$SHELL_RC" ]; then
    # Remove alias antigo se existir
    if grep -q 'alias zaya=' "$SHELL_RC" 2>/dev/null; then
        sed -i.bak '/alias zaya=/d' "$SHELL_RC"
    fi
    echo "alias zaya='cd $INSTALL_DIR && npm start'" >> "$SHELL_RC"
    echo -e "  ${GREEN}✓${NC} Atalho criado! Digite ${CYAN}zaya${NC} no terminal pra iniciar"
fi

# Criar script executavel tambem (funciona sem reabrir terminal)
cat > "$HOME/.local/bin/zaya" 2>/dev/null << SCRIPT || true
#!/bin/bash
cd "$INSTALL_DIR" && npm start
SCRIPT
chmod +x "$HOME/.local/bin/zaya" 2>/dev/null || true

# Mac: criar tambem em /usr/local/bin se possivel
if [ "$(uname)" = "Darwin" ]; then
    mkdir -p /usr/local/bin 2>/dev/null
    cat > /usr/local/bin/zaya 2>/dev/null << SCRIPT || true
#!/bin/bash
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
cd "$INSTALL_DIR" && npm start
SCRIPT
    chmod +x /usr/local/bin/zaya 2>/dev/null || true
fi

echo ""
echo "  ─────────────────────────────────────"
echo ""
echo -e "${GREEN}${BOLD}  ✓ Zaya Plus instalada e ativada!${NC}"
echo ""
echo -e "  Para iniciar, basta digitar:"
echo -e "  ${CYAN}${BOLD}zaya${NC}"
echo ""
echo -e "  Ou se preferir:"
echo -e "  ${CYAN}cd $INSTALL_DIR && npm start${NC}"
echo ""
echo -e "  Acesse: ${BOLD}http://localhost:3001${NC}"
echo ""
echo "  ─────────────────────────────────────"
echo ""
echo -e "  ${PURPLE}Iniciando Zaya Plus...${NC}"
echo ""
npm start
