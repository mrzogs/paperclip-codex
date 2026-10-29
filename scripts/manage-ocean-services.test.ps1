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
Assert-Test ($manager.Contains('function Stop-WebsiteSupervisorProcesses')) 'WEBSITE_RESTART_CANNOT_RETIRE_STALE_SUPERVISORS'
Assert-Test ($manager.Contains("Join-Path `$Root 'scripts\run-ocean-website-supervised.ps1'")) `
  'WEBSITE_SUPERVISOR_MATCH_IS_NOT_BOUND_TO_TRACKED_SCRIPT'
Assert-Test ($manager.Contains('Stop-WebsiteSupervisorProcesses')) 'WEBSITE_RESTART_DOES_NOT_INVOKE_SUPERVISOR_RETIREMENT'
Assert-Test ($manager.Contains('Stopped stale Ocean website supervisor child PID')) 'WEBSITE_RESTART_DOES_NOT_CLEAN_SUPERVISOR_CHILDREN'
Assert-Test ($manager.Contains("`$_.Name -ieq 'wscript.exe'")) 'WEBSITE_RESTART_DOES_NOT_RETIRE_HIDDEN_LAUNCHER'
Assert-Test ($manager.Contains('[regex]::Escape($HiddenLauncher)')) 'WEBSITE_HIDDEN_LAUNCHER_MATCH_IS_NOT_PATH_BOUND'
Assert-Test ($manager.Contains('Ocean website supervisor process tree did not exit')) 'WEBSITE_RESTART_REPORTS_SUCCESS_WITH_LIVE_OLD_PROCESSES'
Assert-Test ($manager.Contains("schema_version -eq 14")) 'MANAGER_DOES_NOT_REQUIRE_CURRENT_WORKFLOW_SCHEMA'
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

# Evaluate only these function declarations. Never dot-source the manager's
# action dispatcher or invoke real scheduled-task/process-management cmdlets.
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($managerPath, [ref]$tokens, [ref]$parseErrors)
Assert-Test ($parseErrors.Count -eq 0) 'MANAGER_PARSE_FAILED'
foreach ($name in @('Get-TaskSpec','Register-OceanTask','Get-WebsiteSupervisorCommandPattern',
    'Get-MonitorOwnedProcessTree','Stop-WebsiteSupervisorProcesses','Stop-TaskComponent','Disable-TaskComponent',
    'Test-OceanWorkflowReady','Test-OceanWebsiteAvailable')) {
  $declaration = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
  }, $true))
  Assert-Test ($declaration.Count -eq 1) "MANAGER_FUNCTION_NOT_UNIQUE_$name"
  . ([scriptblock]::Create($declaration[0].Extent.Text))
}

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('ocean-manager-contract-' + [guid]::NewGuid().ToString('N'))
try {
  $Root = Join-Path $fixture 'canonical+[1]'
  $TaskPath = '\OceanTrading\'
  $Powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  $Wscript = 'C:\Windows\System32\wscript.exe'
  $HiddenLauncher = Join-Path $Root 'scripts\run-hidden-service.vbs'
  [IO.Directory]::CreateDirectory((Split-Path -Parent $HiddenLauncher)) | Out-Null
  [IO.File]::WriteAllText($HiddenLauncher, 'SOFTWARE FIXTURE ONLY; NEVER EXECUTE')
  foreach ($name in @('Paperclip','Website','Monitor','ReplayBridge','CodexBridge')) {
    [IO.File]::WriteAllText((Get-TaskSpec $name).Script, 'SOFTWARE FIXTURE ONLY; NEVER EXECUTE')
  }
  $releaseSource = Join-Path $fixture 'immutable\paperclip-source'
  $relativeSupervisor = 'scripts\run-ocean-website-supervised.ps1'
  $releaseSupervisor = Join-Path $releaseSource $relativeSupervisor
  [IO.Directory]::CreateDirectory((Split-Path -Parent $releaseSupervisor)) | Out-Null
  [IO.File]::WriteAllText($releaseSupervisor, 'IMMUTABLE SOFTWARE FIXTURE ONLY; NEVER EXECUTE')
  $script:FakeDeployment = [pscustomobject]@{ SourceRoot=$releaseSource; SupportFiles=@(
    [pscustomobject]@{ relative_path=$relativeSupervisor; sha256=(Get-FileHash -LiteralPath $releaseSupervisor -Algorithm SHA256).Hash.ToLowerInvariant() }
  ) }
  $script:DeploymentCalls = 0
  $script:RegisteredTasks = @()
  $script:StoppedTasks = @()
  $script:DisabledTasks = @()
  function Get-ValidatedOceanDeployment { $script:DeploymentCalls++; if ($script:RejectDeployment) { throw 'FIXTURE_INVALID_MANIFEST' }; return $script:FakeDeployment }
  function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{ Execute=$Execute; Argument=$Argument; WorkingDirectory=$WorkingDirectory } }
  function New-ScheduledTaskTrigger { [pscustomobject]@{ Fixture='trigger' } }
  function New-ScheduledTaskPrincipal { [pscustomobject]@{ Fixture='principal' } }
  function New-ScheduledTaskSettingsSet { [pscustomobject]@{ Fixture='settings' } }
  function Register-ScheduledTask { param($TaskPath,$TaskName,$Action,$Trigger,$Settings,$Principal,$Description,[switch]$Force)
    $script:RegisteredTasks += [pscustomobject]@{ Name=$TaskName; Action=$Action }
  }
  function Get-ScheduledTask { [CmdletBinding()]param($TaskPath,$TaskName) [pscustomobject]@{ State='Running' } }
  function Stop-ScheduledTask { param($TaskPath,$TaskName) $script:StoppedTasks += $TaskName }
  function Disable-ScheduledTask { param($TaskPath,$TaskName) $script:DisabledTasks += $TaskName }

  Register-OceanTask 'Website'
  Assert-Test ($script:DeploymentCalls -eq 1) 'WEBSITE_REGISTRATION_DID_NOT_VALIDATE_ACTIVE_DEPLOYMENT'
  $registered = $script:RegisteredTasks[-1]
  Assert-Test ($registered.Name -ceq 'OceanTrading-Website') 'WEBSITE_TASK_ID_CHANGED'
  Assert-Test ($registered.Action.Argument.Contains('-File "' + $releaseSupervisor + '"')) 'WEBSITE_REGISTRATION_USES_CANONICAL_INSTEAD_OF_PINNED_SUPERVISOR'
  Assert-Test (-not $registered.Action.Argument.Contains('-File "' + (Get-TaskSpec 'Website').Script + '"')) 'WEBSITE_REGISTRATION_RETAINS_DIRTY_CANONICAL_SCRIPT'
  Assert-Test ($registered.Action.WorkingDirectory -ceq $Root) 'REGISTRATION_CHANGED_EXISTING_WORKING_DIRECTORY'
  Assert-Test ($registered.Action.Execute -ceq $Wscript -and $registered.Action.Argument.Contains($HiddenLauncher)) 'WEBSITE_REGISTRATION_BYPASSES_HIDDEN_LAUNCHER'

  foreach ($invalid in @(
      @(),
      @([pscustomobject]@{ relative_path='scripts\RUN-OCEAN-WEBSITE-SUPERVISED.ps1'; sha256=('a' * 64) }),
      @([pscustomobject]@{ relative_path=$relativeSupervisor; sha256='not-a-hash' }),
      @($script:FakeDeployment.SupportFiles[0], $script:FakeDeployment.SupportFiles[0])
    )) {
    $saved = $script:FakeDeployment.SupportFiles
    $script:FakeDeployment.SupportFiles = $invalid
    $before = $script:RegisteredTasks.Count
    $rejected = $false
    try { Register-OceanTask 'Website' } catch { $rejected = $_.Exception.Message -like '*supervisor support binding*' }
    Assert-Test ($rejected -and $script:RegisteredTasks.Count -eq $before) 'UNBOUND_WEBSITE_SUPERVISOR_REACHED_TASK_REGISTRATION'
    $script:FakeDeployment.SupportFiles = $saved
  }
  $script:RejectDeployment = $true
  $before = $script:DeploymentCalls
  foreach ($name in @('Paperclip','Monitor','ReplayBridge','CodexBridge')) {
    Register-OceanTask $name
    Assert-Test ($script:RegisteredTasks[-1].Action.Argument.Contains('-File "' + (Get-TaskSpec $name).Script + '"')) "OTHER_COMPONENT_SCRIPT_CHANGED_$name"
  }
  Assert-Test ($script:DeploymentCalls -eq $before) 'OTHER_COMPONENT_REGISTRATION_NOW_REQUIRES_WEBSITE_MANIFEST'
  $pureSpec = Get-TaskSpec 'Website'
  Stop-TaskComponent 'Website'
  Disable-TaskComponent 'Website'
  Assert-Test ($script:DeploymentCalls -eq $before -and $pureSpec.TaskName -ceq 'OceanTrading-Website') 'STOP_OR_TASK_ID_LOOKUP_REQUIRES_VALID_MANIFEST'
  Assert-Test ($script:StoppedTasks -contains 'OceanTrading-Website' -and $script:DisabledTasks -contains 'OceanTrading-Website') 'STUBBED_STOP_DID_NOT_RETAIN_WEBSITE_TASK_ID'

  $pattern = Get-WebsiteSupervisorCommandPattern
  $canonicalCommand = 'powershell.exe -NoProfile -File "' + (Get-TaskSpec 'Website').Script + '"'
  $oldRelease = 'D:\OceanTradingData\website\deployments\ocean-old-20261027\scripts\run-ocean-website-supervised.ps1'
  $newRelease = 'D:\OceanTradingData\website\deployments\ocean-88b1e4b-20261029\paperclip-source\scripts\run-ocean-website-supervised.ps1'
  foreach ($command in @($canonicalCommand, ('powershell.exe -File ' + $oldRelease), ('pwsh.exe -NoProfile -File "' + $newRelease + '"'))) {
    Assert-Test ($command -match $pattern) "SUPERVISOR_PATTERN_REJECTS_KNOWN_GENERATION_$command"
  }
  foreach ($command in @(
      'powershell.exe -File "D:\other\run-ocean-website-supervised.ps1"',
      ('powershell.exe -File "' + $newRelease + '.bak"'),
      'powershell.exe -File "D:\OceanTradingData\website\deployments-other\ocean-x\scripts\run-ocean-website-supervised.ps1"',
      'powershell.exe -File "D:\OceanTradingData\website\deployments\not-ocean-x\scripts\run-ocean-website-supervised.ps1"',
      'powershell.exe -File "D:\OceanTradingData\website\deployments\ocean-x\..\ocean-y\scripts\run-ocean-website-supervised.ps1"',
      'powershell.exe -File "D:\OceanTradingData\website\deployments\ocean-x\paperclip-source\other\scripts\run-ocean-website-supervised.ps1"',
      ('powershell.exe -Command "Write-Output -File ' + $newRelease + '"'),
      ('powershell.exe -File "' + $newRelease + '"suffix')
    )) {
    Assert-Test (-not ($command -match $pattern)) "SUPERVISOR_PATTERN_ACCEPTS_UNOWNED_COMMAND_$command"
  }
  $script:StoppedProcessIds = @()
  $script:ProcessSnapshot = @(
    [pscustomobject]@{ ProcessId=100; ParentProcessId=1; Name='powershell.exe'; CommandLine=$canonicalCommand },
    [pscustomobject]@{ ProcessId=101; ParentProcessId=100; Name='node.exe'; CommandLine='owned supervisor child' },
    [pscustomobject]@{ ProcessId=200; ParentProcessId=1; Name='pwsh.exe'; CommandLine=('pwsh.exe -File "' + $newRelease + '"') },
    [pscustomobject]@{ ProcessId=300; ParentProcessId=1; Name='wscript.exe'; CommandLine=('wscript.exe //B "' + $HiddenLauncher + '" "' + $Powershell + '" -File "' + $oldRelease + '"') },
    [pscustomobject]@{ ProcessId=400; ParentProcessId=1; Name='powershell.exe'; CommandLine='powershell.exe -File D:\other\run-ocean-website-supervised.ps1' },
    [pscustomobject]@{ ProcessId=500; ParentProcessId=1; Name='wscript.exe'; CommandLine=('wscript.exe "D:\other\run-hidden-service.vbs" -File "' + $newRelease + '"') },
    [pscustomobject]@{ ProcessId=600; ParentProcessId=1; Name='node.exe'; CommandLine=('node.exe -File "' + $newRelease + '"') }
  )
  function Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter) $script:ProcessSnapshot }
  function Stop-Process { [CmdletBinding()]param($Id,[switch]$Force) $script:StoppedProcessIds += [int]$Id }
  function Get-Process { [CmdletBinding()]param($Id) return $null }
  Stop-WebsiteSupervisorProcesses | Out-Null
  Assert-Test (($script:StoppedProcessIds | Sort-Object) -join ',' -ceq '100,101,200,300') 'SUPERVISOR_RETIREMENT_IGNORES_PROCESS_PARENT_OR_HIDDEN_LAUNCHER_GUARDS'
  Assert-Test ($script:DeploymentCalls -eq $before) 'SUPERVISOR_RETIREMENT_REQUIRES_VALID_MANIFEST'
} finally {
  if (Test-Path -LiteralPath $fixture) {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'TEST_FIXTURE_CLEANUP_OUTSIDE_TEMP' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

# These predicates use only in-memory readiness/deployment fixtures. No HTTP,
# scheduler or process APIs are invoked, and full operational health stays false.
$script:RejectDeployment = $false
$script:FakeDeployment = [pscustomobject]@{ReleaseId='ocean-reviewed-fixture';SourceCommit=('a'*40);ManifestSha256=('b'*64)}
$script:FakeReadiness = $null
function Get-OceanWorkflowReadiness { return $script:FakeReadiness }
$degraded = [pscustomobject]@{state='DEGRADED_READ_ONLY';execution='READ_ONLY';workflow=[pscustomobject]@{
  state='DEGRADED_READ_ONLY';schema_version=14;read_only=$true;mutations_enabled=$false;
  deployment=[pscustomobject]@{release_id=$script:FakeDeployment.ReleaseId;source_commit=$script:FakeDeployment.SourceCommit;manifest_sha256=$script:FakeDeployment.ManifestSha256};
  physical_readiness=[pscustomobject]@{state='BLOCKED';latched=$true;blocker=[pscustomobject]@{code='OPERATIONAL_TELEMETRY_MODULE_HASH_CONFLICT'}}}}
$script:FakeReadiness = $degraded
Assert-Test (Test-OceanWebsiteAvailable) 'REVIEWED_READ_ONLY_WEBSITE_IS_NOT_AVAILABLE'
Assert-Test (-not (Test-OceanWorkflowReady)) 'READ_ONLY_WEBSITE_IS_MISREPORTED_OPERATIONALLY_READY'
foreach ($mutate in @(
    {param($v) $v.state='READY'}, {param($v) $v.execution='NORMAL'},
    {param($v) $v.workflow.state='READY'}, {param($v) $v.workflow.schema_version=13},
    {param($v) $v.workflow.read_only=$false}, {param($v) $v.workflow.mutations_enabled=$true},
    {param($v) $v.workflow.physical_readiness.state='READY'}, {param($v) $v.workflow.physical_readiness.latched=$false},
    {param($v) $v.workflow.physical_readiness.blocker.code='OTHER_FAILURE'},
    {param($v) $v.workflow.deployment.release_id='other'}, {param($v) $v.workflow.deployment.source_commit=('c'*40)},
    {param($v) $v.workflow.deployment.manifest_sha256=('d'*64)}
  )) {
  $script:FakeReadiness = $degraded | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  & $mutate $script:FakeReadiness
  Assert-Test (-not (Test-OceanWebsiteAvailable)) 'UNBOUND_OR_MUTABLE_DEGRADED_WEBSITE_ACCEPTED'
}
$script:FakeReadiness = $null
Assert-Test (-not (Test-OceanWebsiteAvailable)) 'MISSING_WEBSITE_READINESS_ACCEPTED'
$script:FakeReadiness = [pscustomobject]@{}
& { Set-StrictMode -Version Latest; Assert-Test (-not (Test-OceanWebsiteAvailable)) 'STRICT_MODE_MALFORMED_READINESS_ACCEPTED' }
$ready = [pscustomobject]@{execution='TEST_ONLY';workflow=[pscustomobject]@{state='READY';schema_version=14;
  deployment=$degraded.workflow.deployment;
  operational_learning=[pscustomobject]@{enabled=$true;state='READY';last_error=$null};
  candidate_evaluator=[pscustomobject]@{version='ocean-operational-candidate-evaluator/v2';state='READY';last_error=$null}}}
$script:FakeReadiness = $ready
Assert-Test (Test-OceanWorkflowReady) 'GENUINE_OPERATIONAL_READY_PATH_CHANGED'
Assert-Test (Test-OceanWebsiteAvailable) 'GENUINE_READY_WEBSITE_UNAVAILABLE'
foreach ($patch in @(@{state='DEGRADED_READ_ONLY'},@{state='ERROR'},@{execution='READ_ONLY'},
    @{workflow_read_only=$true},@{workflow_mutations_enabled=$false},
    @{workflow_physical_readiness=[pscustomobject]@{state='BLOCKED';latched=$true}})) {
  $script:FakeReadiness = $ready | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  foreach ($key in $patch.Keys) {
    if ($key.StartsWith('workflow_')) { $script:FakeReadiness.workflow | Add-Member -Force -NotePropertyName $key.Substring(9) -NotePropertyValue $patch[$key] }
    else { $script:FakeReadiness | Add-Member -Force -NotePropertyName $key -NotePropertyValue $patch[$key] }
  }
  Assert-Test (-not (Test-OceanWorkflowReady)) 'CONTRADICTORY_READ_ONLY_RESPONSE_REPORTED_OPERATIONALLY_READY'
}

Write-Output 'managed Ocean website launcher contract: PASS'
