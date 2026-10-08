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

$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'BRIDGE_SCRIPT_PARSE_FAILED' }
foreach ($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
  . ([ScriptBlock]::Create($definition.Extent.Text))
}

function Assert-BridgeTest($Condition, [string]$Code) {
  if (-not $Condition) { throw $Code }
}

function Assert-BridgeThrows([ScriptBlock]$Action, [string]$Code) {
  $observed = $null
  try { & $Action } catch { $observed = $_.Exception.Message }
  Assert-BridgeTest ($observed -ceq $Code) ('EXPECTED_' + $Code)
}

# Only disposable mock config files are used; no credential, DB, service or
# physical-process call is made by these executable configuration regressions.
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('ocean-bridge-config-test-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($tempRoot)
$ConfigPath = Join-Path $tempRoot 'bridge.json'
$mockReader = Join-Path $tempRoot 'read-config.mjs'
$Node = 'C:\Program Files\nodejs\node.exe'
[IO.File]::WriteAllText($mockReader, "import fs from 'node:fs'; console.log(fs.readFileSync(process.argv[2], 'utf8'));", [Text.UTF8Encoding]::new($false))
$script:MockConfig = [ordered]@{
  schema_version='ocean-replay-run-bridge/v4'; base_url='http://127.0.0.1:3102'; namespace='OPERATIONAL'
  workflow_db=(Join-Path $tempRoot 'workflow.sqlite'); telemetry_db=(Join-Path $tempRoot 'telemetry.sqlite')
  handoff_path=(Join-Path $tempRoot 'unused-mock-credential'); state_file=(Join-Path $tempRoot 'unused-state.json')
  expected_sierra_exe=(Join-Path $tempRoot 'unused-sierra.exe'); strategy_id='mock-strategy'; instance_id='mock-instance'
  identity_id='mock-telemetry'; credential_ref='OCEAN_MOCK_TOKEN'; expected_telemetry_version='v0.5.542'
  expected_chartbook_path=(Join-Path $tempRoot 'unused-chartbook'); source_preflight_status_path=(Join-Path $tempRoot 'unused-preflight')
  expected_strategy_module_path=(Join-Path $tempRoot 'unused-strategy.dll'); expected_telemetry_module_path=(Join-Path $tempRoot 'unused-telemetry.dll')
  factual_binding_hash=('sha256:' + ('a' * 64)); expected_strategy_module_sha256=('sha256:' + ('a' * 64))
  expected_telemetry_module_sha256=('sha256:' + ('c' * 64)); minimum_schema_version=9
  freshness_seconds=120; expected_chart_number=6; expected_bar_period_seconds=300; poll_seconds=1
}
function Write-MockBridgeConfig {
  [IO.File]::WriteAllText($ConfigPath, ($script:MockConfig | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
$script:MockCycles = 0
function Invoke-PinnedBridgeCycle {
  $script:MockCycles++
  $childConfig = Invoke-BoundedNode $mockReader @($ConfigPath) 15000 'MOCK_CHILD_READER_FAILED' | ConvertFrom-Json
  Assert-BridgeTest ($childConfig.expected_strategy_module_sha256 -ceq $Config.expected_strategy_module_sha256) 'PARENT_CHILD_CONFIG_CONFLICT'
  $writeDenied = $false
  try { [IO.File]::WriteAllText($ConfigPath, 'concurrent replacement') } catch { $writeDenied = $true }
  Assert-BridgeTest $writeDenied 'CYCLE_CONFIG_WRITE_NOT_BLOCKED'
}
try {
  Write-MockBridgeConfig
  $Config = Read-BridgeConfig
  $initialHash = $script:ConfigHash
  Assert-BridgeTest ($initialHash -ceq ('sha256:' + (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant())) 'CONFIG_BYTES_NOT_PINNED'
  Invoke-BridgeCycle
  Invoke-BridgeCycle
  Assert-BridgeTest ($script:MockCycles -eq 2) 'UNCHANGED_CONFIG_CANNOT_CONTINUE'

  $script:Credential = [pscustomobject]@{identity_id='mock-telemetry';token='mock-only'}
  $originalCredential = $script:Credential
  $script:LeaseId = 'mock-owned-lease'
  $script:LeaseRunId = 'mock-active-run'
  $script:MockConfig.expected_strategy_module_sha256 = 'sha256:' + ('b' * 64)
  Write-MockBridgeConfig
  Assert-BridgeThrows { Invoke-BridgeCycle } 'BRIDGE_CONFIG_CHANGED_RESTART_REQUIRED'
  Assert-BridgeTest ($script:MockCycles -eq 2 -and $script:ConfigHash -ceq $initialHash) 'CHANGED_CONFIG_WAS_HOT_RELOADED'
  Assert-BridgeTest ($script:LeaseId -ceq 'mock-owned-lease' -and $script:LeaseRunId -ceq 'mock-active-run' -and
    [Object]::ReferenceEquals($script:Credential,$originalCredential)) 'ACTIVE_IDENTITY_OR_LEASE_CHANGED'

  # A new process may accept the new snapshot, but cannot reuse the old lease.
  $script:LeaseId = $null; $script:LeaseRunId = $null
  $Config = Read-BridgeConfig
  Assert-BridgeTest ($script:ConfigHash -cne $initialHash -and $Config.expected_strategy_module_sha256 -ceq ('sha256:' + ('b' * 64))) 'RESTART_KEPT_STALE_PINS'
  Invoke-BridgeCycle
  Assert-BridgeTest ($script:MockCycles -eq 3) 'RESTART_CANNOT_CONTINUE'

  [IO.File]::WriteAllText($ConfigPath, '{invalid json')
  Assert-BridgeThrows { Invoke-BridgeCycle } 'BRIDGE_CONFIG_CHANGED_RESTART_REQUIRED'
  [IO.File]::Delete($ConfigPath)
  if ([IO.Path]::GetFullPath($mockReader) -cne (Join-Path ([IO.Path]::GetFullPath($tempRoot)) 'read-config.mjs')) { throw 'TEST_CLEANUP_SCOPE_CONFLICT' }
  [IO.File]::Delete($mockReader)
  Assert-BridgeThrows { Invoke-BridgeCycle } 'BRIDGE_CONFIG_UNAVAILABLE_RESTART_REQUIRED'
  Assert-BridgeTest ($script:MockCycles -eq 3) 'INVALID_OR_MISSING_CONFIG_ENTERED_CYCLE'

  # Execute the real outer loop with isolated state/client/credential mocks.
  # A config change between startup and the cycle must escape its retry catch.
  Write-MockBridgeConfig
  $script:MockStates = @(); $script:MockDisposed = $false
  function Read-ProtectedCredential($Config) { return [pscustomobject]@{identity_id='mock-telemetry';token='mock-only'} }
  function New-BridgeClient($Binding) {
    $client = [pscustomobject]@{}
    $client | Add-Member ScriptMethod Dispose { $script:MockDisposed = $true }
    return $client
  }
  function Write-State($State) { $script:MockStates += $State }
  $realCycle = ($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-BridgeCycle'}, $false))[0].Body.GetScriptBlock()
  function Invoke-BridgeCycle {
    $script:MockConfig.identity_id = 'changed-mock-identity'
    Write-MockBridgeConfig
    & $realCycle
  }
  $Once = $true
  $script:LeaseId = 'mock-owned-lease'; $script:LeaseRunId = 'mock-active-run'
  $main = [ScriptBlock]::Create($source.Substring($source.LastIndexOf('$Config = Read-BridgeConfig', [StringComparison]::Ordinal)))
  Assert-BridgeThrows { & $main } 'BRIDGE_CONFIG_CHANGED_RESTART_REQUIRED'
  Assert-BridgeTest ($script:MockStates.Count -eq 1 -and $script:MockStates[0].status -ceq 'RESTART_REQUIRED' -and
    $script:MockStates[0].run_id -ceq 'mock-active-run') 'CONFIG_CHANGE_RETRIED_INFINITELY'
  Assert-BridgeTest ($script:MockDisposed -and $null -eq $script:Credential.token) 'RESTART_DID_NOT_DISPOSE_CLIENT_OR_CLEAR_TOKEN'
  Assert-BridgeTest ($script:LeaseId -ceq 'mock-owned-lease') 'RESTART_MUTATED_SERVER_LEASE'
} finally {
  # No recursive cleanup or computed paths outside the unique fixture directory.
  if ([IO.Path]::GetFullPath($ConfigPath) -cne (Join-Path ([IO.Path]::GetFullPath($tempRoot)) 'bridge.json')) { throw 'TEST_CLEANUP_SCOPE_CONFLICT' }
  [IO.File]::Delete($ConfigPath)
  [IO.Directory]::Delete($tempRoot)
}

Write-Output 'PASS: TEST/OPERATIONAL bridge gates and executable config snapshot, child consistency, active-lease fail-closed exit and restart regressions.'
