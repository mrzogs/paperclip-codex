param(
  [string]$ConfigPath = 'D:\Paperclip-codex\website\ocean-trading\dashboard\config\replay-run-bridge.json',
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$Node = 'C:\Program Files\nodejs\node.exe'
$Probe = 'D:\Paperclip-codex\website\ocean-trading\dashboard\workflow\replay-run-bridge-probe.mjs'
$EvidenceBuilder = 'D:\Paperclip-codex\website\ocean-trading\dashboard\workflow\replay-run-evidence.mjs'
$script:Credential = $null
$script:Client = $null
$script:Sequence = 0
$script:LeaseId = $null
$script:LeaseRunId = $null

function Read-BridgeConfig {
  $value = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if ($value.schema_version -cne 'ocean-replay-run-bridge/v3' -or $value.base_url -cne 'http://127.0.0.1:3102') { throw 'BRIDGE_CONFIG_REJECTED' }
  foreach ($key in @('workflow_db','telemetry_db','handoff_path','expected_sierra_exe','state_file')) {
    if (-not [IO.Path]::IsPathRooted([string]$value.$key) -or ([string]$value.$key).StartsWith('\\')) { throw 'LOCAL_PATH_REQUIRED' }
  }
  if ($value.instance_id -cnotmatch '^test-[A-Za-z0-9_.:-]+$' -or $value.strategy_id -cnotmatch '^[a-z0-9]+(?:[_-][a-z0-9]+)*$') { throw 'BRIDGE_SCOPE_REJECTED' }
  if ($value.expected_telemetry_version -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'TELEMETRY_VERSION_REJECTED' }
  if ($value.identity_id -cne ($value.instance_id + '-telemetry') -or $value.credential_ref -cnotmatch '^OCEAN_[A-Z0-9_]+_TOKEN$') { throw 'BRIDGE_IDENTITY_REJECTED' }
  return $value
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
  if ($binding.identity_id -cne $Config.identity_id -or
      $binding.credential_ref -cne $Config.credential_ref -or
      $binding.audience -cne 'Ocean workflow TEST' -or $binding.revoked -or
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
  if ($Route -cnotmatch '^/api/workflow/(status|health|run-manager/context/[A-Za-z0-9_.:-]+|run-manager/(claim|renew|activate|pin|evidence|progress|finish))$') { throw 'ROUTE_REJECTED' }
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
  $script:Sequence++
  $messageId = 'test-replay-bridge-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '-' + $script:Sequence
  return Invoke-OceanRequest 'POST' ('/api/workflow/run-manager/' + $Action) @{ message_id=$messageId; data=$Data }
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
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      try { $process.Kill() } catch {}
      $process.WaitForExit()
      throw ($FailureCode + '_TIMEOUT')
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
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

function Submit-EvidencePlan($Plan, [string]$LeaseId) {
  foreach ($action in @($Plan.actions)) {
    $data = @{}
    foreach ($property in $action.data.PSObject.Properties) { $data[$property.Name] = $property.Value }
    $data.lease_id = $LeaseId
    if ($action.type -in @('pin-open','pin-close')) { $null = Invoke-Mutation 'pin' $data }
    elseif ($action.type -ceq 'evidence') { $null = Invoke-Mutation 'evidence' $data }
    else { throw 'REPLAY_EVIDENCE_ACTION_REJECTED' }
  }
}

function Write-State($State) {
  $directory = Split-Path -Parent $Config.state_file
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $State.updated_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
  $State.pid = $PID
  $temp = $Config.state_file + '.next'
  [IO.File]::WriteAllText($temp, ($State | ConvertTo-Json -Depth 30))
  Move-Item -LiteralPath $temp -Destination $Config.state_file -Force
}

function Invoke-BridgeCycle {
  $probe = Get-Probe
  if (-not $probe.run) {
    Write-State ([ordered]@{ status='IDLE'; run_id=$null; telemetry=$probe.telemetry; safety='TEST_ONLY_INGESTION_OFF' })
    return
  }
  $runId = [string]$probe.run.id
  if ($script:LeaseRunId -and $script:LeaseRunId -cne $runId) {
    $script:LeaseId = $null
    $script:LeaseRunId = $null
  }
  $context = Invoke-OceanRequest 'GET' ('/api/workflow/run-manager/context/' + $runId)
  $lease = $context.lease
  if (-not $lease -or $lease.expired) {
    $claimed = Invoke-Mutation 'claim' @{run_id=$runId;expected_revision=[int]$context.revision}
    $leaseId = [string]$claimed.lease_id
    $script:LeaseId = $leaseId
    $script:LeaseRunId = $runId
  } elseif ($lease.owner_id -ceq $script:Credential.identity_id -and -not $lease.expired -and
            $script:LeaseRunId -ceq $runId -and $script:LeaseId) {
    $leaseId = [string]$script:LeaseId
  } else { throw 'FOREIGN_OR_UNAVAILABLE_RUN_LEASE' }

  if ($context.state -eq 'READY') {
    if (-not $probe.telemetry.verified) { throw 'TELEMETRY_BINDING_NOT_VERIFIED' }
    $source = @{
      observed_at_utc=[DateTimeOffset]::UtcNow.ToString('o')
      environment='REPLAY'
      simulation=$true
      replay=$true
      account_alias=$Config.account_alias
      source_schema_version=[string]$probe.telemetry.source_schema_version
      quality='VERIFIED'
    }
    $context = Invoke-Mutation 'activate' @{
      run_id=$runId
      lease_id=$leaseId
      expected_revision=[int]$context.revision
      observed_handshake=@{instance=$context.plan.instance;source_state=$source;plan_hash=$context.plan.plan_hash;context_hash=$context.context.context_hash}
    }
  } else {
    $context = Invoke-Mutation 'renew' @{run_id=$runId;lease_id=$leaseId}
  }

  $reconciliation = $null
  if ($context.state -in @('ACTIVE','COMPLETING')) {
    $evidencePlan = Get-EvidencePlan $runId
    if ($evidencePlan.status -ceq 'READY') {
      Submit-EvidencePlan $evidencePlan $leaseId
      $reconciliation = [ordered]@{status=$evidencePlan.status;evidence_image=$evidencePlan.evidence_image;metrics=$evidencePlan.metrics;action_count=@($evidencePlan.actions).Count}
      $axes = @{source_market=@($evidencePlan.scored_intervals);strategy_execution=@($evidencePlan.scored_intervals);processing_review=@($evidencePlan.scored_intervals)}
      $watermark = [string]$evidencePlan.watermark
    } elseif ($evidencePlan.status -ceq 'AWAITING_SIERRA_EVIDENCE_IMAGE' -and $context.state -ceq 'ACTIVE') {
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
  $healthBody = @{
    message_id=('test-replay-bridge-health-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    data=@{strategy_id=$Config.strategy_id;instance_id=$Config.instance_id;status='READY';next_owner=$script:Credential.identity_id;next_action='Continue scoped Replay telemetry observation'}
  }
  $null = Invoke-OceanRequest 'POST' '/api/workflow/health' $healthBody
  Write-State ([ordered]@{status='ACTIVE';run_id=$runId;run_state=$context.state;lease_id=$leaseId;telemetry=$probe.telemetry;reconciliation=$reconciliation;safety='TEST_ONLY_SCOPED_REPLAY_EVIDENCE'})
}

$Config = Read-BridgeConfig
$script:Credential = Read-ProtectedCredential $Config
try {
  $script:Client = New-BridgeClient $script:Credential
  do {
    try { Invoke-BridgeCycle }
    catch {
      Write-State ([ordered]@{status='DEGRADED';error=$(if ($_.Exception.Message -cmatch '^[A-Z][A-Z0-9_]{1,100}$') {$_.Exception.Message} else {'BRIDGE_CYCLE_FAILED'});safety='TEST_ONLY_INGESTION_OFF'})
    }
    if (-not $Once) { Start-Sleep -Seconds ([int]$Config.poll_seconds) }
  } while (-not $Once)
} finally {
  if ($script:Client) { $script:Client.Dispose() }
  if ($script:Credential) { $script:Credential.token = $null }
}
