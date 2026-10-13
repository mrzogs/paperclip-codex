$ErrorActionPreference = 'Stop'

function Assert-Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$scriptsRoot = Split-Path -Parent $PSCommandPath
$managerPath = Join-Path $scriptsRoot 'manage-ocean-services.ps1'
$launcherPath = Join-Path $scriptsRoot 'start-ocean-website.ps1'
$stackLauncherPath = Join-Path $scriptsRoot 'start-ocean-trading-stack.ps1'
$manager = Get-Content -LiteralPath $managerPath -Raw
$launcher = Get-Content -LiteralPath $launcherPath -Raw
$stackLauncher = Get-Content -LiteralPath $stackLauncherPath -Raw

Assert-Test ($manager.Contains('AddSeconds(120)')) 'OUTER_WEBSITE_HEALTH_GATE_IS_SHORTER_THAN_SUPERVISED_STARTUP'
Assert-Test ($manager.Contains("Script = Join-Path `$Root 'scripts\run-ocean-website-supervised.ps1'")) 'MANAGER_DOES_NOT_USE_TRACKED_SUPERVISOR'
Assert-Test ($launcher.Contains("Join-Path `$PSScriptRoot 'manage-ocean-services.ps1'")) 'NORMAL_LAUNCHER_BYPASSES_MANAGED_SERVICE'
Assert-Test ($launcher.Contains("Component = @('Website')")) 'NORMAL_LAUNCHER_CAN_RESTART_UNRELATED_SERVICES'
Assert-Test (-not $launcher.Contains('Start-Process')) 'NORMAL_LAUNCHER_RETAINS_LEGACY_DIRECT_NODE_PATH'
Assert-Test ($manager.Contains("Join-Path `$PSScriptRoot 'ocean-deployment.ps1'")) 'MANAGER_BYPASSES_DEPLOYMENT_MANIFEST'
Assert-Test ($manager.Contains('function Get-ValidatedOceanDeployment')) 'MANAGER_DOES_NOT_LAZILY_VALIDATE_DEPLOYMENT'
Assert-Test (-not $manager.Contains("`$Deployment = Get-OceanDeployment -ConfigPath")) 'STOP_AND_UNINSTALL_REQUIRE_A_VALID_DEPLOYMENT'
Assert-Test ($manager.Contains("Join-Path `$Root 'scripts\run-hidden-service.vbs'")) 'MANAGER_BYPASSES_HIDDEN_LAUNCHER'
foreach ($dependency in @('ocean-deployment.ps1','run-hidden-service.vbs','run-paperclip-supervised.ps1',
    'run-codex-bridge-supervised.ps1','run-ocean-monitor-supervised.ps1','run-ocean-website-supervised.ps1',
    'run-ocean-replay-bridge.ps1')) {
  Assert-Test (Test-Path -LiteralPath (Join-Path $scriptsRoot $dependency) -PathType Leaf) "MANAGED_DEPENDENCY_MISSING_$dependency"
}
Assert-Test ($stackLauncher.Contains("Join-Path `$PSScriptRoot 'manage-ocean-services.ps1'")) 'STACK_LAUNCHER_BYPASSES_SERVICE_MANAGER'
Assert-Test (-not $stackLauncher.Contains('Start-Process')) 'STACK_LAUNCHER_RETAINS_LEGACY_PROCESS_STARTS'
Assert-Test (-not $stackLauncher.Contains('D:\Paperclip-codex\website\ocean-trading\dashboard')) 'STACK_LAUNCHER_RETAINS_OLD_DASHBOARD'

Write-Output 'managed Ocean website launcher contract: PASS'
