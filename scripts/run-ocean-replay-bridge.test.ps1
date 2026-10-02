$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'run-ocean-replay-bridge.ps1'
$source = [IO.File]::ReadAllText($scriptPath)

if ($source -cnotmatch 'run-manager/\(claim\|renew\|activate\|pin\|evidence\|progress\|finish\)') {
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

Write-Output 'PASS: Replay bridge finalizes drained COMPLETING runs and binds its versioned identity from validated configuration.'
