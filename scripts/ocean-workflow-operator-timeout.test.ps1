$ErrorActionPreference = 'Stop'

$scriptsRoot = Split-Path -Parent $PSCommandPath
$sourcePath = Join-Path $scriptsRoot 'ocean-workflow-operator.ps1'
$source = Get-Content -LiteralPath $sourcePath -Raw

function Assert-Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

Assert-Test ($source.Contains("if (`$Mode -cne 'commit') { return 60000 }")) 'NON_COMMIT_TIMEOUT_CHANGED'
Assert-Test ($source.Contains('$seconds = 900')) 'COMMIT_TIMEOUT_IS_NOT_LONG_ENOUGH_FOR_DATABASE_SNAPSHOT'
Assert-Test ($source.Contains('OCEAN_WORKFLOW_COMMIT_TIMEOUT_SECONDS')) 'COMMIT_TIMEOUT_HAS_NO_BOUNDED_OPERATOR_OVERRIDE'
Assert-Test ($source.Contains('$parsed -lt 60 -or $parsed -gt 3600')) 'COMMIT_TIMEOUT_OVERRIDE_IS_NOT_BOUNDED'
Assert-Test ($source.Contains('[int]($seconds * 1000)')) 'COMMIT_TIMEOUT_MILLISECOND_CONVERSION_IS_INVALID'
Assert-Test ($source.Contains('$timeoutMilliseconds = Get-CoreTimeoutMilliseconds $mode')) 'CORE_TIMEOUT_IS_NOT_SELECTED_BY_OPERATION_MODE'
Assert-Test ($source.Contains('$p.WaitForExit($timeoutMilliseconds)')) 'CORE_PROCESS_DOES_NOT_USE_SELECTED_TIMEOUT'
Assert-Test (-not $source.Contains('$p.WaitForExit(60000)')) 'LEGACY_HARD_CODED_PROCESS_TIMEOUT_REMAINS'
Assert-Test ([int](900 * 1000) -eq 900000) 'COMMIT_TIMEOUT_MILLISECOND_CONVERSION_FAILED'
Assert-Test ($source.Contains('function Get-HandoffFileStem($Identity)')) 'HANDOFF_FILENAME_POLICY_IS_NOT_CENTRALISED'
Assert-Test ($source.Contains("if (`$Identity.identity_id -match '^[A-Za-z0-9_.-]+`$')")) 'SAFE_IDENTITY_HANDOFF_NAMES_ARE_NOT_PRESERVED'
Assert-Test ($source.Contains("if (`$Identity.credential_ref -match '^[A-Za-z0-9_.-]+`$')")) 'UNSAFE_IDENTITY_IDS_HAVE_NO_CREDENTIAL_REFERENCE_FALLBACK'
Assert-Test (-not $source.Contains("throw 'Unsafe identity handoff path.'")) 'BULK_HANDOFF_STILL_REJECTS_VALID_COLON_IDENTITIES'
Assert-Test ($source.Contains('$stem = Get-HandoffFileStem $identity')) 'HANDOFF_PUBLICATION_DOES_NOT_USE_FILENAME_POLICY'

Write-Output 'ocean-workflow-operator timeout tests passed'
