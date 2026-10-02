param([ValidateSet('Write','Read')][string]$Action,[string]$File)
$ErrorActionPreference='Stop'
$env:PSModulePath="$PSHOME\Modules;${env:ProgramFiles}\WindowsPowerShell\Modules"
if ($File -notmatch '[\\/]ocean-s302-[^\\/]+[\\/]') { throw 'Isolated fixture path required' }
if ($Action -eq 'Write') {
  $value=[Console]::In.ReadToEnd()
  $sealed=ConvertTo-SecureString -String $value -AsPlainText -Force | ConvertFrom-SecureString
  [IO.File]::WriteAllText($File,$sealed)
} else {
  if (-not [Console]::IsOutputRedirected) { throw 'Captured fixture reader only' }
  $secure=Get-Content -LiteralPath $File -Raw | ConvertTo-SecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
