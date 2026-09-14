param([int]$Port = 19222, [string]$InstallDir = '')
$ErrorActionPreference = 'Stop'
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }

if (-not $InstallDir -and $env:ZCODE_INSTALL_DIR) { $InstallDir = $env:ZCODE_INSTALL_DIR }
if (-not $InstallDir) {
  $resolver = Join-Path $PSScriptRoot 'zcode-install.mjs'
  if (-not (Test-Path -LiteralPath $resolver)) { throw "ZCode install resolver not found: $resolver" }
  $resolved = (& node $resolver --path 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $resolved) { throw $resolved }
  $InstallDir = $resolved
}

$executable = Join-Path $InstallDir 'ZCode.exe'
if (-not (Test-Path -LiteralPath $executable) -or -not (Test-Path -LiteralPath (Join-Path $InstallDir 'resources\app.asar'))) {
  throw "ZCode installation is invalid: $InstallDir. Set ZCODE_INSTALL_DIR or pass -InstallDir with the installation root."
}
$running = Get-Process ZCode -ErrorAction SilentlyContinue
if ($running) { throw 'ZCode is already running. Finish its tasks and close it normally before enabling the desktop bridge. No processes were stopped.' }
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $Port is already in use." }
Start-Process -FilePath $executable -ArgumentList @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$Port") -WindowStyle Hidden
Write-Output "ZCode launched from $InstallDir. Run npm run doctor to verify http://127.0.0.1:$Port."
