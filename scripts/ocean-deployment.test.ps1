$ErrorActionPreference = 'Stop'

function Assert-Test([bool]$Condition,[string]$Message) {
  if (-not $Condition) { throw $Message }
}

$scriptsRoot = Split-Path -Parent $PSCommandPath
. (Join-Path $scriptsRoot 'ocean-deployment.ps1')
$repositoryRoot = Split-Path -Parent $scriptsRoot
$dashboard = Join-Path $repositoryRoot 'website\ocean-trading\dashboard'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('ocean-deployment-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null

try {
  $binding = Join-Path $fixture 'binding.json'
  [IO.File]::WriteAllText($binding,'{"schema_version":"test-binding/v1"}',[Text.UTF8Encoding]::new($false))
  $bindingHash = (Get-FileHash -LiteralPath $binding -Algorithm SHA256).Hash.ToLowerInvariant()
  $runtimePaths = @('server.mjs','monitor.mjs','workflow\backend.mjs',
    'workflow\operational-candidate-evaluation.mjs','workflow\operational-candidate-dispatch.mjs',
    'public\workflow\ui.js')
  $runtimeFiles = @($runtimePaths | ForEach-Object {
    [pscustomobject][ordered]@{relative_path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $dashboard $_) -Algorithm SHA256).Hash.ToLowerInvariant()}
  })
  $fileMapText = (@($runtimeFiles | Sort-Object relative_path | ForEach-Object { "$($_.relative_path)`t$($_.sha256)" }) -join "`n")
  $fileMapHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($fileMapText))).Replace('-','').ToLowerInvariant()
  $manifest = Join-Path $fixture 'deployment.json'
  [IO.File]::WriteAllText($manifest,([ordered]@{
    schema_version='ocean-website-deployment/v1'
    release_id='test-release'
    source_commit=('a' * 40)
    dashboard=$dashboard
    physical_binding_file=$binding
    physical_binding_sha256=$bindingHash
    file_map_sha256=$fileMapHash
    files=$runtimeFiles
  } | ConvertTo-Json),[Text.UTF8Encoding]::new($false))

  $resolved = Get-OceanDeployment -ConfigPath $manifest
  Assert-Test ($resolved.ReleaseId -ceq 'test-release') 'VALID_DEPLOYMENT_WAS_NOT_RESOLVED'
  Assert-Test ($resolved.Dashboard -ceq $dashboard) 'DASHBOARD_PATH_CHANGED'
  Assert-Test ($resolved.PhysicalBindingSha256 -ceq $bindingHash) 'BINDING_HASH_CHANGED'
  Assert-Test ($resolved.ManifestSha256 -ceq (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()) 'MANIFEST_HASH_CHANGED'
  Assert-Test ($resolved.FileMapSha256 -ceq $fileMapHash) 'FILE_MAP_HASH_CHANGED'
  Assert-Test (Test-OceanLocalAbsolutePath $dashboard) 'LOCAL_ABSOLUTE_PATH_WAS_REJECTED'
  Assert-Test (-not (Test-OceanLocalAbsolutePath '\\server\share\dashboard')) 'UNC_PATH_WAS_ACCEPTED'
  Assert-Test (-not (Test-OceanLocalAbsolutePath (Join-Path $dashboard '..\dashboard'))) 'NONCANONICAL_PATH_WAS_ACCEPTED'

  $wrongRuntimeHash = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  $wrongRuntimeHash.files[0].sha256 = '0' * 64
  $wrongRuntimeManifest = Join-Path $fixture 'deployment-wrong-runtime.json'
  [IO.File]::WriteAllText($wrongRuntimeManifest,($wrongRuntimeHash | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  $runtimeFailure = $null
  try { $null = Get-OceanDeployment -ConfigPath $wrongRuntimeManifest } catch { $runtimeFailure = $_.Exception.Message }
  Assert-Test ($runtimeFailure -like 'Ocean deployment runtime hash mismatch:*') 'RUNTIME_TAMPER_WAS_ACCEPTED'

  [IO.File]::AppendAllText($binding,'tamper')
  $failure = $null
  try { $null = Get-OceanDeployment -ConfigPath $manifest } catch { $failure = $_.Exception.Message }
  Assert-Test ($failure -like 'Ocean physical binding hash mismatch:*') 'BINDING_TAMPER_WAS_ACCEPTED'
} finally {
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'Ocean deployment resolver contract: PASS'
