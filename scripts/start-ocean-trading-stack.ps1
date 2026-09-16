param(
  [switch]$NoMonitor,
  [switch]$WebsiteOnly,
  [switch]$RestartWebsite,
  [switch]$DisableWorkflow,
  [switch]$EnableWorkflow
)

$ErrorActionPreference = 'Stop'
if ($WebsiteOnly) {
  & "$PSScriptRoot\start-ocean-website.ps1" -Restart:$RestartWebsite -DisableWorkflow:$DisableWorkflow -EnableWorkflow:$EnableWorkflow -PreserveMonitorState
  return
}
if ($RestartWebsite -or $DisableWorkflow -or $EnableWorkflow) { throw 'Website lifecycle switches require -WebsiteOnly; no stack-wide restart is implicit.' }
$PaperclipRoot = 'D:\Paperclip-codex'
$DashboardRoot = 'D:\Paperclip-codex\website\ocean-trading\dashboard'
$PaperclipHome = 'D:\Paperclip-codex\.paperclip-home'
$PaperclipConfigPath = Join-Path $PaperclipHome 'instances\default\config.json'
$Node = 'C:\Program Files\nodejs\node.exe'
$CorepackCmd = 'C:\Program Files\nodejs\corepack.cmd'
$LogsDir = Join-Path $DashboardRoot 'logs'
$CodexBridgeScript = Join-Path $PaperclipRoot 'scripts\start-codex-app-server.ps1'
New-Item -ItemType Directory -Force -Path $PaperclipHome, $LogsDir | Out-Null

if (-not (Test-Path -LiteralPath $PaperclipConfigPath)) {
  throw "Paperclip config missing: $PaperclipConfigPath"
}
$PaperclipConfig = Get-Content -LiteralPath $PaperclipConfigPath -Raw | ConvertFrom-Json
$PostgresPort = [int]$PaperclipConfig.database.embeddedPostgresPort

function Test-HttpOk([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 5
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Test-PortListening([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Get-CommandLineProcess([string]$Pattern) {
  Get-CimInstance Win32_Process | Where-Object { ($_.CommandLine -as [string]) -match $Pattern }
}

function Start-CodexBridgeIfNeeded {
  if (-not (Test-Path -LiteralPath $CodexBridgeScript)) {
    Write-Warning "Codex app-server launcher missing: $CodexBridgeScript"
    return
  }

  & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File $CodexBridgeScript
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Codex app-server launcher exited with $LASTEXITCODE."
  }
}

function Start-PaperclipIfNeeded {
  if ((Test-HttpOk 'http://127.0.0.1:3100/api/health') -and (Test-PortListening $PostgresPort)) {
    Write-Output 'Paperclip/Postgres already running.'
    return
  }

  $log = Join-Path $PaperclipHome 'paperclip-restart.log'
  $command = "Set-Location '$PaperclipRoot'; & '$CorepackCmd' pnpm paperclipai run --data-dir '$PaperclipHome' --bind loopback *> '$log'"
  Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',$command) -WindowStyle Hidden
  Write-Output 'Started Paperclip/Postgres launcher.'
}

function Start-OceanServerIfNeeded {
  if (Test-HttpOk 'http://127.0.0.1:3102/') {
    Write-Output 'Ocean Trading website already running.'
    return
  }

  & "$PSScriptRoot\start-ocean-website.ps1"
  Write-Output 'Started Ocean Trading website.'
}

function Start-OceanMonitorIfNeeded {
  if ($NoMonitor) { return }
  $monitorPattern = [regex]::Escape('D:\Paperclip-codex\website\ocean-trading\dashboard\monitor.mjs')
  $shortMonitorPattern = 'node(\.exe)?"?\s+monitor\.mjs'
  $existing = @(Get-CommandLineProcess $monitorPattern) + @(Get-CommandLineProcess $shortMonitorPattern)
  if ($existing.Count -gt 0) {
    Write-Output 'Ocean monitor already running.'
    return
  }

  Start-Process -FilePath $Node -ArgumentList @('D:\Paperclip-codex\website\ocean-trading\dashboard\monitor.mjs') -WorkingDirectory $DashboardRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogsDir 'monitor-start.out.log') -RedirectStandardError (Join-Path $LogsDir 'monitor-start.err.log')
  Write-Output 'Started Ocean monitor.'
}

Start-CodexBridgeIfNeeded
Start-PaperclipIfNeeded
$paperclipDeadline = (Get-Date).AddMinutes(3)
do {
  $paperclipReady = (Test-HttpOk 'http://127.0.0.1:3100/api/health') -and (Test-PortListening $PostgresPort)
  if (-not $paperclipReady) { Start-Sleep -Seconds 2 }
} while (-not $paperclipReady -and (Get-Date) -lt $paperclipDeadline)
Start-OceanServerIfNeeded
Start-Sleep -Seconds 3
Start-OceanMonitorIfNeeded
Start-Sleep -Seconds 5

$paperclipOk = Test-HttpOk 'http://127.0.0.1:3100/api/health'
$oceanOk = Test-HttpOk 'http://127.0.0.1:3102/'
$postgresOk = Test-PortListening $PostgresPort
$codexOk = Test-PortListening 8793
$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8793,3100,3102,$PostgresPort } | Select-Object LocalAddress,LocalPort,OwningProcess

Write-Output "Codex app-server port 8793: $codexOk"
Write-Output "Paperclip health: $paperclipOk"
Write-Output "Postgres port ${PostgresPort}: $postgresOk"
Write-Output "Ocean website health: $oceanOk"
$ports | Format-Table -AutoSize

if (-not $codexOk) {
  Write-Warning 'Codex app-server is not listening on port 8793. Agentic OS Codex continuation will be unavailable until it starts.'
}

if (-not ($paperclipOk -and $postgresOk -and $oceanOk)) {
  throw 'Startup verification failed.'
}
