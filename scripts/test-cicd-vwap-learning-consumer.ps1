<#
Isolated fault-injection tests, NOT deployed Ocean acceptance evidence.
HTTP is entirely MOCKED; a tiny in-memory service models transactional job-before-
ACK and recipient/hash-idempotent re-ACK. DPAPI, disk writes, locks, hashing and the
unmodified consumer entry point are real. CrashAfterCommit injects an interruption
after MOCK remote commit but before the response (not a physical power-loss test).
No production handoff, inbox, log, task, backend, or network is touched.
#>
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ConsumerPath = Join-Path $PSScriptRoot 'consume-cicd-vwap-learning-outbox.ps1'
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ('cicd-vwap-consumer-mocks-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($TestRoot) | Out-Null
$script:Passed = 0

function Assert-Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Set-MockArtifact {
  $json = $global:ConsumerMock.Content | ConvertTo-Json -Depth 10
  # BOM + non-ASCII UTF-8 + CRLF + trailing whitespace detects text re-encoding.
  $text = ([string][char]0xfeff) + $json.Replace("`r`n", "`n").Replace("`n", "`r`n") + "`r`n `t`r`n"
  $global:ConsumerMock.Bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $global:ConsumerMock.Hash = 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($global:ConsumerMock.Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Write-MockHandoff([int]$Minutes = 60) {
  $m = $global:ConsumerMock
  $binding = @{
    identity_id = $m.Identity.id; credential_ref = 'OCEAN_CICD_VWAP_REPLAY_STRATEGY_V1_TOKEN'
    audience = 'Ocean workflow operational v1'; revoked = $false
    expires_at_utc = [DateTimeOffset]::UtcNow.AddMinutes($Minutes).ToString('o'); token = $m.Token
  } | ConvertTo-Json
  $secure = ConvertTo-SecureString -String $binding -AsPlainText -Force
  try { [IO.File]::WriteAllText($m.Handoff, ($secure | ConvertFrom-SecureString), [Text.UTF8Encoding]::new($false)) }
  finally { $secure.Dispose() }
}

function New-MockFixture {
  $root = Join-Path $TestRoot ([guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($root) | Out-Null
  $global:ConsumerMock = @{
    Root = $root; Inbox = (Join-Path $root 'inbox'); Log = (Join-Path $root 'consumer.jsonl'); Handoff = (Join-Path $root 'mock.dpapi')
    Token = ('MOCK-ONLY-NOT-A-CREDENTIAL-' + [guid]::NewGuid().ToString('N'))
    Outbox = 'mock-outbox-1'; Lease = 'mock-lease-1'; PayloadHash = ('sha256:' + ('a' * 64))
    Case = 'CASE-OPERATIONAL-ABCDEF-0001'; Artifact = 'test-operational-learning-recommendation-abcdef0123456789'
    Run = 'operational-mock-run'; State = 'PENDING'; Mode = 'Normal'; ExpiredLease = $false; Duplicate = $false
    Job = 'mock-research-job-1'; Jobs = 0; AckCalls = 0; ClaimCalls = 0; FailCalls = 0; HttpCalls = 0
    AckLeases = [Collections.Generic.List[string]]::new(); SeenTokens = [Collections.Generic.List[string]]::new()
    EventNamespace = 'OPERATIONAL'; EventRole = 'BRAIN'; CaseInstance = 'cicd-vwap-pull-back-strategy:replay-two:chart1'; ClaimPayloadHash = $null
    Identity = [pscustomobject]@{
      id = 'cicd-vwap-pull-back-strategy:strategy:replay-two'; role = 'STRATEGY'; namespace = 'OPERATIONAL'
      audience = 'Ocean workflow operational v1'; strategy_ids = @('cicd-vwap-pull-back-strategy')
      instance_ids = @('cicd-vwap-pull-back-strategy:replay-two:chart1'); scopes = @('read', 'delivery')
      expires_at_utc = [DateTimeOffset]::UtcNow.AddHours(1).ToString('o')
    }
    Content = [ordered]@{
      schema_version = 'ocean-operational-learning-recommendation/v1'; title = ('MOCK caf' + [char]0x00e9)
      content = 'MOCK evidence only'; run_id = 'operational-mock-run'
      authority = [ordered]@{ automatic_strategy_change = $false; candidate_approved = $false; paper_authorized = $false; live_authorized = $false }
    }
  }
  Set-MockArtifact
  Write-MockHandoff
}

function Get-MockItem {
  $m = $global:ConsumerMock
  return [pscustomobject]@{
    outbox_id = $m.Outbox; lease_id = $m.Lease; payload_hash = $(if ($m.ClaimPayloadHash) { $m.ClaimPayloadHash } else { $m.PayloadHash })
    payload = [pscustomobject]@{
      namespace = $m.EventNamespace; actor_role = $m.EventRole; action = 'operational.learning.continuation'; entity_id = $m.Case
      payload = [pscustomobject]@{ artifact_id = $m.Artifact; run_id = $m.Run }
    }
  }
}

function Throw-MockStaleLease {
  $errorRecord = [Management.Automation.ErrorRecord]::new([InvalidOperationException]::new('MOCK HTTP 409'), 'MockHttp409', [Management.Automation.ErrorCategory]::InvalidOperation, $null)
  $errorRecord.ErrorDetails = [Management.Automation.ErrorDetails]::new('{"error":{"code":"STALE_OR_FOREIGN_DELIVERY_LEASE"}}')
  throw $errorRecord
}

# MOCK HTTP boundary. Every unknown URL fails closed, never calls a real cmdlet.
function Invoke-RestMethod {
  param($Method, $Uri, $Headers, $TimeoutSec, $MaximumRedirection, $ContentType, $Body)
  $m = $global:ConsumerMock
  $m.HttpCalls++
  Assert-Test ($Uri.StartsWith('http://127.0.0.1:1/api/workflow/operational/v1/')) 'Only isolated MOCK origin and OPERATIONAL routes permitted.'
  Assert-Test ($MaximumRedirection -eq 0) 'Credentials must not follow redirects.'
  Assert-Test ($Headers.Authorization -ceq "Bearer $($m.Token)") 'Fresh MOCK protected handoff required.'
  $m.SeenTokens.Add($Headers.Authorization)
  $route = $Uri.Substring('http://127.0.0.1:1/api/workflow/operational/v1/'.Length)
  if ($Method -ieq 'Get') {
    switch ($route) {
      'identity' { return [pscustomobject]@{ schema_version = 'ocean-service-identity/v1'; identity = $m.Identity; operational_ingestion = 'OFF'; live_real = 'DISABLED'; approval_authority = $false } }
      "cases/$($m.Case)" { return [pscustomobject]@{ namespace = 'OPERATIONAL'; case_id = $m.Case; strategy_id = 'cicd-vwap-pull-back-strategy'; execution_instance_id = $m.CaseInstance; run_id = $m.Run } }
      "artifacts/$($m.Artifact)" { return [pscustomobject]@{ manifest = [pscustomobject]@{ artifact_id = $m.Artifact; strategy_id = 'cicd-vwap-pull-back-strategy'; run_id = $m.Run; media_type = 'application/json'; immutable = $true; content_hash = $m.Hash } } }
      default { throw 'Unexpected MOCK GET route.' }
    }
  }
  Assert-Test ($Method -ieq 'Post') 'MOCK only allows GET or POST.'
  $request = $Body | ConvertFrom-Json
  $data = $request.data
  switch ($route) {
    'outbox/claim' {
      $m.ClaimCalls++
      Assert-Test ($data.strategy_id -ceq 'cicd-vwap-pull-back-strategy' -and $data.instance_id -ceq 'cicd-vwap-pull-back-strategy:replay-two:chart1') 'Exact claim scope.'
      if ($m.State -ceq 'PENDING' -or ($m.State -ceq 'LEASED' -and $m.ExpiredLease) -or $m.Duplicate) {
        if ($m.ExpiredLease) { $m.Lease = 'mock-lease-2'; $m.ExpiredLease = $false }
        if ($m.State -cne 'ACKNOWLEDGED') { $m.State = 'LEASED' }
        return [pscustomobject]@{ items = @(Get-MockItem); namespace = 'TEST' }
      }
      return [pscustomobject]@{ items = @(); namespace = 'TEST' }
    }
    'outbox/ack' {
      $m.AckCalls++
      $m.AckLeases.Add([string]$data.lease_id)
      $path = Join-Path $m.Inbox "$($m.Outbox).prepared.receipt.json"
      Assert-Test ([IO.File]::Exists($path)) 'PREPARED must be persisted BEFORE any remote ACK.'
      $prepared = [IO.File]::ReadAllText($path) | ConvertFrom-Json
      Assert-Test ($prepared.delivery_state -ceq 'PREPARED' -and $prepared.outbox_id -ceq $data.outbox_id -and $prepared.lease_id -ceq $data.lease_id -and $prepared.payload_hash -ceq $data.payload_hash) 'ACK fields must match durable PREPARED exactly.'
      $stored = [IO.File]::ReadAllBytes((Join-Path $m.Inbox "$($m.Artifact).json"))
      Assert-Test ([Convert]::ToBase64String($stored) -ceq [Convert]::ToBase64String($m.Bytes)) 'Artifact bytes must be exact before ACK.'
      if ($data.outbox_id -cne $m.Outbox -or $data.payload_hash -cne $m.PayloadHash) { throw 'MOCK immutable delivery conflict.' }
      if ($m.Mode -ceq 'OutageBeforeCommit') { throw 'MOCK service outage before commit.' }
      if ($m.State -cne 'ACKNOWLEDGED' -and ($m.ExpiredLease -or $data.lease_id -cne $m.Lease)) { Throw-MockStaleLease }
      if ($m.Jobs -eq 0) { $m.Jobs = 1 }
      $m.State = 'ACKNOWLEDGED'
      if ($m.Mode -ceq 'CrashAfterCommit') { throw 'MOCK simulated interruption after durable remote ACK.' }
      if ($m.Mode -ceq 'DiskAfterCommit') { [IO.Directory]::CreateDirectory((Join-Path $m.Inbox "$($m.Outbox).receipt.json")) | Out-Null }
      $ack = [pscustomobject]@{ outbox_id = $m.Outbox; state = 'ACKNOWLEDGED'; research_job_id = $m.Job; analysis_complete = $false }
      if ($m.Mode -ceq 'NoResearchJob') { $ack.research_job_id = '' }
      if ($m.Mode -ceq 'AnalysisComplete') { $ack.analysis_complete = $true }
      return $ack
    }
    'outbox/fail' { $m.FailCalls++; throw 'Consumer must not FAIL an uncertain MOCK ACK.' }
    default { throw 'Unexpected MOCK POST route.' }
  }
}

function Invoke-WebRequest {
  param($Method, $Uri, $Headers, $OutFile, $TimeoutSec, $MaximumRedirection, [switch]$UseBasicParsing)
  $m = $global:ConsumerMock
  Assert-Test ($Method -ieq 'Get' -and $Uri -ceq "http://127.0.0.1:1/api/workflow/operational/v1/artifacts/$($m.Artifact)/download") 'Only MOCK byte download allowed.'
  Assert-Test ($Headers.Authorization -ceq "Bearer $($m.Token)" -and $MaximumRedirection -eq 0) 'Protected MOCK byte download.'
  [IO.File]::WriteAllBytes($OutFile, $m.Bytes)
  if ($m.Mode -ceq 'DiskBeforePrepare') { [IO.Directory]::CreateDirectory((Join-Path $m.Inbox "$($m.Outbox).prepared.receipt.json")) | Out-Null }
}

function Invoke-TestConsumer([bool]$ExpectError = $false) {
  $failure = $null
  try {
    $output = @(& $ConsumerPath -Origin 'http://127.0.0.1:1' -HandoffPath $global:ConsumerMock.Handoff -Inbox $global:ConsumerMock.Inbox -LogPath $global:ConsumerMock.Log)
    Assert-Test ($output.Count -eq 0) 'Consumer must remain silent for the hidden task.'
  } catch { $failure = $_ }
  Assert-Test (($null -ne $failure) -eq $ExpectError) "Expected error=$ExpectError; actual error=$($null -ne $failure). $failure"
}

function Get-TestLog {
  return @(Get-Content -LiteralPath $global:ConsumerMock.Log | ForEach-Object { $_ | ConvertFrom-Json })[-1]
}

function Assert-TestPrepared {
  $m = $global:ConsumerMock
  Assert-Test ([IO.File]::Exists((Join-Path $m.Inbox "$($m.Outbox).prepared.receipt.json"))) 'PREPARED survives interruption.'
  Assert-Test (-not [IO.File]::Exists((Join-Path $m.Inbox "$($m.Outbox).receipt.json"))) 'No final receipt before verified ACK response.'
  Assert-Test ($m.FailCalls -eq 0) 'No uncertain-ACK failure mutation.'
}

function Assert-TestFinal {
  $m = $global:ConsumerMock
  $receipt = [IO.File]::ReadAllText((Join-Path $m.Inbox "$($m.Outbox).receipt.json")) | ConvertFrom-Json
  Assert-Test ($receipt.delivery_state -ceq 'ACKNOWLEDGED' -and $receipt.research_job_id -ceq $m.Job -and $receipt.analysis_complete -eq $false) 'Verified durable Research job, not analysis completion.'
  Assert-Test ($receipt.content_sha256 -ceq $m.Hash -and $receipt.payload_hash -ceq $m.PayloadHash -and $receipt.case_id -ceq $m.Case -and $receipt.artifact_id -ceq $m.Artifact) 'Final immutable provenance.'
  Assert-Test (-not (Test-Path -LiteralPath (Join-Path $m.Inbox "$($m.Outbox).prepared.receipt.json"))) 'PREPARED removed only after final receipt.'
  foreach ($file in @(Get-ChildItem -LiteralPath $m.Inbox -Filter '*receipt.json') + @(Get-Item -LiteralPath $m.Log)) {
    $text = [IO.File]::ReadAllText($file.FullName)
    Assert-Test (-not $text.Contains($m.Token) -and -not $text.Contains('Authorization') -and -not $text.Contains('Bearer')) 'No credentials in receipt or log.'
  }
  Assert-Test ($m.Jobs -eq 1 -and $m.FailCalls -eq 0) 'One durable MOCK job and no failure mutation.'
}

function Run-Test([string]$Name, [scriptblock]$Body) {
  New-MockFixture
  & $Body
  $script:Passed++
  Write-Output "PASS [MOCK HTTP / isolated disk+DPAPI]: $Name"
}

try {
  Run-Test 'byte-exact artifact and atomic credential-free receipt before ACK' {
    Invoke-TestConsumer
    Assert-TestFinal
    $m = $global:ConsumerMock
    Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $m.Inbox "$($m.Artifact).json"))) -ceq [Convert]::ToBase64String($m.Bytes)) 'BOM/non-ASCII/CRLF/trailing bytes survive.'
    Assert-Test ((Get-TestLog).state -ceq 'PASS') 'Successful quiet run recorded.'
  }
  Run-Test 'crash after remote ACK recovers after lease expiry without redelivery' {
    $m = $global:ConsumerMock
    $m.Mode = 'CrashAfterCommit'
    Invoke-TestConsumer $true
    Assert-TestPrepared
    Assert-Test ($m.State -ceq 'ACKNOWLEDGED') 'MOCK remote ACK committed before interruption.'
    $m.Mode = 'Normal'; $m.ExpiredLease = $true
    Invoke-TestConsumer
    Assert-TestFinal
    Assert-Test ($m.AckCalls -eq 2 -and (Get-TestLog).recovered -eq 1 -and (Get-TestLog).claimed -eq 0) 'Re-ACK retained expired lease, independent of claim/redelivery.'
  }
  Run-Test 'duplicate delivery preserves final receipt and stable Research job' {
    Invoke-TestConsumer
    $m = $global:ConsumerMock
    $path = Join-Path $m.Inbox "$($m.Outbox).receipt.json"
    $before = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
    $m.Duplicate = $true
    Invoke-TestConsumer
    Assert-TestFinal
    Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -ceq $before) 'Duplicate must not rewrite acknowledged provenance.'
    Assert-Test ($m.AckCalls -eq 2) 'Duplicate safely re-ACKed once.'
  }
  Run-Test 'disk IOException after ACK is ERROR, retains PREPARED, then recovers' {
    $m = $global:ConsumerMock
    $m.Mode = 'DiskAfterCommit'
    Invoke-TestConsumer $true
    Assert-TestPrepared
    Assert-Test ((Get-TestLog).state -ceq 'ERROR') 'Disk failure must never be SKIPPED_OVERLAP.'
    [IO.Directory]::Delete((Join-Path $m.Inbox "$($m.Outbox).receipt.json"))
    $m.Mode = 'Normal'
    Invoke-TestConsumer
    Assert-TestFinal
  }
  Run-Test 'disk error before PREPARED prevents remote ACK and is retryable' {
    $m = $global:ConsumerMock
    $m.Mode = 'DiskBeforePrepare'
    Invoke-TestConsumer $true
    Assert-Test ($m.AckCalls -eq 0 -and $m.Jobs -eq 0 -and (Get-TestLog).state -ceq 'ERROR') 'Failed PREPARED persistence must not ACK or skip.'
    Assert-Test (-not [IO.File]::Exists((Join-Path $m.Inbox "$($m.Outbox).receipt.json"))) 'No final receipt after disk failure.'
    [IO.Directory]::Delete((Join-Path $m.Inbox "$($m.Outbox).prepared.receipt.json"))
    $m.Mode = 'Normal'; $m.ExpiredLease = $true
    Invoke-TestConsumer
    Assert-TestFinal
  }
  Run-Test 'expired handoff blocks recovery; fresh DPAPI renewal succeeds' {
    $m = $global:ConsumerMock
    $m.Mode = 'CrashAfterCommit'
    Invoke-TestConsumer $true
    Write-MockHandoff -1
    $calls = $m.HttpCalls
    Invoke-TestConsumer $true
    Assert-TestPrepared
    Assert-Test ($m.HttpCalls -eq $calls) 'Expired credential never reaches HTTP.'
    $oldToken = $m.Token
    $m.Token = 'MOCK-ONLY-RENEWED-' + [guid]::NewGuid().ToString('N')
    Write-MockHandoff
    $m.Mode = 'Normal'
    Invoke-TestConsumer
    Assert-TestFinal
    Assert-Test ($m.SeenTokens[$m.SeenTokens.Count - 1] -ceq "Bearer $($m.Token)") 'Recovery rereads the renewed handoff.'
    Assert-Test (-not [IO.File]::ReadAllText($m.Log).Contains($oldToken)) 'Expired credential absent from logs.'
  }
  Run-Test 'outage before commit then stale-lease reclaim and retry' {
    $m = $global:ConsumerMock
    $m.Mode = 'OutageBeforeCommit'
    Invoke-TestConsumer $true
    Assert-TestPrepared
    Assert-Test ($m.Jobs -eq 0 -and $m.State -ceq 'LEASED') 'Outage never falsely acknowledges.'
    $m.Mode = 'Normal'; $m.ExpiredLease = $true
    Invoke-TestConsumer
    Assert-TestFinal
    Assert-Test ($m.AckCalls -eq 3 -and ($m.AckLeases -join ',') -ceq 'mock-lease-1,mock-lease-1,mock-lease-2') 'Reclaim changes only lease after immutable comparison.'
  }
  Run-Test 'mismatched reclaim cannot replace PREPARED immutable fields' {
    $m = $global:ConsumerMock
    $m.Mode = 'OutageBeforeCommit'
    Invoke-TestConsumer $true
    $path = Join-Path $m.Inbox "$($m.Outbox).prepared.receipt.json"
    $before = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path))
    $m.Mode = 'Normal'; $m.ExpiredLease = $true; $m.ClaimPayloadHash = 'sha256:' + ('b' * 64)
    Invoke-TestConsumer $true
    Assert-TestPrepared
    Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -ceq $before) 'Mismatched payload must never overwrite PREPARED.'
    Assert-Test ($m.AckCalls -eq 2 -and $m.Jobs -eq 0 -and (Get-TestLog).state -ceq 'ERROR') 'No ACK for mismatched reclaimed fields.'
  }
  Run-Test 'existing artifact hash conflict fails closed before ACK' {
    $m = $global:ConsumerMock
    [IO.Directory]::CreateDirectory($m.Inbox) | Out-Null
    $path = Join-Path $m.Inbox "$($m.Artifact).json"
    [IO.File]::WriteAllBytes($path, [byte[]]@(1, 2, 3))
    Invoke-TestConsumer $true
    Assert-Test ($m.AckCalls -eq 0 -and $m.Jobs -eq 0 -and (Get-TestLog).state -ceq 'ERROR') 'Hash conflict cannot ACK.'
    Assert-Test ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -ceq 'AQID') 'Existing conflicting evidence never overwritten.'
  }
  Run-Test 'prepared artifact tampering blocks all recovery HTTP' {
    $m = $global:ConsumerMock
    $m.Mode = 'CrashAfterCommit'
    Invoke-TestConsumer $true
    [IO.File]::WriteAllBytes((Join-Path $m.Inbox "$($m.Artifact).json"), [byte[]]@(1))
    $calls = $m.HttpCalls
    Invoke-TestConsumer $true
    Assert-TestPrepared
    Assert-Test ($m.HttpCalls -eq $calls) 'Hash-check stored bytes before any re-ACK.'
  }
  Run-Test 'actual overlapping lock is the only SKIPPED_OVERLAP path' {
    $m = $global:ConsumerMock
    [IO.Directory]::CreateDirectory($m.Inbox) | Out-Null
    $lock = [IO.File]::Open((Join-Path $m.Inbox '.consumer.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Invoke-TestConsumer; Assert-Test ((Get-TestLog).state -ceq 'SKIPPED_OVERLAP' -and $m.HttpCalls -eq 0) 'Actual sharing violation skips without network.' }
    finally { $lock.Dispose() }
    Invoke-TestConsumer
    Assert-TestFinal
  }
  foreach ($mode in @('NoResearchJob', 'AnalysisComplete')) {
    Run-Test "invalid durable ACK contract: $mode" {
      $m = $global:ConsumerMock
      $m.Mode = $mode
      Invoke-TestConsumer $true
      Assert-TestPrepared
      $m.Mode = 'Normal'
      Invoke-TestConsumer
      Assert-TestFinal
    }
  }
  foreach ($boundary in @('identity-role', 'identity-namespace', 'identity-instance', 'identity-scope', 'event-namespace', 'event-role', 'case-instance', 'authority-true', 'authority-string')) {
    Run-Test "exact protected boundary: $boundary" {
      $m = $global:ConsumerMock
      switch ($boundary) {
        'identity-role' { $m.Identity.role = 'BRAIN' }
        'identity-namespace' { $m.Identity.namespace = 'TEST' }
        'identity-instance' { $m.Identity.instance_ids = @('wrong-instance') }
        'identity-scope' { $m.Identity.scopes = @('read') }
        'event-namespace' { $m.EventNamespace = 'TEST' }
        'event-role' { $m.EventRole = 'TELEMETRY' }
        'case-instance' { $m.CaseInstance = 'wrong-instance' }
        'authority-true' { $m.Content.authority.live_authorized = $true; Set-MockArtifact }
        'authority-string' { $m.Content.authority.candidate_approved = 'false'; Set-MockArtifact }
      }
      Invoke-TestConsumer $true
      Assert-Test ($m.AckCalls -eq 0 -and (Get-TestLog).state -ceq 'ERROR') 'Boundary failure cannot acknowledge.'
    }
  }
  Write-Output "RESULT: $script:Passed passed, 0 failed. MOCK HTTP only; no deployed backend, task or Actions used."
} finally {
  Remove-Variable -Name ConsumerMock -Scope Global -ErrorAction SilentlyContinue
  $resolved = [IO.Path]::GetFullPath($TestRoot)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolved) -notlike 'cicd-vwap-consumer-mocks-*') { throw 'Refusing cleanup outside isolated test directory.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
