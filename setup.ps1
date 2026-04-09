# ================================================================
# ZAYA PLUS - Instalador Universal (Windows PowerShell) v2.1
# Uso: irm URL/setup.ps1 | iex
# Uso com token: powershell -c "& { $token='SEU-TOKEN'; irm URL/setup.ps1 | iex }"
# Uso interativo: powershell -ExecutionPolicy Bypass -File setup.ps1 -Token SEU-TOKEN
# ================================================================

param(
    [string]$Token = "",
    [string]$InstallDir = "",
    [switch]$NonInteractive = $false,
    [switch]$SkipFirewall = $false
)

# P9: ExecutionPolicy bypass para sessão atual (caso o user não tenha setado)
try {
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue
} catch {}

$ErrorActionPreference = "Continue"  # Não para em todos os erros — só nos críticos
$REPO = "https://github.com/Shelbyys/zaya-plus.git"
$MIN_NODE = 18
$MIN_DISK_MB = 500

# Default install dir
if (-not $InstallDir) {
    $InstallDir = "$env:USERPROFILE\zaya-plus"
}

# ================================================================
# Banner
# ================================================================
Clear-Host
Write-Host ""
Write-Host "  ZZZZZZ  AAAAA  Y   Y  AAAAA" -ForegroundColor Magenta
Write-Host "     Z   A   A  Y Y  A   A" -ForegroundColor Magenta
Write-Host "    Z   AAAAA   Y   AAAAA" -ForegroundColor Magenta
Write-Host "   Z   A   A   Y   A   A" -ForegroundColor Magenta
Write-Host "  ZZZZ A   A   Y   A   A" -ForegroundColor Magenta
Write-Host "         P L U S" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Instalador Universal Windows v2.1" -ForegroundColor White
Write-Host ""

# Token via args[0] (compat com versões antigas)
if (-not $Token -and $args.Count -gt 0) { $Token = $args[0] }
if ($Token) {
    $tp = $Token.Substring(0, [Math]::Min(8, $Token.Length)) + "..."
    Write-Host "  Token: $tp" -ForegroundColor Cyan
    Write-Host ""
}

# P15: Helper para validar exit code de comandos críticos
function Test-LastCommand {
    param([string]$Operation)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  x $Operation falhou (exit code: $LASTEXITCODE)" -ForegroundColor Red
        return $false
    }
    return $true
}

# P14: git clone com captura de erro
function Invoke-GitClone {
    param([string]$Repo, [string]$Dest)
    $output = git clone $Repo $Dest 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  x Falha ao clonar:" -ForegroundColor Red
        $output | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkRed }
        return $false
    }
    return $true
}

# ================================================================
# 0. Confirmação de pasta (P18)
# ================================================================
if (-not $NonInteractive -and (Test-Path $InstallDir) -and -not (Test-Path "$InstallDir\.git")) {
    Write-Host "  ! A pasta $InstallDir ja existe e nao parece ser uma instalacao do Zaya." -ForegroundColor Yellow
    $confirm = Read-Host "  Sobrescrever? (s/n) [n]"
    if ($confirm -notmatch "^[sS]") {
        Write-Host "  Cancelado." -ForegroundColor Red
        exit 0
    }
}

# ================================================================
# 1. Espaco em disco
# ================================================================
Write-Host "[1/7] Verificando espaco em disco..." -ForegroundColor Magenta

$drive = (Get-Item $env:USERPROFILE).PSDrive
$freeMB = [Math]::Floor($drive.Free / 1MB)
if ($freeMB -lt $MIN_DISK_MB) {
    Write-Host "  x Espaco insuficiente (${freeMB}MB). Precisa de ${MIN_DISK_MB}MB." -ForegroundColor Red
    exit 1
}
Write-Host "  OK Espaco em disco: ${freeMB}MB disponivel" -ForegroundColor Green
Write-Host ""

# ================================================================
# 2. Node.js (P10, P16, P19)
# ================================================================
Write-Host "[2/7] Verificando Node.js..." -ForegroundColor Magenta

# P19: Detecta nvm-windows e usa node ativo
$nvmVersion = $null
try { $nvmVersion = nvm version 2>$null } catch {}
if ($nvmVersion) {
    Write-Host "  i nvm-windows detectado" -ForegroundColor Cyan
}

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
            Write-Host "  -> Usando winget..." -ForegroundColor Cyan
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $installed = $true }
        }
    } catch {}

    # P16: Fallback MSI com versão dinâmica
    if (-not $installed) {
        Write-Host "  -> Buscando ultima versao LTS do Node..." -ForegroundColor Cyan
        try {
            # Busca versão LTS mais recente
            $nodeIndex = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing -ErrorAction Stop
            $latestLts = ($nodeIndex | Where-Object { $_.lts -ne $false } | Select-Object -First 1).version
            if (-not $latestLts) { $latestLts = "v22.15.0" }  # Fallback hardcoded
        } catch {
            $latestLts = "v22.15.0"
        }

        Write-Host "  -> Baixando Node.js $latestLts MSI..." -ForegroundColor Cyan
        $msi = "$env:TEMP\node-install.msi"
        try {
            Invoke-WebRequest -Uri "https://nodejs.org/dist/$latestLts/node-$latestLts-x64.msi" -OutFile $msi -UseBasicParsing -ErrorAction Stop
        } catch {
            Write-Host "  x Falha ao baixar Node.js MSI" -ForegroundColor Red
            Write-Host "    $($_.Exception.Message)" -ForegroundColor DarkRed
            Write-Host "  Instale manualmente: https://nodejs.org" -ForegroundColor Yellow
            exit 1
        }

        # P10: Detecta se UAC foi cancelado
        try {
            $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn" -Wait -Verb RunAs -PassThru -ErrorAction Stop
            if ($proc.ExitCode -ne 0) {
                Write-Host "  x Instalacao MSI falhou (codigo: $($proc.ExitCode))" -ForegroundColor Red
                Write-Host "  Provavel: UAC cancelado ou permissao negada" -ForegroundColor Yellow
                Write-Host "  Instale manualmente: https://nodejs.org" -ForegroundColor Yellow
                exit 1
            }
        } catch {
            Write-Host "  x Permissao negada ou UAC cancelado" -ForegroundColor Red
            Write-Host "  Instale Node.js manualmente: https://nodejs.org" -ForegroundColor Yellow
            exit 1
        }
        Remove-Item $msi -Force -ErrorAction SilentlyContinue
    }

    # P22: Recarrega PATH dinamicamente
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

    try {
        $nv = node -v 2>$null
        if ($nv) { Write-Host "  OK Node.js $nv instalado" -ForegroundColor Green }
        else {
            Write-Host "  x Node.js nao detectado apos instalacao" -ForegroundColor Red
            Write-Host "  Feche e reabra o PowerShell, depois rode o setup novamente" -ForegroundColor Yellow
            exit 1
        }
    } catch {
        Write-Host "  x Erro ao detectar Node.js" -ForegroundColor Red
        exit 1
    }
}

# npm
try { npm -v 2>$null | Out-Null } catch { Write-Host "  x npm nao encontrado" -ForegroundColor Red; exit 1 }
Write-Host ""

# ================================================================
# 3. Git
# ================================================================
Write-Host "[3/7] Verificando Git..." -ForegroundColor Magenta

$gitOk = $false
try { git --version 2>$null | Out-Null; $gitOk = $true } catch {}

if (-not $gitOk) {
    Write-Host "  -> Instalando Git..." -ForegroundColor Cyan
    try {
        winget install Git.Git --accept-package-agreements --accept-source-agreements --silent 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            $gitOk = $true
        }
    } catch {}
    if (-not $gitOk) {
        Write-Host "  x Instale Git: https://git-scm.com" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  OK Git instalado" -ForegroundColor Green
Write-Host ""

# ================================================================
# 4. Build Tools (CRÍTICO para better-sqlite3)
# ================================================================
Write-Host "[4/7] Verificando build tools..." -ForegroundColor Magenta

$buildToolsOk = $false
try {
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vsWhere) {
        $vsResult = & $vsWhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($vsResult) { $buildToolsOk = $true }
    }
} catch {}

# Tenta detectar Python (alternativa para alguns módulos)
$pythonOk = $false
try { python --version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $pythonOk = $true } } catch {}

if (-not $buildToolsOk) {
    Write-Host "  ! Visual Studio Build Tools nao encontrado" -ForegroundColor Yellow
    Write-Host "  i Tentando instalar via winget..." -ForegroundColor Cyan
    try {
        winget install Microsoft.VisualStudio.2022.BuildTools --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  OK Build Tools instalado" -ForegroundColor Green
        } else {
            Write-Host "  ! Falha ao instalar Build Tools — npm install pode falhar" -ForegroundColor Yellow
            Write-Host "    Se der erro, instale manualmente:" -ForegroundColor Yellow
            Write-Host "    https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Cyan
        }
    } catch {
        Write-Host "  ! Build Tools nao instalado — better-sqlite3 pode falhar" -ForegroundColor Yellow
    }
} else {
    Write-Host "  OK Visual Studio Build Tools" -ForegroundColor Green
}
Write-Host ""

# ================================================================
# 5. Clonar / Atualizar (P14)
# ================================================================
Write-Host "[5/7] Baixando Zaya Plus..." -ForegroundColor Magenta

if (Test-Path "$InstallDir\.git") {
    Write-Host "  ! Pasta existe. Atualizando..." -ForegroundColor Yellow
    Set-Location $InstallDir
    git pull origin main 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ! git pull falhou — continuando com versao atual" -ForegroundColor Yellow
    }
} else {
    if (-not (Invoke-GitClone $REPO $InstallDir)) {
        exit 1
    }
    if (-not (Test-Path $InstallDir)) {
        Write-Host "  x Pasta nao foi criada apos clone" -ForegroundColor Red
        exit 1
    }
    Set-Location $InstallDir
}
Write-Host "  OK Codigo baixado em $InstallDir" -ForegroundColor Green
Write-Host ""

# ================================================================
# 6. Dependencias (P4 - verificar BUILD do better-sqlite3)
# ================================================================
Write-Host "[6/7] Instalando dependencias (pode demorar 2-5 min)..." -ForegroundColor Magenta

# P17, P21: Flags pra reduzir output e melhorar reliability
$npmArgs = @("install", "--production", "--no-audit", "--no-fund", "--loglevel=error")
& npm $npmArgs 2>&1 | Select-Object -Last 10

# P4: Verifica EXIT CODE do npm install
$npmExitCode = $LASTEXITCODE
if ($npmExitCode -ne 0) {
    Write-Host "  x npm install falhou (exit code: $npmExitCode)" -ForegroundColor Red
    Write-Host "  Causas comuns:" -ForegroundColor Yellow
    Write-Host "    - Sem internet ou rede instavel" -ForegroundColor White
    Write-Host "    - Build tools faltando (better-sqlite3 precisa compilar)" -ForegroundColor White
    Write-Host "  Tente:" -ForegroundColor Yellow
    Write-Host "    cd $InstallDir" -ForegroundColor Cyan
    Write-Host "    npm install" -ForegroundColor Cyan
    exit 1
}

# P4: Verifica se better-sqlite3 compilou corretamente
$sqliteNode = Join-Path $InstallDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"
$sqliteAlt = Join-Path $InstallDir "node_modules\better-sqlite3\prebuilds"
if (-not (Test-Path $sqliteNode) -and -not (Test-Path $sqliteAlt)) {
    Write-Host "  ! better-sqlite3 nao compilou corretamente" -ForegroundColor Yellow
    Write-Host "  -> Tentando rebuild..." -ForegroundColor Cyan
    npm rebuild better-sqlite3 2>&1 | Select-Object -Last 5
    if (-not (Test-Path $sqliteNode) -and -not (Test-Path $sqliteAlt)) {
        Write-Host "  x Rebuild falhou. Instale Visual Studio Build Tools:" -ForegroundColor Red
        Write-Host "    https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Cyan
        Write-Host "  Depois rode: cd $InstallDir; npm rebuild" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  OK better-sqlite3 rebuild OK" -ForegroundColor Green
} else {
    Write-Host "  OK better-sqlite3 compilado" -ForegroundColor Green
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
# 7. Firewall + Licenca + Atalhos
# ================================================================
Write-Host "[7/7] Configurando..." -ForegroundColor Magenta

# P8: Adiciona regra de firewall pra porta 3001
if (-not $SkipFirewall) {
    try {
        $existing = Get-NetFirewallRule -DisplayName "Zaya Plus" -ErrorAction SilentlyContinue
        if (-not $existing) {
            $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Path
            if ($nodePath) {
                New-NetFirewallRule -DisplayName "Zaya Plus" -Direction Inbound -Program $nodePath -Action Allow -Profile Private,Domain -ErrorAction SilentlyContinue | Out-Null
                Write-Host "  OK Regra de firewall adicionada" -ForegroundColor Green
            }
        } else {
            Write-Host "  OK Regra de firewall ja existe" -ForegroundColor Green
        }
    } catch {
        Write-Host "  ! Nao foi possivel adicionar regra de firewall (precisa admin)" -ForegroundColor Yellow
    }
}

# Licenca
if ($Token) {
    Write-Host "  -> Ativando licenca..." -ForegroundColor Cyan
    & node activate.js $Token
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ! Falha ao ativar licenca — voce pode ativar depois" -ForegroundColor Yellow
    } else {
        Write-Host "  OK Licenca ativada" -ForegroundColor Green
    }
} elseif (Test-Path ".license") {
    Write-Host "  OK Licenca ja ativada" -ForegroundColor Green
} else {
    Write-Host "  ! Nenhum token. Ative pelo dashboard ou: node activate.js SEU-TOKEN" -ForegroundColor Yellow
}

# CMD shortcut
$cmdDir = Join-Path $env:USERPROFILE "AppData\Local\Microsoft\WindowsApps"
if (Test-Path $cmdDir) {
    $bp = Join-Path $cmdDir "zaya.cmd"
    [System.IO.File]::WriteAllText($bp, "@echo off`r`ncd /d `"$InstallDir`" && npm start")
    Write-Host "  OK Atalho 'zaya' criado (CMD)" -ForegroundColor Green
}

# PowerShell profile
try {
    $pd = Split-Path $PROFILE -Parent
    if (-not (Test-Path $pd)) { New-Item -ItemType Directory -Path $pd -Force | Out-Null }
    if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
    $pc = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if (-not $pc -or $pc -notmatch "function zaya") {
        $fn = "function zaya { Set-Location '$InstallDir'; npm start }"
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
Write-Host "    powershell -File `"$InstallDir\uninstall.ps1`"" -ForegroundColor Cyan
Write-Host ""
Write-Host "  ==========================================" -ForegroundColor DarkGray
Write-Host ""

# P20, P23: NonInteractive não pergunta nem inicia
if ($NonInteractive) {
    exit 0
}

$start = Read-Host "  Iniciar agora? (s/n) [s]"
if (-not $start -or $start -match "^[sS]") {
    Write-Host ""
    Write-Host "  Iniciando Zaya Plus..." -ForegroundColor Magenta
    Write-Host ""
    npm start
}
