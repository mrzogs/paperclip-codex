param(
  [switch]$NoMonitor,
  [switch]$WebsiteOnly,
  [switch]$RestartWebsite,
  [switch]$DisableWorkflow,
  [switch]$EnableWorkflow
)

$ErrorActionPreference = 'Stop'
$ServiceManager = Join-Path $PSScriptRoot 'manage-ocean-services.ps1'
if ($WebsiteOnly) {
  $action = if ($RestartWebsite) { 'Restart' } else { 'Start' }
  & $ServiceManager -Action $action -Component Website -DisableWorkflow:$DisableWorkflow -EnableWorkflow:$EnableWorkflow
  return
}
if ($RestartWebsite -or $DisableWorkflow -or $EnableWorkflow) { throw 'Website lifecycle switches require -WebsiteOnly; no stack-wide restart is implicit.' }

& $ServiceManager -Action Start -NoMonitor:$NoMonitor
