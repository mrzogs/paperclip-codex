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

  function Invoke-RuntimeProbe {
    $output = & $NodeExe $ProbeScript health --base-url 'http://127.0.0.1:3100' --issue 'OCE-918' --timeout-ms 4000 2>&1
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{ Ok = ($exitCode -eq 0 -and (Test-EmbeddedPostgres)); Output = ($output -join "`n") }
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

  function Get-ProcessTree([int]$RootProcessId) {
    $snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootProcessId)
    do {
      $added = $false
      foreach ($process in $snapshot) {
        if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) { $added = $true }
      }
    } while ($added)
    return @($snapshot | Where-Object { $ids.Contains([int]$_.ProcessId) })
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

  function Stop-ExpectedPaperclipRuntime {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue)
    $owners = @()
    foreach ($listener in $listeners) {
      $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
      $commandLine = $owner.CommandLine -as [string]
      if (-not $owner -or $commandLine -notmatch 'paperclipai|cli[\\/]src[\\/]index\.ts') {
        throw "Port 3100 is owned by an unexpected process; recovery refused."
      }
      $owners += $owner
    }

    Stop-EmbeddedPostgresSafely
    foreach ($owner in $owners) {
      Stop-Process -Id $owner.ProcessId -Force -ErrorAction SilentlyContinue
      $deadline = (Get-Date).AddSeconds(10)
      while ((Get-Process -Id $owner.ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 100
      }
      if (Get-Process -Id $owner.ProcessId -ErrorAction SilentlyContinue) {
        throw "Paperclip server PID $($owner.ProcessId) did not exit after PostgreSQL shutdown."
      }
      Write-SupervisorLog "Stopped unhealthy Paperclip server PID $($owner.ProcessId) after safe database shutdown."
    }
  }

  function Stop-StartedChildAfterDatabaseShutdown([Diagnostics.Process]$Child) {
    if (-not $Child -or $Child.HasExited) { return }
    $tree = @(Get-ProcessTree -RootProcessId ([int]$Child.Id))
    $postgresProcesses = @($tree | Where-Object { $_.Name -ieq 'postgres.exe' })
    if ($postgresProcesses.Count) {
      throw 'PostgreSQL remained in the failed child tree after safe shutdown; force termination refused.'
    }
    foreach ($process in @($tree | Sort-Object ProcessId -Descending)) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }

  function Start-PaperclipRuntime([string]$ChildOutLog, [string]$ChildErrLog) {
    return Start-Process -FilePath $CorepackCmd `
      -ArgumentList @('pnpm','paperclipai','run','--data-dir',$PaperclipHome,'--bind','loopback') `
      -WorkingDirectory $PaperclipRoot -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $ChildOutLog -RedirectStandardError $ChildErrLog
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

    Stop-ExpectedPaperclipRuntime
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
      Stop-ExpectedPaperclipRuntime
      Stop-StartedChildAfterDatabaseShutdown -Child $child
      Start-Sleep -Seconds ([Math]::Min(10, 2 * $startAttempt))
    }

    if (-not $recovered) { throw "Paperclip recovery exhausted $MaxStartAttempts start attempts." }
    $supervisorState = Update-PaperclipSupervisorState -State $supervisorState -Healthy $true -RecoveryCompleted
  }
} finally {
  if ($lockStream) { $lockStream.Dispose() }
}
