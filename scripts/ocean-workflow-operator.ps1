param(
  [ValidateSet('Bootstrap','Maintenance','Initialize','Reset-Password','Enroll','Rotate','Revoke','Verify','Resume','Status','Runtime','Transfer','Probe','Setup-Import','Setup-Read','Setup-Export')][string]$Action = 'Status',
  [string]$RequestFile,
  [string]$IdentityId,
  [string]$Root = 'D:\OceanTradingData\website\workflow'
)
if ($PSVersionTable.PSEdition -eq 'Core') {
  $forward = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$PSCommandPath)
  foreach ($key in $PSBoundParameters.Keys) { $forward += "-$key"; $forward += [string]$PSBoundParameters[$key] }
  & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' @forward
  if ($LASTEXITCODE -ne 0) { throw 'Native Windows protected operator command failed.' }
  return
}
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules;${env:ProgramFiles}\WindowsPowerShell\Modules"
$Node = 'C:\Program Files\nodejs\node.exe'
$Module = 'D:\Paperclip-codex\website\ocean-trading\dashboard\workflow\operator.mjs'
$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Root = [IO.Path]::GetFullPath($Root)
$StatePath = Join-Path $Root 'operator-state.dpapi'
$PendingPath = Join-Path $Root 'operator-pending.dpapi'
if (-not (Test-Path -LiteralPath $Root)) {
  if ($Action -notin @('Initialize','Bootstrap')) { throw 'Machine state is absent. Run the protected operator command with -Action Bootstrap.' }
  New-Item -ItemType Directory -Path $Root | Out-Null
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($principal in @($Sid,'S-1-5-18')) {
    $identity = New-Object Security.Principal.SecurityIdentifier($principal)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($Root,$acl)
}
$acl = Get-Acl -LiteralPath $Root
if ((Get-Item -LiteralPath $Root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse-point operator root rejected.' }
if (-not $acl.AreAccessRulesProtected) { throw 'Operator directory must have protected current-user/SYSTEM ACLs.' }
foreach ($rule in $acl.Access) {
  $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($rule.AccessControlType -eq 'Allow' -and $ruleSid -notin @($Sid,'S-1-5-18')) { throw 'Unexpected principal in operator directory ACL.' }
}
function Decode-State([string]$File) {
  $secure = Get-Content -LiteralPath $File -Raw | ConvertTo-SecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) | ConvertFrom-Json } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function Encode-State($Value,[string]$File) {
  $json = ConvertTo-Json -InputObject $Value -Depth 50 -Compress
  $sealed = ConvertTo-SecureString -String $json -AsPlainText -Force | ConvertFrom-SecureString
  $bytes = [Text.Encoding]::UTF8.GetBytes($sealed)
  $stream = New-Object IO.FileStream($File,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Invoke-Core($Value) {
  $json = ConvertTo-Json -InputObject $Value -Depth 50 -Compress
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = '--disable-warning=ExperimentalWarning "' + $Module + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $p.StandardInput.Write($json)
  $p.StandardInput.Close()
  $output = $p.StandardOutput.ReadToEnd()
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { throw "Protected workflow operation failed: $err" }
  $output | ConvertFrom-Json
}
function Publish-Handoffs($State) {
  $directory = Join-Path $Root 'handoffs'
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  foreach ($identity in $State.config.identities) {
    if ($identity.identity_id -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Unsafe identity handoff path.' }
    $target = Join-Path $directory "$($identity.identity_id).dpapi"
    $candidate = "$target.next"
    $token = if ($identity.revoked) { $null } else { $State.environment.($identity.credential_ref) }
    Encode-State @{identity_id=$identity.identity_id;credential_ref=$identity.credential_ref;token=$token;expires_at_utc=$identity.expires_at_utc;credential_version=$identity.credential_version;revoked=[bool]$identity.revoked;audience='Ocean workflow TEST';owner=$identity.owner} $candidate
    if (Test-Path -LiteralPath $target) { [IO.File]::Replace($candidate,$target,"$target.previous") } else { [IO.File]::Move($candidate,$target) }
  }
}
$lock = $null
$lockDeadline = [DateTimeOffset]::UtcNow.AddSeconds(8)
while (-not $lock) {
  try { $lock = [IO.File]::Open((Join-Path $Root 'operator.lock'),'OpenOrCreate','ReadWrite','None') }
  catch [IO.IOException] {
    if ([DateTimeOffset]::UtcNow -ge $lockDeadline) { throw 'Protected operator busy; bounded lock wait exceeded. Retry the same operation.' }
    Start-Sleep -Milliseconds 100
  }
}
try {
  if ($Action -like 'Setup-*') {
    if (Test-Path -LiteralPath $PendingPath) { throw 'Resume the pending credential publication before setup operations.' }
    $state=Decode-State $StatePath
    $request=if($RequestFile){Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json}else{$null}
    Invoke-Core @{mode='setup';state=$state;operator_id=$Sid;action=$Action.ToLowerInvariant();request=$request} | ConvertTo-Json -Depth 50
    return
  }
  if ($Action -eq 'Bootstrap' -and (Test-Path -LiteralPath $StatePath) -and -not (Test-Path -LiteralPath $PendingPath)) {
    $state=Decode-State $StatePath
    Invoke-Core @{mode='verify';state=$state} | ConvertTo-Json -Depth 20
    return
  }
  if ($Action -eq 'Revoke' -and (Test-Path -LiteralPath $PendingPath)) {
    $request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
    $plan = Invoke-Core @{mode='cancel-renewal';state=(Decode-State $StatePath);pending=(Decode-State $PendingPath);request=$request;operator_id=$Sid;root=$Root}
    $candidate = Join-Path $Root 'operator-pending.next.dpapi'
    Encode-State $plan $candidate
    [IO.File]::Replace($candidate,$PendingPath,"$PendingPath.before-cancel")
  } elseif ($Action -eq 'Resume' -or ($Action -in @('Maintenance','Bootstrap') -and (Test-Path -LiteralPath $PendingPath))) {
    if (-not (Test-Path -LiteralPath $PendingPath)) { throw 'No interrupted operator update exists.' }
    $plan = Decode-State $PendingPath
  } elseif ($Action -in @('Status','Runtime','Transfer','Probe')) {
    if (Test-Path -LiteralPath $PendingPath) { throw 'Interrupted credential update. Run -Action Resume first.' }
    $state = Decode-State $StatePath
    $status = Invoke-Core @{mode='verify';state=$state}
    if ($Action -eq 'Runtime') {
      if (-not [Console]::IsOutputRedirected) { throw 'Runtime is an internal captured-output reader. Use Status in an operator console.' }
      ConvertTo-Json -InputObject $state -Depth 50 -Compress
    } elseif ($Action -eq 'Status') { ConvertTo-Json -InputObject $status -Depth 50 }
    else {
      $identity = @($state.config.identities | Where-Object { $_.identity_id -ceq $IdentityId })
      if ($identity.Count -ne 1 -or $identity[0].revoked -or [DateTimeOffset]::Parse($identity[0].expires_at_utc) -le [DateTimeOffset]::UtcNow) { throw 'Active, unexpired, exact identity required.' }
      $identity = $identity[0]
      $token = $state.environment.($identity.credential_ref)
      if ($Action -eq 'Probe') {
        $response = Invoke-RestMethod -Uri 'http://localhost:3102/api/workflow/status' -Headers @{Authorization="Bearer $token"} -TimeoutSec 8
        if ($response.identity.id -cne $IdentityId) { throw 'Observed identity mismatch.' }
        @{ status='PASS'; test_type='ACTUAL_DEPLOYED_OCEAN_LOCAL_OPERATOR_PROBE'; observed_at_utc=[DateTimeOffset]::UtcNow.ToString('o'); identity=$response.identity; integration_readiness=$response.integration_readiness; consumer_acceptance='NOT_VERIFIED_BY_THIS_LOCAL_PROBE' } | ConvertTo-Json -Depth 12
      } else {
        if ($IdentityId -notmatch '^[A-Za-z0-9_.:-]+$' -or $IdentityId.Contains(':')) { throw 'Identity is unsuitable for a protected handoff filename.' }
        $handoffs = Join-Path $Root 'handoffs'
        New-Item -ItemType Directory -Path $handoffs -Force | Out-Null
        $target = Join-Path $handoffs "$IdentityId.dpapi"
        Publish-Handoffs $state
        @{protected_handoff=$target;identity_id=$IdentityId;credential_ref=$identity.credential_ref;encryption='Windows DPAPI CurrentUser';plaintext_exported=$false} | ConvertTo-Json
      }
    }
    return
  } else {
    if (Test-Path -LiteralPath $PendingPath) { throw 'Interrupted credential update. Run -Action Resume first.' }
    $state = if (Test-Path -LiteralPath $StatePath) { Decode-State $StatePath } else { $null }
    $password = $null
    if ($Action -in @('Initialize','Reset-Password')) {
      if ([Console]::IsInputRedirected) { throw 'Human secret entry requires the genuine protected interactive operator prompt.' }
      $first = Read-Host 'New Ocean workflow password (14-256 characters)' -AsSecureString
      $second = Read-Host 'Confirm new password' -AsSecureString
      $p1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($first)
      $p2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($second)
      try {
        $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p1)
        if ($password -cne [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p2)) { throw 'Passwords do not match.' }
      } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p1); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p2) }
    }
    $request = if ($RequestFile) { Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json } else { $null }
    $mode = if ($Action -eq 'Maintenance') { 'maintenance' } else { 'prepare' }
    $plan = Invoke-Core @{mode=$mode;action=$Action.ToLowerInvariant();state=$state;password=$password;request=$request;operator_id=$Sid;root=$Root}
    $password = $null
    if ($plan.no_change) { $plan | ConvertTo-Json; return }
    Encode-State $plan $PendingPath
  }
  $result = Invoke-Core @{mode='commit';plan=$plan}
  $candidate = Join-Path $Root 'operator-state.next.dpapi'
  Encode-State $plan.next $candidate
  if (Test-Path -LiteralPath $StatePath) { [IO.File]::Replace($candidate,$StatePath,(Join-Path $Root "operator-before-$($plan.next.revision).dpapi")) } else { [IO.File]::Move($candidate,$StatePath) }
  Publish-Handoffs $plan.next
  Remove-Item -LiteralPath $PendingPath
  $result | ConvertTo-Json
} finally { $lock.Dispose() }
