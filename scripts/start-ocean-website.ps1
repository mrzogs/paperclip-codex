param(
  [switch]$Restart,
  [switch]$DisableWorkflow,
  [switch]$EnableWorkflow,
  [switch]$PreserveMonitorState
)

$ErrorActionPreference = 'Stop'
if ($DisableWorkflow -and $EnableWorkflow) { throw 'Choose only one workflow flag.' }

$manager = Join-Path $PSScriptRoot 'manage-ocean-services.ps1'
if (-not (Test-Path -LiteralPath $manager)) { throw "Managed Ocean service launcher missing: $manager" }

$parameters = @{
  Action = if ($Restart) { 'Restart' } else { 'Start' }
  Component = @('Website')
}
if ($DisableWorkflow) { $parameters.DisableWorkflow = $true }
if ($EnableWorkflow) { $parameters.EnableWorkflow = $true }

# The managed website never changes the monitor component, so preserving its
# state is the normal behavior rather than a separate direct-launch mode.
& $manager @parameters
