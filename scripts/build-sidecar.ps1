param(
    [string]$Python = (Join-Path $PSScriptRoot '..\.venv\Scripts\python.exe'),
    [string]$Pandoc = (Get-Command pandoc.exe -ErrorAction Stop).Source,
    [string]$Output = 'out\sidecar'
)

# Build the docflow CLI from core/. The reading editor runs it as a sidecar and its installer bundles this EXE.
# All build output goes to out/ (see AGENTS.md).
$ErrorActionPreference = 'Stop'
$pythonExe = (Get-Command $Python -ErrorAction Stop).Source
$pandocExe = (Resolve-Path -LiteralPath $Pandoc).Path
if ((Split-Path -Leaf $pandocExe) -ne 'pandoc.exe') {
    throw 'Select pandoc.exe.'
}
$pandocDir = Split-Path -Parent $pandocExe
$copyright = Join-Path $pandocDir 'COPYRIGHT.txt'
$copying = Join-Path $pandocDir 'COPYING.rtf'
# PyInstaller resolves bundled resources relative to its generated spec directory.
$figureSkill = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\core\src\documentcraft\figure_skill.md')).Path

# Notes storage needs _sqlite3. Conda Pythons keep sqlite3.dll in Library\bin, which PyInstaller
# does not collect, and the EXE then fails at startup with "DLL load failed". Bundle it explicitly.
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less UTF-8 as the ANSI code page.
$basePrefix = & $pythonExe -c 'import sys; print(sys.base_prefix)'
$sqliteCandidates = @(
    (Join-Path $basePrefix 'DLLs\sqlite3.dll'),
    (Join-Path $basePrefix 'Library\bin\sqlite3.dll')
)
$sqliteDll = $sqliteCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $sqliteDll) {
    throw "sqlite3.dll not found under $basePrefix."
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
    $buildArgs = @(
        '--noconfirm', '--onefile', '--noupx', '--console',
        '--name', 'DocumentCraft-cli', '--distpath', $Output,
        '--paths', 'core\src', '--specpath', 'out\pyinstaller', '--workpath', 'out\pyinstaller',
        '--collect-data', 'docx', '--collect-data', 'docxcompose', '--collect-data', 'babel',
        '--add-data', "${figureSkill}:documentcraft",
        '--add-binary', "${pandocExe}:engine", '--add-data', "${copyright}:engine", '--add-data', "${copying}:engine",
        '--add-binary', "${sqliteDll}:.",
        'core\src\documentcraft\__main__.py'
    )
    & $pythonExe -m PyInstaller @buildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "EXE build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
