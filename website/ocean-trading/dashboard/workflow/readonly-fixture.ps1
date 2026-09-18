param([string]$Root, [ValidateSet('Seal','LooseAcl','LooseFileAcl','Lock')][string]$Action = 'Seal')
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $Root.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path $Root -Leaf) -notlike 'ocean-readonly-*') { throw 'Private isolated fixture root required.' }
if ($Action -eq 'Lock') {
  $stream = [IO.File]::Open((Join-Path $Root 'operator.lock'),'Open','ReadWrite','None')
  try { [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); Start-Sleep -Seconds 10 } finally { $stream.Dispose() }
  return
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
foreach ($principal in @($sid,'S-1-5-18')) {
  $identity = [Security.Principal.SecurityIdentifier]::new($principal)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
if ($Action -eq 'LooseAcl') {
  $directory = [IO.DirectoryInfo]::new($Root)
  $existing = [IO.FileSystemAclExtensions]::GetAccessControl($directory,[Security.AccessControl.AccessControlSections]::Access)
  $existing.SetAccessRuleProtection($false,$true)
  [IO.FileSystemAclExtensions]::SetAccessControl($directory,$existing)
  return
}
if ($Action -eq 'LooseFileAcl') {
  $file = Join-Path $Root 'operator-state.dpapi'
  $info = [IO.FileInfo]::new($file)
  $fileAcl = [IO.FileSystemAclExtensions]::GetAccessControl($info,[Security.AccessControl.AccessControlSections]::Access)
  $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))
  [IO.FileSystemAclExtensions]::SetAccessControl($info,$fileAcl)
  return
}
if (-not (Test-Path -LiteralPath (Join-Path $Root 'operator-state.dpapi'))) {
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Root),$acl)
}
$json = [Console]::In.ReadToEnd()
$sealed = ConvertTo-SecureString -String $json -AsPlainText -Force | ConvertFrom-SecureString
[IO.File]::WriteAllText((Join-Path $Root 'operator-state.dpapi'),$sealed)
$lock = Join-Path $Root 'operator.lock'
if (-not (Test-Path -LiteralPath $lock)) { [IO.File]::WriteAllText($lock,'') }
[Console]::Out.WriteLine('SEALED ISOLATED FIXTURE')
