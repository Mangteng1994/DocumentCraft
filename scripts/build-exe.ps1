param(
    [string]$Python = (Join-Path $PSScriptRoot '..\.venv\Scripts\python.exe'),
    [string]$Pandoc = (Get-Command pandoc.exe -ErrorAction Stop).Source,
    [string]$Output = 'dist-cli'
)

# 打包 docflow 命令行版。阅读编辑器以它作为 sidecar，后续 Tauri 安装包也从这里取 EXE。
$ErrorActionPreference = 'Stop'
$pythonExe = (Get-Command $Python -ErrorAction Stop).Source
$pandocExe = (Resolve-Path -LiteralPath $Pandoc).Path
if ((Split-Path -Leaf $pandocExe) -ne 'pandoc.exe') {
    throw 'Select pandoc.exe.'
}
$pandocDir = Split-Path -Parent $pandocExe
$copyright = Join-Path $pandocDir 'COPYRIGHT.txt'
$copying = Join-Path $pandocDir 'COPYING.rtf'

Push-Location (Join-Path $PSScriptRoot '..')
try {
    $buildArgs = @(
        '--noconfirm', '--onefile', '--noupx', '--console',
        '--name', 'DocumentCraft-cli', '--distpath', $Output,
        '--paths', 'src', '--specpath', 'build', '--workpath', 'build',
        '--collect-data', 'docx', '--collect-data', 'docxcompose', '--collect-data', 'babel',
        '--add-binary', "${pandocExe}:engine", '--add-data', "${copyright}:engine", '--add-data', "${copying}:engine",
        'src/documentcraft/__main__.py'
    )
    & $pythonExe -m PyInstaller @buildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "EXE build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
