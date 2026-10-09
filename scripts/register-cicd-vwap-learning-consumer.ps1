<#
.SYNOPSIS
Registers the CICD VWAP learning consumer through Ocean's hidden process launcher.
.DESCRIPTION
An existing registration keeps its principal, triggers and settings. Only its
action is reconciled. Task Hidden and PowerShell -WindowStyle Hidden alone do
not prevent an interactive console from appearing during process startup.
#>
param(
  [ValidateSet('Status', 'Install')]
  [string]$Action = 'Status',
  [string]$EvidenceRoot = 'D:\Trading\CICD\recovery-outputs'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskName = 'OceanTrading-CICDVWAPLearningConsumer'
$taskPath = '\'
$consumer = Join-Path $PSScriptRoot 'consume-cicd-vwap-learning-outbox.ps1'
$launcher = Join-Path $PSScriptRoot 'run-hidden-service.vbs'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$legacyArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$consumer`""
$arguments = "//B //Nologo `"$launcher`" `"$powershell`" $legacyArguments"

foreach ($path in @($consumer, $launcher, $powershell, $wscript)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file missing: $path" }
}

function Get-NonActionXml([string]$Text) {
  $document = [xml]$Text
  $node = $document.SelectSingleNode('/*[local-name()="Task"]/*[local-name()="Actions"]')
  if ($node) { [void]$node.ParentNode.RemoveChild($node) }
  return $document.OuterXml
}

$task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop
$actionMatches = $false
if ($task -and @($task.Actions).Count -eq 1) {
  $current = $task.Actions[0]
  $actionMatches = $current.Execute -ieq $wscript -and $current.Arguments -ceq $arguments -and $current.WorkingDirectory -ieq $root
}
if ($Action -eq 'Status' -or $actionMatches) {
  [pscustomobject]@{
    status = if ($actionMatches) { 'VERIFIED_REUSE' } else { 'REPAIR_REQUIRED' }
    task = "$taskPath$taskName"
    execute = $wscript
    arguments = $arguments
    working_directory = $root
  } | ConvertTo-Json
  return
}

if (@($task.Actions).Count -ne 1 -or
    $task.Actions[0].Execute -notin @('powershell.exe', $powershell) -or
    $task.Actions[0].Arguments -cne $legacyArguments -or
    $task.Actions[0].WorkingDirectory -ine $root) {
  throw 'Unexpected existing action; inspect it before changing the task.'
}
$beforeXml = Export-ScheduledTask -TaskName $taskName -TaskPath $taskPath

$evidence = Join-Path $EvidenceRoot ('OCEAN-HIDDEN-LEARNING-CONSUMER-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
[void][IO.Directory]::CreateDirectory($evidence)
[IO.File]::WriteAllText((Join-Path $evidence 'task-before.xml'), $beforeXml, [Text.Encoding]::Unicode)
$scheduledAction = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $root
Set-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Action $scheduledAction | Out-Null

$afterXml = Export-ScheduledTask -TaskName $taskName -TaskPath $taskPath
[IO.File]::WriteAllText((Join-Path $evidence 'task-after.xml'), $afterXml, [Text.Encoding]::Unicode)
if ($beforeXml -and (Get-NonActionXml $beforeXml) -cne (Get-NonActionXml $afterXml)) {
  throw "Non-action task properties changed unexpectedly. Inspect backup: $evidence"
}
$after = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath
if (@($after.Actions).Count -ne 1 -or $after.Actions[0].Execute -ine $wscript -or
    $after.Actions[0].Arguments -cne $arguments -or $after.Actions[0].WorkingDirectory -ine $root) {
  throw "Task action readback mismatch. Evidence: $evidence"
}
$receipt = [ordered]@{
  status = 'REPAIRED'
  at_utc = [DateTimeOffset]::UtcNow.ToString('o')
  task = "$taskPath$taskName"
  execute = $wscript
  arguments = $arguments
  preserved_non_action_xml = [bool]$beforeXml
  source_hashes = @($PSCommandPath, $launcher, $consumer | ForEach-Object { Get-FileHash -LiteralPath $_ -Algorithm SHA256 | Select-Object Path,Hash })
  evidence_directory = $evidence
  runtime_execution = 'NOT_RUN_BY_INSTALLER'
}
[IO.File]::WriteAllText((Join-Path $evidence 'registration-receipt.json'), ($receipt | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 5
