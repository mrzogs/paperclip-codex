param()

$ErrorActionPreference = 'Stop'

$currentScripts = [IO.Path]::GetFullPath($PSScriptRoot)
$operationalScripts = [IO.Path]::GetFullPath('D:\Paperclip-codex\scripts')
$sourceRoot = Split-Path -Parent $PSScriptRoot
if ([StringComparer]::OrdinalIgnoreCase.Equals($currentScripts,$operationalScripts) -or
    -not (Test-Path -LiteralPath (Join-Path $sourceRoot '.git'))) {
  . (Join-Path $PSScriptRoot 'ocean-deployment.ps1')
  $Dashboard = (Get-OceanDeployment).Dashboard
} else {
  $Dashboard = Join-Path $sourceRoot 'website\ocean-trading\dashboard'
}
$Node = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Dashboard 'logs'
$Monitor = Join-Path $Dashboard 'monitor.mjs'

function Get-MonitorProcesses {
  $escaped = [regex]::Escape($Monitor)
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.CommandLine -as [string]) -match $escaped -or
      ($_.CommandLine -as [string]) -match 'node(\.exe)?"?\s+monitor\.mjs'
    }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path -LiteralPath $Node)) {
  throw "node.exe not found: $Node"
}
if (-not (Test-Path -LiteralPath $Monitor)) {
  throw "Ocean monitor not found: $Monitor"
}

$existing = @(Get-MonitorProcesses)
if ($existing.Count) {
  Write-Output "Ocean monitor already running with PID(s): $($existing.ProcessId -join ', ')."
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$log = Join-Path $LogDir "monitor-supervised-$stamp.log"
"$(Get-Date -Format o) Starting Ocean monitor supervised service." | Out-File -LiteralPath $log -Encoding utf8

Set-Location -LiteralPath $Dashboard
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $Node $Monitor *>> $log
  $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}

"$(Get-Date -Format o) Ocean monitor supervised service exited with code $exitCode." | Out-File -LiteralPath $log -Append -Encoding utf8
exit $exitCode
