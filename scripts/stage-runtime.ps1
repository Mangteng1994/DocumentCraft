# Stage the runtime DLLs that the editor exe loads but Windows does not provide.
# The gnullvm build links WebView2Loader.dll and libunwind.dll dynamically, so the
# installer must carry them next to the exe. Output goes to out/runtime/.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root "editor\src-tauri"
$target = Join-Path $root "out\runtime"
New-Item -ItemType Directory -Force $target | Out-Null

# WebView2Loader.dll is produced by webview2-com-sys during the cargo build.
$loader = Get-ChildItem (Join-Path $tauri "target\release\build") -Recurse -Filter WebView2Loader.dll -ErrorAction SilentlyContinue |
    Where-Object { $_.Directory.Name -eq "x64" } | Select-Object -First 1
if (-not $loader) {
    Push-Location $tauri
    cargo build --release
    Pop-Location
    $loader = Get-ChildItem (Join-Path $tauri "target\release\build") -Recurse -Filter WebView2Loader.dll |
        Where-Object { $_.Directory.Name -eq "x64" } | Select-Object -First 1
}
if (-not $loader) { throw "WebView2Loader.dll (x64) not found" }
Copy-Item $loader.FullName (Join-Path $target "WebView2Loader.dll") -Force

# libunwind.dll comes from the LLVM toolchain that links the exe.
$unwind = Get-Command libunwind.dll -ErrorAction SilentlyContinue
if (-not $unwind) { throw "libunwind.dll not found on PATH (LLVM toolchain bin)" }
Copy-Item $unwind.Source (Join-Path $target "libunwind.dll") -Force
Write-Host "staged to $target"
