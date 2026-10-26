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
$LockPath = Join-Path $PaperclipHome 'paperclip-supervisor.lock'

New-Item -ItemType Directory -Force -Path $PaperclipHome, $LogDir | Out-Null

foreach ($required in @($CorepackCmd, $NodeExe, $ProbeScript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required file not found: $required" }
}

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
      return [pscustomobject]@{ Known = $true; Count = [int]$payload.activeRunCount; Output = ($output -join "`n") }
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

  function Stop-ExpectedPaperclipRuntime {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3100 -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
      $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
      $commandLine = $owner.CommandLine -as [string]
      if (-not $owner -or $commandLine -notmatch 'paperclipai|cli[\\/]src[\\/]index\.ts') {
        throw "Port 3100 is owned by an unexpected process; recovery refused."
      }
      foreach ($process in @(Get-ProcessTree -RootProcessId ([int]$owner.ProcessId) | Sort-Object ProcessId -Descending)) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
      }
      Write-SupervisorLog "Stopped unhealthy Paperclip process tree rooted at PID $($owner.ProcessId)."
    }

    if (Test-Path -LiteralPath $ConfigPath) {
      $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
      $postgresPort = [int]$config.database.embeddedPostgresPort
      foreach ($listener in @(Get-NetTCPConnection -State Listen -LocalPort $postgresPort -ErrorAction SilentlyContinue)) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
        $commandLine = $owner.CommandLine -as [string]
        if (-not $owner -or $owner.Name -ine 'postgres.exe' -or $commandLine -notmatch [regex]::Escape($PaperclipHome)) {
          throw "Embedded Postgres port $postgresPort is owned by an unexpected process; recovery refused."
        }
        foreach ($process in @(Get-ProcessTree -RootProcessId ([int]$owner.ProcessId) | Sort-Object ProcessId -Descending)) {
          Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Write-SupervisorLog "Stopped embedded Postgres process tree rooted at PID $($owner.ProcessId)."
      }
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
  $failures = 0
  while ($true) {
    $probe = Invoke-RuntimeProbe
    if ($probe.Ok) {
      $failures = 0
      Start-Sleep -Seconds $ProbeIntervalSec
      continue
    }

    $failures++
    Write-SupervisorLog "Runtime probe failed ($failures/$ConsecutiveFailuresBeforeRecovery): $($probe.Output)"
    if ($failures -lt $ConsecutiveFailuresBeforeRecovery) {
      Start-Sleep -Seconds $ProbeIntervalSec
      continue
    }

    $custody = Get-ActiveRunCustody
    if (-not $custody.Known) {
      if ((Test-PaperclipListener) -or (Test-EmbeddedPostgres)) {
        Write-SupervisorLog "Recovery deferred: active-run custody could not be proven. $($custody.Output)"
        Start-Sleep -Seconds $ProbeIntervalSec
        continue
      }
      Write-SupervisorLog 'No Paperclip or embedded Postgres listener exists; proceeding with a cold start.'
    }
    if ($custody.Known -and $custody.Count -gt 0) {
      Write-SupervisorLog "Recovery deferred: $($custody.Count) queued or running agent run(s) retain custody."
      Start-Sleep -Seconds $ProbeIntervalSec
      continue
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
      foreach ($process in @(Get-ProcessTree -RootProcessId ([int]$child.Id) | Sort-Object ProcessId -Descending)) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
      }
      Start-Sleep -Seconds ([Math]::Min(10, 2 * $startAttempt))
    }

    if (-not $recovered) { throw "Paperclip recovery exhausted $MaxStartAttempts start attempts." }
    $failures = 0
  }
} finally {
  if ($lockStream) { $lockStream.Dispose() }
}
