$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

flutter build windows --release `
  --dart-define=ORACLE_DATA_MODE=alpha-vantage

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host ''
Write-Host 'Built Finance Oracle desktop app:'
Write-Host (Join-Path $repoRoot 'build\windows\x64\runner\Release\FinanceOracle.exe')
