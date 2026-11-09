# Downloads a portable Node.js (v22 LTS) into bin\node for Elixir. No admin rights needed.
# Used by start.bat when Node.js isn't installed. The download is checked against nodejs.org's SHA-256 list.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # much faster downloads in Windows PowerShell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'bin\node'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$base = 'https://nodejs.org/dist/latest-v22.x/'
try {
  $sums = (Invoke-WebRequest -UseBasicParsing ($base + 'SHASUMS256.txt')).Content
  $line = ($sums -split "`n") | Where-Object { $_ -match ("node-v[\d.]+-win-" + $arch + "\.zip\s*$") } | Select-Object -First 1
  if (-not $line) { throw "No Node.js download found for Windows $arch" }
  $parts = $line.Trim() -split '\s+'
  $hash = $parts[0]; $file = $parts[-1]
  $tmp = Join-Path $env:TEMP $file
  Write-Host "  Downloading $file ..."
  Invoke-WebRequest -UseBasicParsing ($base + $file) -OutFile $tmp
  if ((Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) { Remove-Item $tmp -Force; throw 'The download was corrupted (checksum mismatch). Run start.bat again.' }
  Write-Host '  Unpacking ...'
  $unz = Join-Path $env:TEMP ('elixir-node-' + [guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $tmp -DestinationPath $unz -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'bin') | Out-Null
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item (Join-Path $unz ($file -replace '\.zip$', '')) $dest
  Remove-Item $tmp -Force
  Remove-Item $unz -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host '  Node.js is ready (bin\node). Starting Elixir...'
  Write-Host ''
  exit 0
} catch {
  Write-Host ('  ' + $_.Exception.Message)
  exit 1
}
