param([string]$Root)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $Root.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $Root -Leaf) -notlike 'ocean-s302-mutation-*') { throw 'Private mutation fixture required.' }
$stream = [IO.File]::Open((Join-Path $Root 'operator.lock'),'Open','ReadWrite','None')
try {
  [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush()
  $release = [Console]::In.ReadLineAsync()
  if (-not $release.Wait(120000) -or $release.Result -cne 'RELEASE') { throw 'Fixture release signal missing.' }
}
finally { $stream.Dispose() }
