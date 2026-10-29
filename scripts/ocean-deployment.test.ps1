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
    'workflow\targeted-replay-behavior.mjs','workflow\contracts\cicd-vwap-targeted-replay-behavior-v1.json',
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
  Assert-Test ($null -eq $resolved.VwapImprovementReportConfig) 'ABSENT_READER_CONFIG_WAS_NOT_UNSET'
  Assert-Test ($null -eq $resolved.VwapDiscoverySemanticConfig -and $null -eq $resolved.VwapDiscoverySemanticConfigSha256) 'ABSENT_SEMANTIC_PAIR_WAS_NOT_UNSET'
  $strictResolved = & { Set-StrictMode -Version Latest; Get-OceanDeployment -ConfigPath $manifest }
  Assert-Test ($null -eq $strictResolved.VwapImprovementReportConfig) 'ABSENT_READER_CONFIG_FAILED_UNDER_STRICT_CALLER'
  Assert-Test ($null -eq $strictResolved.VwapDiscoverySemanticConfig -and $null -eq $strictResolved.VwapDiscoverySemanticConfigSha256) 'ABSENT_SEMANTIC_PAIR_FAILED_UNDER_STRICT_CALLER'
  Assert-Test (Test-OceanLocalAbsolutePath $dashboard) 'LOCAL_ABSOLUTE_PATH_WAS_REJECTED'
  Assert-Test (-not (Test-OceanLocalAbsolutePath '\\server\share\dashboard')) 'UNC_PATH_WAS_ACCEPTED'
  Assert-Test (-not (Test-OceanLocalAbsolutePath (Join-Path $dashboard '..\dashboard'))) 'NONCANONICAL_PATH_WAS_ACCEPTED'

  $reader = Join-Path $fixture 'reader-config.json'
  [IO.File]::WriteAllText($reader,'{"schema_version":"fixture-reader/v1","private_value":"DO_NOT_PRINT"}',[Text.UTF8Encoding]::new($false))
  $readerHash = (Get-FileHash -LiteralPath $reader -Algorithm SHA256).Hash
  $defaultManifestHash = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
  $configuredManifest = Join-Path $fixture 'deployment-reader.json'
  $withReader = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  $withReader | Add-Member -NotePropertyName vwap_improvement_report_config -NotePropertyValue $reader
  [IO.File]::WriteAllText($configuredManifest,($withReader | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $configured = Get-OceanDeployment -ConfigPath $configuredManifest
  Assert-Test ($configured.VwapImprovementReportConfig -ceq $reader) 'CANONICAL_READER_CONFIG_WAS_NOT_SURFACED'
  Assert-Test ($configured.PhysicalBindingFile -ceq $resolved.PhysicalBindingFile -and
    $configured.PhysicalBindingSha256 -ceq $resolved.PhysicalBindingSha256 -and
    $configured.Dashboard -ceq $resolved.Dashboard -and $configured.SourceRoot -ceq $resolved.SourceRoot -and
    $configured.FileMapSha256 -ceq $resolved.FileMapSha256 -and
    $configured.SupportFileMapSha256 -ceq $resolved.SupportFileMapSha256) 'OPTIONAL_READER_CHANGED_EXISTING_DEPLOYMENT_BINDINGS'
  $withReader.vwap_improvement_report_config = $null
  [IO.File]::WriteAllText($configuredManifest,($withReader | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  Assert-Test ($null -eq (Get-OceanDeployment -ConfigPath $configuredManifest).VwapImprovementReportConfig) 'NULL_READER_CONFIG_WAS_NOT_UNSET'
  foreach ($invalidReader in @('',42,$false,'reader-config.json','\\server\share\reader-config.json',
      '\\?\D:\reader-config.json',($reader + ':secret'),($reader.Replace('\','/')),
      (Join-Path $fixture '..\reader-config.json'),(Join-Path $fixture '.\reader-config.json'),
      (Join-Path $fixture 'trailing.\reader-config.json'),(Join-Path $fixture 'trailing \reader-config.json'),
      (Join-Path $fixture 'missing.json'))) {
    $readerRejected = $false
    try { $null = Resolve-OceanVwapImprovementReportConfig -Value $invalidReader } catch { $readerRejected = $true }
    Assert-Test $readerRejected 'MALFORMED_OR_MISSING_READER_CONFIG_WAS_ACCEPTED'
  }
  $withReader.vwap_improvement_report_config = 42
  [IO.File]::WriteAllText($configuredManifest,($withReader | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $nonstringRejected = $false
  try { $null = Get-OceanDeployment -ConfigPath $configuredManifest } catch { $nonstringRejected = $true }
  Assert-Test $nonstringRejected 'MANIFEST_READER_CONFIG_WAS_COERCED_TO_STRING'
  $emptyReader = Join-Path $fixture 'empty.json'
  [IO.File]::WriteAllText($emptyReader,'',[Text.UTF8Encoding]::new($false))
  $largeReader = Join-Path $fixture 'large.json'
  [IO.File]::WriteAllBytes($largeReader,[byte[]]::new(65537))
  $limitReader = Join-Path $fixture 'limit.json'
  [IO.File]::WriteAllBytes($limitReader,[byte[]]::new(65536))
  Assert-Test ((Resolve-OceanVwapImprovementReportConfig -Value $limitReader) -ceq $limitReader) 'EXACT_64K_METADATA_LIMIT_WAS_REJECTED'
  $directoryReader = Join-Path $fixture 'directory.json'
  New-Item -ItemType Directory -Path $directoryReader | Out-Null
  $aliasRoot = Join-Path $fixture 'reader-alias'
  New-Item -ItemType Junction -Path $aliasRoot -Target $fixture | Out-Null
  foreach ($nonregularReader in @($emptyReader,$largeReader,$directoryReader,(Join-Path $aliasRoot 'reader-config.json'))) {
    $readerRejected = $false
    try { $null = Resolve-OceanVwapImprovementReportConfig -Value $nonregularReader } catch { $readerRejected = $true }
    Assert-Test $readerRejected 'OVERSIZE_NONREGULAR_OR_ALIASED_READER_CONFIG_WAS_ACCEPTED'
  }
  # The PowerShell boundary checks only path/type/length metadata. The child Node
  # reader owns JSON/schema/scope/hash validation and must not be substituted here.
  $metadataOnly = Join-Path $fixture 'node-validates-json.json'
  [IO.File]::WriteAllText($metadataOnly,'not JSON',[Text.UTF8Encoding]::new($false))
  Assert-Test ((Resolve-OceanVwapImprovementReportConfig -Value $metadataOnly) -ceq $metadataOnly) 'POWERSHELL_READER_BOUNDARY_READ_CONFIG_CONTENT'
  Assert-Test ((Get-FileHash -LiteralPath $reader -Algorithm SHA256).Hash -ceq $readerHash -and
    (Get-FileHash -LiteralPath $binding -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $bindingHash -and
    (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash -ceq $defaultManifestHash) 'READER_VALIDATION_MUTATED_EXISTING_STATE'

  # A real builder invocation with malformed explicit input must fail before it
  # reads the active deployment hash or creates a candidate directory. No active
  # deployment paths, physical bindings or databases are opened by this branch.
  $builderFailure = $null
  try { & (Join-Path $scriptsRoot 'new-ocean-website-release.ps1') -Commit ('a' * 40) `
      -ReleaseId 'test-invalid-reader-config-preflight' -ExpectedDeploymentSha256 ('0' * 64) `
      -VwapImprovementReportConfig 'relative-reader.json' | Out-Null } catch { $builderFailure = $_.Exception.Message }
  Assert-Test ($builderFailure -ceq 'Ocean VWAP improvement reader config path is invalid.') 'BUILDER_DID_NOT_VALIDATE_READER_BEFORE_ACTIVE_STATE'

  $semantic = Join-Path $fixture 'discovery-semantic-config.json'
  [IO.File]::WriteAllText($semantic,'{"schema_version":"fixture-semantic-descriptor/v1","private_value":"DO_NOT_PRINT"}',[Text.UTF8Encoding]::new($false))
  $semanticPin = (Get-FileHash -LiteralPath $semantic -Algorithm SHA256).Hash
  $semanticManifest = Join-Path $fixture 'deployment-semantic.json'
  $withSemantic = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  $withSemantic | Add-Member -NotePropertyName vwap_improvement_report_config -NotePropertyValue $reader
  $withSemantic | Add-Member -NotePropertyName vwap_discovery_semantic_config -NotePropertyValue $semantic
  $withSemantic | Add-Member -NotePropertyName vwap_discovery_semantic_config_sha256 -NotePropertyValue $semanticPin
  [IO.File]::WriteAllText($semanticManifest,($withSemantic | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $semanticResolved = Get-OceanDeployment -ConfigPath $semanticManifest
  Assert-Test ($semanticResolved.VwapDiscoverySemanticConfig -ceq $semantic -and
    $semanticResolved.VwapDiscoverySemanticConfigSha256 -ceq $semanticPin.ToLowerInvariant()) 'SEMANTIC_CONFIG_PAIR_WAS_NOT_SURFACED'
  Assert-Test ($semanticResolved.VwapImprovementReportConfig -ceq $reader -and
    $semanticResolved.PhysicalBindingSha256 -ceq $resolved.PhysicalBindingSha256 -and
    $semanticResolved.Dashboard -ceq $resolved.Dashboard -and
    $semanticResolved.FileMapSha256 -ceq $resolved.FileMapSha256 -and
    $semanticResolved.SupportFileMapSha256 -ceq $resolved.SupportFileMapSha256) 'SEMANTIC_PAIR_CHANGED_DIAGNOSTIC_OR_EXISTING_BINDINGS'
  $withSemantic.vwap_discovery_semantic_config = $null
  $withSemantic.vwap_discovery_semantic_config_sha256 = $null
  [IO.File]::WriteAllText($semanticManifest,($withSemantic | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $nullSemantic = Get-OceanDeployment -ConfigPath $semanticManifest
  Assert-Test ($null -eq $nullSemantic.VwapDiscoverySemanticConfig -and
    $null -eq $nullSemantic.VwapDiscoverySemanticConfigSha256) 'NULL_SEMANTIC_PAIR_WAS_NOT_UNSET'
  foreach ($invalidPair in @(
      [pscustomobject]@{Path=$semantic;Pin=$null},[pscustomobject]@{Path=$null;Pin=$semanticPin},
      [pscustomobject]@{Path=$semantic;Pin=''},[pscustomobject]@{Path=$semantic;Pin=42},
      [pscustomobject]@{Path=$semantic;Pin=('sha256:' + $semanticPin)},
      [pscustomobject]@{Path=$semantic;Pin=('a' * 63)},[pscustomobject]@{Path=$semantic;Pin=('g' * 64)},
      [pscustomobject]@{Path='relative-semantic.json';Pin=$semanticPin})) {
    $pairRejected = $false
    try { $null = Resolve-OceanVwapDiscoverySemanticConfig -Config $invalidPair.Path -Sha256 $invalidPair.Pin } catch { $pairRejected = $true }
    Assert-Test $pairRejected 'PARTIAL_OR_MALFORMED_SEMANTIC_PAIR_WAS_ACCEPTED'
  }
  foreach ($partialProperty in @('vwap_discovery_semantic_config','vwap_discovery_semantic_config_sha256')) {
    $partialSemantic = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $partialValue = if ($partialProperty -ceq 'vwap_discovery_semantic_config') { $semantic } else { $semanticPin }
    $partialSemantic | Add-Member -NotePropertyName $partialProperty -NotePropertyValue $partialValue
    [IO.File]::WriteAllText($semanticManifest,($partialSemantic | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    $pairRejected = $false
    try { $null = Get-OceanDeployment -ConfigPath $semanticManifest } catch { $pairRejected = $true }
    Assert-Test $pairRejected 'PARTIAL_MANIFEST_SEMANTIC_PAIR_WAS_ACCEPTED'
  }
  foreach ($partialBuilder in @(@{VwapDiscoverySemanticConfig=$semantic},@{VwapDiscoverySemanticConfigSha256=$semanticPin})) {
    $semanticBuilderFailure = $null
    try { & (Join-Path $scriptsRoot 'new-ocean-website-release.ps1') -Commit ('a' * 40) `
        -ReleaseId 'test-invalid-semantic-config-preflight' -ExpectedDeploymentSha256 ('0' * 64) `
        @partialBuilder | Out-Null } catch { $semanticBuilderFailure = $_.Exception.Message }
    Assert-Test ($semanticBuilderFailure -ceq 'Ocean VWAP discovery semantic builder parameters must be supplied together.') 'BUILDER_DID_NOT_REJECT_PARTIAL_SEMANTIC_PAIR_BEFORE_ACTIVE_STATE'
  }
  Assert-Test ((Get-FileHash -LiteralPath $semantic -Algorithm SHA256).Hash -ceq $semanticPin -and
    (Get-FileHash -LiteralPath $reader -Algorithm SHA256).Hash -ceq $readerHash -and
    (Get-FileHash -LiteralPath $binding -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $bindingHash -and
    (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash -ceq $defaultManifestHash) 'SEMANTIC_VALIDATION_MUTATED_EXISTING_STATE'

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

  foreach ($requiredTargetedReplayFile in @('workflow\targeted-replay-behavior.mjs',
      'workflow\contracts\cicd-vwap-targeted-replay-behavior-v1.json')) {
    $missingTargetedReplay = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $missingTargetedReplay.files = @($missingTargetedReplay.files | Where-Object { $_.relative_path -cne $requiredTargetedReplayFile })
    $missingTargetedReplay.file_map_sha256 = Get-OceanDeploymentFileMapHash -Entries $missingTargetedReplay.files
    $missingTargetedReplayManifest = Join-Path $fixture 'deployment-missing-targeted-replay.json'
    [IO.File]::WriteAllText($missingTargetedReplayManifest,($missingTargetedReplay | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    $targetedReplayFailure = $null
    try { $null = Get-OceanDeployment -ConfigPath $missingTargetedReplayManifest } catch { $targetedReplayFailure = $_.Exception.Message }
    Assert-Test ($targetedReplayFailure -eq "Ocean deployment runtime binding is missing or invalid: $requiredTargetedReplayFile") `
      "MISSING_TARGETED_REPLAY_FILE_WAS_ACCEPTED: $requiredTargetedReplayFile"
  }

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
  # Remove the fixture junction itself before Windows PowerShell 5.1's recursive
  # directory cleanup. Never recurse through an alias back into the fixture.
  if ($aliasRoot -and (Test-Path -LiteralPath $aliasRoot)) {
    $aliasItem = Get-Item -LiteralPath $aliasRoot -Force
    if (($aliasItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
        [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($aliasRoot)) -ceq [IO.Path]::GetFullPath($fixture)) {
      [IO.Directory]::Delete($aliasRoot)
    }
  }
  $resolvedFixture = [IO.Path]::GetFullPath($fixture)
  $expectedFixtureParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  Assert-Test ($resolvedFixture.StartsWith($expectedFixtureParent,[StringComparison]::OrdinalIgnoreCase) -and
    [IO.Path]::GetFileName($resolvedFixture) -match '^ocean-deployment-[a-f0-9]{32}$') 'FIXTURE_CLEANUP_PATH_ESCAPED_TEMP'
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'Ocean deployment resolver contract: PASS'
