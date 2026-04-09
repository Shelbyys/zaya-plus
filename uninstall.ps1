# ================================================================
# ZAYA PLUS - Desinstalador (Windows PowerShell)
# Uso: powershell -File ~/zaya-plus/uninstall.ps1
# ================================================================

$INSTALL_DIR = "$env:USERPROFILE\zaya-plus"

Write-Host ""
Write-Host "  ZAYA PLUS - Desinstalador" -ForegroundColor Magenta
Write-Host ""
Write-Host "  Isso vai remover:" -ForegroundColor White
Write-Host "  * Pasta $INSTALL_DIR" -ForegroundColor Yellow
Write-Host "  * Atalhos 'zaya' (CMD e PowerShell)" -ForegroundColor Yellow
Write-Host "  * Sessoes WhatsApp locais" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Seus dados (.env, banco de dados) serao perdidos!" -ForegroundColor Red
Write-Host ""

$confirm = Read-Host "  Tem certeza? (s/n) [n]"
if ($confirm -notmatch "^[sS]") {
    Write-Host "  Cancelado." -ForegroundColor Green
    exit 0
}

Write-Host ""

# ================================================================
# 1. Parar servidor
# ================================================================
Write-Host "[1/5] Parando servidor..." -ForegroundColor Magenta

try {
    $port = 3001
    $proc = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) {
        Stop-Process -Id $proc.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "  OK Servidor parado" -ForegroundColor Green
    } else {
        Write-Host "  ~ Servidor nao estava rodando" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ~ Nao foi possivel verificar servidor" -ForegroundColor Yellow
}

# ================================================================
# 2. Desativar licenca
# ================================================================
Write-Host "[2/5] Desativando licenca..." -ForegroundColor Magenta

$licFile = Join-Path $INSTALL_DIR ".license"
if (Test-Path $licFile) {
    try {
        $lic = Get-Content $licFile -Raw | ConvertFrom-Json
        if ($lic.token) {
            $body = @{ token = $lic.token } | ConvertTo-Json
            Invoke-RestMethod -Uri "https://zaya-plus.onrender.com/api/license/deactivate" -Method POST -Body $body -ContentType "application/json" -ErrorAction SilentlyContinue | Out-Null
            Write-Host "  OK Licenca desativada" -ForegroundColor Green
        }
    } catch {
        Write-Host "  ~ Nao foi possivel desativar online" -ForegroundColor Yellow
    }
} else {
    Write-Host "  ~ Nenhuma licenca encontrada" -ForegroundColor Yellow
}

# ================================================================
# 3. Remover atalhos
# ================================================================
Write-Host "[3/5] Removendo atalhos..." -ForegroundColor Magenta

# CMD
$cmdZaya = Join-Path $env:USERPROFILE "AppData\Local\Microsoft\WindowsApps\zaya.cmd"
if (Test-Path $cmdZaya) { Remove-Item $cmdZaya -Force }

# PowerShell profile
try {
    if (Test-Path $PROFILE) {
        $content = Get-Content $PROFILE -Raw
        $content = $content -replace "(?m)^# Zaya Plus\r?\n", ""
        $content = $content -replace "(?m)^function zaya \{[^\}]*\}\r?\n?", ""
        Set-Content $PROFILE -Value $content.Trim()
    }
} catch {}

Write-Host "  OK Atalhos removidos" -ForegroundColor Green

# ================================================================
# 4. Backup opcional
# ================================================================
Write-Host "[4/5] Backup..." -ForegroundColor Magenta

$backup = Read-Host "  Salvar backup do .env e banco de dados? (s/n) [s]"
if (-not $backup -or $backup -match "^[sS]") {
    $ts = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupDir = "$env:USERPROFILE\zaya-backup-$ts"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    $filesToBackup = @(".env", "zaya.db", ".license")
    foreach ($f in $filesToBackup) {
        $src = Join-Path $INSTALL_DIR $f
        if (Test-Path $src) { Copy-Item $src $backupDir }
    }
    $dataDir = Join-Path $INSTALL_DIR "data"
    if (Test-Path $dataDir) { Copy-Item $dataDir $backupDir -Recurse }

    Write-Host "  OK Backup salvo em $backupDir" -ForegroundColor Green
}

# ================================================================
# 5. Remover pasta
# ================================================================
Write-Host "[5/5] Removendo arquivos..." -ForegroundColor Magenta

Set-Location $env:USERPROFILE
if (Test-Path $INSTALL_DIR) {
    Remove-Item $INSTALL_DIR -Recurse -Force
    Write-Host "  OK Pasta removida" -ForegroundColor Green
}

Write-Host ""
Write-Host "  OK Zaya Plus desinstalada com sucesso!" -ForegroundColor Green
if ($backupDir) { Write-Host "  Backup em: $backupDir" -ForegroundColor Cyan }
Write-Host ""
