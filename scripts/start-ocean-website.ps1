param([switch]$Restart,[switch]$DisableWorkflow,[switch]$EnableWorkflow,[switch]$PreserveMonitorState)
if ($PSVersionTable.PSEdition -eq 'Core') {
  $forward = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
  foreach ($key in $PSBoundParameters.Keys) { if ($PSBoundParameters[$key]) { $forward += "-$key" } }
  & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' @forward
  if ($LASTEXITCODE -ne 0) { throw 'Native Windows Ocean launcher failed.' }
  return
}
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules;${env:ProgramFiles}\WindowsPowerShell\Modules"
$Dashboard = 'D:\Paperclip-codex\website\ocean-trading\dashboard'
$Runtime = 'D:\OceanTradingData\website\ocean-runtime'
$StateFile = Join-Path $Runtime 'website-process.json'
$StopFile = Join-Path $Runtime 'website-stop.json'
New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach ($principal in @($sid,'S-1-5-18')) {
  $identity = New-Object Security.Principal.SecurityIdentifier($principal)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
[IO.Directory]::SetAccessControl($Runtime,$acl)
$flag = Join-Path $Runtime 'workflow-disabled.json'
if ($DisableWorkflow -and $EnableWorkflow) { throw 'Choose only one workflow flag.' }
if ($DisableWorkflow -or $EnableWorkflow) { [IO.File]::WriteAllText($flag,(@{disabled=[bool]$DisableWorkflow} | ConvertTo-Json -Compress)) }
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3102 -ErrorAction SilentlyContinue)
if ($listeners.Count -and $Restart) {
  if (-not (Test-Path -LiteralPath $StateFile)) { throw 'Legacy listener has no graceful control receipt. Reconcile the exact old website PID before first activation; no process tree will be killed.' }
  $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
  if (@($listeners | Where-Object { $_.OwningProcess -ne $state.pid }).Count) { throw 'Port 3102 listener differs from protected website receipt.' }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)"
  if (-not $proc -or $proc.CommandLine -notmatch 'server\.mjs' -or $state.dashboard -ne $Dashboard) { throw 'Website process identity conflict.' }
  [IO.File]::WriteAllText($StopFile,($state | Select-Object pid,nonce | ConvertTo-Json -Compress))
  $deadline = (Get-Date).AddSeconds(35)
  while ((Get-Process -Id $state.pid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Get-Process -Id $state.pid -ErrorAction SilentlyContinue) { throw 'Website did not stop cleanly. Other services remain untouched.' }
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3102 -ErrorAction SilentlyContinue)
}
if ($listeners.Count) { Write-Output 'Existing Ocean listener on 3102 retained.'; return }
$env:DASHBOARD_PORT = '3102'
if ($PreserveMonitorState) { $env:OCEAN_TRADING_MONITOR_DEFAULT_ON = '0' }
$disabled = (Test-Path -LiteralPath $flag) -and (Get-Content -LiteralPath $flag -Raw | ConvertFrom-Json).disabled
$env:OCEAN_WORKFLOW_ENABLED = if ($disabled) { '0' } else { '1' }
$env:OCEAN_WORKFLOW_CONFIG = 'D:\OceanTradingData\website\workflow\operator-state.dpapi'
if (-not $disabled) {
  try { & "$PSScriptRoot\ocean-workflow-operator.ps1" -Action Bootstrap | Out-Null }
  catch { Write-Warning 'Machine bootstrap needs operator attention. The independent trading website will still start.' }
}
$env:OCEAN_WEBSITE_CONTROL_ROOT = $Runtime
$logs = Join-Path $Dashboard 'logs'
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$proc = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList @('server.mjs') -WorkingDirectory $Dashboard -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs "website-$stamp.out.log") -RedirectStandardError (Join-Path $logs "website-$stamp.err.log")
$deadline = (Get-Date).AddSeconds(40)
do {
  Start-Sleep -Milliseconds 500
  $ready = $false
  try { $ready = (Invoke-WebRequest -UseBasicParsing 'http://localhost:3102/' -TimeoutSec 3).StatusCode -eq 200 } catch {}
} while (-not $ready -and (Get-Date) -lt $deadline -and -not $proc.HasExited)
if (-not $ready) { throw 'Ocean website startup failed; no unrelated service was restarted.' }
Write-Output "Ocean website ready at http://localhost:3102/ (PID $($proc.Id)). Workflow enrollment is checked independently."
