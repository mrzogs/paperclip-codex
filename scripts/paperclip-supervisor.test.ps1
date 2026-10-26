$ErrorActionPreference = 'Stop'

function Assert-Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$scriptsRoot = Split-Path -Parent $PSCommandPath
$supervisor = Get-Content -LiteralPath (Join-Path $scriptsRoot 'run-paperclip-supervised.ps1') -Raw
$probe = Get-Content -LiteralPath (Join-Path $scriptsRoot 'paperclip-runtime-probe.mjs') -Raw
$skill = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $scriptsRoot) 'skills\paperclip\SKILL.md') -Raw

Assert-Test ($supervisor.Contains('[IO.FileShare]::None')) 'SUPERVISOR_HAS_NO_SINGLE_INSTANCE_LOCK'
Assert-Test ($supervisor.Contains('ConsecutiveFailuresBeforeRecovery')) 'SUPERVISOR_RECOVERS_ON_FIRST_TRANSIENT_FAILURE'
Assert-Test ($supervisor.Contains('Get-ActiveRunCustody')) 'SUPERVISOR_DOES_NOT_CHECK_ACTIVE_RUN_CUSTODY'
Assert-Test ($supervisor.Contains('active-run custody could not be proven')) 'SUPERVISOR_DOES_NOT_FAIL_CLOSED_ON_UNKNOWN_CUSTODY'
Assert-Test ($supervisor.Contains('proceeding with a cold start')) 'SUPERVISOR_CANNOT_BOOT_WHEN_BOTH_LISTENERS_ARE_ABSENT'
Assert-Test ($supervisor.Contains('queued or running agent run(s) retain custody')) 'SUPERVISOR_CAN_RESTART_WITH_ACTIVE_RUNS'
Assert-Test ($supervisor.Contains('Port 3100 is owned by an unexpected process; recovery refused.')) `
  'SUPERVISOR_CAN_TERMINATE_AN_UNEXPECTED_PORT_OWNER'
Assert-Test ($supervisor.Contains('MaxStartAttempts')) 'SUPERVISOR_HAS_UNBOUNDED_IMMEDIATE_RESTARTS'
Assert-Test ($probe.Contains('/api/issues/')) 'PROBE_HAS_NO_ISSUE_DATA_CHECK'
Assert-Test ($supervisor.Contains("--issue 'OCE-918'")) 'SUPERVISOR_DOES_NOT_PROBE_THE_OBSERVED_DECISION_PAGE'
Assert-Test ($probe.Contains('<div id="root"></div>')) 'PROBE_ACCEPTS_ARBITRARY_HTML'
Assert-Test ($probe.Contains("where status in ('queued', 'running')")) 'CUSTODY_QUERY_IGNORES_ACTIVE_RUNS'
Assert-Test ($skill.Contains('An interaction ID is **not** an approval ID')) 'SKILL_CAN_STILL_BUILD_APPROVAL_LINKS_FROM_INTERACTIONS'

Write-Output 'Paperclip supervisor recovery contract: PASS'

