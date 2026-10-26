function Get-PaperclipRecoveryAction {
  param(
    [bool]$Healthy,
    [int]$ConsecutiveFailures,
    [int]$FailureThreshold,
    [bool]$CustodyKnown,
    [int]$ActiveRunCount,
    [bool]$ServerListenerPresent,
    [bool]$DatabaseListenerPresent
  )

  if ($Healthy) { return 'monitor' }
  if ($ConsecutiveFailures -lt $FailureThreshold) { return 'observe' }
  if (-not $CustodyKnown) {
    if ($ServerListenerPresent -or $DatabaseListenerPresent) { return 'defer_unknown_custody' }
    return 'cold_start'
  }
  if ($ActiveRunCount -gt 0) { return 'defer_active_runs' }
  return 'restart'
}

function New-PaperclipSupervisorState {
  return [pscustomobject]@{ FailureCount = 0; SuccessfulRecoveryCount = 0 }
}

function Update-PaperclipSupervisorState {
  param(
    [Parameter(Mandatory)]$State,
    [bool]$Healthy,
    [switch]$RecoveryCompleted
  )

  return [pscustomobject]@{
    FailureCount = if ($Healthy) { 0 } else { [int]$State.FailureCount + 1 }
    SuccessfulRecoveryCount = [int]$State.SuccessfulRecoveryCount + $(if ($RecoveryCompleted) { 1 } else { 0 })
  }
}

function Invoke-PaperclipSupervisorCycle {
  param(
    [Parameter(Mandatory)]$State,
    [bool]$Healthy,
    [int]$FailureThreshold,
    [bool]$CustodyKnown,
    [int]$ActiveRunCount,
    [bool]$ServerListenerPresent,
    [bool]$DatabaseListenerPresent
  )

  $nextState = Update-PaperclipSupervisorState -State $State -Healthy $Healthy
  $action = Get-PaperclipRecoveryAction -Healthy $Healthy -ConsecutiveFailures $nextState.FailureCount `
    -FailureThreshold $FailureThreshold -CustodyKnown $CustodyKnown -ActiveRunCount $ActiveRunCount `
    -ServerListenerPresent $ServerListenerPresent -DatabaseListenerPresent $DatabaseListenerPresent
  return [pscustomobject]@{ State = $nextState; Action = $action }
}

function Get-PaperclipFencedRecoveryAction {
  param(
    [bool]$CustodyKnown,
    [int]$ActiveRunCount
  )

  if (-not $CustodyKnown) { return 'restore_server_defer_unknown_custody' }
  if ($ActiveRunCount -gt 0) { return 'restore_server_defer_active_runs' }
  return 'shutdown_database'
}

function Get-PaperclipServerStopDeadline {
  param(
    [Parameter(Mandatory)][DateTimeOffset]$NowUtc,
    [Parameter(Mandatory)][DateTimeOffset]$LeaseExpiresAtUtc,
    [int]$MaxStopSeconds = 30,
    [int]$LeaseSafetyMarginSeconds = 5
  )

  if ($MaxStopSeconds -lt 1 -or $LeaseSafetyMarginSeconds -lt 1) {
    throw 'Server stop deadline parameters must be positive.'
  }
  $hardDeadline = $NowUtc.AddSeconds($MaxStopSeconds)
  $leaseDeadline = $LeaseExpiresAtUtc.AddSeconds(-$LeaseSafetyMarginSeconds)
  $deadline = if ($hardDeadline -lt $leaseDeadline) { $hardDeadline } else { $leaseDeadline }
  if ($deadline -le $NowUtc) {
    throw 'Supervisor fence lease has no safe server-stop window remaining.'
  }
  return $deadline
}

function Get-PaperclipSupervisorControlToken {
  param(
    [Parameter(Mandatory)][string]$TokenPath,
    [Parameter(Mandatory)][bool]$ServerPresent
  )

  Add-Type -AssemblyName System.Security
  $entropy = [Text.Encoding]::UTF8.GetBytes('paperclip-supervisor-control-v1')
  if (Test-Path -LiteralPath $TokenPath -PathType Leaf) {
    $protectedBytes = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $TokenPath).Trim())
    $clearBytes = [Security.Cryptography.ProtectedData]::Unprotect(
      $protectedBytes,
      $entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $token = [Text.Encoding]::UTF8.GetString($clearBytes)
    if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 32) {
      throw 'Protected Paperclip supervisor control token is invalid.'
    }
    return $token
  }

  if ($ServerPresent) {
    throw 'Protected Paperclip supervisor control token is missing while a server is running; reattachment refused.'
  }

  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = [Convert]::ToBase64String($bytes)
  $clearBytes = [Text.Encoding]::UTF8.GetBytes($token)
  $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
    $clearBytes,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $temporaryPath = "$TokenPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temporaryPath, [Convert]::ToBase64String($protectedBytes), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $TokenPath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
  }
  return $token
}
