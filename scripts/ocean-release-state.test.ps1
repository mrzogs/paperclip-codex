$ErrorActionPreference = 'Stop'

function Assert-Test([bool]$Condition,[string]$Message) {
  if (-not $Condition) { throw $Message }
}

. (Join-Path $PSScriptRoot 'ocean-release-state.ps1')

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('ocean-release-state-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null

try {
  $publisher = Join-Path $fixture 'publisher'
  $previous = Join-Path $fixture 'previous'
  $candidate = Join-Path $fixture 'candidate'
  New-Item -ItemType Directory -Path $publisher,$previous,$candidate | Out-Null
  [IO.File]::WriteAllText((Join-Path $publisher 'manifest.json'),'mutable',[Text.UTF8Encoding]::new($false))
  New-Item -ItemType Junction -Path (Join-Path $previous 'data') -Target $publisher | Out-Null

  $result = New-OceanReleaseMutableDataLink -PreviousDashboard $previous -CandidateDashboard $candidate
  Assert-Test ($result.LinkType -eq 'Junction') 'CANDIDATE_DATA_IS_NOT_A_JUNCTION'
  Assert-Test ([IO.Path]::GetFullPath([string]@($result.Target)[0]) -ceq (Resolve-Path -LiteralPath $publisher).Path) `
    'CANDIDATE_DATA_TARGET_CHANGED'
  Assert-Test ((Get-Content -Raw -LiteralPath (Join-Path $candidate 'data\manifest.json')) -ceq 'mutable') `
    'CANDIDATE_CANNOT_READ_MUTABLE_PUBLISHER'

  $plainPrevious = Join-Path $fixture 'plain-previous'
  $plainCandidate = Join-Path $fixture 'plain-candidate'
  New-Item -ItemType Directory -Path (Join-Path $plainPrevious 'data'),$plainCandidate -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $plainPrevious 'data\state.json'),'legacy',[Text.UTF8Encoding]::new($false))
  $plainResult = New-OceanReleaseMutableDataLink -PreviousDashboard $plainPrevious -CandidateDashboard $plainCandidate
  Assert-Test ($plainResult.LinkType -eq 'Junction') 'PLAIN_PREVIOUS_DATA_WAS_COPIED'
  Assert-Test ((Get-Content -Raw -LiteralPath (Join-Path $plainCandidate 'data\state.json')) -ceq 'legacy') `
    'PLAIN_PREVIOUS_DATA_IS_NOT_LIVE'

  $collision = $null
  try { $null = New-OceanReleaseMutableDataLink -PreviousDashboard $previous -CandidateDashboard $candidate } catch { $collision = $_.Exception.Message }
  Assert-Test ($collision -eq 'Ocean candidate data path already exists; mutable publisher attachment refused.') `
    'EXISTING_CANDIDATE_DATA_WAS_OVERWRITTEN'
} finally {
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'Ocean release mutable data contract: PASS'
