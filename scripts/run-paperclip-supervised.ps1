param(
  [int]$ProbeIntervalSec = 30,
  [int]$ConsecutiveFailuresBeforeRecovery = 3,
  [int]$MaxStartAttempts = 3
)

$ErrorActionPreference = 'Stop'

$PaperclipRoot = 'D:\Paperclip-codex'
$PaperclipHome = 'D:\Paperclip-codex\.paperclip-home'
$CorepackCmd = 'C:\Program Files\nodejs\corepack.cmd'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$LogDir = Join-Path $PaperclipHome 'service-logs'
$ConfigPath = Join-Path $PaperclipHome 'instances\default\config.json'
$ProbeScript = Join-Path $PaperclipRoot 'scripts\paperclip-runtime-probe.mjs'
$PolicyScript = Join-Path $PaperclipRoot 'scripts\paperclip-supervisor-policy.ps1'
$LockPath = Join-Path $PaperclipHome 'paperclip-supervisor.lock'
$SupervisorTokenPath = Join-Path $PaperclipHome 'supervisor-control-token.dpapi'
$SupervisorControlToken = $null

New-Item -ItemType Directory -Force -Path $PaperclipHome, $LogDir | Out-Null

foreach ($required in @($CorepackCmd, $NodeExe, $ProbeScript, $PolicyScript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required file not found: $required" }
}
. $PolicyScript

$lockStream = $null
try {
  try {
    $lockStream = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch [IO.IOException] {
    Write-Output 'Paperclip supervisor already owns the single-instance lock.'
    exit 0
  }

  $SupervisorControlToken = Get-PaperclipSupervisorControlToken -TokenPath $SupervisorTokenPath `
    -ServerPresent ([bool](Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue))

  $stamp = Get-Date -Format 'yyyyMMddTHHmmss'
  $log = Join-Path $LogDir "paperclip-supervisor-$stamp.log"

  function Write-SupervisorLog([string]$Message) {
    "$(Get-Date -Format o) $Message" | Out-File -LiteralPath $log -Append -Encoding utf8
  }

  function Test-EmbeddedPostgres {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return $false }
    try {
      $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
      $port = [int]$config.database.embeddedPostgresPort
      return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    } catch {
      return $false
    }
  }

  function Test-PaperclipListener {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue)
  }

  function Test-PaperclipSupervisorControl {
    try {
      $response = Invoke-RestMethod -Method Post `
        -Uri 'http://127.0.0.1:3100/api/health/supervisor-dispatch-fence/capability' `
        -Headers @{ 'x-paperclip-supervisor-token' = $SupervisorControlToken } `
        -TimeoutSec 4
      return ($response.status -eq 'ok' -and [bool]$response.controlled)
    } catch {
      return $false
    }
  }

  function Invoke-RuntimeProbe {
    $output = & $NodeExe $ProbeScript health --base-url 'http://127.0.0.1:3100' --issue 'OCE-918' --timeout-ms 4000 2>&1
    $exitCode = $LASTEXITCODE
    $controlReady = Test-PaperclipSupervisorControl
    return [pscustomobject]@{
      Ok = ($exitCode -eq 0 -and (Test-EmbeddedPostgres) -and $controlReady)
      ControlReady = $controlReady
      Output = ($output -join "`n")
    }
  }

  function Get-ActiveRunCustody {
    $output = & $NodeExe $ProbeScript active-runs --config $ConfigPath --timeout-ms 4000 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      return [pscustomobject]@{ Known = $false; Count = $null; Output = ($output -join "`n") }
    }
    try {
      $payload = ($output -join "`n") | ConvertFrom-Json
      return [pscustomobject]@{
        Known = [bool]$payload.custodyKnown
        Count = [int]$payload.activeRunCount
        RecoverableCount = [int]$payload.recoverableRunCount
        Output = ($output -join "`n")
      }
    } catch {
      return [pscustomobject]@{ Known = $false; Count = $null; Output = ($output -join "`n") }
    }
  }

  function Get-PgCtlPath {
    $matches = @(Get-ChildItem -Path (Join-Path $PaperclipRoot `
      'node_modules\.pnpm\@embedded-postgres+windows-x64@*\node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe') `
      -File -ErrorAction SilentlyContinue)
    if ($matches.Count -ne 1) {
      throw "Expected exactly one bundled pg_ctl.exe; found $($matches.Count)."
    }
    return $matches[0].FullName
  }

  function Stop-EmbeddedPostgresSafely {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
      throw 'Paperclip config is unavailable; PostgreSQL shutdown refused.'
    }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $postgresPort = [int]$config.database.embeddedPostgresPort
    $dataDir = [string]$config.database.embeddedPostgresDataDir
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $postgresPort -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { return }
    if ([string]::IsNullOrWhiteSpace($dataDir) -or -not (Test-Path -LiteralPath $dataDir -PathType Container)) {
      throw 'Embedded PostgreSQL data directory is unavailable; shutdown refused.'
    }
    foreach ($listener in $listeners) {
      $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
      $commandLine = $owner.CommandLine -as [string]
      if (-not $owner -or $owner.Name -ine 'postgres.exe' -or $commandLine -notmatch [regex]::Escape($dataDir)) {
        throw "Embedded Postgres port $postgresPort is owned by an unexpected process; shutdown refused."
      }
    }
    $pgCtl = Get-PgCtlPath
    $output = & $pgCtl stop -D $dataDir -m fast -w -t 30 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Bounded PostgreSQL fast shutdown failed; recovery refused. $($output -join ' ')"
    }
    if (Get-NetTCPConnection -State Listen -LocalPort $postgresPort -ErrorAction SilentlyContinue) {
      throw "PostgreSQL still listens on port $postgresPort after verified fast shutdown; recovery refused."
    }
    Write-SupervisorLog "Embedded PostgreSQL completed a bounded fast shutdown on port $postgresPort."
  }

  function Get-ExpectedPaperclipServerProcesses {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $commandLine = ($_.CommandLine -as [string]) -replace '\\\\', '\'
      $_.Name -ieq 'node.exe' -and
        $commandLine -match 'cli[\\/]src[\\/]index\.ts' -and
        $commandLine -match '(?:^|\s|["''])run(?:\s|["'']|$)' -and
        $commandLine.Contains($PaperclipHome)
    })
  }

  function New-PaperclipDispatchFenceLease {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes)
  }

  function Invoke-PaperclipDispatchFence(
    [ValidateSet('enter', 'check', 'exit')][string]$Action,
    [Parameter(Mandatory)][string]$LeaseToken
  ) {
    $headers = @{
      'x-paperclip-supervisor-token' = $SupervisorControlToken
      'x-paperclip-supervisor-lease' = $LeaseToken
    }
    try {
      $response = Invoke-RestMethod -Method Post `
        -Uri "http://127.0.0.1:3100/api/health/supervisor-dispatch-fence/$Action" `
        -Headers $headers `
        -TimeoutSec 15
    } catch {
      throw "Paperclip dispatch fence '$Action' was not acknowledged; recovery refused. $($_.Exception.Message)"
    }
    $expectedFenced = $Action -ne 'exit'
    if ($response.status -ne 'ok' -or -not $response.acknowledged -or `
        [bool]$response.fenced -ne $expectedFenced -or [int]$response.activeAdmissions -ne 0 -or `
        ($Action -eq 'check' -and -not $response.leaseValid)) {
      throw "Paperclip dispatch fence '$Action' returned an invalid acknowledgement; recovery refused."
    }
    return $response
  }

  function Stop-ExpectedPaperclipServerForFence(
    [Parameter(Mandatory)][DateTimeOffset]$LeaseExpiresAt
  ) {
    $stopDeadline = Get-PaperclipServerStopDeadline -NowUtc ([DateTimeOffset]::UtcNow) `
      -LeaseExpiresAtUtc $LeaseExpiresAt -MaxStopSeconds 30 -LeaseSafetyMarginSeconds 5
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue)
    $expected = @(Get-ExpectedPaperclipServerProcesses)
    $ownersById = @{}
    foreach ($process in $expected) { $ownersById[[int]$process.ProcessId] = $process }
    foreach ($listener in $listeners) {
      $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
      $commandLine = $owner.CommandLine -as [string]
      if (-not $owner -or -not $ownersById.ContainsKey([int]$owner.ProcessId) -or `
          $commandLine -notmatch 'cli[\\/]src[\\/]index\.ts') {
        throw "Port 3100 is owned by an unexpected process; recovery refused."
      }
    }

    foreach ($owner in @($ownersById.Values | Sort-Object ProcessId)) {
      if ([DateTimeOffset]::UtcNow -ge $stopDeadline) {
        throw 'Paperclip server stop deadline reached before all expected processes were stopped; database shutdown refused.'
      }
      Stop-Process -Id $owner.ProcessId -Force -ErrorAction SilentlyContinue
      while ((Get-Process -Id $owner.ProcessId -ErrorAction SilentlyContinue) -and `
          [DateTimeOffset]::UtcNow -lt $stopDeadline) {
        Start-Sleep -Milliseconds 100
      }
      if (Get-Process -Id $owner.ProcessId -ErrorAction SilentlyContinue) {
        throw "Paperclip server PID $($owner.ProcessId) did not exit while establishing the dispatch fence."
      }
      Write-SupervisorLog "Stopped unhealthy Paperclip server PID $($owner.ProcessId); dispatch fence established before the final custody check."
    }
    if (Test-PaperclipListener -or @(Get-ExpectedPaperclipServerProcesses).Count -gt 0) {
      throw 'Paperclip still listens on port 3100 after the dispatch fence; database shutdown refused.'
    }
    return ($ownersById.Count -gt 0)
  }

  function Start-PaperclipRuntime([string]$ChildOutLog, [string]$ChildErrLog) {
    $previousToken = [Environment]::GetEnvironmentVariable('PAPERCLIP_SUPERVISOR_CONTROL_TOKEN', 'Process')
    [Environment]::SetEnvironmentVariable('PAPERCLIP_SUPERVISOR_CONTROL_TOKEN', $SupervisorControlToken, 'Process')
    try {
      return Start-Process -FilePath $CorepackCmd `
        -ArgumentList @('pnpm','paperclipai','run','--data-dir',$PaperclipHome,'--bind','loopback') `
        -WorkingDirectory $PaperclipRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $ChildOutLog -RedirectStandardError $ChildErrLog
    } finally {
      [Environment]::SetEnvironmentVariable('PAPERCLIP_SUPERVISOR_CONTROL_TOKEN', $previousToken, 'Process')
    }
  }

  function Wait-RuntimeReady([Diagnostics.Process]$Child) {
    $deadline = (Get-Date).AddMinutes(3)
    do {
      if ($Child -and $Child.HasExited) { return $false }
      $probe = Invoke-RuntimeProbe
      if ($probe.Ok) { return $true }
      Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    return $false
  }

  function Restore-PaperclipServerAfterAbortedFence {
    $childStamp = Get-Date -Format 'yyyyMMddTHHmmss'
    $childOutLog = Join-Path $LogDir "paperclip-fence-restore-$childStamp.out.log"
    $childErrLog = Join-Path $LogDir "paperclip-fence-restore-$childStamp.err.log"
    $child = Start-PaperclipRuntime -ChildOutLog $childOutLog -ChildErrLog $childErrLog
    Write-SupervisorLog "Restoring Paperclip server as PID $($child.Id) with embedded PostgreSQL left running."
    if (-not (Wait-RuntimeReady -Child $child)) {
      throw 'Paperclip server did not recover after the fenced custody check deferred database shutdown.'
    }
    Write-SupervisorLog 'Paperclip server restored after the fenced custody check deferred database shutdown.'
  }

  Write-SupervisorLog 'Paperclip single-instance supervisor started.'
  $supervisorState = New-PaperclipSupervisorState
  while ($true) {
    $probe = Invoke-RuntimeProbe
    $cycle = Invoke-PaperclipSupervisorCycle -State $supervisorState -Healthy $probe.Ok `
      -FailureThreshold $ConsecutiveFailuresBeforeRecovery -CustodyKnown $false -ActiveRunCount 0 `
      -ServerListenerPresent (Test-PaperclipListener) -DatabaseListenerPresent (Test-EmbeddedPostgres)
    $supervisorState = $cycle.State
    $failures = [int]$supervisorState.FailureCount
    if ($probe.Ok) {
      Start-Sleep -Seconds $ProbeIntervalSec
      continue
    }

    Write-SupervisorLog "Runtime probe failed ($failures/$ConsecutiveFailuresBeforeRecovery): $($probe.Output)"
    if ($cycle.Action -eq 'observe') {
      Start-Sleep -Seconds $ProbeIntervalSec
      continue
    }

    $custody = Get-ActiveRunCustody
    $action = Get-PaperclipRecoveryAction -Healthy $false -ConsecutiveFailures $failures `
      -FailureThreshold $ConsecutiveFailuresBeforeRecovery -CustodyKnown $custody.Known `
      -ActiveRunCount $(if ($custody.Known) { $custody.Count } else { 0 }) `
      -ServerListenerPresent (Test-PaperclipListener) -DatabaseListenerPresent (Test-EmbeddedPostgres)
    if ($action -eq 'defer_unknown_custody') {
      Write-SupervisorLog "Recovery deferred: active-run custody could not be proven. $($custody.Output)"
      Start-Sleep -Seconds $ProbeIntervalSec
      continue
    }
    if ($action -eq 'cold_start') {
      Write-SupervisorLog 'No Paperclip or embedded Postgres listener exists; proceeding with a cold start.'
    }
    if ($action -eq 'defer_active_runs') {
      Write-SupervisorLog "Recovery deferred: $($custody.Count) live running agent process(es) retain custody."
      Start-Sleep -Seconds $ProbeIntervalSec
      continue
    }
    if ($action -eq 'restart' -and $custody.RecoverableCount -gt 0) {
      Write-SupervisorLog "Safe restart will hand $($custody.RecoverableCount) queued or dead-process run(s) to Paperclip startup reconciliation."
    }

    $serverPresent = (Test-PaperclipListener) -or @(Get-ExpectedPaperclipServerProcesses).Count -gt 0
    if (-not $serverPresent) {
      Write-SupervisorLog 'No expected Paperclip server process remained to fence; starting the server without restarting embedded PostgreSQL.'
      Restore-PaperclipServerAfterAbortedFence
      $supervisorState = Update-PaperclipSupervisorState -State $supervisorState -Healthy $true
      Start-Sleep -Seconds $ProbeIntervalSec
      continue
    }

    $fenceHeld = $false
    $serverStoppedForFence = $false
    $fenceLease = New-PaperclipDispatchFenceLease
    try {
      $fenceHeld = $true
      $fenceAcknowledgement = Invoke-PaperclipDispatchFence -Action enter -LeaseToken $fenceLease
      Write-SupervisorLog "Paperclip dispatch fence acknowledged with $($fenceAcknowledgement.activeAdmissions) active admissions."
      $fencedCustody = Get-ActiveRunCustody
      $fencedAction = Get-PaperclipFencedRecoveryAction -CustodyKnown $fencedCustody.Known `
        -ActiveRunCount $(if ($fencedCustody.Known) { $fencedCustody.Count } else { 0 })
      if ($fencedAction -ne 'shutdown_database') {
        Write-SupervisorLog "Database shutdown deferred after dispatch fence: $fencedAction. $($fencedCustody.Output)"
        Invoke-PaperclipDispatchFence -Action exit -LeaseToken $fenceLease | Out-Null
        $fenceHeld = $false
        Start-Sleep -Seconds $ProbeIntervalSec
        continue
      }

      $leaseCheckAcknowledgement = Invoke-PaperclipDispatchFence -Action check -LeaseToken $fenceLease
      $serverStoppedForFence = Stop-ExpectedPaperclipServerForFence `
        -LeaseExpiresAt ([DateTimeOffset]::Parse([string]$leaseCheckAcknowledgement.leaseExpiresAt))
      if (-not $serverStoppedForFence) {
        throw 'Paperclip dispatch fence was acknowledged but no expected server process could be stopped; database shutdown refused.'
      }
      $fenceHeld = $false
      Stop-EmbeddedPostgresSafely
    } catch {
      if ($fenceHeld -and -not $serverStoppedForFence -and (Test-PaperclipListener)) {
        try {
          Invoke-PaperclipDispatchFence -Action exit -LeaseToken $fenceLease | Out-Null
          Write-SupervisorLog 'Released Paperclip dispatch fence after recovery aborted before server shutdown.'
        } catch {
          Write-SupervisorLog "Dispatch fence release also failed after recovery abort: $($_.Exception.Message)"
        }
      }
      throw
    }
    $recovered = $false
    for ($startAttempt = 1; $startAttempt -le $MaxStartAttempts; $startAttempt++) {
      $childStamp = Get-Date -Format 'yyyyMMddTHHmmss'
      $childOutLog = Join-Path $LogDir "paperclip-child-$childStamp.out.log"
      $childErrLog = Join-Path $LogDir "paperclip-child-$childStamp.err.log"
      $child = Start-PaperclipRuntime -ChildOutLog $childOutLog -ChildErrLog $childErrLog
      Write-SupervisorLog "Started Paperclip recovery attempt $startAttempt as PID $($child.Id)."
      if (Wait-RuntimeReady -Child $child) {
        Write-SupervisorLog "Paperclip recovery attempt $startAttempt passed page-and-data health."
        $recovered = $true
        break
      }
      Write-SupervisorLog "Paperclip recovery attempt $startAttempt did not become ready."
      if ((Test-PaperclipListener) -or @(Get-ExpectedPaperclipServerProcesses).Count -gt 0) {
        $retryFenceHeld = $false
        $retryServerStopped = $false
        $retryFenceLease = New-PaperclipDispatchFenceLease
        try {
          $retryFenceHeld = $true
          Invoke-PaperclipDispatchFence -Action enter -LeaseToken $retryFenceLease | Out-Null
          $retryCustody = Get-ActiveRunCustody
          $retryFenceAction = Get-PaperclipFencedRecoveryAction -CustodyKnown $retryCustody.Known `
            -ActiveRunCount $(if ($retryCustody.Known) { $retryCustody.Count } else { 0 })
          if ($retryFenceAction -ne 'shutdown_database') {
            throw "Recovery retry refused after fenced custody check: $retryFenceAction."
          }
          $retryLeaseCheckAcknowledgement = Invoke-PaperclipDispatchFence -Action check -LeaseToken $retryFenceLease
          $retryServerStopped = [bool](Stop-ExpectedPaperclipServerForFence `
            -LeaseExpiresAt ([DateTimeOffset]::Parse([string]$retryLeaseCheckAcknowledgement.leaseExpiresAt)))
          if (-not $retryServerStopped) {
            throw 'Recovery retry fence was acknowledged but no expected server process could be stopped.'
          }
          $retryFenceHeld = $false
        } catch {
          if ($retryFenceHeld -and -not $retryServerStopped -and (Test-PaperclipListener)) {
            try { Invoke-PaperclipDispatchFence -Action exit -LeaseToken $retryFenceLease | Out-Null } catch { }
          }
          throw
        }
      }
      Start-Sleep -Seconds ([Math]::Min(10, 2 * $startAttempt))
    }

    if (-not $recovered) { throw "Paperclip recovery exhausted $MaxStartAttempts start attempts." }
    $supervisorState = Update-PaperclipSupervisorState -State $supervisorState -Healthy $true -RecoveryCompleted
  }
} finally {
  if ($lockStream) { $lockStream.Dispose() }
}
