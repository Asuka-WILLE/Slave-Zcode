param([int]$Port = 19222, [string]$InstallDir = 'C:\Program Files\ZCode')
$ErrorActionPreference = 'Stop'
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
$executable = Join-Path $InstallDir 'ZCode.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw "ZCode not found: $executable" }
$running = Get-Process ZCode -ErrorAction SilentlyContinue
if ($running) { throw 'ZCode is already running. Finish its tasks and close it normally before enabling the desktop bridge. No processes were stopped.' }
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port is already in use." }
Start-Process -FilePath $executable -ArgumentList @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$Port") -WindowStyle Hidden
Write-Output "ZCode launched. Run npm run doctor to verify http://127.0.0.1:$Port."
