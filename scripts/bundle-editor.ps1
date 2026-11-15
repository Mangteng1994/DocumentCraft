# Build the editor installer with the MSVC Rust toolchain.
# The MSVC build links the WebView2 loader and the C runtime statically, so the installer
# needs no extra DLLs, and the exe is flagged by antivirus far less often than the gnullvm build.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$editor = Join-Path $root "editor"
$release = Join-Path $editor "src-tauri\target\release"

# rustup's cargo shim must come first, otherwise another Rust install earlier on PATH is used.
$env:PATH = (Join-Path $env:USERPROFILE ".cargo\bin") + ";" + $env:PATH
$env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-msvc"

# Stale resource copies left by earlier builds make tauri-build fail with "file in use".
foreach ($name in "DocumentCraft-cli.exe", "builtin-template.docx", "WebView2Loader.dll", "libunwind.dll") {
    Remove-Item (Join-Path $release $name) -Force -ErrorAction SilentlyContinue
}

# The updater signs the installer with a minisign private key. Without it the build would
# produce an installer that installed copies can never update to, so stop early.
# Generate once with: npx tauri signer generate -w $env:USERPROFILE\.tauri\documentcraft.key
# `tauri build` reads TAURI_SIGNING_PRIVATE_KEY (key text or a path to the key file). The *_PATH variant
# only belongs to `tauri signer sign` and is ignored by the bundler ("public key found, but no private key").
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $defaultKey = Join-Path $env:USERPROFILE ".tauri\documentcraft.key"
    if ($env:TAURI_SIGNING_PRIVATE_KEY_PATH -and (Test-Path $env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
        $env:TAURI_SIGNING_PRIVATE_KEY = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
    } elseif (Test-Path $defaultKey) {
        $env:TAURI_SIGNING_PRIVATE_KEY = $defaultKey
    } else {
        Write-Error "No updater signing key. Set TAURI_SIGNING_PRIVATE_KEY or create $defaultKey (see README)."
        exit 1
    }
}

Push-Location $editor
npx tauri build --config src-tauri/tauri.bundle.conf.json
$code = $LASTEXITCODE
Pop-Location
exit $code
