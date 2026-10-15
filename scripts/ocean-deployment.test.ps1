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
    'workflow\operational-candidate-governance.mjs',
    'workflow\operational-candidate-evaluation.mjs','workflow\operational-candidate-dispatch.mjs',
    'public\workflow\ui.js','public\index.html','public\app.js')
  $runtimePaths += @(Get-ChildItem -LiteralPath (Join-Path $dashboard 'quant-terminal') -Recurse -File |
    Where-Object { $_.FullName -notmatch '\\(?:data|node_modules)\\' } |
    ForEach-Object { $_.FullName.Substring($dashboard.Length + 1) })
  $runtimeFiles = @($runtimePaths | ForEach-Object {
    [pscustomobject][ordered]@{relative_path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $dashboard $_) -Algorithm SHA256).Hash.ToLowerInvariant()}
  })
  $supportPaths = @('scripts\consume-ocean-proposal-planning.mjs','scripts\ocean-workflow-operator.ps1')
  $supportFiles = @($supportPaths | ForEach-Object {
    [pscustomobject][ordered]@{relative_path=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $repositoryRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant()}
  })
  $fileMapHash = Get-OceanDeploymentFileMapHash -Entries $runtimeFiles
  $supportFileMapHash = Get-OceanDeploymentFileMapHash -Entries $supportFiles
  $manifest = Join-Path $fixture 'deployment.json'
  [IO.File]::WriteAllText($manifest,([ordered]@{
    schema_version='ocean-website-deployment/v1'
    release_id='test-release'
    source_commit=('a' * 40)
    dashboard=$dashboard
    source_root=$repositoryRoot
    physical_binding_file=$binding
    physical_binding_sha256=$bindingHash
    file_map_sha256=$fileMapHash
    files=$runtimeFiles
    support_file_map_sha256=$supportFileMapHash
    support_files=$supportFiles
  } | ConvertTo-Json),[Text.UTF8Encoding]::new($false))

  $resolved = Get-OceanDeployment -ConfigPath $manifest
  Assert-Test ($resolved.ReleaseId -ceq 'test-release') 'VALID_DEPLOYMENT_WAS_NOT_RESOLVED'
  Assert-Test ($resolved.Dashboard -ceq $dashboard) 'DASHBOARD_PATH_CHANGED'
  Assert-Test ($resolved.SourceRoot -ceq $repositoryRoot) 'SOURCE_ROOT_CHANGED'
  Assert-Test ($resolved.PhysicalBindingSha256 -ceq $bindingHash) 'BINDING_HASH_CHANGED'
  Assert-Test ($resolved.ManifestSha256 -ceq (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()) 'MANIFEST_HASH_CHANGED'
  Assert-Test ($resolved.FileMapSha256 -ceq $fileMapHash) 'FILE_MAP_HASH_CHANGED'
  Assert-Test ($resolved.SupportFileMapSha256 -ceq $supportFileMapHash) 'SUPPORT_FILE_MAP_HASH_CHANGED'
  Assert-Test (Test-OceanLocalAbsolutePath $dashboard) 'LOCAL_ABSOLUTE_PATH_WAS_REJECTED'
  Assert-Test (-not (Test-OceanLocalAbsolutePath '\\server\share\dashboard')) 'UNC_PATH_WAS_ACCEPTED'
  Assert-Test (-not (Test-OceanLocalAbsolutePath (Join-Path $dashboard '..\dashboard'))) 'NONCANONICAL_PATH_WAS_ACCEPTED'

  $orderingFixture = @(
    [pscustomobject]@{relative_path='public\workflow\icons.js';sha256=('1' * 64)}
    [pscustomobject]@{relative_path='public\workflow\index.html';sha256=('2' * 64)}
    [pscustomobject]@{relative_path='public\workflow\LUCIDE-LICENSE.txt';sha256=('3' * 64)}
  )
  $expectedOrderingText = @(
    "public\workflow\LUCIDE-LICENSE.txt`t$('3' * 64)"
    "public\workflow\icons.js`t$('1' * 64)"
    "public\workflow\index.html`t$('2' * 64)"
  ) -join "`n"
  $expectedOrderingHash = [BitConverter]::ToString(
    [Security.Cryptography.SHA256]::Create().ComputeHash(
      [Text.UTF8Encoding]::new($false).GetBytes($expectedOrderingText)
    )
  ).Replace('-','').ToLowerInvariant()
  Assert-Test ((Get-OceanDeploymentFileMapHash -Entries $orderingFixture) -ceq $expectedOrderingHash) `
    'FILE_MAP_ORDER_WAS_NOT_ORDINAL'

  $missingGovernance = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  foreach ($requiredQuantFile in @('quant-terminal\server.js','quant-terminal\lib\proxy.js',
      'quant-terminal\public\js\chart.js','public\index.html')) {
    $missingQuant = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $missingQuant.files = @($missingQuant.files | Where-Object { $_.relative_path -cne $requiredQuantFile })
    $missingQuant.file_map_sha256 = Get-OceanDeploymentFileMapHash -Entries $missingQuant.files
    $missingQuantManifest = Join-Path $fixture 'deployment-missing-quant.json'
    [IO.File]::WriteAllText($missingQuantManifest,($missingQuant | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    $quantFailure = $null
    try { $null = Get-OceanDeployment -ConfigPath $missingQuantManifest } catch { $quantFailure = $_.Exception.Message }
    Assert-Test ($quantFailure -eq "Ocean deployment runtime binding is missing or invalid: $requiredQuantFile") `
      "MISSING_QUANT_FILE_WAS_ACCEPTED: $requiredQuantFile"
  }
  $supervisorSource = Get-Content -LiteralPath (Join-Path $scriptsRoot 'run-ocean-website-supervised.ps1') -Raw
  Assert-Test ($supervisorSource.Contains("`$env:QT_DATA_DIR = Join-Path (Split-Path -Parent `$Runtime) 'quant-terminal'")) `
    'QUANT_STATE_IS_NOT_PINNED_OUTSIDE_RELEASE'
  Assert-Test ($supervisorSource.Contains("`$env:QT_CUSTOM_DIR = Join-Path `$env:QT_DATA_DIR 'custom'")) `
    'CUSTOM_INDICATORS_ARE_NOT_PINNED_OUTSIDE_RELEASE'
  $missingGovernance.files = @($missingGovernance.files | Where-Object { $_.relative_path -cne 'workflow\operational-candidate-governance.mjs' })
  $missingGovernance.file_map_sha256 = Get-OceanDeploymentFileMapHash -Entries $missingGovernance.files
  $missingGovernanceManifest = Join-Path $fixture 'deployment-missing-governance.json'
  [IO.File]::WriteAllText($missingGovernanceManifest,($missingGovernance | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  $governanceFailure = $null
  try { $null = Get-OceanDeployment -ConfigPath $missingGovernanceManifest } catch { $governanceFailure = $_.Exception.Message }
  Assert-Test ($governanceFailure -eq 'Ocean deployment runtime binding is missing or invalid: workflow\operational-candidate-governance.mjs') `
    'MISSING_CANDIDATE_GOVERNANCE_WAS_ACCEPTED'

  $missingOperator = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  $missingOperator.support_files = @($missingOperator.support_files | Where-Object { $_.relative_path -cne 'scripts\ocean-workflow-operator.ps1' })
  $missingOperator.support_file_map_sha256 = Get-OceanDeploymentFileMapHash -Entries $missingOperator.support_files
  $missingOperatorManifest = Join-Path $fixture 'deployment-missing-operator.json'
  [IO.File]::WriteAllText($missingOperatorManifest,($missingOperator | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  $operatorFailure = $null
  try { $null = Get-OceanDeployment -ConfigPath $missingOperatorManifest } catch { $operatorFailure = $_.Exception.Message }
  Assert-Test ($operatorFailure -eq 'Ocean deployment support binding is missing or invalid: scripts\ocean-workflow-operator.ps1') `
    'MISSING_PROTECTED_OPERATOR_WAS_ACCEPTED'

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
