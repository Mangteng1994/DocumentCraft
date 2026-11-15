# One-command release build: checks the tools, prepares the Python venv, builds the sidecar and the signed installer.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
#
# It does NOT publish anything. After it succeeds run scripts\publish-release.ps1 -DryRun, then without -DryRun.
# The updater signing key password is asked here with hidden input and only lives in this process, so
# characters such as ! $ % ^ & are safe and nothing stays in the shell afterwards.
# Add -SkipSidecar to reuse out\sidecar from an earlier run when only the Rust/Tauri step needs a retry.
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less UTF-8 as the ANSI code page.
param([switch]$SkipSidecar)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Fail([string]$message) {
    Write-Host ""
    Write-Host "STOP: $message" -ForegroundColor Red
    exit 1
}

Write-Host "[1/5] Checking tools..."
if (-not (Get-Command pandoc.exe -ErrorAction SilentlyContinue)) {
    Fail "pandoc.exe not found. Install it (winget install --id JohnMacFarlane.Pandoc), then open a NEW terminal and rerun."
}
$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) {
    Fail "python.exe not found. Install Python 3.10+ with 'Add python.exe to PATH' ticked, then open a NEW terminal and rerun."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "npm not found."
}
$keyFile = Join-Path $env:USERPROFILE ".tauri\documentcraft.key"
if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and -not $env:TAURI_SIGNING_PRIVATE_KEY_PATH -and -not (Test-Path $keyFile)) {
    Fail "Updater private key not found at $keyFile."
}

Write-Host "[2/5] Preparing the Python venv (first run only)..."
$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    & $python.Source -m venv (Join-Path $root ".venv")
    if ($LASTEXITCODE -ne 0) { Fail "Creating .venv failed." }
}
& $venvPython -m pip install --quiet -e "$root\core[build-exe]"
if ($LASTEXITCODE -ne 0) { Fail "pip install failed." }

if ($SkipSidecar) {
    $sidecar = Join-Path $root "out\sidecar\DocumentCraft-cli.exe"
    if (-not (Test-Path $sidecar)) { Fail "-SkipSidecar given but $sidecar does not exist." }
    Write-Host "[3/5] Skipping the sidecar build, reusing $sidecar"
} else {
    Write-Host "[3/5] Building the docflow sidecar (slow, PyInstaller)..."
    & (Join-Path $PSScriptRoot "build-sidecar.ps1")
    if ($LASTEXITCODE -ne 0) { Fail "build-sidecar.ps1 failed." }
}

Write-Host "[4/5] Signing key password"
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    $secure = Read-Host "Updater signing key password (input is hidden)" -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

Write-Host "[5/5] Building the signed installer (slow, first Rust build)..."
Push-Location (Join-Path $root "editor")
try {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }
    npm run bundle
    if ($LASTEXITCODE -ne 0) { Fail "npm run bundle failed." }
}
finally {
    Pop-Location
}

$bundle = Join-Path $root "editor\src-tauri\target\release\bundle\nsis"
Write-Host ""
Write-Host "Done. Output in $bundle :" -ForegroundColor Green
Get-ChildItem $bundle -Filter "*setup*" | ForEach-Object { Write-Host ("  " + $_.Name + "  " + [math]::Round($_.Length / 1MB, 1) + " MB") }
Write-Host "Next: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-release.ps1 -DryRun"
