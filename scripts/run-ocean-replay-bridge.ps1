param(
  [string]$ConfigPath = 'D:\Paperclip-codex\website\ocean-trading\dashboard\config\replay-run-bridge.json',
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
# Node callers may inherit another PowerShell engine's module search path.
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Add-Type -AssemblyName System.Net.Http
$Node = 'C:\Program Files\nodejs\node.exe'
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Probe = Join-Path $RepositoryRoot 'website\ocean-trading\dashboard\workflow\replay-run-bridge-probe.mjs'
$EvidenceBuilder = Join-Path $RepositoryRoot 'website\ocean-trading\dashboard\workflow\replay-run-evidence.mjs'
$script:Credential = $null
$script:Client = $null
$script:Sequence = 0
$script:LeaseId = $null
$script:LeaseRunId = $null
$script:Namespace = $null
$script:ConfigHash = $null

function Get-BridgeConfigHash([byte[]]$Bytes) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return 'sha256:' + ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose() }
}

function Read-BridgeConfig {
  $bytes = [IO.File]::ReadAllBytes($ConfigPath)
  $value = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json
  if ($value.schema_version -notin @('ocean-replay-run-bridge/v3','ocean-replay-run-bridge/v4') -or $value.base_url -cne 'http://127.0.0.1:3102') { throw 'BRIDGE_CONFIG_REJECTED' }
  $operational = $value.schema_version -ceq 'ocean-replay-run-bridge/v4'
  foreach ($key in @('workflow_db','telemetry_db','handoff_path','expected_sierra_exe','state_file')) {
    if (-not [IO.Path]::IsPathRooted([string]$value.$key) -or ([string]$value.$key).StartsWith('\\')) { throw 'LOCAL_PATH_REQUIRED' }
  }
  if ($value.strategy_id -cnotmatch '^[a-z0-9]+(?:[_-][a-z0-9]+)*$') { throw 'BRIDGE_SCOPE_REJECTED' }
  if ($operational) {
    foreach ($key in @('expected_chartbook_path','expected_strategy_module_path','expected_telemetry_module_path','source_preflight_status_path')) {
      if (-not [IO.Path]::IsPathRooted([string]$value.$key) -or ([string]$value.$key).StartsWith('\\')) { throw 'LOCAL_PATH_REQUIRED' }
    }
    if ($value.namespace -cne 'OPERATIONAL' -or $value.instance_id.StartsWith('test-') -or $value.instance_id -cnotmatch '^[A-Za-z0-9_.:-]+$') { throw 'BRIDGE_SCOPE_REJECTED' }
    if ($value.factual_binding_hash -cnotmatch '^sha256:[a-f0-9]{64}$' -or
        $value.expected_strategy_module_sha256 -cnotmatch '^sha256:[a-f0-9]{64}$' -or
        $value.expected_telemetry_module_sha256 -cnotmatch '^sha256:[a-f0-9]{64}$') { throw 'OPERATIONAL_HASH_REJECTED' }
    if ([int]$value.minimum_schema_version -lt 9 -or [int]$value.freshness_seconds -lt 30 -or [int]$value.freshness_seconds -gt 300 -or
        [int]$value.expected_chart_number -lt 1 -or [int]$value.expected_bar_period_seconds -ne 300) { throw 'OPERATIONAL_SOURCE_POLICY_REJECTED' }
  } elseif ($value.instance_id -cnotmatch '^test-[A-Za-z0-9_.:-]+$') { throw 'BRIDGE_SCOPE_REJECTED' }
  if ($value.expected_telemetry_version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'TELEMETRY_VERSION_REJECTED' }
  if ((-not $operational -and $value.identity_id -cne ($value.instance_id + '-telemetry')) -or
      $value.identity_id -cnotmatch '^[A-Za-z0-9_.:-]+$' -or $value.credential_ref -cnotmatch '^OCEAN_[A-Z0-9_]+_TOKEN$') { throw 'BRIDGE_IDENTITY_REJECTED' }
  $script:ConfigHash = Get-BridgeConfigHash $bytes
  return $value
}

function Open-BridgeConfigGuard {
  if (-not $script:ConfigHash) { throw 'BRIDGE_CONFIG_SNAPSHOT_REQUIRED' }
  $stream = $null
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    # Keep the path stable and deny writes/deletion while child readers and
    # lease mutations use the same startup configuration snapshot.
    $stream = [IO.File]::Open($ConfigPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $observed = 'sha256:' + ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
    if ($observed -cne $script:ConfigHash) { throw 'BRIDGE_CONFIG_CHANGED_RESTART_REQUIRED' }
    return $stream
  } catch {
    if ($stream) { $stream.Dispose() }
    if ($_.Exception.Message -ceq 'BRIDGE_CONFIG_CHANGED_RESTART_REQUIRED') { throw }
    throw 'BRIDGE_CONFIG_UNAVAILABLE_RESTART_REQUIRED'
  } finally { $hash.Dispose() }
}

function Read-ProtectedCredential($Config) {
  $secure = [IO.File]::ReadAllText($Config.handoff_path) | ConvertTo-SecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $binding = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) | ConvertFrom-Json }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
  $expires = if ($binding.expires_at_utc -is [DateTime]) {
    [DateTimeOffset]::new([DateTime]::SpecifyKind([DateTime]$binding.expires_at_utc,[DateTimeKind]::Utc))
  } else {
    [DateTimeOffset]::Parse([string]$binding.expires_at_utc,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal)
  }
  $expectedAudience = if ($Config.schema_version -ceq 'ocean-replay-run-bridge/v4') { 'Ocean workflow operational v1' } else { 'Ocean workflow TEST' }
  if ($binding.identity_id -cne $Config.identity_id -or
      $binding.credential_ref -cne $Config.credential_ref -or
      $binding.audience -cne $expectedAudience -or $binding.revoked -or
      $expires -le [DateTimeOffset]::UtcNow) { throw 'CREDENTIAL_BINDING_REJECTED' }
  return $binding
}

function New-BridgeClient($Binding) {
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $handler.UseCookies = $false
  $handler.UseProxy = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(10)
  $client.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', [string]$Binding.token)
  return $client
}

function Invoke-OceanRequest([string]$Method, [string]$Route, $Body = $null) {
  if ($Route -cnotmatch '^/api/workflow/(status|health|run-manager/context/[A-Za-z0-9_.:-]+|run-manager/(claim|renew|activate|reconcile|pin|evidence|progress|end|finish)|operational/v1/runs/[A-Za-z0-9_.:-]+|operational/v1/run/(claim|renew|activate|reconcile|pin|evidence|progress|end|finish))$') { throw 'ROUTE_REJECTED' }
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), ($Config.base_url + $Route))
  try {
    if ($null -ne $Body) {
      $json = $Body | ConvertTo-Json -Depth 50 -Compress
      $request.Content = [Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
    }
    $response = $script:Client.SendAsync($request).GetAwaiter().GetResult()
    try {
      $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if (-not $response.IsSuccessStatusCode) {
        $code = 'OCEAN_REQUEST_REJECTED'
        try { $code = ($text | ConvertFrom-Json).error.code } catch {}
        throw $code
      }
      return $text | ConvertFrom-Json
    } finally { $response.Dispose() }
  } finally { $request.Dispose() }
}

function Invoke-Mutation([string]$Action, $Data) {
  if ($script:Namespace -ceq 'OPERATIONAL') {
    return Invoke-OceanRequest 'POST' ('/api/workflow/operational/v1/run/' + $Action) $Data
  }
  $script:Sequence++
  $messageId = 'test-replay-bridge-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '-' + $script:Sequence
  return Invoke-OceanRequest 'POST' ('/api/workflow/run-manager/' + $Action) @{ message_id=$messageId; data=$Data }
}

function Get-RunContext([string]$RunId) {
  if ($script:Namespace -ceq 'OPERATIONAL') {
    return Invoke-OceanRequest 'GET' ('/api/workflow/operational/v1/runs/' + $RunId)
  }
  return Invoke-OceanRequest 'GET' ('/api/workflow/run-manager/context/' + $RunId)
}

function New-ObservedSourceState($Probe) {
  return @{
    observed_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    environment='REPLAY'
    simulation=$true
    replay=$true
    account_alias=$Config.account_alias
    source_schema_version=[string]$Probe.telemetry.source_schema_version
    quality='VERIFIED'
  }
}

function Test-BridgeWindowsPath([string]$Left, [string]$Right) {
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right) -or
      -not [IO.Path]::IsPathRooted($Left) -or -not [IO.Path]::IsPathRooted($Right)) { return $false }
  try {
    return [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right))
  } catch { return $false }
}

function Test-OperationalPhysicalBinding($BridgeConfig) {
  if ($BridgeConfig.schema_version -cne 'ocean-replay-run-bridge/v4') { return }
  foreach ($pair in @(
    @([string]$BridgeConfig.expected_strategy_module_path,[string]$BridgeConfig.expected_strategy_module_sha256),
    @([string]$BridgeConfig.expected_telemetry_module_path,[string]$BridgeConfig.expected_telemetry_module_sha256)
  )) {
    if (-not [IO.File]::Exists($pair[0])) { throw 'EXPECTED_MODULE_MISSING' }
    $observedHash = 'sha256:' + (Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($observedHash -cne $pair[1]) { throw 'EXPECTED_MODULE_HASH_MISMATCH' }
  }
  $expectedExe = [IO.Path]::GetFullPath([string]$BridgeConfig.expected_sierra_exe)
  $matches = @(Get-Process -Name 'SierraChart_64' -ErrorAction SilentlyContinue | Where-Object {
    Test-BridgeWindowsPath ([string]$_.Path) $expectedExe
  })
  if ($matches.Count -ne 1) { throw 'EXACT_SIERRA_PROCESS_REQUIRED' }
  $process = $matches[0]
  $modulePaths = @($process.Modules | ForEach-Object { [IO.Path]::GetFullPath([string]$_.FileName) })
  foreach ($modulePath in @([string]$BridgeConfig.expected_strategy_module_path,[string]$BridgeConfig.expected_telemetry_module_path)) {
    $expectedPath = [IO.Path]::GetFullPath($modulePath)
    if (-not ($modulePaths | Where-Object { Test-BridgeWindowsPath $_ $expectedPath })) { throw 'EXPECTED_MODULE_NOT_LOADED' }
  }
  # Sierra's main-window title is mutable and commonly shows the active chart
  # rather than the chartbook name. Exact process/module binding is verified
  # here; chart number, symbol, bar period and stopped Replay state are proved
  # by the fresh strategy-owned source preflight before release.
  if (-not $process.Responding) { throw 'EXPECTED_SIERRA_PROCESS_NOT_RESPONDING' }
}

function Invoke-BoundedNode([string]$Script, [string[]]$Arguments, [int]$TimeoutMilliseconds, [string]$FailureCode) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Node
  $quoted = @($Script) + $Arguments | ForEach-Object { '"' + ([string]$_).Replace('"','\"') + '"' }
  $start.Arguments = $quoted -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw $FailureCode }
    # Drain both redirected streams while the child is running. Waiting first can
    # deadlock once a multi-trade evidence plan fills an OS pipe buffer.
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      try { $process.Kill() } catch {}
      $process.WaitForExit()
      throw ($FailureCode + '_TIMEOUT')
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw $FailureCode }
    return $stdout
  } finally { $process.Dispose() }
}

function Get-Probe {
  $raw = Invoke-BoundedNode $Probe @($ConfigPath) 15000 'BRIDGE_PROBE_FAILED'
  return $raw | ConvertFrom-Json
}

function Get-EvidencePlan([string]$RunId) {
  $raw = Invoke-BoundedNode $EvidenceBuilder @($ConfigPath,$RunId) 30000 'REPLAY_EVIDENCE_PLAN_FAILED'
  return $raw | ConvertFrom-Json
}

function ConvertTo-UtcTimestamp($Value) {
  if ($Value -is [DateTime]) {
    return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
  }
  if ($Value -is [DateTimeOffset]) {
    return $Value.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
  }
  return [string]$Value
}

function Submit-EvidencePlan($Plan, [string]$LeaseId) {
  $actionIndex = 0
  foreach ($action in @($Plan.actions)) {
    if ($actionIndex -gt 0 -and $actionIndex % 30 -eq 0) {
      $null = Invoke-Mutation 'renew' @{run_id=[string]$Plan.run_id;lease_id=$LeaseId}
    }
    $data = @{}
    foreach ($property in $action.data.PSObject.Properties) { $data[$property.Name] = $property.Value }
    $data.lease_id = $LeaseId
    if ($action.type -in @('pin-open','pin-close')) { $null = Invoke-Mutation 'pin' $data }
    elseif ($action.type -ceq 'evidence') { $null = Invoke-Mutation 'evidence' $data }
    else { throw 'REPLAY_EVIDENCE_ACTION_REJECTED' }
    $actionIndex++
  }
}

function Write-AtomicJson([string]$Path, $Value) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temp = $Path + '.next'
  [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Get-BridgeHealthPath {
  return ([string]$Config.state_file + '.health.json')
}

function Get-LastAuthenticatedRunIdentity {
  if (-not [IO.File]::Exists([string]$Config.state_file)) { return $null }
  try {
    $state = [IO.File]::ReadAllText([string]$Config.state_file) | ConvertFrom-Json
    if ($state.config_sha256 -cne $script:ConfigHash) { return $null }
    if ($state.identity_fresh -eq $false -and $state.last_authenticated_run_identity) {
      $preserved = $state.last_authenticated_run_identity
      if ($preserved.config_sha256 -cne $script:ConfigHash -or [string]::IsNullOrWhiteSpace([string]$preserved.run_id)) { return $null }
      return [ordered]@{
        run_id=[string]$preserved.run_id
        run_state=[string]$preserved.run_state
        observed_at_utc=[string]$preserved.observed_at_utc
        config_sha256=[string]$preserved.config_sha256
      }
    }
    if ([string]::IsNullOrWhiteSpace([string]$state.run_id)) { return $null }
    return [ordered]@{
      run_id=[string]$state.run_id
      run_state=[string]$state.run_state
      observed_at_utc=[string]$state.updated_at_utc
      config_sha256=[string]$state.config_sha256
    }
  } catch { return $null }
}

function Get-BridgeFailureReason($FailureRecord) {
  $message = [string]$FailureRecord.Exception.Message
  if ($message -cmatch '^[A-Z][A-Z0-9_]{1,100}$') { return $message }
  if ($message -match '(?i)database is locked|sqlite.*busy|busy.*sqlite') { return 'TRANSIENT_WORKFLOW_STATE_UNAVAILABLE' }
  if ($message -match '(?i)timed?\s*out|timeout') { return 'TRANSIENT_DEPENDENCY_TIMEOUT' }
  if ($message -match '(?i)actively refused|connection refused|unable to connect|no connection could be made') { return 'TRANSIENT_OCEAN_UNAVAILABLE' }
  return 'BRIDGE_CYCLE_FAILED'
}

function Get-BridgeFailureDetail($FailureRecord) {
  $message = [string]$FailureRecord.Exception.Message
  if ([string]::IsNullOrWhiteSpace($message)) { return $null }
  $message = [Regex]::Replace($message, '(?i)(bearer\s+)[^\s,;]+', '$1[REDACTED]')
  $message = [Regex]::Replace($message, '(?i)(token\s*[=:]\s*)[^\s,;]+', '$1[REDACTED]')
  if ($message.Length -gt 512) { $message = $message.Substring(0,512) }
  return $message
}

function Write-BridgeHealth([string]$Status, [string]$ReasonCode, $LastAuthenticatedRunIdentity, [string]$FailureDetail = $null) {
  $health = [ordered]@{
    schema_version='ocean-replay-bridge-health/v1'
    status=$Status
    reason_code=$ReasonCode
    identity_fresh=($Status -ceq 'HEALTHY')
    last_authenticated_run_identity=$LastAuthenticatedRunIdentity
    failure_detail=$FailureDetail
    updated_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
    pid=$PID
    config_sha256=$script:ConfigHash
  }
  Write-AtomicJson (Get-BridgeHealthPath) $health
}

function Write-State($State, [switch]$SuppressHealthyReceipt) {
  $State.updated_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
  $State.pid = $PID
  $State.config_sha256 = $script:ConfigHash
  if (-not $State.Contains('identity_fresh')) { $State.identity_fresh = $true }
  Write-AtomicJson ([string]$Config.state_file) $State
  if (-not $SuppressHealthyReceipt) {
    $identity = if ([string]::IsNullOrWhiteSpace([string]$State.run_id)) { $null } else {
      [ordered]@{run_id=[string]$State.run_id;run_state=[string]$State.run_state;observed_at_utc=[string]$State.updated_at_utc;config_sha256=$script:ConfigHash}
    }
    Write-BridgeHealth 'HEALTHY' $null $identity
  }
}

function Publish-BridgeCycleFailure($FailureRecord, [bool]$RestartRequired) {
  $reason = Get-BridgeFailureReason $FailureRecord
  $detail = Get-BridgeFailureDetail $FailureRecord
  $lastIdentity = Get-LastAuthenticatedRunIdentity
  $status = if ($RestartRequired) { 'RESTART_REQUIRED' } else { 'DEGRADED' }

  # Health is published first so a crash during state projection cannot erase
  # the reason for the failed cycle or present preserved identity as fresh.
  Write-BridgeHealth $status $reason $lastIdentity $detail
  $state = [ordered]@{
    status=$status
    error=$reason
    identity_fresh=$false
    last_authenticated_run_identity=$lastIdentity
    run_id=if ($lastIdentity) { [string]$lastIdentity.run_id } else { $null }
    run_state=if ($lastIdentity) { [string]$lastIdentity.run_state } else { $null }
    safety=if ($script:Namespace -ceq 'OPERATIONAL') { 'OPERATIONAL_SCOPED_EVENT_ONLY_LIVE_REAL_DISABLED' } else { 'TEST_ONLY_INGESTION_OFF' }
  }
  if ($RestartRequired) {
    $state.next_action = 'Restart only ReplayBridge through the existing Ocean service lifecycle; revalidate current config and protected identity. Existing run leases expire normally; no binding is hot-swapped.'
  }
  Write-State $state -SuppressHealthyReceipt
}

function Invoke-BridgeCycle {
  $guard = Open-BridgeConfigGuard
  try { Invoke-PinnedBridgeCycle }
  finally { $guard.Dispose() }
}

function Invoke-PinnedBridgeCycle {
  if (Complete-VerifiedFailedAttempt) { return }
  $probe = Get-Probe
  if (-not $probe.run) {
    $safety = if ($script:Namespace -ceq 'OPERATIONAL') { 'OPERATIONAL_SCOPED_EVENT_ONLY_LIVE_REAL_DISABLED' } else { 'TEST_ONLY_INGESTION_OFF' }
    Write-State ([ordered]@{ status='IDLE'; run_id=$null; telemetry=$probe.telemetry; safety=$safety })
    return
  }
  $runId = [string]$probe.run.id
  if ($script:LeaseRunId -and $script:LeaseRunId -cne $runId) {
    $script:LeaseId = $null
    $script:LeaseRunId = $null
  }
  $context = Get-RunContext $runId
  $evidencePlan = Get-EvidencePlan $runId
  if ($script:Namespace -ceq 'OPERATIONAL' -and $context.state -eq 'READY') {
    if ($evidencePlan.status -cne 'READY') {
      Test-OperationalPhysicalBinding $Config
    }
    if ($evidencePlan.status -cne 'READY' -and -not $probe.telemetry.preflight_verified) {
      Write-State ([ordered]@{status='AWAITING_SOURCE_PREFLIGHT';run_id=$runId;run_state=$context.state;telemetry=$probe.telemetry;safety='OPERATIONAL_SCOPED_EVENT_ONLY_LIVE_REAL_DISABLED'})
      return
    }
    $source = New-ObservedSourceState $probe
    $sourceHandshake = @{instance=$context.plan.instance;source_state=$source;context_hash=$context.context.context_hash}
    $releaseRecorded = [string]$probe.run.release_context_hash -ceq [string]$context.context.context_hash
    if (-not $releaseRecorded) {
      $releaseRequest = @{
        environment='REPLAY'
        strategy_id=$Config.strategy_id
        instance_id=$Config.instance_id
        run_id=$runId
        context_hash=$context.context.context_hash
        source_handshake=$sourceHandshake
      }
      Write-State ([ordered]@{status='AWAITING_HUMAN_RELEASE';run_id=$runId;run_state=$context.state;telemetry=$probe.telemetry;release_recorded=$false;release_request=$releaseRequest;safety='OPERATIONAL_SCOPED_EVENT_ONLY_LIVE_REAL_DISABLED'})
      return
    }
    if ($evidencePlan.status -cne 'READY' -and -not $probe.telemetry.verified) {
      Write-State ([ordered]@{status='AWAITING_MATCHING_REPLAY_RUN';run_id=$runId;run_state=$context.state;telemetry=$probe.telemetry;release_recorded=$true;safety='OPERATIONAL_SCOPED_EVENT_ONLY_LIVE_REAL_DISABLED'})
      return
    }
  }
  $lease = $context.lease
  if (-not $lease -or $lease.expired) {
    $claimed = Invoke-Mutation 'claim' @{run_id=$runId;expected_revision=[int]$context.revision}
    $leaseId = [string]$claimed.lease_id
    $script:LeaseId = $leaseId
    $script:LeaseRunId = $runId
  } elseif ($lease.owner_id -ceq $script:Credential.identity_id -and -not $lease.expired -and
            $script:LeaseRunId -ceq $runId -and $script:LeaseId) {
    $leaseId = [string]$script:LeaseId
  } elseif ($lease.owner_id -ceq $script:Credential.identity_id -and -not $lease.expired) {
    # Lease identifiers are deliberately absent from readback. A restarted
    # bridge waits for the bounded owner lease to expire, then claims a fresh
    # lease instead of reading protected state directly from SQLite.
    throw 'OWNER_LEASE_RECOVERY_WAIT'
  } else { throw 'FOREIGN_OR_UNAVAILABLE_RUN_LEASE' }

  if ($context.state -eq 'READY') {
    if ($evidencePlan.status -ceq 'READY') {
      $context = Invoke-Mutation 'reconcile' @{
        run_id=$runId
        lease_id=$leaseId
        expected_revision=[int]$context.revision
        completion_receipt=$evidencePlan.completion_receipt
        evidence_image_sha256=[string]$evidencePlan.evidence_image.sha256
      }
    } else {
      if (-not $probe.telemetry.verified) { throw 'TELEMETRY_BINDING_NOT_VERIFIED' }
      $source = New-ObservedSourceState $probe
      $context = Invoke-Mutation 'activate' @{
        run_id=$runId
        lease_id=$leaseId
        expected_revision=[int]$context.revision
        observed_handshake=@{instance=$context.plan.instance;source_state=$source;plan_hash=$context.plan.plan_hash;context_hash=$context.context.context_hash}
      }
    }
  } else {
    $context = Invoke-Mutation 'renew' @{run_id=$runId;lease_id=$leaseId}
  }

  $reconciliation = $null
  if ($context.state -in @('ACTIVE','COMPLETING')) {
    if ($evidencePlan.status -ceq 'READY') {
      Submit-EvidencePlan $evidencePlan $leaseId
      $reconciliation = [ordered]@{status=$evidencePlan.status;evidence_image=$evidencePlan.evidence_image;metrics=$evidencePlan.metrics;action_count=@($evidencePlan.actions).Count}
      $axes = @{source_market=@($evidencePlan.scored_intervals);strategy_execution=@($evidencePlan.scored_intervals);processing_review=@($evidencePlan.scored_intervals)}
      $watermark = ConvertTo-UtcTimestamp $evidencePlan.watermark
    } elseif ($evidencePlan.status -in @('AWAITING_SIERRA_EVIDENCE_IMAGE','AWAITING_REPLAY_COMPLETION') -and $context.state -ceq 'ACTIVE') {
      $reconciliation = [ordered]@{status=$evidencePlan.status;evidence_image=$evidencePlan.evidence_image;metrics=$null;action_count=0}
      $axes = @{source_market=@();strategy_execution=@();processing_review=@()}
      $watermark = $null
    } else { throw 'REPLAY_EVIDENCE_NOT_READY' }
    $context = Invoke-Mutation 'progress' @{
      run_id=$runId
      lease_id=$leaseId
      axes=$axes
      watermark=$watermark
      pending_events=0
      gaps=@()
      failures=@()
    }
    if ($evidencePlan.status -ceq 'READY' -and $context.state -ceq 'ACTIVE' -and
        $evidencePlan.completion_receipt.status -ceq 'COMPLETED') {
      $context = Invoke-Mutation 'end' @{
        run_id=$runId
        expected_revision=[int]$context.revision
        outcome='COMPLETED'
      }
    }
  }
  if ($context.state -eq 'COMPLETING') {
    $context = Invoke-Mutation 'finish' @{
      run_id=$runId
      lease_id=$leaseId
      expected_revision=[int]$context.revision
    }
    $script:LeaseId = $null
    $script:LeaseRunId = $null
  }
  if ($script:Namespace -ceq 'TEST') {
    $healthBody = @{
      message_id=('test-replay-bridge-health-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      data=@{strategy_id=$Config.strategy_id;instance_id=$Config.instance_id;status='READY';next_owner=$script:Credential.identity_id;next_action='Continue scoped Replay telemetry observation'}
    }
    $null = Invoke-OceanRequest 'POST' '/api/workflow/health' $healthBody
  }
  $safety = if ($script:Namespace -ceq 'OPERATIONAL') { 'OPERATIONAL_SCOPED_EVENT_ONLY_LIVE_REAL_DISABLED' } else { 'TEST_ONLY_SCOPED_REPLAY_EVIDENCE' }
  Write-State ([ordered]@{status='ACTIVE';run_id=$runId;run_state=$context.state;lease_id=$leaseId;telemetry=$probe.telemetry;reconciliation=$reconciliation;safety=$safety})
}

function Complete-VerifiedFailedAttempt {
  if ($script:Namespace -cne 'OPERATIONAL') { return $false }
  $failure = Get-EvidencePlan '--failure-only'
  if ($failure.status -ceq 'NO_TERMINAL_FAILURE') { return $false }
  if ($failure.status -cne 'TERMINAL_FAILURE_READY' -or $failure.failure_proof_hash -cnotmatch '^sha256:[a-f0-9]{64}$') { throw 'FAILURE_PROOF_NOT_READY' }
  $runId = [string]$failure.run_id
  $context = Get-RunContext $runId
  if ($context.state -notin @('READY','ACTIVE','COMPLETING')) { throw 'FAILURE_RUN_STATE_REJECTED' }
  if (-not $context.lease -or $context.lease.expired) {
    $claimed = Invoke-Mutation 'claim' @{run_id=$runId;expected_revision=[int]$context.revision}
    $script:LeaseId = [string]$claimed.lease_id; $script:LeaseRunId = $runId
  } elseif ($context.lease.owner_id -cne $script:Credential.identity_id) { throw 'FOREIGN_OR_UNAVAILABLE_RUN_LEASE' }
  elseif ($script:LeaseRunId -cne $runId -or -not $script:LeaseId) { throw 'OWNER_LEASE_RECOVERY_WAIT' }
  $leaseId = $script:LeaseId
  $context = Invoke-Mutation 'renew' @{run_id=$runId;lease_id=$leaseId}
  if ($context.state -in @('READY','ACTIVE')) {
    $context = Invoke-Mutation 'end' @{run_id=$runId;lease_id=$leaseId;expected_revision=[int]$context.revision;outcome='FAILED';failure_proof_hash=[string]$failure.failure_proof_hash}
  }
  if ($context.state -ceq 'COMPLETING') {
    $context = Invoke-Mutation 'finish' @{run_id=$runId;lease_id=$leaseId;expected_revision=[int]$context.revision}
  }
  if ($context.state -cne 'FAILED') { throw 'FAILED_ATTEMPT_NOT_RECONCILED' }
  $script:LeaseId = $null; $script:LeaseRunId = $null
  Write-State ([ordered]@{status='FAILED_ATTEMPT_RECONCILED';run_id=$runId;run_state='FAILED';physical_execution='STOPPED';failure_proof_hash=$failure.failure_proof_hash;full_requested_coverage_verified=$false;next_action=$context.execution.next_action;safety='OPERATIONAL_SCOPED_EVENT_ONLY_LIVE_REAL_DISABLED'})
  return $true
}

$bridgeMutex = [Threading.Mutex]::new($false, 'Local\OceanTrading-ReplayBridge')
$bridgeMutexAcquired = $false
try {
  try { $bridgeMutexAcquired = $bridgeMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $bridgeMutexAcquired = $true }
  if (-not $bridgeMutexAcquired) { return }

  $Config = Read-BridgeConfig
  $script:Namespace = if ($Config.schema_version -ceq 'ocean-replay-run-bridge/v4') { 'OPERATIONAL' } else { 'TEST' }
  $startupGuard = Open-BridgeConfigGuard
  try {
    $script:Credential = Read-ProtectedCredential $Config
    $script:Client = New-BridgeClient $script:Credential
  } finally { $startupGuard.Dispose() }
  do {
    try { Invoke-BridgeCycle }
    catch {
      $restartRequired = $_.Exception.Message -in @('BRIDGE_CONFIG_CHANGED_RESTART_REQUIRED','BRIDGE_CONFIG_UNAVAILABLE_RESTART_REQUIRED')
      Publish-BridgeCycleFailure $_ $restartRequired
      if ($restartRequired) { throw $_.Exception.Message }
    }
    if (-not $Once) { Start-Sleep -Seconds ([int]$Config.poll_seconds) }
  } while (-not $Once)
} finally {
  if ($script:Client) { $script:Client.Dispose() }
  if ($script:Credential) { $script:Credential.token = $null }
  if ($bridgeMutexAcquired) { $bridgeMutex.ReleaseMutex() }
  $bridgeMutex.Dispose()
}
