$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'run-ocean-replay-bridge.ps1'
$source = [IO.File]::ReadAllText($scriptPath)

if ($source -cnotmatch 'run-manager/\(claim\|renew\|activate\|pin\|evidence\|progress\|end\|finish\)') {
  throw 'FINISH_ROUTE_NOT_ALLOWED'
}
if (-not $source.Contains("if (`$context.state -eq 'COMPLETING') {") -or
    -not $source.Contains("`$context = Invoke-Mutation 'finish'") -or
    -not $source.Contains('expected_revision=[int]$context.revision')) {
  throw 'COMPLETING_RUN_NOT_FINALIZED'
}
if ($source.IndexOf("Invoke-Mutation 'progress'", [StringComparison]::Ordinal) -ge
    $source.IndexOf("if (`$context.state -eq 'COMPLETING')", [StringComparison]::Ordinal)) {
  throw 'FINISH_MUST_FOLLOW_DRAINED_PROGRESS'
}
if (-not $source.Contains('$binding.identity_id -cne $Config.identity_id') -or
    -not $source.Contains('$binding.credential_ref -cne $Config.credential_ref')) {
  throw 'CREDENTIAL_BINDING_MUST_BE_CONFIG_SCOPED'
}
if ($source.Contains('test-cicd-vwap-pull-back-replay-two-v012-telemetry') -or
    $source.Contains('OCEAN_VWAP_PULLBACK_REPLAY_TWO_V012_TELEMETRY_TOKEN')) {
  throw 'VERSIONED_IDENTITY_MUST_NOT_BE_HARDCODED'
}
if (-not $source.Contains('$binding.expires_at_utc -is [DateTime]') -or
    -not $source.Contains('[Globalization.CultureInfo]::InvariantCulture')) {
  throw 'DPAPI_EXPIRY_PARSE_MUST_BE_CULTURE_SAFE'
}
if (-not $source.Contains("'ocean-replay-run-bridge/v4'") -or
    -not $source.Contains("'Ocean workflow operational v1'") -or
    -not $source.Contains("'/api/workflow/operational/v1/run/'") -or
    -not $source.Contains("'/api/workflow/operational/v1/runs/'")) {
  throw 'OPERATIONAL_BRIDGE_ROUTE_REQUIRED'
}
if (-not $source.Contains('$value.factual_binding_hash') -or
    -not $source.Contains('OPERATIONAL_HASH_REJECTED')) {
  throw 'OPERATIONAL_FACTUAL_BINDING_CONFIG_REQUIRED'
}
if (-not $source.Contains("status='AWAITING_HUMAN_RELEASE'") -or
    -not $source.Contains("status='AWAITING_MATCHING_REPLAY_RUN'") -or
    -not $source.Contains('OPERATIONAL_SCOPED_EVENT_ONLY_LIVE_REAL_DISABLED')) {
  throw 'OPERATIONAL_FAIL_CLOSED_STATES_REQUIRED'
}
if (-not $source.Contains('Test-OperationalPhysicalBinding') -or
    -not $source.Contains('EXPECTED_MODULE_NOT_LOADED') -or
    -not $source.Contains('EXPECTED_SIERRA_PROCESS_NOT_RESPONDING') -or
    $source.Contains('EXPECTED_CHARTBOOK_NOT_OPEN')) {
  throw 'OPERATIONAL_PHYSICAL_BINDING_REQUIRED'
}
if (-not $source.Contains('$process.StandardOutput.ReadToEndAsync()') -or
    -not $source.Contains('$process.StandardError.ReadToEndAsync()') -or
    $source.IndexOf('$process.StandardOutput.ReadToEndAsync()', [StringComparison]::Ordinal) -ge
    $source.IndexOf('$process.WaitForExit($TimeoutMilliseconds)', [StringComparison]::Ordinal)) {
  throw 'REDIRECTED_STREAMS_MUST_DRAIN_BEFORE_WAIT'
}
if (-not $source.Contains("Invoke-Mutation 'renew' @{run_id=[string]`$Plan.run_id;lease_id=`$LeaseId}") -or
    -not $source.Contains("`$evidencePlan.completion_receipt.status -ceq 'COMPLETED'") -or
    -not $source.Contains("`$context = Invoke-Mutation 'end'") -or
    $source.IndexOf("Invoke-Mutation 'progress'", [StringComparison]::Ordinal) -ge
    $source.IndexOf("`$context = Invoke-Mutation 'end'", [StringComparison]::Ordinal) -or
    $source.IndexOf("`$context = Invoke-Mutation 'end'", [StringComparison]::Ordinal) -ge
    $source.IndexOf("if (`$context.state -eq 'COMPLETING')", [StringComparison]::Ordinal)) {
  throw 'SEALED_COMPLETION_MUST_RENEW_END_AND_FINISH'
}
if (-not $source.Contains('function ConvertTo-UtcTimestamp($Value)') -or
    -not $source.Contains("ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)") -or
    -not $source.Contains('$watermark = ConvertTo-UtcTimestamp $evidencePlan.watermark')) {
  throw 'JSON_DATE_WATERMARK_MUST_BE_UTC_NORMALIZED'
}

Write-Output 'PASS: Replay bridge preserves TEST behavior and adds a fail-closed, exact-binding OPERATIONAL route without LIVE_REAL authority.'
