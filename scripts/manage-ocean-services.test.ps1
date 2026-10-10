$ErrorActionPreference = 'Stop'

function Assert-Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$scriptsRoot = Split-Path -Parent $PSCommandPath
$managerPath = Join-Path $scriptsRoot 'manage-ocean-services.ps1'
$launcherPath = Join-Path $scriptsRoot 'start-ocean-website.ps1'
$manager = Get-Content -LiteralPath $managerPath -Raw
$launcher = Get-Content -LiteralPath $launcherPath -Raw

Assert-Test ($manager.Contains('AddSeconds(120)')) 'OUTER_WEBSITE_HEALTH_GATE_IS_SHORTER_THAN_SUPERVISED_STARTUP'
Assert-Test ($manager.Contains("Script = Join-Path `$Root 'scripts\run-ocean-website-supervised.ps1'")) 'MANAGER_DOES_NOT_USE_TRACKED_SUPERVISOR'
Assert-Test ($launcher.Contains("Join-Path `$PSScriptRoot 'manage-ocean-services.ps1'")) 'NORMAL_LAUNCHER_BYPASSES_MANAGED_SERVICE'
Assert-Test ($launcher.Contains("Component = @('Website')")) 'NORMAL_LAUNCHER_CAN_RESTART_UNRELATED_SERVICES'
Assert-Test (-not $launcher.Contains('Start-Process')) 'NORMAL_LAUNCHER_RETAINS_LEGACY_DIRECT_NODE_PATH'

Write-Output 'managed Ocean website launcher contract: PASS'
