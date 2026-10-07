<#
.SYNOPSIS
Hidden-task-compatible protected Ocean learning delivery consumer (Windows PS 5.1+).
.DESCRIPTION
Review-only worktree replacement for consume-ocean-learning-outbox.ps1; this file
does not install, deploy, launch a window, or change the scheduled task.
Ocean must transactionally persist ow_research_jobs BEFORE ACK, return a stable
research_job_id and analysis_complete:false, and accept repeated ACKNOWLEDGED
ACKs for the exact recipient + payload_hash even after the original lease expires.
Delivery acknowledgement is NOT analysis completion or trading authority.

Protocol: persist and hash-check the exact downloaded bytes, atomically flush a
credential-free *.prepared.receipt.json, ACK, then atomically flush the final
*.receipt.json before removing PREPARED. Restart re-ACKs PREPARED using a freshly
read renewable DPAPI handoff. A stale UNACKNOWLEDGED lease requires a matching
reclaim; only lease_id may change after all immutable fields match. Network,
credential and disk failures retain PREPARED; never FAIL an uncertain remote ACK.
Atomic writes use same-directory temporary files, Flush(true), and rename/replace.
Only a sharing/lock violation during lock acquisition is SKIPPED_OVERLAP.
Local tests use labelled HTTP mocks and isolated DPAPI/inbox/log paths:
  powershell -NoProfile -File scripts/test-cicd-vwap-learning-consumer.ps1
#>
param(
  [string]$Origin = 'http://127.0.0.1:3102',
  [string]$HandoffPath = 'D:\OceanTradingData\website\workflow\handoffs\OCEAN_CICD_VWAP_REPLAY_STRATEGY_V1_TOKEN.dpapi',
  [string]$Inbox = 'C:\Users\wayne\OneDrive\Documents\Brady - Optimization\onboarding\learning-inbox',
  [string]$LogPath = 'D:\OceanTradingData\website\workflow\logs\cicd-vwap-learning-consumer.jsonl'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$StrategyId = 'cicd-vwap-pull-back-strategy'
$InstanceId = 'cicd-vwap-pull-back-strategy:replay-two:chart1'
$IdentityId = 'cicd-vwap-pull-back-strategy:strategy:replay-two'
$CredentialRef = 'OCEAN_CICD_VWAP_REPLAY_STRATEGY_V1_TOKEN'
$Audience = 'Ocean workflow operational v1'
$Api = "$($Origin.TrimEnd('/'))/api/workflow/operational/v1"

function Write-ConsumerLog([string]$State, [hashtable]$Details = @{}) {
  [IO.Directory]::CreateDirectory((Split-Path -Parent $LogPath)) | Out-Null
  $record = [ordered]@{
    timestamp_utc = [DateTimeOffset]::UtcNow.ToString('o')
    level = if ($State -eq 'ERROR') { 'ERROR' } else { 'INFO' }
    component = 'cicd-vwap-learning-consumer'
    state = $State
  }
  foreach ($entry in $Details.GetEnumerator()) { $record[$entry.Key] = $entry.Value }
  [IO.File]::AppendAllText($LogPath, (($record | ConvertTo-Json -Compress -Depth 8) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}

function ConvertTo-ConsumerExpiry($Value) {
  if ($Value -is [DateTime]) { return [DateTimeOffset]::new($Value.ToUniversalTime()) }
  return [DateTimeOffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
}

function Read-ProtectedHandoff {
  $secure = $null
  $handoff = $null
  try {
    $secure = [IO.File]::ReadAllText($HandoffPath) | ConvertTo-SecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $handoff = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) | ConvertFrom-Json }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($handoff.identity_id -cne $IdentityId -or $handoff.credential_ref -cne $CredentialRef -or
        $handoff.audience -cne $Audience -or $handoff.revoked -isnot [bool] -or $handoff.revoked -or
        (ConvertTo-ConsumerExpiry $handoff.expires_at_utc) -le [DateTimeOffset]::UtcNow -or
        [string]::IsNullOrWhiteSpace([string]$handoff.token)) { throw 'Protected strategy handoff validation failed.' }
    return $handoff
  } catch {
    if ($handoff) { $handoff.token = $null }
    throw 'Protected strategy handoff unavailable, expired or invalid; renew it and retry.'
  } finally { if ($secure) { $secure.Dispose() } }
}

function Assert-ConsumerIdentity($Readback) {
  $identity = $Readback.identity
  if ($Readback.schema_version -cne 'ocean-service-identity/v1' -or
      $identity.id -cne $IdentityId -or $identity.role -cne 'STRATEGY' -or
      $identity.namespace -cne 'OPERATIONAL' -or $identity.audience -cne $Audience -or
      @($identity.strategy_ids).Count -ne 1 -or $identity.strategy_ids[0] -cne $StrategyId -or
      @($identity.instance_ids).Count -ne 1 -or $identity.instance_ids[0] -cne $InstanceId -or
      (ConvertTo-ConsumerExpiry $identity.expires_at_utc) -le [DateTimeOffset]::UtcNow -or
      $Readback.operational_ingestion -cne 'OFF' -or $Readback.live_real -cne 'DISABLED' -or
      $Readback.approval_authority -isnot [bool] -or $Readback.approval_authority -ne $false) {
    throw 'Exact protected operational strategy identity required.'
  }
  foreach ($scope in @('read', 'delivery')) {
    if ($scope -cnotin @($identity.scopes)) { throw 'Protected strategy delivery scope missing.' }
  }
}

function Invoke-ProtectedOcean([string]$Route, $Data = $null, [string]$DownloadPath = '') {
  $handoff = Read-ProtectedHandoff
  $headers = @{ Authorization = "Bearer $($handoff.token)" }
  try {
    $identity = Invoke-RestMethod -Method Get -Uri "$Api/identity" -Headers $headers -TimeoutSec 15 -MaximumRedirection 0
    Assert-ConsumerIdentity $identity
    if ($DownloadPath) {
      Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$Api/$Route" -Headers $headers -OutFile $DownloadPath -TimeoutSec 15 -MaximumRedirection 0 | Out-Null
    } elseif ($null -ne $Data) {
      $body = @{ message_id = "test-operational-consumer-$([guid]::NewGuid().ToString('N'))"; data = $Data } | ConvertTo-Json -Depth 20 -Compress
      Invoke-RestMethod -Method Post -Uri "$Api/$Route" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 15 -MaximumRedirection 0
    } else {
      Invoke-RestMethod -Method Get -Uri "$Api/$Route" -Headers $headers -TimeoutSec 15 -MaximumRedirection 0
    }
  } finally { $handoff.token = $null; $headers.Clear() }
}

function Write-AtomicBytes([string]$Path, [byte[]]$Bytes) {
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  $stream = $null
  try {
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    $stream.Write($Bytes, 0, $Bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    # PS 5.1 coerces $null to an empty path; NullString supplies a real null backup.
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
  } finally {
    if ($stream) { $stream.Dispose() }
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function Write-AtomicReceipt([string]$Path, $Receipt) {
  Write-AtomicBytes $Path ([Text.UTF8Encoding]::new($false).GetBytes(($Receipt | ConvertTo-Json -Depth 10)))
}

function Get-ConsumerHash([string]$Path) {
  return 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-NoAuthority($Authority) {
  foreach ($name in @('automatic_strategy_change', 'candidate_approved', 'paper_authorized', 'live_authorized')) {
    if ($Authority.$name -isnot [bool] -or $Authority.$name -ne $false) { throw 'Recommendation authority boundary failed.' }
  }
}

function Read-ConsumerArtifact([string]$Path, [string]$Hash) {
  if ((Get-ConsumerHash $Path) -cne $Hash) { throw 'Existing inbox artifact hash conflict.' }
  $bytes = [IO.File]::ReadAllBytes($Path)
  $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xfeff)
  $content = $text | ConvertFrom-Json
  if ($content.schema_version -cne 'ocean-operational-learning-recommendation/v1') { throw 'Unsupported recommendation schema.' }
  Assert-NoAuthority $content.authority
  return $content
}

function Assert-DeliveryFields($Delivery) {
  if ([string]$Delivery.outbox_id -cnotmatch '^[A-Za-z0-9_-]+$' -or
      [string]$Delivery.lease_id -cnotmatch '^[A-Za-z0-9_-]+$' -or
      [string]$Delivery.payload_hash -cnotmatch '^sha256:[a-f0-9]{64}$' -or
      [string]$Delivery.case_id -cnotmatch '^[A-Za-z0-9_.:-]+$' -or
      [string]$Delivery.artifact_id -cnotmatch '^test-operational-learning-recommendation-[a-f0-9]+$' -or
      [string]$Delivery.content_sha256 -cnotmatch '^sha256:[a-f0-9]{64}$') { throw 'Invalid immutable delivery fields.' }
}

function Read-ConsumerReceipt([string]$Path, [string]$State) {
  $receipt = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
  Assert-DeliveryFields $receipt
  $schema = if ($State -ceq 'PREPARED') { 'cicd-vwap-learning-prepared/v1' } else { 'cicd-vwap-learning-consumption/v1' }
  $suffix = if ($State -ceq 'PREPARED') { '.prepared.receipt.json' } else { '.receipt.json' }
  if ($receipt.schema_version -cne $schema -or $receipt.delivery_state -cne $State -or
      [IO.Path]::GetFileName($Path) -cne ($receipt.outbox_id + $suffix) -or
      $receipt.recipient_id -cne $IdentityId -or $receipt.namespace -cne 'OPERATIONAL' -or
      $receipt.role -cne 'STRATEGY' -or $receipt.strategy_id -cne $StrategyId -or $receipt.instance_id -cne $InstanceId) {
    throw 'Local receipt identity or state conflict.'
  }
  Assert-NoAuthority $receipt.authority
  Read-ConsumerArtifact (Join-Path $Inbox "$($receipt.artifact_id).json") $receipt.content_sha256 | Out-Null
  if ($State -ceq 'ACKNOWLEDGED' -and
      ([string]::IsNullOrWhiteSpace([string]$receipt.research_job_id) -or
       $receipt.analysis_complete -isnot [bool] -or $receipt.analysis_complete -ne $false)) { throw 'Local durable Research receipt invalid.' }
  return $receipt
}

function Assert-MatchingDelivery($Expected, $Observed) {
  foreach ($field in @('outbox_id', 'payload_hash', 'case_id', 'artifact_id', 'content_sha256')) {
    if ([string]$Expected.$field -cne [string]$Observed.$field) { throw 'Local receipt immutable delivery conflict.' }
  }
}

function Complete-PreparedDelivery($Prepared) {
  $finalPath = Join-Path $Inbox "$($Prepared.outbox_id).receipt.json"
  $final = $null
  if (Test-Path -LiteralPath $finalPath) {
    $final = Read-ConsumerReceipt $finalPath 'ACKNOWLEDGED'
    Assert-MatchingDelivery $Prepared $final
  }
  $ack = Invoke-ProtectedOcean 'outbox/ack' @{
    outbox_id = $Prepared.outbox_id; lease_id = $Prepared.lease_id; payload_hash = $Prepared.payload_hash
  }
  if ($ack.outbox_id -cne $Prepared.outbox_id -or $ack.state -cne 'ACKNOWLEDGED' -or
      [string]::IsNullOrWhiteSpace([string]$ack.research_job_id) -or
      $ack.analysis_complete -isnot [bool] -or $ack.analysis_complete -ne $false) { throw 'Ocean durable Research acknowledgement invalid.' }
  if ($final) {
    if ($final.research_job_id -cne $ack.research_job_id) { throw 'Ocean Research job receipt conflict.' }
  } else {
    $receipt = [ordered]@{}
    foreach ($field in @('prepared_at_utc', 'outbox_id', 'lease_id', 'payload_hash', 'case_id', 'artifact_id',
        'content_sha256', 'recipient_id', 'namespace', 'role', 'strategy_id', 'instance_id', 'authority')) {
      $receipt[$field] = $Prepared.$field
    }
    $receipt.schema_version = 'cicd-vwap-learning-consumption/v1'
    $receipt.delivery_state = 'ACKNOWLEDGED'
    $receipt.acknowledged_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    $receipt.research_job_id = $ack.research_job_id
    $receipt.analysis_complete = $false
    Write-AtomicReceipt $finalPath $receipt
  }
  [IO.File]::Delete((Join-Path $Inbox "$($Prepared.outbox_id).prepared.receipt.json"))
}

function Test-StaleDeliveryLease($Failure) {
  try {
    $detail = $Failure.ErrorDetails.Message | ConvertFrom-Json
    return $detail.error.code -ceq 'STALE_OR_FOREIGN_DELIVERY_LEASE'
  } catch { return $false }
}

function Prepare-ClaimedDelivery($Item) {
  if ($Item.payload.namespace -cne 'OPERATIONAL' -or $Item.payload.actor_role -cne 'BRAIN' -or
      $Item.payload.action -cne 'operational.learning.continuation') { throw 'Unsupported operational delivery.' }
  $delivery = [pscustomobject][ordered]@{
    schema_version = 'cicd-vwap-learning-prepared/v1'
    prepared_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
    delivery_state = 'PREPARED'
    outbox_id = [string]$Item.outbox_id
    lease_id = [string]$Item.lease_id
    payload_hash = [string]$Item.payload_hash
    case_id = [string]$Item.payload.entity_id
    artifact_id = [string]$Item.payload.payload.artifact_id
    content_sha256 = 'sha256:' + ('0' * 64)
    recipient_id = $IdentityId
    namespace = 'OPERATIONAL'
    role = 'STRATEGY'
    strategy_id = $StrategyId
    instance_id = $InstanceId
    authority = [ordered]@{ automatic_strategy_change = $false; candidate_approved = $false; paper_authorized = $false; live_authorized = $false }
  }
  Assert-DeliveryFields $delivery
  $case = Invoke-ProtectedOcean "cases/$($delivery.case_id)"
  $metadata = Invoke-ProtectedOcean "artifacts/$($delivery.artifact_id)"
  if ($case.namespace -cne 'OPERATIONAL' -or $case.case_id -cne $delivery.case_id -or
      $case.strategy_id -cne $StrategyId -or $case.execution_instance_id -cne $InstanceId -or
      $metadata.manifest.artifact_id -cne $delivery.artifact_id -or $metadata.manifest.strategy_id -cne $StrategyId -or
      $metadata.manifest.run_id -cne $case.run_id -or $metadata.manifest.media_type -cne 'application/json' -or
      $metadata.manifest.immutable -isnot [bool] -or $metadata.manifest.immutable -ne $true) { throw 'Operational case/artifact binding failed.' }
  $delivery.content_sha256 = [string]$metadata.manifest.content_hash
  Assert-DeliveryFields $delivery
  $preparedPath = Join-Path $Inbox "$($delivery.outbox_id).prepared.receipt.json"
  $finalPath = Join-Path $Inbox "$($delivery.outbox_id).receipt.json"
  foreach ($pair in @(@($preparedPath, 'PREPARED'), @($finalPath, 'ACKNOWLEDGED'))) {
    if (Test-Path -LiteralPath $pair[0]) {
      $existing = Read-ConsumerReceipt $pair[0] $pair[1]
      Assert-MatchingDelivery $existing $delivery
    }
  }
  $artifactPath = Join-Path $Inbox "$($delivery.artifact_id).json"
  $download = Join-Path $Inbox "$($delivery.artifact_id).$([guid]::NewGuid().ToString('N')).download"
  try {
    Invoke-ProtectedOcean "artifacts/$($delivery.artifact_id)/download" $null $download
    $content = Read-ConsumerArtifact $download $delivery.content_sha256
    if ($content.run_id -cne $case.run_id -or $content.run_id -cne $Item.payload.payload.run_id) { throw 'Recommendation run binding failed.' }
    if (Test-Path -LiteralPath $artifactPath) {
      Read-ConsumerArtifact $artifactPath $delivery.content_sha256 | Out-Null
    } else { Write-AtomicBytes $artifactPath ([IO.File]::ReadAllBytes($download)) }
    Read-ConsumerArtifact $artifactPath $delivery.content_sha256 | Out-Null
    Write-AtomicReceipt $preparedPath $delivery
    return $delivery
  } finally { if ([IO.File]::Exists($download)) { [IO.File]::Delete($download) } }
}

$lock = $null
try {
  [IO.Directory]::CreateDirectory($Inbox) | Out-Null
  try {
    $lock = [IO.File]::Open((Join-Path $Inbox '.consumer.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] {
    $code = $_.Exception.HResult -band 0xffff
    if ($code -notin @(32, 33)) { throw }
    Write-ConsumerLog 'SKIPPED_OVERLAP'
    return
  }
  $acknowledged = 0
  $recovered = 0
  $deferred = @{}
  foreach ($file in @(Get-ChildItem -LiteralPath $Inbox -Filter '*.prepared.receipt.json' -File | Sort-Object Name)) {
    $prepared = Read-ConsumerReceipt $file.FullName 'PREPARED'
    try { Complete-PreparedDelivery $prepared; $recovered++ }
    catch {
      if (-not (Test-StaleDeliveryLease $_)) { throw }
      $deferred[$prepared.outbox_id] = $true
    }
  }
  $claim = Invoke-ProtectedOcean 'outbox/claim' @{ strategy_id = $StrategyId; instance_id = $InstanceId }
  foreach ($item in @($claim.items)) {
    $prepared = Prepare-ClaimedDelivery $item
    Complete-PreparedDelivery $prepared
    $deferred.Remove($prepared.outbox_id)
    $acknowledged++
  }
  Write-ConsumerLog $(if ($deferred.Count) { 'RETRY_PENDING' } else { 'PASS' }) @{
    claimed = @($claim.items).Count; acknowledged = $acknowledged; recovered = $recovered; pending = $deferred.Count
  }
} catch {
  # HTTP error bodies and credentials never enter the persistent consumer log.
  Write-ConsumerLog 'ERROR' @{ error = 'CONSUMER_FAILED'; error_type = $_.Exception.GetType().FullName }
  throw
} finally { if ($lock) { $lock.Dispose() } }
