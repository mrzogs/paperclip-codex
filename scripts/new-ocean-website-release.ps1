param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$Commit,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$')][string]$ReleaseId,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedDeploymentSha256,
  [AllowNull()][object]$VwapImprovementReportConfig,
  [AllowNull()][object]$VwapDiscoverySemanticConfig,
  [AllowNull()][object]$VwapDiscoverySemanticConfigSha256
)

# Build only. The protected service manager remains the sole restart mechanism.
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'ocean-deployment.ps1')
# Reject an invalid explicit operator path before reading active state or making
# release directories. Explicit null clears this optional candidate setting.
$explicitVwapReportConfig = $PSBoundParameters.ContainsKey('VwapImprovementReportConfig')
if ($explicitVwapReportConfig) {
  $selectedVwapReportConfig = Resolve-OceanVwapImprovementReportConfig -Value $VwapImprovementReportConfig
}
# The descriptor and its independently supplied pin are one optional operator
# binding. Supplying BOTH explicit null values clears the candidate pair.
$explicitSemanticConfig = $PSBoundParameters.ContainsKey('VwapDiscoverySemanticConfig') -or
  $PSBoundParameters.ContainsKey('VwapDiscoverySemanticConfigSha256')
if ($explicitSemanticConfig) {
  if (-not $PSBoundParameters.ContainsKey('VwapDiscoverySemanticConfig') -or
      -not $PSBoundParameters.ContainsKey('VwapDiscoverySemanticConfigSha256')) {
    throw 'Ocean VWAP discovery semantic builder parameters must be supplied together.'
  }
  $selectedSemanticConfig = Resolve-OceanVwapDiscoverySemanticConfig -Config $VwapDiscoverySemanticConfig -Sha256 $VwapDiscoverySemanticConfigSha256
}
$runtime = 'D:\OceanTradingData\website\ocean-runtime'
$activePath = Join-Path $runtime 'deployment.json'
$observedHash = (Get-FileHash -LiteralPath $activePath -Algorithm SHA256).Hash
if ($observedHash -ine $ExpectedDeploymentSha256) { throw 'Concurrent Ocean deployment changed; release build refused.' }
$validatedActive = Get-OceanDeployment -ConfigPath $activePath
if ($validatedActive.ManifestSha256 -ine $observedHash) { throw 'Concurrent Ocean deployment changed during validation; release build refused.' }
if (-not $explicitVwapReportConfig) { $selectedVwapReportConfig = $validatedActive.VwapImprovementReportConfig }
if (-not $explicitSemanticConfig) {
  $selectedSemanticConfig = Resolve-OceanVwapDiscoverySemanticConfig -Config $validatedActive.VwapDiscoverySemanticConfig -Sha256 $validatedActive.VwapDiscoverySemanticConfigSha256
}
$release = Join-Path 'D:\OceanTradingData\website\deployments' $ReleaseId
if (Test-Path -LiteralPath $release) { throw "Release directory already exists: $release" }
$commitExists = & git -C $repository cat-file -t $Commit
if ($LASTEXITCODE -ne 0 -or $commitExists -cne 'commit') { throw 'Release source is not a committed Git revision.' }
New-Item -ItemType Directory -Path $release | Out-Null
$archive = Join-Path $release 'source.zip'
& git -C $repository archive --format=zip "--output=$archive" $Commit
if ($LASTEXITCODE -ne 0) { throw 'Git source archive failed.' }
$source = Join-Path $release 'paperclip-source'
Expand-Archive -LiteralPath $archive -DestinationPath $source
$dashboard = Join-Path $source 'website\ocean-trading\dashboard'

. (Join-Path $PSScriptRoot 'ocean-release-state.ps1')

# Keep the mutable data directory attached to its existing publisher. A
# website-only restart must not strand the monitor on the previous release's
# data path while the new website reads a copied, frozen snapshot.
$null = New-OceanReleaseMutableDataLink -PreviousDashboard $validatedActive.Dashboard -CandidateDashboard $dashboard

# Carry operational uploads forward, never replace committed code/config with
# an old working tree. Persistent database and physical-binding paths remain.
$oldUploads = Join-Path $validatedActive.Dashboard 'uploads'
if (Test-Path -LiteralPath $oldUploads) {
  $newUploads = Join-Path $dashboard 'uploads'
  New-Item -ItemType Directory -Force -Path $newUploads | Out-Null
  foreach ($item in @(Get-ChildItem -LiteralPath $oldUploads -Force)) {
    Copy-Item -LiteralPath $item.FullName -Destination $newUploads -Recurse -Force
  }
}
$oldManifest = Join-Path $validatedActive.Dashboard 'dashboard-data.json'
if (Test-Path -LiteralPath $oldManifest) { Copy-Item -LiteralPath $oldManifest -Destination (Join-Path $dashboard 'dashboard-data.json') }
$oldConfig = Join-Path $validatedActive.Dashboard 'config'
if (Test-Path -LiteralPath $oldConfig) {
  foreach ($file in @(Get-ChildItem -LiteralPath $oldConfig -Recurse -File)) {
    $destination = Join-Path (Join-Path $dashboard 'config') $file.FullName.Substring($oldConfig.Length + 1)
    if (-not (Test-Path -LiteralPath $destination)) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $destination
    }
  }
}

. (Join-Path $source 'scripts\ocean-deployment.ps1')
$tracked = @(& git -C $repository ls-tree -r --name-only $Commit)
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate committed release files.' }
$prefix = 'website/ocean-trading/dashboard/'
$files = @($tracked | Where-Object { $_.StartsWith($prefix) -and $_ -notmatch '/(?:data|logs|uploads)/' } | ForEach-Object {
  $relative = $_.Substring($prefix.Length).Replace('/','\')
  [pscustomobject]@{ relative_path=$relative; sha256=(Get-FileHash -LiteralPath (Join-Path $dashboard $relative) -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$support = @($tracked | Where-Object { $_.StartsWith('scripts/') } | ForEach-Object {
  $relative = $_.Replace('/','\')
  [pscustomobject]@{ relative_path=$relative; sha256=(Get-FileHash -LiteralPath (Join-Path $source $relative) -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$candidate = [ordered]@{
  schema_version='ocean-website-deployment/v1'; release_id=$ReleaseId
  source_commit=$Commit; source_root=$source; dashboard=$dashboard
  physical_binding_file=$validatedActive.PhysicalBindingFile
  physical_binding_sha256=$validatedActive.PhysicalBindingSha256
  file_map_sha256=(Get-OceanDeploymentFileMapHash -Entries $files); files=$files
  support_file_map_sha256=(Get-OceanDeploymentFileMapHash -Entries $support); support_files=$support
  previous_deployment_sha256=$observedHash.ToLowerInvariant()
}
if ($null -ne $selectedVwapReportConfig) {
  $candidate['vwap_improvement_report_config'] = Resolve-OceanVwapImprovementReportConfig -Value $selectedVwapReportConfig
}
if ($null -ne $selectedSemanticConfig.Path) {
  $checkedSemanticConfig = Resolve-OceanVwapDiscoverySemanticConfig -Config $selectedSemanticConfig.Path -Sha256 $selectedSemanticConfig.Sha256
  $candidate['vwap_discovery_semantic_config'] = $checkedSemanticConfig.Path
  $candidate['vwap_discovery_semantic_config_sha256'] = $checkedSemanticConfig.Sha256
}
$candidatePath = Join-Path $release 'deployment.json'
[IO.File]::WriteAllText($candidatePath,($candidate | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$validated = Get-OceanDeployment -ConfigPath $candidatePath
if ((Get-FileHash -LiteralPath $activePath -Algorithm SHA256).Hash -ine $observedHash) {
  throw 'Concurrent Ocean deployment changed during build; do not promote this candidate.'
}
[pscustomobject]@{candidate=$candidatePath; release=$validated.ReleaseId; expected_active_sha256=$observedHash; activates_or_restarts_services=$false} | ConvertTo-Json
