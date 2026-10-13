param(
  [string]$ListenUrl = 'ws://127.0.0.1:8793',
  [int]$Port = 8793
)

$ErrorActionPreference = 'Stop'

$LogDir = 'D:\Paperclip-codex\.paperclip-home\service-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-PortListening([int]$TargetPort) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $TargetPort -ErrorAction SilentlyContinue)
}

function Get-CodexExe {
  if ($env:CODEX_EXE -and (Test-Path -LiteralPath $env:CODEX_EXE)) {
    return (Resolve-Path -LiteralPath $env:CODEX_EXE).Path
  }

  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  $codexBinRoot = Join-Path $localAppData 'OpenAI\Codex\bin'
  if (Test-Path -LiteralPath $codexBinRoot) {
    $candidate = Get-ChildItem -LiteralPath $codexBinRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1

    if ($candidate) { return $candidate }
  }

  $pathCommand = Get-Command codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pathCommand -and $pathCommand.Source -and (Test-Path -LiteralPath $pathCommand.Source)) {
    return $pathCommand.Source
  }

  throw 'Could not find codex.exe. Set CODEX_EXE to the full Codex binary path and retry.'
}

if (Test-PortListening $Port) {
  Write-Output "Codex app-server already listening on port $Port."
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$log = Join-Path $LogDir "codex-bridge-$stamp.log"
$codexExe = Get-CodexExe
"$(Get-Date -Format o) Starting Codex bridge supervised service from $codexExe." | Out-File -LiteralPath $log -Encoding utf8

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $codexExe app-server --listen $ListenUrl *>> $log
  $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}

"$(Get-Date -Format o) Codex bridge supervised service exited with code $exitCode." | Out-File -LiteralPath $log -Append -Encoding utf8
exit $exitCode
