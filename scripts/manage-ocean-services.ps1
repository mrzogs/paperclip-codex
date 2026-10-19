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
$Runtime = 'D:\OceanTradingData\website\ocean-runtime'
. (Join-Path $PSScriptRoot 'ocean-deployment.ps1')
$script:Deployment = $null
$PaperclipConfigPath = Join-Path $PaperclipHome 'instances\default\config.json'
$Powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$Wscript = 'C:\Windows\System32\wscript.exe'
$HiddenLauncher = Join-Path $Root 'scripts\run-hidden-service.vbs'

function Get-ValidatedOceanDeployment {
  if (-not $script:Deployment) {
    $script:Deployment = Get-OceanDeployment -ConfigPath (Join-Path $Runtime 'deployment.json')
  }
  return $script:Deployment
}

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

function Get-OceanWorkflowReadiness([int]$TimeoutSec = 5) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3102/api/workflow/readiness' `
      -Headers @{ Origin = 'http://127.0.0.1:3102' } -TimeoutSec $TimeoutSec
    if ([int]$response.StatusCode -ne 200) { return $null }
    return $response.Content | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-OceanWorkflowReady {
  try {
    $deployment = Get-ValidatedOceanDeployment
  } catch {
    return $false
  }
  $readiness = Get-OceanWorkflowReadiness
  return [bool]($readiness -and
    $readiness.workflow.state -ceq 'READY' -and
    [int]$readiness.workflow.schema_version -eq 13 -and
    $readiness.workflow.deployment.release_id -ceq $deployment.ReleaseId -and
    $readiness.workflow.deployment.source_commit -ceq $deployment.SourceCommit -and
    $readiness.workflow.deployment.manifest_sha256 -ceq $deployment.ManifestSha256 -and
    $readiness.workflow.operational_learning.enabled -eq $true -and
    $readiness.workflow.operational_learning.state -ceq 'READY' -and
    -not $readiness.workflow.operational_learning.last_error -and
    $readiness.workflow.candidate_evaluator.version -ceq 'ocean-operational-candidate-evaluator/v2' -and
    $readiness.workflow.candidate_evaluator.state -in @('READY','RUNNING') -and
    -not $readiness.workflow.candidate_evaluator.last_error)
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
  $websiteProcessIds = @($listeners | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
  $state = $null
  if (Test-Path -LiteralPath $stateFile) {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($state.pid -and ([int]$state.pid -notin $websiteProcessIds)) { $websiteProcessIds += [int]$state.pid }
  }
  if (-not $listeners.Count) {
    Stop-WebsiteOwnedMonitorProcesses -WebsiteProcessIds $websiteProcessIds
    return
  }
  if ($state) {
    $owned = @($listeners | Where-Object { $_.OwningProcess -eq $state.pid })
    if ($owned.Count) {
      [IO.File]::WriteAllText($stopFile, ($state | Select-Object pid,nonce | ConvertTo-Json -Compress))
      $deadline = (Get-Date).AddSeconds(35)
      while ((Get-Process -Id $state.pid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    }
  }
  Stop-PortProcess 3102 'server\.mjs' 'Ocean website'
  Stop-WebsiteOwnedMonitorProcesses -WebsiteProcessIds $websiteProcessIds
}

function Get-MonitorProcesses {
  try {
    $monitorPath = Join-Path (Get-ValidatedOceanDeployment).Dashboard 'monitor.mjs'
  } catch {
    return @()
  }
  $monitorPattern = [regex]::Escape($monitorPath)
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -ieq 'node.exe' -and
      ($_.CommandLine -as [string]) -match $monitorPattern
    }
}

function Get-ReleaseMonitorCommandPattern {
  $deploymentRoot = [IO.Path]::GetFullPath('D:\OceanTradingData\website\deployments').TrimEnd('\') + '\'
  return [regex]::Escape($deploymentRoot) +
    'ocean-[^\\"]+\\(?:paperclip-source\\)?website\\ocean-trading\\dashboard\\monitor\.mjs(?:["\s]|$)'
}

function Get-MonitorSupervisorCommandPattern {
  return [regex]::Escape((Join-Path $Root 'scripts\run-ocean-monitor-supervised.ps1'))
}

function Stop-WebsiteOwnedMonitorProcesses {
  param([int[]]$WebsiteProcessIds)
  if (-not $WebsiteProcessIds.Count) { return }
  $owners = [Collections.Generic.HashSet[int]]::new()
  foreach ($processId in $WebsiteProcessIds) { if ($processId -gt 0) { [void]$owners.Add($processId) } }
  $releaseMonitorPattern = Get-ReleaseMonitorCommandPattern
  $owned = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -ieq 'node.exe' -and
    $owners.Contains([int]$_.ParentProcessId) -and
    ($_.CommandLine -as [string]) -match $releaseMonitorPattern
  })
  foreach ($proc in $owned) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped website-owned Ocean monitor PID $($proc.ProcessId) from retired website PID $($proc.ParentProcessId)."
  }
}

function Get-MonitorOwnedProcessTree {
  param(
    [object[]]$Snapshot,
    [object[]]$Roots
  )

  $owned = [Collections.Generic.HashSet[int]]::new()
  foreach ($proc in $Roots) { [void]$owned.Add([int]$proc.ProcessId) }
  do {
    $added = $false
    foreach ($proc in $Snapshot) {
      if ($owned.Contains([int]$proc.ParentProcessId) -and $owned.Add([int]$proc.ProcessId)) {
        $added = $true
      }
    }
  } while ($added)
  return @($Snapshot | Where-Object { $owned.Contains([int]$_.ProcessId) })
}

function Stop-MonitorProcesses {
  $snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $releaseMonitorPattern = Get-ReleaseMonitorCommandPattern
  $supervisorPattern = Get-MonitorSupervisorCommandPattern
  $roots = @($snapshot | Where-Object {
    $commandLine = $_.CommandLine -as [string]
    ($_.Name -ieq 'node.exe' -and $commandLine -match $releaseMonitorPattern) -or
    ($_.Name -ieq 'powershell.exe' -and $commandLine -match $supervisorPattern)
  })
  $supervisorIds = [Collections.Generic.HashSet[int]]::new()
  foreach ($proc in $roots | Where-Object { $_.Name -ieq 'powershell.exe' }) {
    [void]$supervisorIds.Add([int]$proc.ProcessId)
  }
  $tree = @(Get-MonitorOwnedProcessTree -Snapshot $snapshot -Roots $roots)
  foreach ($proc in @($tree | Sort-Object @{ Expression = { if ($supervisorIds.Contains([int]$_.ProcessId)) { 0 } else { 1 } } }, ProcessId)) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped Ocean monitor generation PID $($proc.ProcessId)."
  }
}

function Write-MonitorStoppedState([string]$Reason = 'managed-service-stop') {
  try {
    $dashboard = (Get-ValidatedOceanDeployment).Dashboard
    $stateFile = Join-Path $dashboard 'data\monitor-state.json'
    $previous = $null
    if (Test-Path -LiteralPath $stateFile) {
      try { $previous = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json }
      catch { $previous = $null }
    }
    $next = [ordered]@{}
    if ($previous) {
      foreach ($property in $previous.PSObject.Properties) { $next[$property.Name] = $property.Value }
    }
    $now = [DateTimeOffset]::UtcNow.ToString('o')
    $events = @($next['recentEvents']) | Where-Object { $null -ne $_ }
    $events += [pscustomobject]@{
      atUtc = $now
      level = 'info'
      action = 'managed-stop'
      message = 'Monitor worker stopped by the managed service controller'
      reason = $Reason
    }
    $next['pid'] = $null
    $next['running'] = $false
    $next['status'] = 'stopped'
    $next['error'] = $null
    $next['stoppedAtUtc'] = $now
    $next['updatedAtUtc'] = $now
    $next['recentEvents'] = @($events | Select-Object -Last 20)
    $directory = Split-Path -Parent $stateFile
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = Join-Path $directory ".monitor-state.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
      [IO.File]::WriteAllText(
        $temporary,
        ($next | ConvertTo-Json -Depth 12),
        [Text.UTF8Encoding]::new($false)
      )
      Move-Item -LiteralPath $temporary -Destination $stateFile -Force
    } finally {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Warning "Could not publish the managed Ocean monitor stopped state: $($_.Exception.Message)"
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
    'Monitor' {
      Stop-MonitorProcesses
      Write-MonitorStoppedState
    }
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
        $ok = Test-OceanWorkflowReady
        if (-not $ok) { Start-Sleep -Seconds 1 }
      } while (-not $ok -and (Get-Date) -lt $deadline)
      if (-not $ok) { throw 'Ocean website did not become healthy.' }
    }
    'Monitor' {
      $deadline = (Get-Date).AddSeconds(30)
      do {
        $ok = [bool]@(Get-MonitorProcesses).Count
        if (-not $ok) { Start-Sleep -Milliseconds 250 }
      } while (-not $ok -and (Get-Date) -lt $deadline)
      if (-not $ok) { throw 'Ocean monitor is not running.' }
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
      workflow = Test-OceanWorkflowReady
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
        'Website' { Test-OceanWorkflowReady }
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
    if (-not ($snapshot.health.paperclip -and $snapshot.health.postgres -and $snapshot.health.website -and
      $snapshot.health.workflow -and $snapshot.health.monitor)) { exit 1 }
  }
  'Uninstall' {
    foreach ($name in @('Paperclip','Website','Monitor','ReplayBridge','CodexBridge')) {
      $spec = Get-TaskSpec $name
      Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $spec.TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    Get-ServiceSnapshot | ConvertTo-Json -Depth 6
  }
}
