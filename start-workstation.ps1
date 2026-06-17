# Starts the Finance Oracle workstation with one command.
#
#   .\start-workstation.ps1            starts backend + frontend, opens browser
#   .\start-workstation.ps1 -NoBrowser starts servers only
#
# Idempotent: anything already running is left alone, anything down is
# started. Safe to run any time the app "isn't loading".

param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Test-PortOpen([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne(300)) {
      $client.EndConnect($async)
      return $true
    }
    return $false
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-ForPort([int]$Port, [string]$Label, [int]$TimeoutSeconds = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortOpen $Port) {
      Write-Host "  $Label is up on port $Port" -ForegroundColor Green
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "  $Label did not come up on port $Port within ${TimeoutSeconds}s" -ForegroundColor Red
  return $false
}

Write-Host "Finance Oracle Workstation launcher" -ForegroundColor Cyan

# --- Backend cache server (port 8787) ---------------------------------------
if (Test-PortOpen 8787) {
  Write-Host "  Backend already running on 8787" -ForegroundColor Green
} else {
  Write-Host "  Starting backend cache server..."
  Start-Process -FilePath 'cmd' `
    -ArgumentList '/c', 'dart run tool/backend_cache_server.dart --port 8787 --web-root build/web' `
    -WorkingDirectory $root -WindowStyle Minimized
}

# --- Vite dev server (port 1420) ---------------------------------------------
if (Test-PortOpen 1420) {
  Write-Host "  Frontend already running on 1420" -ForegroundColor Green
} else {
  Write-Host "  Starting Vite dev server..."
  Start-Process -FilePath 'cmd' `
    -ArgumentList '/c', 'npm run dev' `
    -WorkingDirectory (Join-Path $root 'desktop-js') -WindowStyle Minimized
}

$backendUp = Wait-ForPort 8787 'Backend'
$frontendUp = Wait-ForPort 1420 'Frontend'

if ($backendUp -and $frontendUp) {
  Write-Host ""
  Write-Host "Workstation ready: http://127.0.0.1:1420" -ForegroundColor Cyan
  Write-Host "(The backend warms the symbol universe in the background;"
  Write-Host " the UI fills in automatically over the first few minutes.)"
  if (-not $NoBrowser) {
    Start-Process 'http://127.0.0.1:1420'
  }
} else {
  Write-Host ""
  Write-Host "Something failed to start. Check the minimized console windows for errors." -ForegroundColor Red
  exit 1
}
