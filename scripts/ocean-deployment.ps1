function Test-OceanLocalAbsolutePath {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or
      -not [IO.Path]::IsPathRooted($Path) -or
      $Path.StartsWith('\\')) {
    return $false
  }
  try {
    $root = [IO.Path]::GetPathRoot($Path)
    return $root -match '^[A-Za-z]:\\$' -and [IO.Path]::GetFullPath($Path) -ceq $Path
  } catch {
    return $false
  }
}

function Resolve-OceanVwapImprovementReportConfig {
  param([AllowNull()][object]$Value)

  # Optional operator-owned manifest metadata, never supplied by an HTTP caller
  # or a report. An explicit path must already name a nonempty regular .json file
  # of at most 64 KiB. Do not read/print its contents: Node validates its contract.
  if ($null -eq $Value) { return $null }
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or
      $Value.Length -gt 4096 -or -not (Test-OceanLocalAbsolutePath $Value) -or
      $Value.Contains('/') -or $Value.Substring(2).Contains(':') -or
      $Value.Substring(2) -match '[<>"|?*\x00-\x1F]' -or
      [IO.Path]::GetExtension($Value) -ine '.json') {
    throw 'Ocean VWAP improvement reader config path is invalid.'
  }
  foreach ($segment in @($Value.Substring(3) -split '\\')) {
    if ([string]::IsNullOrEmpty($segment) -or $segment -in @('.','..') -or
        $segment -match '[ .]$' -or $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
      throw 'Ocean VWAP improvement reader config path is invalid.'
    }
  }
  $current = $Value
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if (-not $item -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Ocean VWAP improvement reader config requires an existing path without aliases.'
    }
    if ($current -ceq $Value -and ($item.PSIsContainer -or $item.Length -le 0 -or $item.Length -gt 65536)) {
      throw 'Ocean VWAP improvement reader config must be a nonempty regular JSON file at most 64 KiB.'
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -ceq $current) { break }
    $current = $parent
  }
  if (-not ('OceanDeploymentFinalPathMetadataV1' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OceanDeploymentFinalPathMetadataV1 {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
}
'@
  }
  $stream = $null
  try {
    $stream = [IO.File]::Open($Value,[IO.FileMode]::Open,[IO.FileAccess]::Read,
      ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $finalPath = [Text.StringBuilder]::new(32768)
    $length = [OceanDeploymentFinalPathMetadataV1]::GetFinalPathNameByHandle($stream.SafeFileHandle,$finalPath,$finalPath.Capacity,0)
    if ($length -eq 0 -or $length -ge $finalPath.Capacity -or $stream.Length -le 0 -or $stream.Length -gt 65536 -or
        -not $finalPath.ToString().StartsWith('\\?\') -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals($finalPath.ToString().Substring(4),$Value)) {
      throw 'Reader config metadata mismatch.'
    }
  } catch {
    throw 'Ocean VWAP improvement reader config could not be verified as a canonical regular file.'
  } finally {
    if ($stream) { $stream.Dispose() }
  }
  return $Value
}

function Resolve-OceanVwapDiscoverySemanticConfig {
  param(
    [AllowNull()][object]$Config,
    [AllowNull()][object]$Sha256
  )

  # This separately pinned Website-owned descriptor is independent of publisher
  # report configuration. PowerShell checks only path metadata and pin shape;
  # Node verifies the bytes/schema and separation from the evidence root.
  if ($null -eq $Config -and $null -eq $Sha256) {
    return [pscustomobject]@{ Path=$null; Sha256=$null }
  }
  if ($null -eq $Config -or $Sha256 -isnot [string] -or $Sha256 -cnotmatch '^[a-fA-F0-9]{64}$') {
    throw 'Ocean VWAP discovery semantic config requires a path and an independent 64-hex SHA256 pin.'
  }
  $resolvedPath = Resolve-OceanVwapImprovementReportConfig -Value $Config
  [pscustomobject]@{ Path=$resolvedPath; Sha256=$Sha256.ToLowerInvariant() }
}

function Get-OceanDeploymentFileMapHash {
  param([object[]]$Entries)

  $rows = [string[]]@($Entries | ForEach-Object {
    "$([string]$_.relative_path)`t$([string]$_.sha256)"
  })
  [array]::Sort($rows,[StringComparer]::Ordinal)
  $fileMapText = ($rows -join "`n")
  $fileMapBytes = [Text.UTF8Encoding]::new($false).GetBytes($fileMapText)
  [BitConverter]::ToString(
    [Security.Cryptography.SHA256]::Create().ComputeHash($fileMapBytes)
  ).Replace('-','').ToLowerInvariant()
}

function Get-OceanDeployment {
  param(
    [string]$ConfigPath = 'D:\OceanTradingData\website\ocean-runtime\deployment.json'
  )

  $manifestStream = $null
  try {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Ocean deployment manifest missing: $ConfigPath"
  }
  # Retain one bounded snapshot for both identity and parsing. Keep its read-only
  # handle open through validation; FileShare.Read denies concurrent write/delete.
  $manifestStream = [IO.File]::Open($ConfigPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $manifestLength = $manifestStream.Length
  if ($manifestLength -le 0 -or $manifestLength -gt 4MB) {
    throw 'Ocean deployment manifest must be nonempty and at most 4 MiB.'
  }
  $manifestBytes = [byte[]]::new([int]$manifestLength)
  $readLength = 0
  while ($readLength -lt $manifestBytes.Length) {
    $count = $manifestStream.Read($manifestBytes,$readLength,$manifestBytes.Length - $readLength)
    if ($count -le 0) { throw 'Ocean deployment manifest snapshot is incomplete.' }
    $readLength += $count
  }
  if ($manifestStream.Length -ne $manifestLength) { throw 'Ocean deployment manifest snapshot length changed.' }
  $manifestHasher = [Security.Cryptography.SHA256]::Create()
  try {
    $manifestSha256 = [BitConverter]::ToString($manifestHasher.ComputeHash($manifestBytes)).Replace('-','').ToLowerInvariant()
  } finally { $manifestHasher.Dispose() }
  $manifestMemory = [IO.MemoryStream]::new($manifestBytes,$false)
  $manifestReader = [IO.StreamReader]::new($manifestMemory,[Text.UTF8Encoding]::new($false,$true),$true)
  try { $manifestText = $manifestReader.ReadToEnd() } finally { $manifestReader.Dispose() }
  $deployment = $manifestText | ConvertFrom-Json
  if ($deployment.schema_version -cne 'ocean-website-deployment/v1') {
    throw "Unsupported Ocean deployment manifest: $($deployment.schema_version)"
  }
  if ([string]$deployment.source_commit -notmatch '^[a-f0-9]{40}$') {
    throw 'Ocean deployment source commit is invalid.'
  }
  $vwapReportConfig = $null
  $readerProperty = $deployment.PSObject.Properties['vwap_improvement_report_config']
  if ($readerProperty) {
    $vwapReportConfig = Resolve-OceanVwapImprovementReportConfig -Value $readerProperty.Value
  }
  $semanticConfigValue = $null
  $semanticHashValue = $null
  $semanticProperty = $deployment.PSObject.Properties['vwap_discovery_semantic_config']
  $semanticHashProperty = $deployment.PSObject.Properties['vwap_discovery_semantic_config_sha256']
  if ($semanticProperty) { $semanticConfigValue = $semanticProperty.Value }
  if ($semanticHashProperty) { $semanticHashValue = $semanticHashProperty.Value }
  $semanticConfig = Resolve-OceanVwapDiscoverySemanticConfig -Config $semanticConfigValue -Sha256 $semanticHashValue

  $dashboard = [string]$deployment.dashboard
  $sourceRoot = [string]$deployment.source_root
  $binding = [string]$deployment.physical_binding_file
  if (-not (Test-OceanLocalAbsolutePath $dashboard) -or
      -not (Test-Path -LiteralPath $dashboard -PathType Container)) {
    throw "Ocean deployment dashboard is incomplete: $dashboard"
  }
  $requiredRuntimeFiles = @(
    'server.mjs',
    'monitor.mjs',
    'workflow\backend.mjs',
    'workflow\operational-candidate-governance.mjs',
    'workflow\operational-candidate-evaluation.mjs',
    'workflow\operational-candidate-dispatch.mjs',
    'workflow\targeted-replay-behavior.mjs',
    'workflow\contracts\cicd-vwap-targeted-replay-behavior-v1.json',
    'public\workflow\ui.js',
    'public\index.html',
    'public\app.js',
    'quant-terminal\server.js',
    'quant-terminal\package.json',
    'quant-terminal\public\index.html',
    'quant-terminal\public\js\app.js',
    'quant-terminal\public\js\api.js',
    'quant-terminal\public\vendor\lightweight-charts.standalone.production.js'
  )
  $runtimeFiles = @($deployment.files)
  $validatedRuntimeFiles = @()
  $seenRuntimeFiles = @{}
  foreach ($entry in $runtimeFiles) {
    $relativePath = [string]$entry.relative_path
    $segments = @($relativePath -split '[\\/]')
    if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath) -or
        $relativePath.Contains('/') -or $segments -contains '..' -or $segments -contains '.' -or
        [string]$entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $seenRuntimeFiles.ContainsKey($relativePath)) {
      throw "Ocean deployment runtime binding is invalid: $relativePath"
    }
    $seenRuntimeFiles[$relativePath] = $true
    $runtimePath = [IO.Path]::GetFullPath((Join-Path $dashboard $relativePath))
    if (-not $runtimePath.StartsWith(([IO.Path]::GetFullPath($dashboard).TrimEnd('\') + '\'),[StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
      throw "Ocean deployment runtime file is missing: $runtimePath"
    }
    $actualRuntimeHash = (Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualRuntimeHash -cne [string]$entry.sha256) {
      throw "Ocean deployment runtime hash mismatch: $runtimePath"
    }
    $validatedRuntimeFiles += [pscustomobject]@{ relative_path=$relativePath; sha256=$actualRuntimeHash }
  }
  $fileMapHash = Get-OceanDeploymentFileMapHash -Entries $validatedRuntimeFiles
  if ([string]$deployment.file_map_sha256 -cne $fileMapHash) {
    throw 'Ocean deployment file-map hash mismatch.'
  }
  foreach ($relativePath in $requiredRuntimeFiles) {
    $entry = @($validatedRuntimeFiles | Where-Object { [string]$_.relative_path -ceq $relativePath })
    if ($entry.Count -ne 1) {
      throw "Ocean deployment runtime binding is missing or invalid: $relativePath"
    }
  }
  # A release must retain the entire embedded app, not merely a navigation link.
  foreach ($subdirectory in @('lib','public','custom')) {
    $quantRoot = Join-Path $dashboard "quant-terminal\$subdirectory"
    if (-not (Test-Path -LiteralPath $quantRoot -PathType Container)) {
      throw "Ocean Quant Terminal directory is missing: $subdirectory"
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $quantRoot -File -Recurse)) {
      $relativePath = $file.FullName.Substring($dashboard.TrimEnd('\').Length + 1)
      if (-not $seenRuntimeFiles.ContainsKey($relativePath)) {
        throw "Ocean deployment runtime binding is missing or invalid: $relativePath"
      }
    }
  }
  $navSource = Get-Content -LiteralPath (Join-Path $dashboard 'public\index.html') -Raw
  $serverSource = Get-Content -LiteralPath (Join-Path $dashboard 'server.mjs') -Raw
  if ($navSource -notmatch 'href="/quant-terminal/"' -or
      $serverSource -notmatch 'handleQuantTerminalRequest\(req, res' -or
      $serverSource -notmatch 'initializeQuantTerminal\(') {
    throw 'Ocean deployment is missing the embedded Quant Terminal integration.'
  }
  if (-not (Test-OceanLocalAbsolutePath $sourceRoot) -or
      -not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "Ocean deployment source root is incomplete: $sourceRoot"
  }
  $requiredSupportFiles = @(
    'scripts\consume-ocean-proposal-planning.mjs',
    'scripts\ocean-workflow-operator.ps1'
  )
  $supportFiles = @($deployment.support_files)
  $validatedSupportFiles = @()
  $seenSupportFiles = @{}
  foreach ($entry in $supportFiles) {
    $relativePath = [string]$entry.relative_path
    $segments = @($relativePath -split '[\\/]')
    if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath) -or
        $relativePath.Contains('/') -or $segments -contains '..' -or $segments -contains '.' -or
        [string]$entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $seenSupportFiles.ContainsKey($relativePath)) {
      throw "Ocean deployment support binding is invalid: $relativePath"
    }
    $seenSupportFiles[$relativePath] = $true
    $supportPath = [IO.Path]::GetFullPath((Join-Path $sourceRoot $relativePath))
    if (-not $supportPath.StartsWith(([IO.Path]::GetFullPath($sourceRoot).TrimEnd('\') + '\'),[StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $supportPath -PathType Leaf)) {
      throw "Ocean deployment support file is missing: $supportPath"
    }
    $actualSupportHash = (Get-FileHash -LiteralPath $supportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSupportHash -cne [string]$entry.sha256) {
      throw "Ocean deployment support hash mismatch: $supportPath"
    }
    $validatedSupportFiles += [pscustomobject]@{ relative_path=$relativePath; sha256=$actualSupportHash }
  }
  $supportFileMapHash = Get-OceanDeploymentFileMapHash -Entries $validatedSupportFiles
  if ([string]$deployment.support_file_map_sha256 -cne $supportFileMapHash) {
    throw 'Ocean deployment support-file-map hash mismatch.'
  }
  foreach ($relativePath in $requiredSupportFiles) {
    $entry = @($validatedSupportFiles | Where-Object { [string]$_.relative_path -ceq $relativePath })
    if ($entry.Count -ne 1) {
      throw "Ocean deployment support binding is missing or invalid: $relativePath"
    }
  }
  if (-not (Test-OceanLocalAbsolutePath $binding) -or
      -not (Test-Path -LiteralPath $binding -PathType Leaf)) {
    throw "Ocean physical binding is missing: $binding"
  }
  $actualBindingHash = (Get-FileHash -LiteralPath $binding -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualBindingHash -cne [string]$deployment.physical_binding_sha256) {
    throw "Ocean physical binding hash mismatch: $binding"
  }

  [pscustomobject]@{
    ReleaseId = [string]$deployment.release_id
    SourceCommit = [string]$deployment.source_commit
    Dashboard = $dashboard
    SourceRoot = $sourceRoot
    PhysicalBindingFile = $binding
    PhysicalBindingSha256 = $actualBindingHash
    VwapImprovementReportConfig = $vwapReportConfig
    VwapDiscoverySemanticConfig = $semanticConfig.Path
    VwapDiscoverySemanticConfigSha256 = $semanticConfig.Sha256
    ManifestSha256 = $manifestSha256
    FileMapSha256 = $fileMapHash
    RuntimeFiles = $validatedRuntimeFiles
    SupportFileMapSha256 = $supportFileMapHash
    SupportFiles = $validatedSupportFiles
  }
  } finally {
    if ($manifestStream) { $manifestStream.Dispose() }
  }
}
