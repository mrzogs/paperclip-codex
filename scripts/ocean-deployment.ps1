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

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Ocean deployment manifest missing: $ConfigPath"
  }
  $manifestSha256 = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $deployment = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if ($deployment.schema_version -cne 'ocean-website-deployment/v1') {
    throw "Unsupported Ocean deployment manifest: $($deployment.schema_version)"
  }
  if ([string]$deployment.source_commit -notmatch '^[a-f0-9]{40}$') {
    throw 'Ocean deployment source commit is invalid.'
  }

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
    ManifestSha256 = $manifestSha256
    FileMapSha256 = $fileMapHash
    RuntimeFiles = $validatedRuntimeFiles
    SupportFileMapSha256 = $supportFileMapHash
    SupportFiles = $validatedSupportFiles
  }
}
