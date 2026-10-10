param(
  [ValidateSet('Install','Start','Stop','Restart','Status','Health','Uninstall')]
  [string]$Action = 'Status',
  [ValidateSet('All','Paperclip','Website','Monitor','ReplayBridge','CodexBridge')]
  [string[]]$Component = @('All'),
  [switch]$NoMonitor,
  [switch]$DisableWorkflow,
  [switch]$EnableWorkflow
)

$ErrorActionPreference = 'Stop'

$TaskPath = '\OceanTrading\'
$Root = 'D:\Paperclip-codex'
$PaperclipHome = 'D:\Paperclip-codex\.paperclip-home'
$Dashboard = 'D:\Paperclip-codex\website\ocean-trading\dashboard'
$Runtime = 'D:\OceanTradingData\website\ocean-runtime'
$PaperclipConfigPath = Join-Path $PaperclipHome 'instances\default\config.json'
$Powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$Wscript = 'C:\Windows\System32\wscript.exe'
$HiddenLauncher = Join-Path $Root 'scripts\run-hidden-service.vbs'

function Resolve-Components {
  $selected = [System.Collections.Generic.List[string]]::new()
  if ($Component -contains 'All') {
    foreach ($item in @('Paperclip','Website','Monitor','ReplayBridge','CodexBridge')) { [void]$selected.Add($item) }
  } else {
    foreach ($item in $Component) { [void]$selected.Add($item) }
  }
  if ($NoMonitor) { return @($selected | Where-Object { $_ -ne 'Monitor' }) }
  return @($selected | Select-Object -Unique)
}

function Get-PostgresPort {
  if (-not (Test-Path -LiteralPath $PaperclipConfigPath)) { return $null }
  $config = Get-Content -LiteralPath $PaperclipConfigPath -Raw | ConvertFrom-Json
  return [int]$config.database.embeddedPostgresPort
}

function Test-PortListening([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Test-HttpOk([string]$Url, [int]$TimeoutSec = 5) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec $TimeoutSec
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Get-TaskSpec([string]$Name) {
  switch ($Name) {
    'Paperclip' {
      return @{
        TaskName = 'OceanTrading-Paperclip'
        Script = Join-Path $Root 'scripts\run-paperclip-supervised.ps1'
        Description = 'Ocean Trading Paperclip UI and embedded Postgres. Runs outside Codex.'
      }
    }
    'Website' {
      return @{
        TaskName = 'OceanTrading-Website'
        Script = Join-Path $Root 'scripts\run-ocean-website-supervised.ps1'
        Description = 'Ocean Trading website on port 3102. Runs outside Codex.'
      }
    }
    'Monitor' {
      return @{
        TaskName = 'OceanTrading-Monitor'
        Script = Join-Path $Root 'scripts\run-ocean-monitor-supervised.ps1'
        Description = 'Ocean Trading database/log monitor. Runs outside Codex.'
      }
    }
    'ReplayBridge' {
      return @{
        TaskName = 'OceanTrading-ReplayBridge'
        Script = Join-Path $Root 'scripts\run-ocean-replay-bridge.ps1'
        Description = 'TEST-only Ocean run lease and heartbeat bridge for scoped VWAP Replay Two telemetry.'
      }
    }
    'CodexBridge' {
      return @{
        TaskName = 'OceanTrading-CodexBridge'
        Script = Join-Path $Root 'scripts\run-codex-bridge-supervised.ps1'
        Description = 'Optional Codex app-server bridge on port 8793. Website must not depend on it.'
      }
    }
  }
}

function Register-OceanTask([string]$Name) {
  $spec = Get-TaskSpec $Name
  if (-not (Test-Path -LiteralPath $spec.Script)) { throw "Task script missing for ${Name}: $($spec.Script)" }
  if (-not (Test-Path -LiteralPath $HiddenLauncher)) { throw "Hidden service launcher missing: $HiddenLauncher" }
  $arguments = "//B //Nologo `"$HiddenLauncher`" `"$Powershell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($spec.Script)`""
  $action = New-ScheduledTaskAction -Execute $Wscript -Argument $arguments -WorkingDirectory $Root
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  # RestartCount is not honoured consistently for manually started long-running tasks.
  # This trigger provides an independent liveness retry; IgnoreNew prevents duplicates.
  $recoveryTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settingsArgs = @{
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    ExecutionTimeLimit = (New-TimeSpan -Seconds 0)
    Hidden = $true
    MultipleInstances = 'IgnoreNew'
    RestartCount = 3
    RestartInterval = (New-TimeSpan -Minutes 1)
    StartWhenAvailable = $true
  }
  $settings = New-ScheduledTaskSettingsSet @settingsArgs
  Register-ScheduledTask -TaskPath $TaskPath -TaskName $spec.TaskName -Action $action -Trigger @($logonTrigger,$recoveryTrigger) -Settings $settings -Principal $principal -Description $spec.Description -Force | Out-Null
}

function Ensure-Tasks([string[]]$Names) {
  foreach ($name in $Names) { Register-OceanTask $name }
}

function Get-TaskState([string]$Name) {
  $spec = Get-TaskSpec $Name
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $spec.TaskName -ErrorAction SilentlyContinue
  if (-not $task) { return 'Missing' }
  return $task.State.ToString()
}

function Start-TaskComponent([string]$Name) {
  $spec = Get-TaskSpec $Name
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $spec.TaskName
}

function Stop-TaskComponent([string]$Name) {
  $spec = Get-TaskSpec $Name
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $spec.TaskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskPath $TaskPath -TaskName $spec.TaskName
  }
}

function Disable-TaskComponent([string]$Name) {
  $spec = Get-TaskSpec $Name
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $spec.TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Disable-ScheduledTask -TaskPath $TaskPath -TaskName $spec.TaskName | Out-Null
  }
}

function Stop-PortProcess([int]$Port, [string]$ExpectedPattern, [string]$Label) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and ($proc.CommandLine -as [string]) -match $ExpectedPattern) {
      Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
      Write-Output "Stopped $Label PID $($listener.OwningProcess) on port $Port."
    } elseif ($proc) {
      throw "Port $Port is owned by unexpected process $($listener.OwningProcess): $($proc.CommandLine)"
    }
  }
}

function Stop-WebsiteGracefully {
  $stateFile = Join-Path $Runtime 'website-process.json'
  $stopFile = Join-Path $Runtime 'website-stop.json'
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3102 -ErrorAction SilentlyContinue)
  if (-not $listeners.Count) { return }
  if (Test-Path -LiteralPath $stateFile) {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $owned = @($listeners | Where-Object { $_.OwningProcess -eq $state.pid })
    if ($owned.Count) {
      [IO.File]::WriteAllText($stopFile, ($state | Select-Object pid,nonce | ConvertTo-Json -Compress))
      $deadline = (Get-Date).AddSeconds(35)
      while ((Get-Process -Id $state.pid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    }
  }
  Stop-PortProcess 3102 'server\.mjs' 'Ocean website'
}

function Get-MonitorProcesses {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.CommandLine -as [string]) -match [regex]::Escape((Join-Path $Dashboard 'monitor.mjs')) -or
      ($_.CommandLine -as [string]) -match 'node(\.exe)?"?\s+monitor\.mjs'
    }
}

function Stop-MonitorProcesses {
  foreach ($proc in @(Get-MonitorProcesses)) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped Ocean monitor PID $($proc.ProcessId)."
  }
}

function Get-ReplayBridgeProcesses {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.CommandLine -as [string]) -match [regex]::Escape((Join-Path $Root 'scripts\run-ocean-replay-bridge.ps1'))
    }
}

function Stop-ReplayBridgeProcesses {
  foreach ($proc in @(Get-ReplayBridgeProcesses)) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped Ocean Replay Bridge PID $($proc.ProcessId)."
  }
}

function Stop-ComponentProcesses([string]$Name) {
  Stop-TaskComponent $Name
  switch ($Name) {
    'Paperclip' {
      Stop-PortProcess 3100 'paperclipai|cli/src/index\.ts' 'Paperclip'
      $pgPort = Get-PostgresPort
      if ($pgPort) { Stop-PortProcess $pgPort 'postgres\.exe' 'embedded Postgres' }
    }
    'Website' { Stop-WebsiteGracefully }
    'Monitor' { Stop-MonitorProcesses }
    'ReplayBridge' {
      Stop-ReplayBridgeProcesses
      Remove-Item -LiteralPath (Join-Path $Runtime 'replay-bridge-status.json') -Force -ErrorAction SilentlyContinue
    }
    'CodexBridge' { Stop-PortProcess 8793 'codex\.exe.*app-server' 'Codex bridge' }
  }
}

function Wait-ComponentHealthy([string]$Name) {
  switch ($Name) {
    'Paperclip' {
      $pgPort = Get-PostgresPort
      $deadline = (Get-Date).AddMinutes(3)
      do {
        $ok = (Test-HttpOk 'http://127.0.0.1:3100/api/health') -and ($pgPort -and (Test-PortListening $pgPort))
        if (-not $ok) { Start-Sleep -Seconds 2 }
      } while (-not $ok -and (Get-Date) -lt $deadline)
      if (-not $ok) { throw 'Paperclip/Postgres did not become healthy.' }
    }
    'Website' {
      # The supervised child has a 90-second protected-workflow startup gate.
      # Keep the outer service command longer so it cannot report failure while
      # the accepted supervisor generation is still within its own contract.
      $deadline = (Get-Date).AddSeconds(120)
      do {
        $ok = Test-HttpOk 'http://127.0.0.1:3102/'
        if (-not $ok) { Start-Sleep -Seconds 1 }
      } while (-not $ok -and (Get-Date) -lt $deadline)
      if (-not $ok) { throw 'Ocean website did not become healthy.' }
    }
    'Monitor' {
      Start-Sleep -Seconds 2
      if (-not @(Get-MonitorProcesses).Count) { throw 'Ocean monitor is not running.' }
    }
    'ReplayBridge' {
      # A completed month can require hundreds of authenticated evidence writes
      # before the first status receipt is published.
      $deadline = (Get-Date).AddSeconds(120)
      do {
        $statusFile = Join-Path $Runtime 'replay-bridge-status.json'
        $ok = $false
        if (Test-Path -LiteralPath $statusFile) {
          try {
            $bridge = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
            $updatedAt = [DateTimeOffset]$bridge.updated_at_utc
            $ok = $bridge.pid -and (Get-Process -Id $bridge.pid -ErrorAction SilentlyContinue) -and
              ([DateTimeOffset]::UtcNow - $updatedAt.ToUniversalTime()).TotalSeconds -lt 30
          } catch { $ok = $false }
        }
        if (-not $ok) { Start-Sleep -Seconds 1 }
      } while (-not $ok -and (Get-Date) -lt $deadline)
      if (-not $ok) { throw 'Ocean Replay Bridge did not become healthy.' }
    }
    'CodexBridge' {
      $deadline = (Get-Date).AddSeconds(30)
      do {
        $ok = Test-PortListening 8793
        if (-not $ok) { Start-Sleep -Milliseconds 500 }
      } while (-not $ok -and (Get-Date) -lt $deadline)
      if (-not $ok) { Write-Warning 'Codex bridge did not become healthy. Website services remain independent.' }
    }
  }
}

function Set-WorkflowFlag {
  if ($DisableWorkflow -and $EnableWorkflow) { throw 'Choose only one workflow flag.' }
  if (-not ($DisableWorkflow -or $EnableWorkflow)) { return }
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  $flag = Join-Path $Runtime 'workflow-disabled.json'
  [IO.File]::WriteAllText($flag, (@{disabled=[bool]$DisableWorkflow} | ConvertTo-Json -Compress))
}

function Get-ServiceSnapshot {
  $pgPort = Get-PostgresPort
  $ports = @(3100,3102,8793)
  if ($pgPort) { $ports += $pgPort }
  [pscustomobject]@{
    timestamp = (Get-Date).ToString('o')
    tasks = @('Paperclip','Website','Monitor','ReplayBridge','CodexBridge') | ForEach-Object {
      $spec = Get-TaskSpec $_
      $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $spec.TaskName -ErrorAction SilentlyContinue
      [pscustomobject]@{ component=$_; task=$spec.TaskName; state=Get-TaskState $_; lastRun=$info.LastRunTime; lastResult=$info.LastTaskResult; nextRun=$info.NextRunTime }
    }
    health = [pscustomobject]@{
      paperclip = Test-HttpOk 'http://127.0.0.1:3100/api/health'
      postgres = if ($pgPort) { Test-PortListening $pgPort } else { $false }
      website = Test-HttpOk 'http://127.0.0.1:3102/'
      codexBridge = Test-PortListening 8793
      monitor = [bool]@(Get-MonitorProcesses).Count
      replayBridge = if (Test-Path -LiteralPath (Join-Path $Runtime 'replay-bridge-status.json')) {
        try {
          $bridge = Get-Content -LiteralPath (Join-Path $Runtime 'replay-bridge-status.json') -Raw | ConvertFrom-Json
          $updatedAt = [DateTimeOffset]$bridge.updated_at_utc
          [bool]($bridge.pid -and (Get-Process -Id $bridge.pid -ErrorAction SilentlyContinue) -and ([DateTimeOffset]::UtcNow - $updatedAt.ToUniversalTime()).TotalSeconds -lt 30)
        } catch { $false }
      } else { $false }
    }
    listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in ($ports | Select-Object -Unique) } | ForEach-Object {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" -ErrorAction SilentlyContinue
      [pscustomobject]@{ port=$_.LocalPort; pid=$_.OwningProcess; parentPid=$proc.ParentProcessId; name=$proc.Name; commandLine=$proc.CommandLine }
    })
  }
}

$selected = Resolve-Components

Set-WorkflowFlag

switch ($Action) {
  'Install' {
    Ensure-Tasks @('Paperclip','Website','Monitor','ReplayBridge','CodexBridge')
    Get-ServiceSnapshot | ConvertTo-Json -Depth 6
  }
  'Start' {
    Ensure-Tasks $selected
    foreach ($name in $selected) {
      $alreadyHealthy = switch ($name) {
        'Paperclip' { (Test-HttpOk 'http://127.0.0.1:3100/api/health') -and ((Get-PostgresPort) -and (Test-PortListening (Get-PostgresPort))) }
        'Website' { Test-HttpOk 'http://127.0.0.1:3102/' }
        'Monitor' { [bool]@(Get-MonitorProcesses).Count }
        'ReplayBridge' {
          $state = Join-Path $Runtime 'replay-bridge-status.json'
          if (-not (Test-Path -LiteralPath $state)) { $false }
          else {
            try { $bridge=Get-Content -LiteralPath $state -Raw|ConvertFrom-Json; [bool]($bridge.pid -and (Get-Process -Id $bridge.pid -ErrorAction SilentlyContinue)) }
            catch { $false }
          }
        }
        'CodexBridge' { Test-PortListening 8793 }
      }
      if ($alreadyHealthy) {
        Write-Output "$name already healthy."
      } else {
        Start-TaskComponent $name
        Wait-ComponentHealthy $name
      }
    }
    Get-ServiceSnapshot | ConvertTo-Json -Depth 6
  }
  'Stop' {
    foreach ($name in $selected) { Disable-TaskComponent $name }
    foreach ($name in @($selected | Sort-Object { @('CodexBridge','ReplayBridge','Monitor','Website','Paperclip').IndexOf($_) })) {
      Stop-ComponentProcesses $name
    }
    Get-ServiceSnapshot | ConvertTo-Json -Depth 6
  }
  'Restart' {
    foreach ($name in $selected) { Disable-TaskComponent $name }
    foreach ($name in @($selected | Sort-Object { @('CodexBridge','ReplayBridge','Monitor','Website','Paperclip').IndexOf($_) })) {
      Stop-ComponentProcesses $name
    }
    Ensure-Tasks $selected
    foreach ($name in @($selected | Sort-Object { @('Paperclip','Website','Monitor','ReplayBridge','CodexBridge').IndexOf($_) })) {
      Start-TaskComponent $name
      Wait-ComponentHealthy $name
    }
    Get-ServiceSnapshot | ConvertTo-Json -Depth 6
  }
  'Status' {
    Get-ServiceSnapshot | ConvertTo-Json -Depth 6
  }
  'Health' {
    $snapshot = Get-ServiceSnapshot
    $snapshot | ConvertTo-Json -Depth 6
    if (-not ($snapshot.health.paperclip -and $snapshot.health.postgres -and $snapshot.health.website)) { exit 1 }
  }
  'Uninstall' {
    foreach ($name in @('Paperclip','Website','Monitor','ReplayBridge','CodexBridge')) {
      $spec = Get-TaskSpec $name
      Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $spec.TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    Get-ServiceSnapshot | ConvertTo-Json -Depth 6
  }
}
