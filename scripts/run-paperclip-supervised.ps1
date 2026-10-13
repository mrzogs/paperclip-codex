param()

$ErrorActionPreference = 'Stop'

$PaperclipRoot = 'D:\Paperclip-codex'
$PaperclipHome = 'D:\Paperclip-codex\.paperclip-home'
$CorepackCmd = 'C:\Program Files\nodejs\corepack.cmd'
$LogDir = Join-Path $PaperclipHome 'service-logs'
$ConfigPath = Join-Path $PaperclipHome 'instances\default\config.json'

New-Item -ItemType Directory -Force -Path $PaperclipHome, $LogDir | Out-Null

if (-not (Test-Path -LiteralPath $CorepackCmd)) {
  throw "corepack.cmd not found: $CorepackCmd"
}

function Test-HttpOk([string]$Url, [int]$TimeoutSec = 5) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec $TimeoutSec
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Test-EmbeddedPostgres {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $false }
  try {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $port = [int]$config.database.embeddedPostgresPort
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
}

if ((Test-HttpOk 'http://127.0.0.1:3100/api/health') -and (Test-EmbeddedPostgres)) {
  Write-Output 'Paperclip and embedded Postgres are already healthy.'
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$log = Join-Path $LogDir "paperclip-$stamp.log"

Set-Location -LiteralPath $PaperclipRoot
"$(Get-Date -Format o) Starting Paperclip supervised service." | Out-File -LiteralPath $log -Encoding utf8

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & $CorepackCmd pnpm paperclipai run --data-dir $PaperclipHome --bind loopback *>> $log
  $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}

"$(Get-Date -Format o) Paperclip supervised service exited with code $exitCode." | Out-File -LiteralPath $log -Append -Encoding utf8
exit $exitCode
