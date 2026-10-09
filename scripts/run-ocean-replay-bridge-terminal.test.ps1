param([string]$BridgeScript = (Join-Path $PSScriptRoot 'run-ocean-replay-bridge.ps1'))
$ErrorActionPreference = 'Stop'
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop

# Execute production function bodies only. All HTTP, evidence, physical process
# and state-file boundaries below are explicit mocks; no runtime is contacted.
$source = [IO.File]::ReadAllText($BridgeScript)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'BRIDGE_PARSE_FAILED' }
foreach ($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
  . ([ScriptBlock]::Create($definition.Extent.Text))
}
$script:Passed = 0
function Assert-Case($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Reset-Case([string]$Outcome = 'FAILED') {
  $script:Config = [pscustomobject]@{strategy_id='mock-strategy';instance_id='mock-instance'}
  $script:Credential = [pscustomobject]@{identity_id='mock-telemetry'}
  $script:Namespace = 'OPERATIONAL'; $script:LeaseId = 'mock-lease'; $script:LeaseRunId = 'mock-run'
  $script:Calls = @(); $script:States = @(); $script:EvidenceCalls = 0; $script:PhysicalChecks = 0
  $script:RenewChange = $null; $script:FinishError = $null; $script:EvidenceReady = $false
  $script:Context = [pscustomobject]@{
    run_id='mock-run';state='COMPLETING';revision=3;namespace='OPERATIONAL'
    context=[pscustomobject]@{run_id='mock-run';strategy_id='mock-strategy';execution_instance_id='mock-instance';expected_environment='REPLAY';context_hash=('sha256:' + ('a'*64))}
    plan=[pscustomobject]@{context_hash=('sha256:' + ('a'*64));instance=[pscustomobject]@{execution_instance_id='mock-instance';telemetry_producer_id='mock-telemetry'}}
    lease=[pscustomobject]@{owner_id='mock-telemetry';expired=$false;expires_ms=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+60000)}
    end_request=[pscustomobject]@{event_id=1;actor_role='HUMAN';outcome=$Outcome}
    open_pins=0;progress=[pscustomobject]@{pending_events=0;axes=[pscustomobject]@{source_market=@();strategy_execution=@();processing_review=@()};watermark=$null;gaps=@('retained-gap');failures=@('retained-failure')}
  }
}
function Get-EvidencePlan([string]$RunId) {
  if ($RunId -ceq '--failure-only') { return [pscustomobject]@{status='NO_TERMINAL_FAILURE'} }
  $script:EvidenceCalls++
  if ($script:EvidenceReady) {
    return [pscustomobject]@{status='READY';run_id='mock-run';actions=@();scored_intervals=@();watermark=$null;completion_receipt=[pscustomobject]@{status='COMPLETED'}}
  }
  return [pscustomobject]@{status='AWAITING_SIERRA_EVIDENCE_IMAGE'}
}
function Test-OperationalPhysicalBinding($Config) { $script:PhysicalChecks++ }
function Get-Probe { return [pscustomobject]@{run=[pscustomobject]@{id='mock-run'};telemetry=[pscustomobject]@{verified=$false}} }
function Get-RunContext([string]$RunId) { Assert-Case ($RunId -ceq 'mock-run') 'WRONG_GET'; return $script:Context }
function Invoke-Mutation([string]$Action, $Data) {
  $script:Calls += [pscustomobject]@{action=$Action;data=$Data}
  Assert-Case ($Data.run_id -ceq 'mock-run') 'WRONG_MUTATION_RUN'
  if ($Action -ceq 'claim') {
    $script:Context.lease=[pscustomobject]@{owner_id='mock-telemetry';expired=$false;expires_ms=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+60000)}
    return [pscustomobject]@{lease_id='mock-new-lease'}
  }
  if ($Action -ceq 'renew' -and $script:RenewChange) { & $script:RenewChange }
  if ($Action -ceq 'finish') {
    Assert-Case ($Data.lease_id -ceq $script:LeaseId -and $Data.expected_revision -eq $script:Context.revision) 'WRONG_FINISH_LEASE_OR_REVISION'
    if ($script:FinishError) { throw $script:FinishError }
    $script:Context.state=$script:Context.end_request.outcome
  }
  return $script:Context
}
function Write-State($State) { $script:States += $State }
function Run-Case([string]$Name, [ScriptBlock]$Work) {
  & $Work
  $script:Passed++
  Write-Output "PASS [MOCK boundaries / actual bridge functions]: $Name"
}
function Assert-Rejected([string]$Code) {
  $observed=$null
  try { Invoke-PinnedBridgeCycle } catch { $observed=$_.Exception.Message }
  Assert-Case ($observed -ceq $Code) "Expected $Code, got $observed"
  Assert-Case (@($script:Calls | Where-Object action -eq 'finish').Count -eq 0) 'REJECTION_FINISHED_RUN'
}

foreach ($outcome in @('FAILED','CANCELLED')) {
  Run-Case "$outcome drained human end finishes without replay artifacts or progress writes" {
    Reset-Case $outcome
    $before=$script:Context.progress | ConvertTo-Json -Depth 8 -Compress
    Invoke-PinnedBridgeCycle
    Assert-Case (($script:Calls.action -join ',') -ceq 'renew,finish') 'ONLY_RENEW_AND_FINISH_ALLOWED'
    Assert-Case ($script:EvidenceCalls -eq 0 -and $script:PhysicalChecks -eq 1) 'ARTIFACT_BYPASS_OR_PHYSICAL_GUARD_WRONG'
    Assert-Case (($script:Context.progress | ConvertTo-Json -Depth 8 -Compress) -ceq $before) 'PROGRESS_REWRITTEN'
    Assert-Case ($script:Context.state -ceq $outcome -and $null -eq $script:LeaseId) 'TERMINAL_STATE_OR_LEASE_WRONG'
    Assert-Case ($script:States[0].status -ceq 'TERMINAL_REQUEST_FINISHED' -and $script:States[0].reconciliation.full_requested_coverage_verified -eq $false) 'TERMINAL_STATUS_OVERCLAIM'
  }
}
foreach ($change in @(
  { $script:Context.run_id='other' },
  { $script:Context.context.run_id='other' },
  { $script:Context.context.strategy_id='other' },
  { $script:Context.context.execution_instance_id='other' },
  { $script:Context.context.expected_environment='PAPER_FORWARD' },
  { $script:Context.plan.context_hash='sha256:' + ('b'*64) },
  { $script:Context.context.context_hash='invalid'; $script:Context.plan.context_hash='invalid' },
  { $script:Context.plan.instance.telemetry_producer_id='other' },
  { $script:Context.plan.instance.execution_instance_id='other' },
  { $script:Context.namespace='TEST' },
  { $script:Context.end_request.actor_role='TELEMETRY' }
)) {
  Run-Case "terminal scope rejection: $change" {
    Reset-Case; & $change
    Assert-Rejected 'TERMINAL_RUN_CONTEXT_REJECTED'
  }
}
foreach ($change in @(
  { $script:Context.open_pins=1 }, { $script:Context.open_pins=$null },
  { $script:Context.progress.pending_events=1 }, { $script:Context.progress.pending_events=$null },
  { $script:Context.progress=$null }
)) {
  Run-Case "undrained rejection: $change" { Reset-Case; & $change; Assert-Rejected 'TERMINAL_RUN_NOT_DRAINED' }
}
foreach ($change in @(
  { $script:Context.lease.owner_id='other' }, { $script:Context.lease.expired=$true },
  { $script:Context.lease.expires_ms=0 }, { $script:Context.lease=$null }
)) {
  Run-Case "post-renew lease rejection: $change" {
    Reset-Case; $script:RenewChange=$change
    Assert-Rejected 'TERMINAL_RUN_LEASE_REJECTED'
  }
}
Run-Case 'restart cannot adopt a hidden live lease; expired lease is freshly claimed' {
  Reset-Case; $script:LeaseId=$null; $script:LeaseRunId=$null
  Assert-Rejected 'FOREIGN_OR_UNAVAILABLE_RUN_LEASE'
  $script:Context.lease.expired=$true
  Invoke-PinnedBridgeCycle
  Assert-Case (($script:Calls.action -join ',') -ceq 'claim,renew,finish') 'RESTART_DID_NOT_RECLAIM'
}
Run-Case 'renewed COMPLETED intent still requires evidence' {
  Reset-Case; $script:RenewChange={ $script:Context.end_request.outcome='COMPLETED' }
  Assert-Rejected 'REPLAY_EVIDENCE_NOT_READY'
  Assert-Case ($script:EvidenceCalls -eq 1) 'COMPLETED_SKIPPED_EVIDENCE'
}
Run-Case 'missing end request stays on strict artifact qualification' {
  Reset-Case; $script:Context.end_request=$null
  Assert-Rejected 'REPLAY_EVIDENCE_NOT_READY'
  Assert-Case ($script:EvidenceCalls -eq 1) 'MISSING_INTENT_SKIPPED_EVIDENCE'
}
Run-Case 'ACTIVE is not terminalized even if an obsolete failed end request is present' {
  Reset-Case; $script:Context.state='ACTIVE'
  Invoke-PinnedBridgeCycle
  Assert-Case ($script:EvidenceCalls -eq 1 -and @($script:Calls | Where-Object action -eq 'finish').Count -eq 0) 'ACTIVE_BYPASSED_EVIDENCE'
}
Run-Case 'COMPLETED with a qualified evidence plan retains progress then finish ordering' {
  Reset-Case 'COMPLETED'; $script:EvidenceReady=$true
  Invoke-PinnedBridgeCycle
  Assert-Case (($script:Calls.action -join ',') -ceq 'renew,progress,finish' -and $script:EvidenceCalls -eq 1) 'COMPLETED_PATH_CHANGED'
}
Run-Case 'finish rejection keeps lease and does not publish terminal success' {
  Reset-Case; $script:FinishError='REVISION_CONFLICT'
  $observed=$null
  try { Invoke-PinnedBridgeCycle } catch { $observed=$_.Exception.Message }
  Assert-Case ($observed -ceq 'REVISION_CONFLICT' -and $script:LeaseId -ceq 'mock-lease' -and $script:States.Count -eq 0) 'FINISH_FAILURE_MASKED'
}
Write-Output "PASS: $script:Passed terminal bridge scenarios; no runtime operations."
