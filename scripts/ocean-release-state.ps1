function New-OceanReleaseMutableDataLink {
  param(
    [Parameter(Mandatory=$true)][string]$PreviousDashboard,
    [Parameter(Mandatory=$true)][string]$CandidateDashboard
  )

  $oldDataDirectory = Join-Path $PreviousDashboard 'data'
  if (-not (Test-Path -LiteralPath $oldDataDirectory -PathType Container)) {
    return $null
  }

  $oldData = Get-Item -LiteralPath $oldDataDirectory
  if ($oldData.LinkType -in @('Junction','SymbolicLink')) {
    $targets = @($oldData.Target)
    if ($targets.Count -ne 1) {
      throw 'Ocean mutable data publisher must resolve to exactly one directory.'
    }
    $publisher = [string]$targets[0]
  } else {
    $publisher = $oldData.FullName
  }

  if (-not [IO.Path]::IsPathRooted($publisher) -or
      $publisher.StartsWith('\\') -or
      -not (Test-Path -LiteralPath $publisher -PathType Container)) {
    throw 'Ocean mutable data publisher is missing or not an absolute local directory.'
  }

  $candidateDataDirectory = Join-Path $CandidateDashboard 'data'
  if (Test-Path -LiteralPath $candidateDataDirectory) {
    throw 'Ocean candidate data path already exists; mutable publisher attachment refused.'
  }

  New-Item -ItemType Junction -Path $candidateDataDirectory -Target $publisher | Out-Null
  Get-Item -LiteralPath $candidateDataDirectory
}
