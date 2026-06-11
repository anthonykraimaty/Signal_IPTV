# Launch backend + frontend in two new PowerShell windows.
$root = $PSScriptRoot

Write-Host "Starting SIGNAL re-stream (backend :4000, frontend :5173)..." -ForegroundColor Yellow

Start-Process powershell -ArgumentList @(
  '-NoExit', '-Command',
  "Set-Location '$root\backend'; if (-not (Test-Path node_modules)) { npm install }; npm run dev"
)

Start-Process powershell -ArgumentList @(
  '-NoExit', '-Command',
  "Set-Location '$root\frontend'; if (-not (Test-Path node_modules)) { npm install }; npm run dev"
)

Write-Host "Opening http://localhost:5173 once the frontend is up." -ForegroundColor Green
