$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

flutter run -d windows `
  --dart-define=ORACLE_DATA_MODE=alpha-vantage

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
