#Requires -Version 7
<#
 onboard-windows.ps1 — wikiTaTa Windows onboarding (card ce413352 / ONBOARD-M5).
 Invoked per onboard.html:
   $env:WT_USERNAME="you"; $env:WT_JWT="<session jwt>"; irm https://start.wikitata.com/onboard-windows.ps1 | iex
 Mirrors scripts/onboard-linux.sh stages. Logging contract: JSONL to
 $env:APPDATA\wikitata\install.jsonl AND best-effort upsert to user_service_configs.
 Secrets: WT_JWT + the self-heal device token are stored DPAPI-protected; they are
 never echoed and never logged (names/lengths only).
#>
$ErrorActionPreference = 'Stop'

# ── Config / contract ─────────────────────────────────────────────────────────
$WT_SB_URL      = if ($env:WT_SB_URL) { $env:WT_SB_URL } else { 'https://onoujmfhlrhvcqzjniei.supabase.co' }
$WT_SB_ANON_KEY = $env:WT_SB_ANON_KEY
$WT_USERNAME    = $env:WT_USERNAME
$WT_JWT         = $env:WT_JWT
$CfgDir   = Join-Path $env:APPDATA 'wikitata'
$DataDir  = Join-Path $env:PROGRAMDATA 'wikitata'
$LogFile  = Join-Path $CfgDir 'install.jsonl'
$RepoDir  = Join-Path $env:USERPROFILE 'git\wikitata'
$McpDir   = Join-Path $RepoDir 'wt-mcp-server'
$SelfHealDir = Join-Path $RepoDir 'tools\self-heal'
$script:Errors = 0

# ── Helpers (parity with onboard-linux.sh) ───────────────────────────────────
function Banner([string]$t, [string]$d) { Write-Host "`n===== $t =====" -ForegroundColor Cyan; if ($d) { Write-Host "  $d" -ForegroundColor DarkGray } }
function Ok([string]$m)   { Write-Host "  OK: $m" -ForegroundColor Green }
function Warn2([string]$m){ Write-Host "  WARN: $m" -ForegroundColor Yellow; $script:Errors++ }
function LogLocal([string]$stage, [string]$status, [string]$detail = '') {
  New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null
  $row = @{ ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); stage = $stage; status = $status; detail = $detail; platform = 'windows'; user = $WT_USERNAME } | ConvertTo-Json -Compress
  Add-Content -Path $LogFile -Value $row
}
function Invoke-Retry([int]$Attempts, [int]$DelaySec, [scriptblock]$Body) {
  for ($i = 1; $i -le $Attempts; $i++) {
    try { return & $Body } catch {
      if ($i -eq $Attempts) { throw }
      Write-Host "  attempt $i/$Attempts failed — retrying in ${DelaySec}s..." -ForegroundColor Yellow
      Start-Sleep -Seconds $DelaySec; $DelaySec *= 2
    }
  }
}
function WtSvcUpsert([string]$svc, $port, [string]$path, [string]$status, [string]$detail) {
  if (-not $WT_JWT -or -not $WT_SB_ANON_KEY) { LogLocal "db:$svc" 'skipped' 'no_jwt'; return }
  $body = @{ service = $svc; port = $port; local_path = $path; status = $status; created_by = $WT_USERNAME; config = @{ detail = $detail; platform = 'windows' } } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Method Post -Uri "$WT_SB_URL/rest/v1/user_service_configs" -TimeoutSec 10 `
      -Headers @{ apikey = $WT_SB_ANON_KEY; Authorization = "Bearer $WT_JWT"; Prefer = 'resolution=merge-duplicates' } `
      -ContentType 'application/json' -Body $body | Out-Null
    LogLocal "db:$svc" 'ok' $detail
  } catch { LogLocal "db:$svc" 'queued' $detail }
}
function WtRpc([string]$fn, [hashtable]$params) {
  Invoke-RestMethod -Method Post -Uri "$WT_SB_URL/rest/v1/rpc/$fn" -TimeoutSec 15 `
    -Headers @{ apikey = $WT_SB_ANON_KEY; Authorization = "Bearer $WT_JWT" } `
    -ContentType 'application/json' -Body ($params | ConvertTo-Json -Compress)
}
function ProtectToFile([string]$plain, [string]$file, [System.Security.Cryptography.DataProtectionScope]$scope) {
  Add-Type -AssemblyName System.Security
  $bytes = [System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, $scope)
  [IO.File]::WriteAllBytes($file, $bytes)
}

# ── STAGE 0 — Identity & prerequisites ────────────────────────────────────────
Banner 'STAGE 0 — Identity & Prerequisites' 'Verifying credentials and environment'
if (-not $WT_USERNAME) { throw 'WT_USERNAME env var is required (set it per the start.wikitata.com instructions)' }
if (-not $WT_JWT)      { Warn2 'WT_JWT missing — DB logging, device registration and self-heal will be skipped' }
if (-not $WT_SB_ANON_KEY) { Warn2 'WT_SB_ANON_KEY missing — REST calls disabled' }
if ($WT_JWT) {
  try {
    Invoke-RestMethod -Method Get -Uri "$WT_SB_URL/rest/v1/user_service_configs?limit=1" -TimeoutSec 10 `
      -Headers @{ apikey = $WT_SB_ANON_KEY; Authorization = "Bearer $WT_JWT" } | Out-Null
    Ok 'Supabase connectivity + JWT verified'
  } catch { Warn2 "DB connectivity probe failed: $($_.Exception.Message)" }
}
LogLocal 'stage0' 'ok' "user:$WT_USERNAME jwt_len:$($WT_JWT.Length)"

# ── STAGE 1 — Platform detect ─────────────────────────────────────────────────
Banner 'STAGE 1 — Platform' 'Windows version + package manager'
$os = Get-CimInstance Win32_OperatingSystem
Ok "$($os.Caption) (build $($os.BuildNumber)) · PowerShell $($PSVersionTable.PSVersion)"
$HasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
if ($HasWinget) { Ok 'winget available' } else { Warn2 'winget not found — installs fall back to manual prompts' }
LogLocal 'stage1' 'ok' "build:$($os.BuildNumber) winget:$HasWinget"
WtSvcUpsert 'onboard:platform' $null $env:COMPUTERNAME 'active' "windows build $($os.BuildNumber)"

# ── STAGE 2 — Dependencies (git) ─────────────────────────────────────────────
Banner 'STAGE 2 — Dependencies' 'git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if ($HasWinget) {
    Invoke-Retry 3 2 { winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements --silent | Out-Null }
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  } else { throw 'git missing and winget unavailable — install Git for Windows, then re-run' }
}
Ok "git $((git --version) -replace 'git version ','')"
LogLocal 'stage2' 'ok' 'git'

# ── STAGE 3 — Node.js ────────────────────────────────────────────────────────
Banner 'STAGE 3 — Node.js' 'LTS runtime for Claude Code + MCP server + poller'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if ($HasWinget) {
    Invoke-Retry 3 2 { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent | Out-Null }
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  } else { throw 'node missing and winget unavailable — install Node LTS, then re-run' }
}
Ok "node $(node --version)"
LogLocal 'stage3' 'ok' (node --version)

# ── STAGE 4 — Claude Code CLI ────────────────────────────────────────────────
Banner 'STAGE 4 — Claude Code' 'npm install -g @anthropic-ai/claude-code'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Invoke-Retry 3 3 { npm install -g @anthropic-ai/claude-code | Out-Null }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
Ok "claude $(claude --version 2>$null)"
LogLocal 'stage4' 'ok' 'claude-code'

# ── STAGE 5 — wikiTaTa MCP server ────────────────────────────────────────────
Banner 'STAGE 5 — wikiTaTa repo + MCP server' 'clone + npm install'
if (-not (Test-Path $McpDir)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir) | Out-Null
  Invoke-Retry 3 3 { git clone https://github.com/catMarvin/wikitata.git $RepoDir | Out-Null }
}
Push-Location $McpDir
Invoke-Retry 3 3 { npm install --omit=dev --silent | Out-Null }
Pop-Location
Ok "MCP server ready: $McpDir"
LogLocal 'stage5' 'ok' $McpDir
WtSvcUpsert 'local:mcp' $null (Join-Path $McpDir 'index.js') 'active' 'stdio-mcp'

# ── STAGE 6 — Credential storage (DPAPI, never plaintext) ────────────────────
Banner 'STAGE 6 — Credential storage' 'WT_JWT → DPAPI-protected file (CurrentUser scope)'
if ($WT_JWT) {
  New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null
  ProtectToFile $WT_JWT (Join-Path $CfgDir 'wt-jwt.dpapi') ([System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  Ok "JWT stored DPAPI-protected ($CfgDir\wt-jwt.dpapi)"
  LogLocal 'stage6' 'ok' 'dpapi-currentuser'
} else { LogLocal 'stage6' 'skipped' 'no_jwt' }

# ── STAGE 7 — Claude MCP registration ────────────────────────────────────────
Banner 'STAGE 7 — Claude MCP registration' 'claude mcp add (user scope)'
$mcpIndex = Join-Path $McpDir 'index.js'
try {
  claude mcp add --scope user wikitata node $mcpIndex -e "WT_USER=$WT_USERNAME" -e "WT_SB_URL=$WT_SB_URL" -e "WT_SB_KEY=$WT_SB_ANON_KEY" 2>$null | Out-Null
  Ok 'wikiTaTa MCP registered (user scope)'
  LogLocal 'stage7' 'ok' 'mcp_registered'
} catch { Warn2 "MCP registration failed — run 'claude mcp add' manually: $($_.Exception.Message)"; LogLocal 'stage7' 'fail' $_.Exception.Message }

# ── STAGE 8 — Device registration ────────────────────────────────────────────
Banner 'STAGE 8 — Device registration' 'this machine → Settings → Devices'
$DeviceId = ''
if ($WT_JWT) {
  try {
    $DeviceId = Invoke-Retry 3 2 { WtRpc 'wt_device_register' @{ p_user = $WT_USERNAME; p_hostname = $env:COMPUTERNAME; p_os_family = 'windows'; p_display_name = "Windows — $env:COMPUTERNAME" } }
    $DeviceId = "$DeviceId".Trim('"')
    Ok "Device registered: $DeviceId"
    LogLocal 'stage8' 'device_registered' $DeviceId
  } catch { Warn2 "Device registration failed: $($_.Exception.Message)"; LogLocal 'stage8' 'device_fail' $_.Exception.Message }
}

# ── STAGE 9 — Self-heal handshake (card ce413352) ────────────────────────────
Banner 'STAGE 9 — Self-heal handshake' 'token (DPAPI) + config + Scheduled Task poller + first boot-audit'
$SelfHealOk = $true
if (-not $DeviceId -or -not (Test-Path (Join-Path $SelfHealDir 'poller.js'))) {
  Warn2 'Self-heal skipped (no device id, or tools/self-heal missing)'
  LogLocal 'stage9' 'skipped' 'prereq'
  $SelfHealOk = $false
}
if ($SelfHealOk) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $tokenFile = Join-Path $DataDir 'selfheal-token.dpapi'
  if (-not (Test-Path $tokenFile)) {
    $rng = [byte[]]::new(32); [System.Security.Cryptography.RandomNumberGenerator]::Fill($rng)
    $tokenPlain = -join ($rng | ForEach-Object { $_.ToString('x2') })
    ProtectToFile $tokenPlain $tokenFile ([System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    Ok 'Device token generated (DPAPI LocalMachine)'
  } else {
    Add-Type -AssemblyName System.Security
    $tokenPlain = [Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($tokenFile), $null, 'LocalMachine'))
    Ok 'Device token already present — reusing'
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($tokenPlain)) | ForEach-Object { $_.ToString('x2') })
  Remove-Variable tokenPlain

  @{ device_id = $DeviceId; supabase_url = $WT_SB_URL; anon_key = $WT_SB_ANON_KEY; poll_seconds = 30; burst_seconds = 5; units = @{}; repos = @($RepoDir); expected_keychain_keys = @() } |
    ConvertTo-Json | Set-Content -Path (Join-Path $DataDir 'selfheal.json')
  Ok "Self-heal config written ($DataDir\selfheal.json)"

  try {
    Invoke-Retry 3 2 { WtRpc 'wt_selfheal_token_set' @{ p_user = $WT_USERNAME; p_device_id = $DeviceId; p_token_hash = $hash } } | Out-Null
    Ok 'Token hash registered with wikiTaTa'
    LogLocal 'stage9' 'token_registered' $DeviceId
  } catch { Warn2 "Token-hash registration failed: $($_.Exception.Message)"; LogLocal 'stage9' 'token_fail' $_.Exception.Message; $SelfHealOk = $false }
}
if ($SelfHealOk) {
  $nodeExe = (Get-Command node).Source
  $pollerPath = Join-Path $SelfHealDir 'poller.js'
  schtasks /Create /F /TN 'wikitata-selfheal' /SC ONLOGON /TR "`"$nodeExe`" `"$pollerPath`"" /RL LIMITED | Out-Null
  schtasks /Run /TN 'wikitata-selfheal' | Out-Null
  Ok 'Self-heal poller Scheduled Task installed + started (at logon)'
  LogLocal 'stage9' 'poller_ok' 'schtasks'
  WtSvcUpsert 'selfheal:poller' $null $pollerPath 'active' 'scheduled-task'
  try {
    & $nodeExe (Join-Path $SelfHealDir 'boot-audit.js') --trigger install 2>$null | Out-Null
    Ok 'First boot config-audit submitted'
    LogLocal 'stage9' 'audit_ok' 'install'
  } catch { Warn2 'Boot audit failed (poller retries at startup)'; LogLocal 'stage9' 'audit_fail' '' }
}

# ── STAGE 10 — Live validation + MCP verify ──────────────────────────────────
Banner 'STAGE 10 — Live validation' 'node, claude, MCP syntax, MCP registration'
$v = 0
if ((node -e "console.log('ok')") -eq 'ok') { Ok 'Node runtime: ok' } else { Warn2 'Node runtime check failed'; $v++ }
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok 'Claude CLI: ok' } else { Warn2 'Claude CLI missing'; $v++ }
node --check $mcpIndex; if ($LASTEXITCODE -eq 0) { Ok 'MCP server syntax: ok' } else { Warn2 'MCP server syntax check failed'; $v++ }
$mcpList = claude mcp list 2>$null | Out-String
if ($mcpList -match 'wikitata') { Ok 'MCP registration visible to Claude CLI' } else { Warn2 'wikitata not in claude mcp list'; $v++ }
LogLocal 'stage10' ($(if ($v -eq 0) { 'validation_pass' } else { 'validation_fail' })) "errors:$v"

# ── STAGE 11 — Final report ──────────────────────────────────────────────────
Banner 'COMPLETE' 'wikiTaTa is set up on this Windows machine'
if (($script:Errors + $v) -eq 0) { Write-Host "  PASS — everything installed and verified." -ForegroundColor Green }
else { Write-Host "  DONE with $($script:Errors + $v) issue(s) — see warnings above." -ForegroundColor Yellow }
Write-Host "`n  Next steps:" -ForegroundColor White
Write-Host '  1. Open a NEW terminal (fresh PATH)'
Write-Host '  2. Run: claude'
Write-Host "  3. Say: hello  — wt_session_start verifies the MCP connection end-to-end"
Write-Host "  4. Visit: https://my.wikitata.com — your workspace`n"
WtSvcUpsert 'onboard:status' $null $CfgDir 'active' 'windows_complete'
LogLocal 'final' 'done' "errors:$($script:Errors + $v)"
