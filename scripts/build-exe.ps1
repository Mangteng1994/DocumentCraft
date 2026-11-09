param(
    [string]$Python = (Join-Path $PSScriptRoot '..\.venv\Scripts\python.exe'),
    [string]$Pandoc = (Get-Command pandoc.exe -ErrorAction Stop).Source,
    [switch]$Console
)

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
    # GUI and CLI builds use separate Windows subsystems and output directories.
    $entryArgs = @('--windowed', '--name', 'DocumentCraft', '--distpath', 'dist', 'src/documentcraft/gui.py')
    if ($Console) {
        $entryArgs = @(
            '--console', '--name', 'DocumentCraft-cli', '--distpath', 'dist-cli',
            'src/documentcraft/__main__.py'
        )
    }
    $buildArgs = @(
        '--noconfirm', '--onefile', '--noupx',
        '--paths', 'src', '--specpath', 'build', '--workpath', 'build',
        '--collect-data', 'docx', '--collect-data', 'docxcompose', '--collect-data', 'babel',
        '--add-binary', "${pandocExe}:engine", '--add-data', "${copyright}:engine", '--add-data', "${copying}:engine"
    )
    $buildArgs += $entryArgs
    & $pythonExe -m PyInstaller @buildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "EXE build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
