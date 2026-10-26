$ErrorActionPreference = 'Stop'

function Assert-Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$scriptsRoot = Split-Path -Parent $PSCommandPath
. (Join-Path $scriptsRoot 'paperclip-supervisor-policy.ps1')

function Get-Action {
  param(
    [bool]$Healthy,
    [int]$Failures,
    [bool]$CustodyKnown = $true,
    [int]$ActiveRuns = 0,
    [bool]$Server = $true,
    [bool]$Database = $true
  )
  return Get-PaperclipRecoveryAction -Healthy $Healthy -ConsecutiveFailures $Failures `
    -FailureThreshold 3 -CustodyKnown $CustodyKnown -ActiveRunCount $ActiveRuns `
    -ServerListenerPresent $Server -DatabaseListenerPresent $Database
}

Assert-Test ((Get-Action -Healthy $true -Failures 0) -eq 'monitor') 'HEALTHY_RUNTIME_IS_NOT_MONITORED'
Assert-Test ((Get-Action -Healthy $false -Failures 1) -eq 'observe') 'FIRST_FAILURE_TRIGGERS_RECOVERY'
Assert-Test ((Get-Action -Healthy $false -Failures 2) -eq 'observe') 'SECOND_FAILURE_TRIGGERS_RECOVERY'
Assert-Test ((Get-Action -Healthy $false -Failures 3 -ActiveRuns 1) -eq 'defer_active_runs') `
  'ACTIVE_RUN_CUSTODY_DOES_NOT_DEFER_RECOVERY'
Assert-Test ((Get-Action -Healthy $false -Failures 3 -CustodyKnown $false) -eq 'defer_unknown_custody') `
  'UNKNOWN_CUSTODY_WITH_LIVE_LISTENERS_DOES_NOT_FAIL_CLOSED'
Assert-Test ((Get-Action -Healthy $false -Failures 3 -CustodyKnown $false -Server $false -Database $false) -eq 'cold_start') `
  'COLD_START_IS_BLOCKED_WITH_NO_RUNTIME_LISTENERS'
Assert-Test ((Get-Action -Healthy $false -Failures 3 -ActiveRuns 0) -eq 'restart') `
  'ZERO_ACTIVE_RUNS_DO_NOT_PERMIT_RECOVERY'

# The actual loop transition must observe exactly three consecutive failures.
$state = New-PaperclipSupervisorState
$cycle = Invoke-PaperclipSupervisorCycle -State $state -Healthy $false -FailureThreshold 3 `
  -CustodyKnown $true -ActiveRunCount 0 -ServerListenerPresent $true -DatabaseListenerPresent $true
$state = $cycle.State
Assert-Test ($state.FailureCount -eq 1 -and $cycle.Action -eq 'observe') 'FIRST_LOOP_FAILURE_DID_NOT_OBSERVE'
$cycle = Invoke-PaperclipSupervisorCycle -State $state -Healthy $false -FailureThreshold 3 `
  -CustodyKnown $true -ActiveRunCount 0 -ServerListenerPresent $true -DatabaseListenerPresent $true
$state = $cycle.State
Assert-Test ($state.FailureCount -eq 2 -and $cycle.Action -eq 'observe') 'SECOND_LOOP_FAILURE_DID_NOT_OBSERVE'
$cycle = Invoke-PaperclipSupervisorCycle -State $state -Healthy $false -FailureThreshold 3 `
  -CustodyKnown $true -ActiveRunCount 0 -ServerListenerPresent $true -DatabaseListenerPresent $true
$state = $cycle.State
Assert-Test ($state.FailureCount -eq 3 -and $cycle.Action -eq 'restart') 'THIRD_LOOP_FAILURE_DID_NOT_SELECT_RESTART'

# A successful restart returns to monitoring and subsequent transient failures
# must again cross the full threshold.
$state = Update-PaperclipSupervisorState -State $state -Healthy $true -RecoveryCompleted
Assert-Test ($state.FailureCount -eq 0) 'SUCCESSFUL_RECOVERY_DOES_NOT_RESET_FAILURE_COUNT'
Assert-Test ($state.SuccessfulRecoveryCount -eq 1) 'SUCCESSFUL_RECOVERY_IS_NOT_PERSISTED'
$cycle = Invoke-PaperclipSupervisorCycle -State $state -Healthy $true -FailureThreshold 3 `
  -CustodyKnown $true -ActiveRunCount 0 -ServerListenerPresent $true -DatabaseListenerPresent $true
$state = $cycle.State
Assert-Test ($cycle.Action -eq 'monitor') 'POST_RESTART_HEALTH_DOES_NOT_PERSIST_MONITORING'
$cycle = Invoke-PaperclipSupervisorCycle -State $state -Healthy $false -FailureThreshold 3 `
  -CustodyKnown $true -ActiveRunCount 0 -ServerListenerPresent $true -DatabaseListenerPresent $true
Assert-Test ($cycle.State.FailureCount -eq 1 -and $cycle.Action -eq 'observe') 'POST_RESTART_FAILURE_THRESHOLD_WAS_NOT_RESET'

$supervisor = Get-Content -LiteralPath (Join-Path $scriptsRoot 'run-paperclip-supervised.ps1') -Raw
$probe = Get-Content -LiteralPath (Join-Path $scriptsRoot 'paperclip-runtime-probe.mjs') -Raw
$skill = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $scriptsRoot) 'skills\paperclip\SKILL.md') -Raw
$safeStopStart = $supervisor.IndexOf('function Stop-EmbeddedPostgresSafely')
$safeStopEnd = $supervisor.IndexOf('function Stop-ExpectedPaperclipRuntime', $safeStopStart)
$safeStop = $supervisor.Substring($safeStopStart, $safeStopEnd - $safeStopStart)

Assert-Test ($supervisor.Contains('[IO.FileShare]::None')) 'SUPERVISOR_HAS_NO_SINGLE_INSTANCE_LOCK'
Assert-Test ($supervisor.Contains('Get-PaperclipRecoveryAction')) 'SUPERVISOR_BYPASSES_EXECUTED_RECOVERY_POLICY'
Assert-Test ($supervisor.Contains('Get-ActiveRunCustody')) 'SUPERVISOR_DOES_NOT_CHECK_ACTIVE_RUN_CUSTODY'
Assert-Test ($supervisor.Contains('MaxStartAttempts')) 'SUPERVISOR_HAS_UNBOUNDED_IMMEDIATE_RESTARTS'
Assert-Test ($supervisor.Contains('pg_ctl.exe')) 'POSTGRES_SHUTDOWN_DOES_NOT_USE_BUNDLED_PG_CTL'
Assert-Test ($safeStop.Contains('-m fast -w -t 30')) 'POSTGRES_SHUTDOWN_IS_NOT_BOUNDED_FAST_MODE'
Assert-Test (-not $safeStop.Contains('Stop-Process')) 'POSTGRES_SHUTDOWN_CAN_FORCE_TERMINATE_DATABASE'
Assert-Test ($safeStop.Contains('recovery refused')) 'POSTGRES_SHUTDOWN_DOES_NOT_FAIL_CLOSED'
Assert-Test ($probe.Contains('/api/issues/')) 'PROBE_HAS_NO_ISSUE_DATA_CHECK'
Assert-Test ($probe.Contains('<div id="root"></div>')) 'PROBE_ACCEPTS_ARBITRARY_HTML'
Assert-Test ($probe.Contains("where status in ('queued', 'running')")) 'CUSTODY_QUERY_IGNORES_ACTIVE_RUNS'
Assert-Test ($probe.Contains('classifyActiveRunCustody')) 'CUSTODY_QUERY_CANNOT_DISTINGUISH_LIVE_AND_RECOVERABLE_RUNS'
Assert-Test ($supervisor.Contains("--issue 'OCE-918'")) 'SUPERVISOR_DOES_NOT_PROBE_THE_OBSERVED_DECISION_PAGE'
Assert-Test ($skill.Contains('An interaction ID is **not** an approval ID')) 'SKILL_CAN_STILL_BUILD_APPROVAL_LINKS_FROM_INTERACTIONS'

Write-Output 'Paperclip supervisor executable recovery policy: PASS'
