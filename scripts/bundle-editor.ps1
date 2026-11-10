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

Push-Location $editor
npx tauri build --config src-tauri/tauri.bundle.conf.json
$code = $LASTEXITCODE
Pop-Location
exit $code
