param(
  [switch]$DefineOnly,
  [ValidateRange(10,60)][int]$ProbeIntervalSeconds = 15,
  [ValidateRange(2,10)][int]$ProbeTimeoutSeconds = 4,
  [ValidateRange(3,10)][int]$FailureThreshold = 4,
  [ValidateRange(30,180)][int]$StartupTimeoutSeconds = 90,
  [ValidateRange(5,35)][int]$GracefulStopTimeoutSeconds = 15,
  [ValidateRange(1,60)][int]$RestartDelaySeconds = 5
)

$ErrorActionPreference = 'Stop'

$Dashboard = 'D:\Paperclip-codex\website\ocean-trading\dashboard'
$Runtime = 'D:\OceanTradingData\website\ocean-runtime'
$WorkflowRoot = 'D:\OceanTradingData\website\workflow'
$StateFile = Join-Path $Runtime 'website-process.json'
$StopFile = Join-Path $Runtime 'website-stop.json'
$StopAckFile = Join-Path $Runtime 'website-stop-ack.json'
$Node = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $Dashboard 'logs'
$ProbeUri = [Uri]'http://127.0.0.1:3102/'
$script:SupervisorLog = $null
$script:SupervisorMutexName = 'Local\OceanTradingWebsiteSupervisor-v1'

function Enter-WebsiteSupervisorSingleton {
  $mutex = [Threading.Mutex]::new($false, $script:SupervisorMutexName)
  try {
    try { $acquired = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if ($acquired) { return $mutex }
    $mutex.Dispose()
    return $null
  } catch {
    $mutex.Dispose()
    throw
  }
}

function Exit-WebsiteSupervisorSingleton([Threading.Mutex]$Mutex) {
  if (-not $Mutex) { return }
  try { $Mutex.ReleaseMutex() } finally { $Mutex.Dispose() }
}

function Write-SupervisorLog([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  if ($script:SupervisorLog) {
    $line | Out-File -LiteralPath $script:SupervisorLog -Append -Encoding utf8
  }
  Write-Host $line
}

function Test-PortListening([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Test-OceanWebsiteLiveness([Uri]$Uri, [int]$TimeoutSeconds) {
  Add-Type -AssemblyName System.Net.Http
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Uri)
  $request.Headers.ConnectionClose = $true
  $request.Headers.CacheControl = [Net.Http.Headers.CacheControlHeaderValue]::new()
  $request.Headers.CacheControl.NoCache = $true
  $cancel = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  try {
    $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
    try {
      if ([int]$response.StatusCode -ne 200) { return $false }
      $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      try {
        $remaining = $deadline - [DateTime]::UtcNow
        if ($remaining -le [TimeSpan]::Zero) { return $false }
        $buffer = [byte[]]::new(1)
        $readTask = $stream.ReadAsync($buffer, 0, 1)
        $delayTask = [Threading.Tasks.Task]::Delay($remaining)
        $completed = [Threading.Tasks.Task]::WhenAny([Threading.Tasks.Task[]]@($readTask, $delayTask)).GetAwaiter().GetResult()
        if (-not [Object]::ReferenceEquals($completed, $readTask)) {
          $cancel.Cancel()
          return $false
        }
        $read = $readTask.GetAwaiter().GetResult()
        return $read -eq 1
      } finally {
        $stream.Dispose()
      }
    } finally {
      $response.Dispose()
    }
  } catch {
    return $false
  } finally {
    $cancel.Dispose()
    $request.Dispose()
    $client.Dispose()
    $handler.Dispose()
  }
}

function Get-NextLivenessState([int]$FailureCount, [bool]$Healthy, [int]$Threshold) {
  $next = if ($Healthy) { 0 } else { $FailureCount + 1 }
  return [pscustomobject]@{
    FailureCount = $next
    RestartRequired = (-not $Healthy) -and $next -ge $Threshold
  }
}

function Set-PrivateDirectoryAcl([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($sid, 'S-1-5-18')) {
    $identity = New-Object Security.Principal.SecurityIdentifier($principal)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  if ($PSVersionTable.PSEdition -eq 'Core') {
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), $acl)
  } else {
    [IO.Directory]::SetAccessControl($Path, $acl)
  }
}

function Get-WebsiteState {
  if (-not (Test-Path -LiteralPath $StateFile)) { throw 'Protected website process state is missing.' }
  $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
  if (-not $state.pid -or -not $state.nonce -or $state.dashboard -cne $Dashboard) {
    throw 'Protected website process state does not identify the configured Ocean website.'
  }
  return $state
}

function Get-StopRequestPaths {
  $paths = @()
  if (Test-Path -LiteralPath $StopFile) { $paths += $StopFile }
  $directory = Split-Path -Parent $StopFile
  if (Test-Path -LiteralPath $directory) {
    $paths += @(Get-ChildItem -LiteralPath $directory -Filter 'website-stop-claimed.*.json' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
  }
  return @($paths | Select-Object -Unique)
}

function Get-StopAcknowledgementPaths {
  $paths = @()
  if (Test-Path -LiteralPath $StopAckFile) { $paths += $StopAckFile }
  $directory = Split-Path -Parent $StopAckFile
  if (Test-Path -LiteralPath $directory) {
    $paths += @(Get-ChildItem -LiteralPath $directory -Filter 'website-stop-ack.*.json' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
  }
  return @($paths | Select-Object -Unique)
}

function Get-RequestAcknowledgementPath([string]$RequestId) {
  if ($RequestId -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw 'Protected stop request ID is not safe for acknowledgement routing.' }
  return Join-Path (Split-Path -Parent $StopAckFile) "website-stop-ack.$RequestId.json"
}

function Move-StopRequestToClaim([string]$Owner) {
  $claim = Join-Path (Split-Path -Parent $StopFile) "website-stop-claimed.$Owner.$([Guid]::NewGuid().ToString('N')).json"
  try {
    [IO.File]::Move($StopFile, $claim)
    return $claim
  } catch [IO.FileNotFoundException] {
    return $null
  } catch [IO.DirectoryNotFoundException] {
    return $null
  } catch [IO.IOException] {
    if (-not (Test-Path -LiteralPath $StopFile)) { return $null }
    throw
  }
}

function Restore-ClaimedStopRequest([string]$ClaimPath) {
  if (-not $ClaimPath -or -not (Test-Path -LiteralPath $ClaimPath) -or (Test-Path -LiteralPath $StopFile)) { return $false }
  try {
    [IO.File]::Move($ClaimPath, $StopFile)
    return $true
  } catch {
    return $false
  }
}

function Test-MatchingStopRequest([int]$ProcessId) {
  if (-not (Test-Path -LiteralPath $StateFile)) { return $false }
  try {
    $state = Get-WebsiteState
    if ([int]$state.pid -ne $ProcessId) { return $false }
    foreach ($path in @(Get-StopRequestPaths)) {
      try {
        $request = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ([int]$request.pid -eq $ProcessId -and $request.nonce -ceq $state.nonce) { return $true }
      } catch { return $true }
    }
    return $false
  } catch {
    return $false
  }
}

function Test-MatchingStopAcknowledgement([int]$ProcessId) {
  if (-not (Test-Path -LiteralPath $StateFile)) { return $false }
  try {
    $state = Get-WebsiteState
    if ([int]$state.pid -ne $ProcessId) { return $false }
    foreach ($path in @(Get-StopAcknowledgementPaths)) {
      try {
        $ack = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ([int]$ack.pid -eq $ProcessId -and $ack.nonce -ceq $state.nonce) { return $true }
      } catch { return $true }
    }
    return $false
  } catch {
    return $false
  }
}

function Test-MatchingProtectedStop([int]$ProcessId) {
  return (Test-MatchingStopRequest $ProcessId) -or (Test-MatchingStopAcknowledgement $ProcessId)
}

function Test-WebsiteRestartAllowed {
  $task = Get-ScheduledTask -TaskPath '\OceanTrading\' -TaskName 'OceanTrading-Website' -ErrorAction SilentlyContinue
  return -not ($task -and $task.State -eq 'Disabled')
}

function ConvertTo-UtcDateTimeOffset($Value) {
  if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime() }
  if ($Value -is [DateTime]) {
    if ($Value.Kind -eq [DateTimeKind]::Unspecified) { throw 'Timestamp kind is unspecified.' }
    return ([DateTimeOffset]$Value).ToUniversalTime()
  }
  return [DateTimeOffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}

function Assert-ProtectedWebsiteProcessIdentity([int]$ProcessId, $State) {
  if ([int]$State.pid -ne $ProcessId) { throw 'Protected website PID does not match the observed process.' }
  $details = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if (-not $details -or $details.Name -notin @('node.exe','node') -or ($details.ExecutablePath -as [string]) -ine $Node -or ($details.CommandLine -as [string]) -notmatch 'server\.mjs(?:[\s"'']|$)') {
    throw 'Protected website process executable or command identity does not match.'
  }
  try {
    $receiptStarted = ConvertTo-UtcDateTimeOffset $State.started_at_utc
    $processStarted = ([DateTimeOffset](Get-Process -Id $ProcessId -ErrorAction Stop).StartTime).ToUniversalTime()
  } catch {
    throw 'Protected website process generation evidence is invalid.'
  }
  if ($receiptStarted -lt $processStarted.AddSeconds(-2) -or $receiptStarted -gt [DateTimeOffset]::UtcNow.AddSeconds(2)) {
    throw "Protected website process receipt belongs to a different process generation (receipt=$($receiptStarted.ToString('o')); process=$($processStarted.ToString('o')))."
  }
  return $details
}

function Resolve-ExistingWebsiteProcess {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3102 -ErrorAction SilentlyContinue)
  if (-not $listeners.Count) { return $null }
  $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($pids.Count -ne 1) { throw 'Port 3102 has more than one listener owner.' }
  $state = Get-WebsiteState
  if ([int]$state.pid -ne [int]$pids[0]) { throw 'Port 3102 listener differs from the protected website process state.' }
  $details = Assert-ProtectedWebsiteProcessIdentity ([int]$state.pid) $state
  return Get-Process -Id ([int]$state.pid) -ErrorAction Stop
}

function Start-WebsiteChild {
  $stamp = Get-Date -Format 'yyyyMMddTHHmmssfff'
  $stdout = Join-Path $LogDir "website-supervised-child-$stamp.out.log"
  $stderr = Join-Path $LogDir "website-supervised-child-$stamp.err.log"
  $process = Start-Process -FilePath $Node -ArgumentList @('server.mjs') -WorkingDirectory $Dashboard -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Write-SupervisorLog "Started hidden Ocean website child PID $($process.Id). stdout=$stdout stderr=$stderr"
  return $process
}

function Wait-WebsiteReady([Diagnostics.Process]$Process, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $Process.Refresh()
    if ($Process.HasExited) { return $false }
    if (Test-OceanWebsiteLiveness $ProbeUri $ProbeTimeoutSeconds) { return $true }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Request-OwnedWebsiteStop([Diagnostics.Process]$Process) {
  $state = Get-WebsiteState
  $details = Assert-ProtectedWebsiteProcessIdentity $Process.Id $state
  $request = [ordered]@{
    pid = [int]$state.pid
    nonce = [string]$state.nonce
    request_id = [Guid]::NewGuid().ToString('N')
    requested_by = 'ocean-website-liveness-supervisor'
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Compress))
  try {
    $stream = [IO.File]::Open($StopFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
  } catch [IO.IOException] {
    if (Test-MatchingStopRequest $Process.Id) { return $null }
    throw 'Website recovery refused to overwrite existing stop evidence.'
  }
  return $request
}

function Complete-OwnedStopRequest([int]$ProcessId, [string]$Nonce, [string]$RequestId, [scriptblock]$AfterClaim = $null) {
  $claim = $null
  $ownAcknowledgementPath = Get-RequestAcknowledgementPath $RequestId
  $ownRequestPresent = $false
  $ownAcknowledgementPresent = $false
  $additionalOwnClaims = @()
  try {
    $claim = Move-StopRequestToClaim 'supervisor-complete'
    if ($claim) {
      $request = Get-Content -LiteralPath $claim -Raw | ConvertFrom-Json
      if ([int]$request.pid -ne $ProcessId -or $request.nonce -cne $Nonce) {
        [void](Restore-ClaimedStopRequest $claim)
        return $false
      }
      $ownRequestPresent = $request.requested_by -ceq 'ocean-website-liveness-supervisor' -and $request.request_id -ceq $RequestId
      if (-not $ownRequestPresent) {
        [void](Restore-ClaimedStopRequest $claim)
        return $false
      }
      if ($AfterClaim) { & $AfterClaim }
    }

    if (Test-Path -LiteralPath $ownAcknowledgementPath) {
      $ack = Get-Content -LiteralPath $ownAcknowledgementPath -Raw | ConvertFrom-Json
      $ownAcknowledgementPresent = [int]$ack.pid -eq $ProcessId -and $ack.nonce -ceq $Nonce -and $ack.requested_by -ceq 'ocean-website-liveness-supervisor' -and $ack.request_id -ceq $RequestId
      if (-not $ownAcknowledgementPresent) { throw 'Request-specific acknowledgement does not match supervisor ownership.' }
    }

    foreach ($path in @(Get-StopAcknowledgementPaths)) {
      if ($path -ceq $ownAcknowledgementPath) { continue }
      try {
        $ack = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ([int]$ack.pid -eq $ProcessId -and $ack.nonce -ceq $Nonce) {
          if ($ownRequestPresent -and (Test-Path -LiteralPath $claim)) { Remove-Item -LiteralPath $claim -Force }
          if ($ownAcknowledgementPresent) { Remove-Item -LiteralPath $ownAcknowledgementPath -Force }
          return $false
        }
      } catch [IO.IOException] { continue }
    }

    foreach ($path in @(Get-StopRequestPaths)) {
      if ($claim -and $path -ceq $claim) { continue }
      try {
        $request = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        if ([int]$request.pid -eq $ProcessId -and $request.nonce -ceq $Nonce) {
          $isOwn = $request.requested_by -ceq 'ocean-website-liveness-supervisor' -and $request.request_id -ceq $RequestId
          if ($isOwn -and $path -ne $StopFile) {
            $additionalOwnClaims += $path
            continue
          }
          if ($ownRequestPresent -and (Test-Path -LiteralPath $claim)) { Remove-Item -LiteralPath $claim -Force }
          if ($ownAcknowledgementPresent) { Remove-Item -LiteralPath $ownAcknowledgementPath -Force }
          return $false
        }
      } catch [IO.IOException] { continue }
    }

    if (-not ($ownRequestPresent -or $ownAcknowledgementPresent)) { return $false }
    if ($ownRequestPresent -and (Test-Path -LiteralPath $claim)) { Remove-Item -LiteralPath $claim -Force }
    foreach ($ownClaim in $additionalOwnClaims) {
      if (Test-Path -LiteralPath $ownClaim) { Remove-Item -LiteralPath $ownClaim -Force }
    }
    if ($ownAcknowledgementPresent) { Remove-Item -LiteralPath $ownAcknowledgementPath -Force }
    return $true
  } catch {
    if ($claim -and (Test-Path -LiteralPath $claim)) {
      try {
        $request = Get-Content -LiteralPath $claim -Raw | ConvertFrom-Json
        $isOwn = [int]$request.pid -eq $ProcessId -and $request.nonce -ceq $Nonce -and $request.requested_by -ceq 'ocean-website-liveness-supervisor' -and $request.request_id -ceq $RequestId
        if (-not $isOwn) { [void](Restore-ClaimedStopRequest $claim) }
      } catch {}
    }
    throw 'Website recovery left unreadable stop ownership evidence; refusing to continue.'
  }
}

function Remove-StaleSharedStopRequest([scriptblock]$AfterClaim = $null) {
  $claim = Move-StopRequestToClaim 'supervisor-initialize'
  if (-not $claim) { return }
  try {
    if ($AfterClaim) { & $AfterClaim }
    if (-not (Test-Path -LiteralPath $StateFile)) {
      [void](Restore-ClaimedStopRequest $claim)
      throw 'Stale website stop receipt has no matching process state.'
    }
    $stopped = Get-Content -LiteralPath $claim -Raw | ConvertFrom-Json
    $state = Get-WebsiteState
    if ($stopped.pid -ne $state.pid -or $stopped.nonce -ne $state.nonce) {
      [void](Restore-ClaimedStopRequest $claim)
      throw 'Website stop receipt does not match the protected process state.'
    }
    if (Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue) {
      [void](Restore-ClaimedStopRequest $claim)
      return
    }
    Remove-Item -LiteralPath $claim -Force
  } catch {
    if (Test-Path -LiteralPath $claim) { [void](Restore-ClaimedStopRequest $claim) }
    throw
  }
}

function Stop-OwnedWebsiteProcess([Diagnostics.Process]$Process, [int]$GracefulTimeoutSeconds) {
  if (Test-MatchingProtectedStop $Process.Id) {
    Write-SupervisorLog "External protected stop won the recovery race for Ocean website PID $($Process.Id)."
    return $false
  }
  $request = Request-OwnedWebsiteStop $Process
  if (-not $request) {
    Write-SupervisorLog "External protected stop won publication for Ocean website PID $($Process.Id)."
    return $false
  }
  Write-SupervisorLog "Requested graceful liveness recovery for exact Ocean website PID $($Process.Id)."
  $deadline = (Get-Date).AddSeconds($GracefulTimeoutSeconds)
  do {
    $Process.Refresh()
    if ($Process.HasExited) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  $Process.Refresh()
  if (-not $Process.HasExited) {
    Write-SupervisorLog "Graceful stop timed out; forcing exact unresponsive Ocean website PID $($Process.Id)."
    Stop-Process -Id $Process.Id -Force -ErrorAction Stop
    if (-not $Process.WaitForExit(5000)) { throw 'Exact Ocean website child did not exit after forced liveness recovery.' }
  }
  $recoveryStillOwned = Complete-OwnedStopRequest ([int]$request.pid) ([string]$request.nonce) ([string]$request.request_id)
  if (-not $recoveryStillOwned) {
    Write-SupervisorLog "A protected operator stop superseded liveness recovery for Ocean website PID $($Process.Id); preserving it."
    return $false
  }
  return $true
}

function Stop-UnreadyStartedChild([Diagnostics.Process]$Process) {
  $Process.Refresh()
  if ($Process.HasExited) { return }
  Write-SupervisorLog "Stopping exact newly started Ocean website PID $($Process.Id) after readiness failure."
  Stop-Process -Id $Process.Id -Force -ErrorAction Stop
  if (-not $Process.WaitForExit(5000)) { throw 'Unready Ocean website child did not exit after forced cleanup.' }
}

function Initialize-WebsiteEnvironment {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  Set-PrivateDirectoryAcl $Runtime
  if (-not (Test-Path -LiteralPath $Node)) { throw "node.exe not found: $Node" }

  Remove-StaleSharedStopRequest
  if (Test-Path -LiteralPath $StopFile) { throw 'A protected stop request arrived during supervisor initialization; website startup is suppressed.' }

  $flag = Join-Path $Runtime 'workflow-disabled.json'
  $disabled = (Test-Path -LiteralPath $flag) -and (Get-Content -LiteralPath $flag -Raw | ConvertFrom-Json).disabled

  $env:DASHBOARD_PORT = '3102'
  $env:OCEAN_TRADING_MONITOR_DEFAULT_ON = '0'
  $env:OCEAN_WORKFLOW_ENABLED = if ($disabled) { '0' } else { '1' }
  $env:OCEAN_WORKFLOW_CONFIG = Join-Path $WorkflowRoot 'operator-state.dpapi'
  $env:OCEAN_OPERATIONAL_LEARNING_ENABLED = '1'
  $env:OCEAN_OPERATIONAL_LEARNING_BRAIN_API = 'http://127.0.0.1:4001'
  $env:OCEAN_OPERATIONAL_LEARNING_BRAIN_PATH = '/trading/learning/operational'
  $env:OCEAN_OPERATIONAL_LEARNING_STRATEGY_ID = 'cicd-vwap-pull-back-strategy'
  $env:OCEAN_OPERATIONAL_LEARNING_BRAIN_TOKEN_FILE = 'D:\Paperclip-codex\workspaces\hermes-brain-console\secrets\clients\trading-cicd-vwap-pull-back-strategy.token'
  $env:OCEAN_OPERATIONAL_LEARNING_INTERVAL_MS = '5000'
  $env:OCEAN_OPERATIONAL_LEARNING_TELEMETRY_REQUIRED = '1'
  $env:OCEAN_OPERATIONAL_LEARNING_TELEMETRY_DB = 'D:\Trading\CICD\runtime\cicd-vwap-pull-back-strategy\ReplayTwo-v013\test-cicd-vwap-pull-back-replay-two-v013\TradeTelemetry_test-cicd-vwap-pull-back-replay-two-v013.sqlite'
  $env:OCEAN_OPERATIONAL_LEARNING_COMPLETION_ROOT = Join-Path $WorkflowRoot 'evidence'
  $env:OCEAN_OPERATIONAL_LEARNING_PHYSICAL_BINDING_FILE = 'D:\Paperclip-codex\website\ocean-trading\dashboard\config\replay-run-bridge.json'
  $env:OCEAN_WEBSITE_CONTROL_ROOT = $Runtime
}

function Invoke-OceanWebsiteSupervisor {
  Initialize-WebsiteEnvironment
  Set-Location -LiteralPath $Dashboard
  $stamp = Get-Date -Format 'yyyyMMddTHHmmss'
  $script:SupervisorLog = Join-Path $LogDir "website-supervisor-$stamp.log"
  Write-SupervisorLog 'Starting Ocean website liveness supervisor.'

  $process = Resolve-ExistingWebsiteProcess
  if ($process) {
    Write-SupervisorLog "Attached to protected Ocean website PID $($process.Id)."
  } else {
    $process = Start-WebsiteChild
    if (-not (Wait-WebsiteReady $process $StartupTimeoutSeconds)) {
      Stop-UnreadyStartedChild $process
      throw 'Ocean website child did not become HTTP-live before the startup deadline.'
    }
    Write-SupervisorLog "Ocean website PID $($process.Id) is HTTP-live."
  }

  $failureCount = 0
  while ($true) {
    if (Test-MatchingProtectedStop $process.Id) {
      Write-SupervisorLog "Protected stop request or acknowledgement observed for Ocean website PID $($process.Id); supervisor will not restart it."
      $process.WaitForExit() | Out-Null
      exit 0
    }

    $process.Refresh()
    if ($process.HasExited) {
      Write-SupervisorLog "Ocean website PID $($process.Id) exited; scheduled-task process recovery remains responsible for ordinary exits."
      exit 1
    }

    $previousFailureCount = $failureCount
    $healthy = Test-OceanWebsiteLiveness $ProbeUri $ProbeTimeoutSeconds
    $state = Get-NextLivenessState $failureCount $healthy $FailureThreshold
    $failureCount = $state.FailureCount
    if ($healthy -and $previousFailureCount -gt 0) {
      Write-SupervisorLog "HTTP liveness recovered for Ocean website PID $($process.Id) before the restart threshold."
    } elseif (-not $healthy) {
      Write-SupervisorLog "HTTP liveness probe failed for Ocean website PID $($process.Id) ($failureCount/$FailureThreshold)."
    }

    if ($state.RestartRequired) {
      if ((Test-MatchingProtectedStop $process.Id) -or -not (Test-WebsiteRestartAllowed)) {
        Write-SupervisorLog "Protected operator stop superseded liveness recovery for Ocean website PID $($process.Id); supervisor will not restart it."
        $process.WaitForExit() | Out-Null
        exit 0
      }
      Write-SupervisorLog "HTTP liveness threshold reached for Ocean website PID $($process.Id); recovering only the protected website child."
      Start-Sleep -Seconds $RestartDelaySeconds
      if ((Test-MatchingProtectedStop $process.Id) -or -not (Test-WebsiteRestartAllowed)) {
        Write-SupervisorLog "Protected operator stop arrived during the recovery delay for Ocean website PID $($process.Id); supervisor will not restart it."
        $process.WaitForExit() | Out-Null
        exit 0
      }
      $recoveryOwned = Stop-OwnedWebsiteProcess $process $GracefulStopTimeoutSeconds
      if (-not $recoveryOwned) {
        $process.WaitForExit() | Out-Null
        exit 0
      }
      if ((Test-MatchingProtectedStop $process.Id) -or -not (Test-WebsiteRestartAllowed)) {
        Write-SupervisorLog 'A protected operator stop or disabled website task superseded recovery; replacement launch suppressed.'
        exit 0
      }
      if (Test-PortListening 3102) { throw 'Port 3102 remained occupied after the exact website child stopped.' }
      if ((Test-MatchingProtectedStop $process.Id) -or -not (Test-WebsiteRestartAllowed)) {
        Write-SupervisorLog 'A protected operator stop or disabled website task arrived immediately before replacement launch; launch suppressed.'
        exit 0
      }
      $process = Start-WebsiteChild
      if (-not (Wait-WebsiteReady $process $StartupTimeoutSeconds)) {
        Stop-UnreadyStartedChild $process
        throw 'Replacement Ocean website child did not become HTTP-live before the startup deadline.'
      }
      Write-SupervisorLog "Replacement Ocean website PID $($process.Id) is HTTP-live."
      $failureCount = 0
    }

    Start-Sleep -Seconds $ProbeIntervalSeconds
  }
}

if ($DefineOnly) { return }
$supervisorMutex = Enter-WebsiteSupervisorSingleton
if (-not $supervisorMutex) {
  Write-Output 'Another Ocean website supervisor generation is already active; duplicate launch suppressed.'
  exit 0
}
try { Invoke-OceanWebsiteSupervisor }
finally { Exit-WebsiteSupervisorSingleton $supervisorMutex }
