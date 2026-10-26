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

