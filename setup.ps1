# ================================================================
# ZAYA PLUS — Instalador Automatico (Windows PowerShell)
# Uso: irm https://raw.githubusercontent.com/Shelbyys/zaya-plus/main/setup.ps1 | iex
# Ou:  powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/Shelbyys/zaya-plus/main/setup.ps1 | iex"
# ================================================================

param([string]$Token = "")

$INSTALL_DIR = "$env:USERPROFILE\zaya-plus"
$REPO = "https://github.com/Shelbyys/zaya-plus-app.git"

Write-Host ""
Write-Host "  ███████╗ █████╗ ██╗   ██╗ █████╗ " -ForegroundColor Magenta
Write-Host "  ╚══███╔╝██╔══██╗╚██╗ ██╔╝██╔══██╗" -ForegroundColor Magenta
Write-Host "    ███╔╝ ███████║ ╚████╔╝ ███████║" -ForegroundColor Magenta
Write-Host "   ███╔╝  ██╔══██║  ╚██╔╝  ██╔══██║" -ForegroundColor Magenta
Write-Host "  ███████╗██║  ██║   ██║   ██║  ██║" -ForegroundColor Magenta
Write-Host "  ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝" -ForegroundColor Magenta
Write-Host "           P L U S" -ForegroundColor Cyan
Write-Host ""

# Token via argumento ou prompt
if (-not $Token) {
    $Token = $args[0]
}
if (-not $Token) {
    Write-Host "  ! Token nao detectado no comando." -ForegroundColor Yellow
    Write-Host ""
    $Token = Read-Host "  Cole seu token aqui"
    Write-Host ""
    if (-not $Token) {
        Write-Host "  x Token obrigatorio!" -ForegroundColor Red
        exit 1
    }
}

$TokenPreview = $Token.Substring(0, [Math]::Min(8, $Token.Length)) + "..." + $Token.Substring([Math]::Max(0, $Token.Length - 6))
Write-Host "  Token: $TokenPreview" -ForegroundColor Cyan
Write-Host ""

# ================================================================
# 1. Verificar/Instalar Node.js
# ================================================================
Write-Host "[1/4] Verificando Node.js..." -ForegroundColor Magenta

$nodeExists = $false
try {
    $nodeVer = (node -v 2>$null)
    if ($nodeVer) {
        $major = [int]($nodeVer -replace 'v','').Split('.')[0]
        if ($major -ge 18) {
            Write-Host "  OK Node.js $nodeVer encontrado" -ForegroundColor Green
            $nodeExists = $true
        } else {
            Write-Host "  ! Node.js $nodeVer muito antigo (precisa v18+)" -ForegroundColor Yellow
        }
    }
} catch {}

if (-not $nodeExists) {
    Write-Host "  -> Instalando Node.js..." -ForegroundColor Cyan

    # Tenta via winget primeiro
    $wingetInstalled = $false
    try {
        $wingetCheck = winget --version 2>$null
        if ($wingetCheck) {
            Write-Host "  -> Usando winget..." -ForegroundColor Cyan
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent 2>$null
            $wingetInstalled = $true
        }
    } catch {}

    if (-not $wingetInstalled) {
        # Download direto do instalador
        Write-Host "  -> Baixando instalador do Node.js..." -ForegroundColor Cyan
        $nodeUrl = "https://nodejs.org/dist/v22.15.0/node-v22.15.0-x64.msi"
        $nodeInstaller = "$env:TEMP\node-install.msi"
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeInstaller -UseBasicParsing
        Write-Host "  -> Instalando (pode pedir permissao de admin)..." -ForegroundColor Cyan
        Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /qn" -Wait -Verb RunAs
        Remove-Item $nodeInstaller -Force -ErrorAction SilentlyContinue
    }

    # Atualiza PATH para a sessao atual
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

    try {
        $nodeVer = (node -v 2>$null)
        if ($nodeVer) {
            Write-Host "  OK Node.js $nodeVer instalado" -ForegroundColor Green
        } else {
            Write-Host "  x Falha ao instalar Node.js. Instale manualmente: https://nodejs.org" -ForegroundColor Red
            exit 1
        }
    } catch {
        Write-Host "  x Falha ao instalar Node.js. Instale manualmente: https://nodejs.org" -ForegroundColor Red
        exit 1
    }
}

# Verificar npm
try {
    npm -v 2>$null | Out-Null
} catch {
    Write-Host "  x npm nao encontrado. Instale o Node.js manualmente: https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Verificar git
$gitExists = $false
try {
    git --version 2>$null | Out-Null
    $gitExists = $true
} catch {}

if (-not $gitExists) {
    Write-Host "  -> Git nao encontrado. Instalando..." -ForegroundColor Yellow
    try {
        winget install Git.Git --accept-package-agreements --accept-source-agreements --silent 2>$null
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    } catch {
        Write-Host "  x Instale o Git manualmente: https://git-scm.com" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""

# ================================================================
# 2. Clonar repositorio
# ================================================================
Write-Host "[2/4] Baixando Zaya Plus..." -ForegroundColor Magenta

if (Test-Path "$INSTALL_DIR\.git") {
    Write-Host "  ! Pasta ja existe. Atualizando..." -ForegroundColor Yellow
    Set-Location $INSTALL_DIR
    git pull origin main 2>$null
} else {
    git clone $REPO $INSTALL_DIR 2>&1 | Out-Null
    if (-not (Test-Path $INSTALL_DIR)) {
        Write-Host "  x Falha ao clonar repositorio" -ForegroundColor Red
        exit 1
    }
    Set-Location $INSTALL_DIR
}

Write-Host "  OK Codigo baixado" -ForegroundColor Green
Write-Host ""

# ================================================================
# 3. Instalar dependencias
# ================================================================
Write-Host "[3/4] Instalando dependencias..." -ForegroundColor Magenta

npm install 2>&1 | Select-Object -Last 3

Write-Host "  OK Dependencias instaladas" -ForegroundColor Green
Write-Host ""

# ================================================================
# 4. Ativar licenca
# ================================================================
Write-Host "[4/4] Ativando licenca..." -ForegroundColor Magenta

node activate.js $Token

# ================================================================
# 5. Criar atalho "zaya" no terminal
# ================================================================

# PowerShell profile alias
$profileDir = Split-Path $PROFILE -Parent
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }

$aliasLine = "function zaya { Set-Location '$INSTALL_DIR'; npm start }"
$profileContent = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
if (-not $profileContent -or $profileContent -notmatch 'function zaya') {
    Add-Content $PROFILE "`n# Zaya Plus`n$aliasLine"
    Write-Host "  OK Atalho 'zaya' criado no PowerShell" -ForegroundColor Green
}

# CMD alias via batch file
$cmdDir = "$env:USERPROFILE\AppData\Local\Microsoft\WindowsApps"
if (Test-Path $cmdDir) {
    $batContent = "@echo off`r`ncd /d `"$INSTALL_DIR`" && npm start"
    Set-Content "$cmdDir\zaya.cmd" $batContent -Force
    Write-Host "  OK Atalho 'zaya' criado no CMD" -ForegroundColor Green
}

Write-Host ""
Write-Host "  -----------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  OK Zaya Plus instalada e ativada!" -ForegroundColor Green
Write-Host ""
Write-Host "  Para iniciar, basta digitar:" -ForegroundColor White
Write-Host "  zaya" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Ou se preferir:" -ForegroundColor White
Write-Host "  cd $INSTALL_DIR; npm start" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Acesse: http://localhost:3001" -ForegroundColor White
Write-Host ""
Write-Host "  -----------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Iniciando Zaya Plus..." -ForegroundColor Magenta
Write-Host ""
npm start
