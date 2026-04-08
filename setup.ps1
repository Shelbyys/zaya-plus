# ================================================================
# ZAYA PLUS - Instalador Automatico (Windows)
# ================================================================

param([string]$Token = "")

$INSTALL_DIR = "$env:USERPROFILE\zaya-plus"
$REPO = "https://github.com/Shelbyys/zaya-plus.git"

Write-Host ""
Write-Host "  ZZZZZZ  AAAAA  Y   Y  AAAAA" -ForegroundColor Magenta
Write-Host "     Z   A   A  Y Y  A   A" -ForegroundColor Magenta
Write-Host "    Z   AAAAA   Y   AAAAA" -ForegroundColor Magenta
Write-Host "   Z   A   A   Y   A   A" -ForegroundColor Magenta
Write-Host "  ZZZZ A   A   Y   A   A" -ForegroundColor Magenta
Write-Host "         P L U S" -ForegroundColor Cyan
Write-Host ""

if (-not $Token) { $Token = $args[0] }
if (-not $Token) {
    Write-Host "  ! Token nao detectado." -ForegroundColor Yellow
    $Token = Read-Host "  Cole seu token aqui"
    if (-not $Token) { Write-Host "  x Token obrigatorio!" -ForegroundColor Red; exit 1 }
}

$tp = $Token.Substring(0, [Math]::Min(8, $Token.Length)) + "..."
Write-Host "  Token: $tp" -ForegroundColor Cyan
Write-Host ""

# ================================================================
# 1. Node.js
# ================================================================
Write-Host "[1/4] Verificando Node.js..." -ForegroundColor Magenta

$nodeOk = $false
try {
    $nv = node -v 2>$null
    if ($nv) {
        $major = [int]($nv -replace "v","").Split(".")[0]
        if ($major -ge 18) {
            Write-Host "  OK Node.js $nv" -ForegroundColor Green
            $nodeOk = $true
        }
    }
} catch {}

if (-not $nodeOk) {
    Write-Host "  -> Instalando Node.js..." -ForegroundColor Cyan
    $installed = $false
    try {
        $wv = winget --version 2>$null
        if ($wv) {
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent 2>$null
            $installed = $true
        }
    } catch {}
    if (-not $installed) {
        Write-Host "  -> Baixando Node.js MSI..." -ForegroundColor Cyan
        $msi = "$env:TEMP\node-install.msi"
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v22.15.0/node-v22.15.0-x64.msi" -OutFile $msi -UseBasicParsing
        $a = "/i " + [char]34 + $msi + [char]34 + " /qn"
        Start-Process msiexec.exe -ArgumentList $a -Wait -Verb RunAs
        Remove-Item $msi -Force -ErrorAction SilentlyContinue
    }
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    try {
        $nv = node -v 2>$null
        if ($nv) { Write-Host "  OK Node.js $nv instalado" -ForegroundColor Green }
        else { Write-Host "  x Instale Node.js manualmente: https://nodejs.org" -ForegroundColor Red; exit 1 }
    } catch { Write-Host "  x Instale Node.js manualmente: https://nodejs.org" -ForegroundColor Red; exit 1 }
}

# npm
try { npm -v 2>$null | Out-Null } catch { Write-Host "  x npm nao encontrado" -ForegroundColor Red; exit 1 }

# git
$gitOk = $false
try { git --version 2>$null | Out-Null; $gitOk = $true } catch {}
if (-not $gitOk) {
    Write-Host "  -> Instalando Git..." -ForegroundColor Yellow
    try {
        winget install Git.Git --accept-package-agreements --accept-source-agreements --silent 2>$null
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } catch { Write-Host "  x Instale Git: https://git-scm.com" -ForegroundColor Red; exit 1 }
}

Write-Host ""

# ================================================================
# 2. Clonar
# ================================================================
Write-Host "[2/4] Baixando Zaya Plus..." -ForegroundColor Magenta

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
# 3. Dependencias
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
# 5. Atalho zaya
# ================================================================

# CMD
$cmdDir = Join-Path $env:USERPROFILE "AppData\Local\Microsoft\WindowsApps"
if (Test-Path $cmdDir) {
    $bp = Join-Path $cmdDir "zaya.cmd"
    $b1 = "@echo off"
    $b2 = "cd /d " + [char]34 + $INSTALL_DIR + [char]34 + " && npm start"
    [System.IO.File]::WriteAllText($bp, ($b1 + [Environment]::NewLine + $b2))
    Write-Host "  OK Atalho zaya criado" -ForegroundColor Green
}

# PowerShell profile
try {
    $pd = Split-Path $PROFILE -Parent
    if (-not (Test-Path $pd)) { New-Item -ItemType Directory -Path $pd -Force | Out-Null }
    if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
    $pc = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if (-not $pc -or $pc -notmatch "function zaya") {
        $fn = "function zaya { Set-Location " + [char]39 + $INSTALL_DIR + [char]39 + "; npm start }"
        $nl = [Environment]::NewLine
        [System.IO.File]::AppendAllText($PROFILE, ($nl + "# Zaya Plus" + $nl + $fn + $nl))
    }
} catch {}

Write-Host ""
Write-Host "  ==========================================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  OK Zaya Plus instalada e ativada!" -ForegroundColor Green
Write-Host ""
Write-Host "  Para iniciar, digite: zaya" -ForegroundColor Cyan
Write-Host "  Acesse: http://localhost:3001" -ForegroundColor White
Write-Host ""
Write-Host "  ==========================================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Iniciando Zaya Plus..." -ForegroundColor Magenta
Write-Host ""
npm start
