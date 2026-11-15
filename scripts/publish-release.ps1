# Publish the installer built by `npm run bundle` as a GitHub Release that installed copies can update to.
#
# 1. Reads the version from editor/src-tauri/tauri.conf.json.
# 2. Builds out/release/latest.json (the manifest the updater plugin downloads) from the signed installer.
# 3. Creates the GitHub Release vX.Y.Z and uploads the installer and latest.json with the gh CLI.
#
# Run with -DryRun first: it only writes latest.json and prints what would be uploaded.
# Publishing is public and the updater of every installed copy will pick it up, so the script asks
# for confirmation before touching GitHub unless -Yes is given.
param(
    [string]$Notes = "",
    [string]$Repo = "Mangteng1994/DocumentCraft",
    [switch]$DryRun,
    [switch]$Yes
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content (Join-Path $root "editor\src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$version = $config.version
$tag = "v$version"

$bundle = Join-Path $root "editor\src-tauri\target\release\bundle\nsis"
$installerName = "DocumentCraft_${version}_x64-setup.exe"
$installer = Join-Path $bundle $installerName
$signatureFile = "$installer.sig"
foreach ($path in $installer, $signatureFile) {
    if (-not (Test-Path $path)) {
        Write-Error "Missing $path. Run 'npm run bundle' in editor/ first (it needs the updater signing key)."
        exit 1
    }
}

# The release must be reachable anonymously at this exact URL, which is also what latest.json points to.
$downloadUrl = "https://github.com/$Repo/releases/download/$tag/$installerName"
$manifest = [ordered]@{
    version  = $version
    notes    = $Notes
    pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = (Get-Content $signatureFile -Raw).Trim()
            url       = $downloadUrl
        }
    }
}
$outDir = Join-Path $root "out\release"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$manifestPath = Join-Path $outDir "latest.json"
# No BOM: the updater plugin parses this file as plain UTF-8 JSON.
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote $manifestPath"
Write-Host "Release $tag on $Repo would upload: $installerName, latest.json"
if ($DryRun) {
    exit 0
}

if (-not $Yes) {
    $answer = Read-Host "Publish release $tag to https://github.com/$Repo now? (y/N)"
    if ($answer -ne "y") {
        Write-Host "Cancelled."
        exit 1
    }
}

# Pre-releases are skipped by /releases/latest/, so never pass --prerelease for a version meant for users.
gh release create $tag $installer $manifestPath --repo $Repo --title "DocumentCraft $version" --notes $Notes
exit $LASTEXITCODE
