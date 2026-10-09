$ErrorActionPreference = 'Stop'

$scriptsRoot = Split-Path -Parent $PSCommandPath
$sourcePath = Join-Path $scriptsRoot 'run-ocean-website-supervised.ps1'
. $sourcePath -DefineOnly

function Assert-Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Start-HttpFixture([ValidateSet('healthy','empty','hang','headers_hang')][string]$Mode) {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $worker = [PowerShell]::Create()
  [void]$worker.AddScript({
    param($Listener, $ResponseMode)
    $client = $null
    try {
      $client = $Listener.AcceptTcpClient()
      $stream = $client.GetStream()
      $buffer = [byte[]]::new(4096)
      $request = [Text.StringBuilder]::new()
      do {
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { break }
        [void]$request.Append([Text.Encoding]::ASCII.GetString($buffer, 0, $read))
      } while ($request.ToString() -notmatch "\r\n\r\n")

      if ($ResponseMode -eq 'hang') {
        Start-Sleep -Seconds 5
        return
      }
      if ($ResponseMode -eq 'headers_hang') {
        $headers = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: text/plain`r`nContent-Length: 1`r`nConnection: close`r`n`r`n")
        $stream.Write($headers, 0, $headers.Length)
        $stream.Flush()
        Start-Sleep -Seconds 5
        $stream.WriteByte([byte][char]'O')
        $stream.Flush()
        return
      }
      $body = if ($ResponseMode -eq 'healthy') { 'O' } else { '' }
      $response = "HTTP/1.1 200 OK`r`nContent-Type: text/plain`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n$body"
      $bytes = [Text.Encoding]::ASCII.GetBytes($response)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
    } finally {
      if ($client) { $client.Dispose() }
      $Listener.Stop()
    }
  }).AddArgument($listener).AddArgument($Mode)
  $async = $worker.BeginInvoke()
  return [pscustomobject]@{ Uri = [Uri]"http://127.0.0.1:$port/"; Listener = $listener; Worker = $worker; Async = $async }
}

function Stop-HttpFixture($Fixture) {
  try { $Fixture.Listener.Stop() } catch {}
  try {
    if (-not $Fixture.Async.IsCompleted) { $Fixture.Worker.Stop() }
    else { $Fixture.Worker.EndInvoke($Fixture.Async) | Out-Null }
  } catch {}
  $Fixture.Worker.Dispose()
}

$fixture = Start-HttpFixture healthy
try { Assert-Test (Test-OceanWebsiteLiveness $fixture.Uri 2) 'NONEMPTY_HTTP_200_NOT_ACCEPTED' }
finally { Stop-HttpFixture $fixture }

$fixture = Start-HttpFixture empty
try { Assert-Test (-not (Test-OceanWebsiteLiveness $fixture.Uri 2)) 'ZERO_BYTE_HTTP_RESPONSE_ACCEPTED' }
finally { Stop-HttpFixture $fixture }

$fixture = Start-HttpFixture hang
$watch = [Diagnostics.Stopwatch]::StartNew()
try { Assert-Test (-not (Test-OceanWebsiteLiveness $fixture.Uri 2)) 'HUNG_HTTP_RESPONSE_ACCEPTED' }
finally { $watch.Stop(); Stop-HttpFixture $fixture }
Assert-Test ($watch.Elapsed.TotalSeconds -lt 4.5) 'HUNG_HTTP_PROBE_WAS_NOT_BOUNDED'

$fixture = Start-HttpFixture headers_hang
$watch = [Diagnostics.Stopwatch]::StartNew()
try { Assert-Test (-not (Test-OceanWebsiteLiveness $fixture.Uri 2)) 'HEADERS_ONLY_RESPONSE_ACCEPTED_AFTER_DEADLINE' }
finally { $watch.Stop(); Stop-HttpFixture $fixture }
Assert-Test ($watch.Elapsed.TotalSeconds -lt 4.5) 'BODY_BYTE_WAIT_WAS_NOT_BOUNDED'

$state = Get-NextLivenessState 0 $false 4
Assert-Test ($state.FailureCount -eq 1 -and -not $state.RestartRequired) 'FIRST_FAILURE_TRIGGERED_RESTART'
$state = Get-NextLivenessState 3 $false 4
Assert-Test ($state.FailureCount -eq 4 -and $state.RestartRequired) 'FOURTH_CONSECUTIVE_FAILURE_DID_NOT_TRIGGER_RESTART'
$state = Get-NextLivenessState 3 $true 4
Assert-Test ($state.FailureCount -eq 0 -and -not $state.RestartRequired) 'SUCCESS_DID_NOT_RESET_FAILURE_COUNT'

$zTimestamp = ('{"started_at_utc":"2026-10-09T18:00:00.000Z"}' | ConvertFrom-Json).started_at_utc
$offsetTimestamp = ('{"started_at_utc":"2026-10-09T18:00:00.000+00:00"}' | ConvertFrom-Json).started_at_utc
Assert-Test ((ConvertTo-UtcDateTimeOffset $zTimestamp).ToString('o') -eq '2026-10-09T18:00:00.0000000+00:00') 'PRODUCTION_Z_TIMESTAMP_CHANGED_IN_UTC_CONVERSION'
Assert-Test ((ConvertTo-UtcDateTimeOffset $offsetTimestamp).ToString('o') -eq '2026-10-09T18:00:00.0000000+00:00') 'OFFSET_TIMESTAMP_CHANGED_IN_UTC_CONVERSION'

$source = Get-Content -LiteralPath $sourcePath -Raw
Assert-Test ($source.Contains("[Uri]'http://127.0.0.1:3102/'")) 'PROBE_IS_NOT_THE_CHEAP_STATIC_ROOT'
Assert-Test (-not $source.Contains('/api/workflow/status')) 'SUPERVISOR_PROBES_THE_SLOW_WORKFLOW_STATUS_ROUTE'
Assert-Test ($source.Contains('-WindowStyle Hidden')) 'WEBSITE_CHILD_IS_NOT_STARTED_HIDDEN'
Assert-Test ($source.Contains('Stop-Process -Id $Process.Id -Force')) 'RECOVERY_IS_NOT_SCOPED_TO_THE_EXACT_CHILD_PID'
Assert-Test (-not ($source -match 'manage-ocean-services\.ps1.+Restart')) 'LIVENESS_RECOVERY_RESTARTS_THE_SERVICE_STACK'
Assert-Test ($source.Contains("Get-ScheduledTask -TaskPath '\OceanTrading\' -TaskName 'OceanTrading-Website'")) 'DISABLED_WEBSITE_TASK_DOES_NOT_SUPPRESS_RESTART'
$delayMarker = 'Start-Sleep -Seconds $RestartDelaySeconds'
$delayIndex = $source.IndexOf($delayMarker)
$postDelay = if ($delayIndex -ge 0) { $source.Substring($delayIndex + $delayMarker.Length) } else { '' }
$postDelayGateIndex = $postDelay.IndexOf('Test-WebsiteRestartAllowed')
$postDelayLaunchIndex = $postDelay.IndexOf('$process = Start-WebsiteChild')
Assert-Test ($delayIndex -ge 0 -and $postDelayGateIndex -ge 0 -and $postDelayLaunchIndex -gt $postDelayGateIndex) 'RECOVERY_DELAY_HAS_AN_UNCHECKED_OPERATOR_STOP_RACE'

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ocean-website-liveness-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$targetScript = Join-Path $testRoot 'server.mjs'
$controlScript = Join-Path $testRoot 'control.mjs'
[IO.File]::WriteAllText($targetScript, 'setInterval(() => {}, 1000);')
[IO.File]::WriteAllText($controlScript, 'setInterval(() => {}, 1000);')
$target = $null
$control = $null
$savedDashboard = $Dashboard
$savedStateFile = $StateFile
$savedStopFile = $StopFile
$savedStopAckFile = $StopAckFile
try {
  $Dashboard = $testRoot
  $StateFile = Join-Path $testRoot 'website-process.json'
  $StopFile = Join-Path $testRoot 'website-stop.json'
  $StopAckFile = Join-Path $testRoot 'website-stop-ack.json'
  $target = Start-Process -FilePath $Node -ArgumentList @($targetScript) -WindowStyle Hidden -PassThru
  $control = Start-Process -FilePath $Node -ArgumentList @($controlScript) -WindowStyle Hidden -PassThru
  [IO.File]::WriteAllText($StateFile, ([ordered]@{ pid=$target.Id; nonce='test-nonce'; dashboard=$Dashboard; started_at_utc=[DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress))
  $recoveryOwned = Stop-OwnedWebsiteProcess $target 1
  $target.Refresh()
  $control.Refresh()
  Assert-Test $recoveryOwned 'SUPERVISOR_DID_NOT_RETAIN_OWNERSHIP_OF_ITS_RECOVERY'
  Assert-Test $target.HasExited 'EXACT_TARGET_PROCESS_WAS_NOT_STOPPED'
  Assert-Test (-not $control.HasExited) 'UNRELATED_SIBLING_PROCESS_WAS_STOPPED'

  $target.Dispose()
  $target = Start-Process -FilePath $Node -ArgumentList @($targetScript) -WindowStyle Hidden -PassThru
  [IO.File]::WriteAllText($StateFile, ([ordered]@{ pid=$target.Id; nonce='operator-stop'; dashboard=$Dashboard; started_at_utc=[DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress))
  Assert-Test (-not (Test-MatchingStopRequest $target.Id)) 'INTERLEAVING_PRECONDITION_ALREADY_HAS_STOP_REQUEST'
  [IO.File]::WriteAllText($StopFile, ([ordered]@{ pid=$target.Id; nonce='operator-stop' } | ConvertTo-Json -Compress))
  $published = Request-OwnedWebsiteStop $target
  $preservedRequest = Get-Content -LiteralPath $StopFile -Raw | ConvertFrom-Json
  Assert-Test (-not $published) 'SUPERVISOR_OVERWROTE_OPERATOR_STOP_DURING_PUBLICATION_RACE'
  Assert-Test (-not $preservedRequest.request_id) 'OPERATOR_STOP_WAS_REPLACED_BY_SUPERVISOR_REQUEST'
  $recoveryOwned = Stop-OwnedWebsiteProcess $target 1
  $target.Refresh()
  Assert-Test (-not $recoveryOwned) 'EXTERNAL_STOP_DID_NOT_WIN_RECOVERY_RACE'
  Assert-Test (-not $target.HasExited) 'SUPERVISOR KILLED PROCESS AFTER_EXTERNAL_STOP_WON_RACE'

  Remove-Item -LiteralPath $StopFile -Force
  $injector = [PowerShell]::Create()
  [void]$injector.AddScript({
    param($Path, $TargetProcessId, $Nonce)
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while (-not (Test-Path -LiteralPath $Path) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
    if (-not (Test-Path -LiteralPath $Path)) { throw 'SUPERVISOR_STOP_REQUEST_NOT_OBSERVED' }
    [IO.File]::WriteAllText($Path, ([ordered]@{ pid=$TargetProcessId; nonce=$Nonce; requested_by='protected-operator' } | ConvertTo-Json -Compress))
  }).AddArgument($StopFile).AddArgument($target.Id).AddArgument('operator-stop')
  $injection = $injector.BeginInvoke()
  $recoveryOwned = Stop-OwnedWebsiteProcess $target 1
  $injector.EndInvoke($injection) | Out-Null
  $injector.Dispose()
  $target.Refresh()
  $operatorRequest = Get-Content -LiteralPath $StopFile -Raw | ConvertFrom-Json
  Assert-Test (-not $recoveryOwned) 'LATE_OPERATOR_STOP_DID_NOT_SUPERSEDE_RECOVERY'
  Assert-Test $target.HasExited 'LATE_OPERATOR_STOP_DID_NOT_ALLOW_EXACT_CHILD_RECOVERY'
  Assert-Test ($operatorRequest.requested_by -ceq 'protected-operator') 'LATE_OPERATOR_STOP_WAS_DELETED_OR_REPLACED'

  Remove-Item -LiteralPath $StopFile -Force
  [IO.File]::WriteAllText($StopAckFile, ([ordered]@{ schema_version='ocean-website-stop-ack/v1'; pid=$target.Id; nonce='operator-stop'; request_id=$null; requested_by='protected-operator' } | ConvertTo-Json -Compress))
  $completed = Complete-OwnedStopRequest $target.Id 'operator-stop' 'missing-supervisor-request'
  Assert-Test (-not $completed) 'CONSUMED_OPERATOR_STOP_WAS_TREATED_AS_SUPERVISOR_OWNED'
  Assert-Test (Test-Path -LiteralPath $StopAckFile) 'CONSUMED_OPERATOR_STOP_ACKNOWLEDGEMENT_WAS_DELETED'
  Assert-Test (Test-MatchingStopAcknowledgement $target.Id) 'NORMAL_POLLING_IGNORES_CONSUMED_OPERATOR_STOP_ACKNOWLEDGEMENT'

  [IO.File]::WriteAllText($StopFile, ([ordered]@{ pid=$target.Id; nonce='operator-stop'; request_id='supervisor-late'; requested_by='ocean-website-liveness-supervisor' } | ConvertTo-Json -Compress))
  $completed = Complete-OwnedStopRequest $target.Id 'operator-stop' 'supervisor-late'
  Assert-Test (-not $completed) 'SUPERVISOR_REQUEST_OVERRULED_MATCHING_OPERATOR_ACKNOWLEDGEMENT'
  Assert-Test (Test-Path -LiteralPath $StopAckFile) 'OPERATOR_ACKNOWLEDGEMENT_WAS_REMOVED_BY_LATER_SUPERVISOR_REQUEST'

  Remove-Item -LiteralPath $StopFile,$StopAckFile -Force -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($StopFile, ([ordered]@{ pid=$target.Id; nonce='operator-stop'; request_id='completion-race'; requested_by='ocean-website-liveness-supervisor' } | ConvertTo-Json -Compress))
  $completed = Complete-OwnedStopRequest $target.Id 'operator-stop' 'completion-race' {
    [IO.File]::WriteAllText($StopFile, ([ordered]@{ pid=$target.Id; nonce='operator-stop'; request_id='operator-after-claim'; requested_by='protected-operator' } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  }
  $operatorRequest = Get-Content -LiteralPath $StopFile -Raw | ConvertFrom-Json
  Assert-Test (-not $completed) 'OPERATOR_STOP_AFTER_COMPLETION_CLAIM_DID_NOT_SUPERSEDE_RECOVERY'
  Assert-Test ($operatorRequest.request_id -ceq 'operator-after-claim') 'COMPLETION_CLEANUP_DELETED_THE_NEWER_OPERATOR_REQUEST'
  Assert-Test (-not @(Get-ChildItem -LiteralPath $testRoot -Filter 'website-stop-claimed.*.json' -File).Count) 'OWNED_COMPLETION_CLAIM_WAS_NOT_CLEANED'

  Remove-Item -LiteralPath $StopFile -Force
  [IO.File]::WriteAllText($StopFile, ([ordered]@{ pid=$target.Id; nonce='operator-stop'; request_id='stale-before-claim'; requested_by='ocean-website-liveness-supervisor' } | ConvertTo-Json -Compress))
  Remove-StaleSharedStopRequest {
    [IO.File]::WriteAllText($StopFile, ([ordered]@{ pid=$target.Id; nonce='operator-stop'; request_id='operator-during-initialize'; requested_by='protected-operator' } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  }
  $operatorRequest = Get-Content -LiteralPath $StopFile -Raw | ConvertFrom-Json
  Assert-Test ($operatorRequest.request_id -ceq 'operator-during-initialize') 'STALE CLEANUP DELETED_THE_NEWER_OPERATOR_REQUEST'
  Assert-Test (-not @(Get-ChildItem -LiteralPath $testRoot -Filter 'website-stop-claimed.*.json' -File).Count) 'STALE CLEANUP LEFT_ITS_PRIVATE_CLAIM'
} finally {
  $Dashboard = $savedDashboard
  $StateFile = $savedStateFile
  $StopFile = $savedStopFile
  $StopAckFile = $savedStopAckFile
  foreach ($process in @($target,$control)) {
    if ($process) {
      try { $process.Refresh(); if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force } } catch {}
      $process.Dispose()
    }
  }
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'PASS: Ocean website liveness probe requires a nonempty HTTP 200, times out, debounces recovery, and remains website-only.'
