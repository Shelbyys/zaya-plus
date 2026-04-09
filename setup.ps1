# ================================================================
# ZAYA PLUS - Instalador Universal (Windows PowerShell)
# Uso: irm URL/setup.ps1 | iex
# Uso com token: powershell -c "& { $token='SEU-TOKEN'; irm URL/setup.ps1 | iex }"
# ================================================================

param([string]$Token = "")

$ErrorActionPreference = "Stop"
$INSTALL_DIR = "$env:USERPROFILE\zaya-plus"
$REPO = "https://github.com/Shelbyys/zaya-plus.git"
$MIN_NODE = 18
$MIN_DISK_MB = 500

Write-Host ""
Write-Host "  ZZZZZZ  AAAAA  Y   Y  AAAAA" -ForegroundColor Magenta
Write-Host "     Z   A   A  Y Y  A   A" -ForegroundColor Magenta
Write-Host "    Z   AAAAA   Y   AAAAA" -ForegroundColor Magenta
Write-Host "   Z   A   A   Y   A   A" -ForegroundColor Magenta
Write-Host "  ZZZZ A   A   Y   A   A" -ForegroundColor Magenta
Write-Host "         P L U S" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Instalador Universal v2.0" -ForegroundColor White
Write-Host ""

# Token
if (-not $Token) { $Token = $args[0] }
if ($Token) {
    $tp = $Token.Substring(0, [Math]::Min(8, $Token.Length)) + "..."
    Write-Host "  Token: $tp" -ForegroundColor Cyan
    Write-Host ""
}

# ================================================================
# 1. Espaco em disco
# ================================================================
Write-Host "[1/6] Verificando espaco em disco..." -ForegroundColor Magenta

$drive = (Get-Item $env:USERPROFILE).PSDrive
$freeMB = [Math]::Floor($drive.Free / 1MB)
if ($freeMB -lt $MIN_DISK_MB) {
    Write-Host "  x Espaco insuficiente (${freeMB}MB). Precisa de ${MIN_DISK_MB}MB." -ForegroundColor Red
    exit 1
}
Write-Host "  OK Espaco em disco: ${freeMB}MB disponivel" -ForegroundColor Green
Write-Host ""

# ================================================================
# 2. Node.js
# ================================================================
Write-Host "[2/6] Verificando Node.js..." -ForegroundColor Magenta

$nodeOk = $false
try {
    $nv = node -v 2>$null
    if ($nv) {
        $major = [int]($nv -replace "v","").Split(".")[0]
        if ($major -ge $MIN_NODE) {
            Write-Host "  OK Node.js $nv" -ForegroundColor Green
            $nodeOk = $true
        } else {
            Write-Host "  ! Node.js $nv muito antigo (precisa v${MIN_NODE}+)" -ForegroundColor Yellow
        }
    }
} catch {}

if (-not $nodeOk) {
    Write-Host "  -> Instalando Node.js..." -ForegroundColor Cyan
    $installed = $false

    # Tenta winget
    try {
        $wv = winget --version 2>$null
        if ($wv) {
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent 2>$null
            $installed = $true
        }
    } catch {}

    # Fallback: MSI direto
    if (-not $installed) {
        Write-Host "  -> Baixando Node.js MSI..." -ForegroundColor Cyan
        $msi = "$env:TEMP\node-install.msi"
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v22.15.0/node-v22.15.0-x64.msi" -OutFile $msi -UseBasicParsing
        Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn" -Wait -Verb RunAs
        Remove-Item $msi -Force -ErrorAction SilentlyContinue
    }

    # Recarrega PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

    try {
        $nv = node -v 2>$null
        if ($nv) { Write-Host "  OK Node.js $nv instalado" -ForegroundColor Green }
        else { Write-Host "  x Instale Node.js manualmente: https://nodejs.org" -ForegroundColor Red; exit 1 }
    } catch { Write-Host "  x Instale Node.js manualmente: https://nodejs.org" -ForegroundColor Red; exit 1 }
}

# npm
try { npm -v 2>$null | Out-Null } catch { Write-Host "  x npm nao encontrado" -ForegroundColor Red; exit 1 }
Write-Host ""

# ================================================================
# 3. Git
# ================================================================
Write-Host "[3/6] Verificando Git..." -ForegroundColor Magenta

$gitOk = $false
try { git --version 2>$null | Out-Null; $gitOk = $true } catch {}

if (-not $gitOk) {
    Write-Host "  -> Instalando Git..." -ForegroundColor Cyan
    try {
        winget install Git.Git --accept-package-agreements --accept-source-agreements --silent 2>$null
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        $gitOk = $true
    } catch {}
    if (-not $gitOk) { Write-Host "  x Instale Git: https://git-scm.com" -ForegroundColor Red; exit 1 }
}
Write-Host "  OK Git instalado" -ForegroundColor Green
Write-Host ""

# ================================================================
# 4. Clonar / Atualizar
# ================================================================
Write-Host "[4/6] Baixando Zaya Plus..." -ForegroundColor Magenta

if (Test-Path "$INSTALL_DIR\.git") {
    Write-Host "  ! Pasta existe. Atualizando..." -ForegroundColor Yellow
    Set-Location $INSTALL_DIR
    git pull origin main 2>$null
} else {
    git clone $REPO $INSTALL_DIR 2>&1 | Out-Null
    if (-not (Test-Path $INSTALL_DIR)) { Write-Host "  x Falha ao clonar" -ForegroundColor Red; exit 1 }
    Set-Location $INSTALL_DIR
}
Write-Host "  OK Codigo baixado" -ForegroundColor Green
Write-Host ""

# ================================================================
# 5. Dependencias
# ================================================================
Write-Host "[5/6] Instalando dependencias..." -ForegroundColor Magenta

# Verifica build tools para better-sqlite3
try {
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vsWhere)) {
        Write-Host "  ! Build tools podem ser necessarios. Se der erro, instale:" -ForegroundColor Yellow
        Write-Host "    npm install -g windows-build-tools" -ForegroundColor Cyan
    }
} catch {}

npm install --production 2>&1 | Select-Object -Last 5

if (-not (Test-Path "node_modules")) {
    Write-Host "  x Falha ao instalar dependencias" -ForegroundColor Red
    exit 1
}

# .env
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") { Copy-Item ".env.example" ".env" }
    Write-Host "  OK Arquivo .env criado" -ForegroundColor Green
} else {
    Write-Host "  ! .env ja existe, mantendo" -ForegroundColor Yellow
}
Write-Host "  OK Dependencias instaladas" -ForegroundColor Green
Write-Host ""

# ================================================================
# 6. Licenca
# ================================================================
Write-Host "[6/6] Configurando..." -ForegroundColor Magenta

if ($Token) {
    Write-Host "  -> Ativando licenca..." -ForegroundColor Cyan
    node activate.js $Token
} elseif (Test-Path ".license") {
    Write-Host "  OK Licenca ja ativada" -ForegroundColor Green
} else {
    Write-Host "  ! Nenhum token. Ative pelo dashboard ou: node activate.js SEU-TOKEN" -ForegroundColor Yellow
}

# ================================================================
# Atalhos
# ================================================================

# CMD
$cmdDir = Join-Path $env:USERPROFILE "AppData\Local\Microsoft\WindowsApps"
if (Test-Path $cmdDir) {
    $bp = Join-Path $cmdDir "zaya.cmd"
    [System.IO.File]::WriteAllText($bp, "@echo off`r`ncd /d `"$INSTALL_DIR`" && npm start")
    Write-Host "  OK Atalho 'zaya' criado (CMD)" -ForegroundColor Green
}

# PowerShell profile
try {
    $pd = Split-Path $PROFILE -Parent
    if (-not (Test-Path $pd)) { New-Item -ItemType Directory -Path $pd -Force | Out-Null }
    if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
    $pc = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if (-not $pc -or $pc -notmatch "function zaya") {
        $fn = "function zaya { Set-Location '$INSTALL_DIR'; npm start }"
        [System.IO.File]::AppendAllText($PROFILE, "`r`n# Zaya Plus`r`n$fn`r`n")
        Write-Host "  OK Atalho 'zaya' criado (PowerShell)" -ForegroundColor Green
    }
} catch {}

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  OK Zaya Plus instalada com sucesso!" -ForegroundColor Green
Write-Host ""
Write-Host "  Para iniciar: zaya" -ForegroundColor Cyan
Write-Host "  Acesse: http://localhost:3001" -ForegroundColor White
Write-Host ""
Write-Host "  Para desinstalar:" -ForegroundColor White
Write-Host "    powershell -File $INSTALL_DIR\uninstall.ps1" -ForegroundColor Cyan
Write-Host ""
Write-Host "  ==========================================" -ForegroundColor DarkGray
Write-Host ""

$start = Read-Host "  Iniciar agora? (s/n) [s]"
if (-not $start -or $start -match "^[sS]") {
    Write-Host ""
    Write-Host "  Iniciando Zaya Plus..." -ForegroundColor Magenta
    Write-Host ""
    npm start
}
