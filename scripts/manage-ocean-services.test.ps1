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

Assert-Test ($manager.Contains('AddSeconds(210)')) 'OUTER_WEBSITE_HEALTH_GATE_IS_SHORTER_THAN_SUPERVISED_STARTUP'
Assert-Test ($manager.Contains("Script = Join-Path `$Root 'scripts\run-ocean-website-supervised.ps1'")) 'MANAGER_DOES_NOT_USE_TRACKED_SUPERVISOR'
Assert-Test ($launcher.Contains("Join-Path `$PSScriptRoot 'manage-ocean-services.ps1'")) 'NORMAL_LAUNCHER_BYPASSES_MANAGED_SERVICE'
Assert-Test ($launcher.Contains("Component = @('Website')")) 'NORMAL_LAUNCHER_CAN_RESTART_UNRELATED_SERVICES'
Assert-Test (-not $launcher.Contains('Start-Process')) 'NORMAL_LAUNCHER_RETAINS_LEGACY_DIRECT_NODE_PATH'
Assert-Test ($manager.Contains("Join-Path `$PSScriptRoot 'ocean-deployment.ps1'")) 'MANAGER_BYPASSES_DEPLOYMENT_MANIFEST'
Assert-Test ($manager.Contains('function Get-ValidatedOceanDeployment')) 'MANAGER_DOES_NOT_LAZILY_VALIDATE_DEPLOYMENT'
Assert-Test (-not $manager.Contains("`$Deployment = Get-OceanDeployment -ConfigPath")) 'STOP_AND_UNINSTALL_REQUIRE_A_VALID_DEPLOYMENT'
Assert-Test ($manager.Contains("candidate_evaluator.version -ceq 'ocean-operational-candidate-evaluator/v2'")) `
  'MANAGER_DOES_NOT_REQUIRE_CANDIDATE_EVALUATOR_V2'
Assert-Test (-not $manager.Contains("candidate_evaluator.version -ceq 'ocean-operational-candidate-evaluator/v1'")) `
  'MANAGER_STILL_ACCEPTS_CANDIDATE_EVALUATOR_V1'
Assert-Test ($manager.Contains("Join-Path (Get-ValidatedOceanDeployment).Dashboard 'monitor.mjs'")) 'MONITOR_MATCH_IS_NOT_BOUND_TO_DEPLOYED_DASHBOARD'
Assert-Test ($manager.Contains("`$_.Name -ieq 'node.exe'")) 'MONITOR_MATCH_DOES_NOT_REQUIRE_NODE'
Assert-Test ($manager.Contains('[regex]::Escape($monitorPath)')) 'MONITOR_PATH_IS_NOT_REGEX_SAFE'
Assert-Test (-not $manager.Contains("'node(\.exe)?")) 'MONITOR_MATCH_RETAINS_BASENAME_ONLY_REGEX'
Assert-Test ($manager.Contains('function Get-ReleaseMonitorCommandPattern')) 'MONITOR_RESTART_CANNOT_FIND_PRIOR_RELEASE_GENERATIONS'
Assert-Test ($manager.Contains('paperclip-source\\)?website\\ocean-trading\\dashboard\\monitor\.mjs')) `
  'MONITOR_RELEASE_PATTERN_DOES_NOT_COVER_LEGACY_AND_CURRENT_LAYOUTS'
Assert-Test ($manager.Contains("Join-Path `$Root 'scripts\run-ocean-monitor-supervised.ps1'")) `
  'MONITOR_RESTART_CANNOT_FIND_PRIOR_SUPERVISORS'
Assert-Test ($manager.Contains('function Get-MonitorOwnedProcessTree')) 'MONITOR_RESTART_DOES_NOT_CLEAN_CHILD_PROCESSES'
Assert-Test ($manager.Contains('Stopped Ocean monitor generation PID')) 'MONITOR_RESTART_STILL_STOPS_ONLY_CURRENT_MONITOR'
Assert-Test ($manager.Contains('function Stop-WebsiteOwnedMonitorProcesses')) 'WEBSITE_RESTART_CANNOT_RETIRE_ITS_DETACHED_MONITOR'
Assert-Test ($manager.Contains('Stop-WebsiteOwnedMonitorProcesses -WebsiteProcessIds $websiteProcessIds')) `
  'WEBSITE_RESTART_DOES_NOT_RETIRE_ITS_DETACHED_MONITOR'
$ownedStart = $manager.IndexOf('function Stop-WebsiteOwnedMonitorProcesses')
$ownedEnd = $manager.IndexOf('function Get-MonitorOwnedProcessTree', $ownedStart)
$ownedMonitorStop = $manager.Substring($ownedStart, $ownedEnd - $ownedStart)
Assert-Test ($ownedMonitorStop.Contains("`$_.Name -ieq 'node.exe'")) 'WEBSITE_MONITOR_RETIREMENT_ACCEPTS_NON_NODE_PROCESSES'
Assert-Test ($ownedMonitorStop.Contains('ParentProcessId')) 'WEBSITE_MONITOR_RETIREMENT_IS_NOT_BOUND_TO_WEBSITE_PARENT'
Assert-Test ($ownedMonitorStop.Contains('Get-ReleaseMonitorCommandPattern')) 'WEBSITE_MONITOR_RETIREMENT_IS_NOT_BOUND_TO_IMMUTABLE_RELEASE_PATHS'
Assert-Test (-not $ownedMonitorStop.Contains('OceanTrading-Monitor')) 'WEBSITE_RESTART_TOUCHES_GENERIC_MONITOR_TASK'
Assert-Test ($manager.Contains('function Write-MonitorStoppedState')) 'MANAGED_MONITOR_STOP_DOES_NOT_PUBLISH_STOPPED_STATE'
Assert-Test ($manager.Contains("`$next['running'] = `$false")) 'MANAGED_MONITOR_STOP_LEAVES_RUNNING_STATE_TRUE'
Assert-Test ($manager.Contains("`$next['pid'] = `$null")) 'MANAGED_MONITOR_STOP_LEAVES_STALE_PID'
Assert-Test ($manager.Contains('Write-MonitorStoppedState')) 'MONITOR_STOP_DOES_NOT_INVOKE_STOPPED_STATE_PUBLICATION'
$releaseMonitorPattern = [regex]::Escape('D:\OceanTradingData\website\deployments\') +
  'ocean-[^\\"]+\\(?:paperclip-source\\)?website\\ocean-trading\\dashboard\\monitor\.mjs(?:["\s]|$)'
Assert-Test ('node D:\OceanTradingData\website\deployments\ocean-r8\paperclip-source\website\ocean-trading\dashboard\monitor.mjs' -match $releaseMonitorPattern) `
  'MONITOR_RELEASE_PATTERN_REJECTS_CURRENT_LAYOUT'
Assert-Test ('node D:\OceanTradingData\website\deployments\ocean-r9\website\ocean-trading\dashboard\monitor.mjs' -match $releaseMonitorPattern) `
  'MONITOR_RELEASE_PATTERN_REJECTS_LEGACY_LAYOUT'
Assert-Test (-not ('node D:\OceanTradingData\website\deployments\ocean-r9\website\ocean-trading\dashboard\build-manifest.mjs' -match $releaseMonitorPattern)) `
  'MONITOR_RELEASE_PATTERN_MATCHES_NON_MONITOR_CHILD'
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
