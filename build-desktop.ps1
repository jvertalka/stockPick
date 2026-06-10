# Builds the installable Finance Oracle desktop app (Tauri + backend sidecar).
#
#   .\build-desktop.ps1          full build -> NSIS installer + portable exe
#
# Steps:
#   1. Compile the Dart backend to a self-contained native exe (sidecar)
#   2. Build the frontend + Tauri shell (tauri build runs `npm run build`)
#
# Output:
#   desktop-js\src-tauri\target\release\finance-oracle-workstation.exe
#   desktop-js\src-tauri\target\release\bundle\nsis\*.exe   (installer)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Write-Host "1/2  Compiling backend sidecar (dart compile exe)..." -ForegroundColor Cyan
$binDir = Join-Path $root 'desktop-js\src-tauri\binaries'
New-Item -ItemType Directory -Force $binDir | Out-Null
& dart compile exe (Join-Path $root 'tool\backend_cache_server.dart') `
  -o (Join-Path $binDir 'backend-cache-x86_64-pc-windows-msvc.exe')
if ($LASTEXITCODE -ne 0) { throw "dart compile failed" }

Write-Host "2/2  Building Tauri app (this compiles Rust; first run takes several minutes)..." -ForegroundColor Cyan
Push-Location (Join-Path $root 'desktop-js')
try {
  & npx tauri build
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Done. Artifacts:" -ForegroundColor Green
Get-ChildItem (Join-Path $root 'desktop-js\src-tauri\target\release\bundle\nsis') -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host "  $($_.FullName)" }
Write-Host "  $(Join-Path $root 'desktop-js\src-tauri\target\release\finance-oracle-workstation.exe')"
