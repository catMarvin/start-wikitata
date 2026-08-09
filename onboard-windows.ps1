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
function Ok([string]$m)    { Write-Host "  OK: $m" -ForegroundColor Green }
function Warn2([string]$m) { Write-Host "  WARN: $m" -ForegroundColor Yellow; $script:Errors++ }
function Why([string]$m)   { Write-Host "  Why: $m" -ForegroundColor DarkGray }
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

# ── Opening brief ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ================================================================" -ForegroundColor DarkGray
Write-Host "  wikiTaTa Developer Setup — What this installs and why" -ForegroundColor White
Write-Host "  ================================================================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  → Installs the tools Claude Code depends on" -ForegroundColor Cyan
Write-Host "    Node.js and git are the runtime foundation. Claude Code and the" -ForegroundColor DarkGray
Write-Host "    wikiTaTa MCP server both run on Node.js." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  → Clones the wikiTaTa repo and starts the MCP server" -ForegroundColor Cyan
Write-Host "    The MCP server bridges Claude to your workspace. Without it," -ForegroundColor DarkGray
Write-Host "    Claude is a generic AI — not your AI." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  → Stores your credentials securely (DPAPI, never plaintext)" -ForegroundColor Cyan
Write-Host "    Your JWT is encrypted to your Windows account — only this machine" -ForegroundColor DarkGray
Write-Host "    can read it. No passwords exposed in environment variables." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  → Registers this device and sets up self-monitoring" -ForegroundColor Cyan
Write-Host "    Self-heal detects connection problems and fixes them automatically." -ForegroundColor DarkGray
Write-Host "    Device registration links this machine to your workspace." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Every stage checks before installing. Safe to re-run." -ForegroundColor DarkGray
Write-Host "  Fresh machine: about 5 minutes." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  ================================================================" -ForegroundColor DarkGray
Write-Host ""
Read-Host "  Ready to begin? Press Enter"

# ── STAGE 0 — Identity & prerequisites ────────────────────────────────────────
Banner 'STAGE 0 — Identity & Prerequisites' 'Verifying credentials and environment'
Why 'Your username and JWT come pre-filled from my.wikitata.com/setup. They tell'
Why 'each stage who you are and authorize the database calls that follow.'
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
Why 'Confirms your Windows version and whether winget is available. winget is the'
Why 'preferred installer — if missing, some steps fall back to manual prompts.'
$os = Get-CimInstance Win32_OperatingSystem
Ok "$($os.Caption) (build $($os.BuildNumber)) · PowerShell $($PSVersionTable.PSVersion)"
$HasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
if ($HasWinget) { Ok 'winget available' } else { Warn2 'winget not found — installs fall back to manual prompts' }
LogLocal 'stage1' 'ok' "build:$($os.BuildNumber) winget:$HasWinget"
WtSvcUpsert 'onboard:platform' $null $env:COMPUTERNAME 'active' "windows build $($os.BuildNumber)"

# ── STAGE 2 — Dependencies (git) ─────────────────────────────────────────────
Banner 'STAGE 2 — Dependencies' 'git'
Why 'git is needed to clone the wikiTaTa repo and pull future updates.'
Why 'Already installed? This stage skips in under a second.'
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
Why 'Claude Code runs on Node.js. The wikiTaTa MCP server — the bridge between'
Why 'Claude and your workspace — also runs on Node.js. Both need it at runtime.'
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
Why 'Claude Code is the AI assistant you will use every day. This is the CLI that'
Why 'loads your MCP servers, manages your config, and runs your sessions.'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Invoke-Retry 3 3 { npm install -g @anthropic-ai/claude-code | Out-Null }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
Ok "claude $(claude --version 2>$null)"
LogLocal 'stage4' 'ok' 'claude-code'

# ── STAGE 5 — wikiTaTa MCP server ────────────────────────────────────────────
Banner 'STAGE 5 — wikiTaTa repo + MCP server' 'clone + npm install'
Why 'The MCP server lives in the wikiTaTa repo. It is the bridge that gives Claude'
Why 'access to your cards, sessions, vault, and workspace tools. Required.'
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
Why 'Your JWT is encrypted using Windows DPAPI — only your Windows account can'
Why 'decrypt it. Never written to env vars, never logged, never exposed in ps output.'
if ($WT_JWT) {
  New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null
  ProtectToFile $WT_JWT (Join-Path $CfgDir 'wt-jwt.dpapi') ([System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  Ok "JWT stored DPAPI-protected ($CfgDir\wt-jwt.dpapi)"
  LogLocal 'stage6' 'ok' 'dpapi-currentuser'
} else { LogLocal 'stage6' 'skipped' 'no_jwt' }

# ── STAGE 7 — Claude MCP registration ────────────────────────────────────────
Banner 'STAGE 7 — Claude MCP registration' 'claude mcp add (user scope)'
Why 'Tells Claude Code where the wikiTaTa MCP server lives and registers your'
Why 'credentials. Without this step Claude has no connection to your workspace.'
$mcpIndex = Join-Path $McpDir 'index.js'
try {
  claude mcp add --scope user wikitata node $mcpIndex -e "WT_USER=$WT_USERNAME" -e "WT_SB_URL=$WT_SB_URL" -e "WT_SB_KEY=$WT_SB_ANON_KEY" 2>$null | Out-Null
  Ok 'wikiTaTa MCP registered (user scope)'
  LogLocal 'stage7' 'ok' 'mcp_registered'
} catch { Warn2 "MCP registration failed — run 'claude mcp add' manually: $($_.Exception.Message)"; LogLocal 'stage7' 'fail' $_.Exception.Message }

# ── STAGE 7b — Golden-bootstrap seed: self-healing config sync (card 2aae217c, Part B) ──
# Fetch the SIGNED golden hook bundle, verify vs the pinned key, install the bootstrap, and wire a
# SessionStart hook so every future session parity-checks config. Idempotent, non-clobbering.
Banner 'STAGE 7b — Golden-bootstrap seed' 'signed golden bundle → SessionStart parity hook'
$SeedMjs = Join-Path $RepoDir 'install-golden-bootstrap.mjs'
if (Test-Path $SeedMjs) {
  try {
    $env:WT_ACTOR = $WT_USERNAME
    node $SeedMjs
    Ok 'Golden-bootstrap seed installed — SessionStart parity check wired (card 2aae217c)'
    LogLocal 'stage7b' 'ok' 'golden_seed'
  } catch { Warn2 "Golden-bootstrap seed skipped — run later: node `"$SeedMjs`""; LogLocal 'stage7b' 'fail' $_.Exception.Message }
}

# ── STAGE 8 — Device registration ────────────────────────────────────────────
Banner 'STAGE 8 — Device registration' 'this machine → Settings → Devices'
Why 'Registers this machine in your wikiTaTa workspace. Lets you see and manage'
Why 'all your connected devices from Settings → Devices.'
$DeviceId = ''
if ($WT_JWT) {
  try {
    $DeviceId = Invoke-Retry 3 2 { WtRpc 'wt_device_register' @{ p_user = $WT_USERNAME; p_hostname = $env:COMPUTERNAME; p_os_family = 'windows'; p_display_name = "Windows — $env:COMPUTERNAME" } }
    $DeviceId = "$DeviceId".Trim('"')
    Ok "Device registered: $DeviceId"
    LogLocal 'stage8' 'device_registered' $DeviceId
  } catch { Warn2 "Device registration failed: $($_.Exception.Message)"; LogLocal 'stage8' 'device_fail' $_.Exception.Message }
}

# ── STAGE 8b — wikiTaTa activation exchange (S549) ──────────────────────────
# The CACP coordination token is delivered ONLY via the activate edge fn (the
# anon bootstrap RPC is revoked). The same exchange registers the device
# server-side over a direct DB connection — covering the case where Stage 8's
# client-side RPC was rejected (lobby JWTs carry no wt_user claim).
Banner 'STAGE 8b — wikiTaTa activation' 'CACP coordination token + server-side device registration'
Why 'The CACP token lets Claude sessions on this machine coordinate through the'
Why 'Now Board. It is delivered only by this one authenticated exchange.'
if ($WT_JWT) {
  try {
    $actBody = @{ mode = 'setup'; jwt = $WT_JWT; username = $WT_USERNAME; hostname = $env:COMPUTERNAME; platform = 'windows'; device_label = "Windows — $env:COMPUTERNAME" } | ConvertTo-Json
    $act = Invoke-RestMethod -Method Post -Uri 'https://onoujmfhlrhvcqzjniei.supabase.co/functions/v1/activate' -TimeoutSec 25 -ContentType 'application/json' -Body $actBody
    if ($act.ok -and $act.cacp_token) {
      ProtectToFile "$($act.cacp_token)" (Join-Path $CfgDir 'wt-cacp.dpapi') ([System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      Ok "CACP token stored DPAPI-protected ($CfgDir\wt-cacp.dpapi)"
      LogLocal 'stage8b' 'cacp_stored' 'dpapi-currentuser'
    } else {
      Warn2 'CACP token not delivered — first Claude session can re-fetch'
      LogLocal 'stage8b' 'cacp_missing' ''
    }
    if (-not $DeviceId -and $act.device_registered) {
      $DeviceId = "$($act.device_id)"
      Ok "Device registered via exchange: $DeviceId"
      LogLocal 'stage8b' 'device_registered' $DeviceId
    }
  } catch { Warn2 "Activation exchange failed: $($_.Exception.Message)"; LogLocal 'stage8b' 'fail' $_.Exception.Message }
} else { LogLocal 'stage8b' 'skipped' 'no_jwt' }

# ── STAGE 9 — Self-heal handshake (card ce413352) ────────────────────────────
Banner 'STAGE 9 — Self-heal handshake' 'token (DPAPI) + config + Scheduled Task poller + first boot-audit'
Why 'When something breaks — MCP loses connection, a token expires, a service'
Why 'restarts — self-heal detects it and fixes it. No manual script required.'
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
Why 'Runs the full stack end-to-end: Node runtime, Claude CLI, MCP server syntax,'
Why 'and MCP registration. Catches problems before you open Claude for the first time.'
$v = 0
if ((node -e "console.log('ok')") -eq 'ok') { Ok 'Node runtime: ok' } else { Warn2 'Node runtime check failed'; $v++ }
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok 'Claude CLI: ok' } else { Warn2 'Claude CLI missing'; $v++ }
node --check $mcpIndex; if ($LASTEXITCODE -eq 0) { Ok 'MCP server syntax: ok' } else { Warn2 'MCP server syntax check failed'; $v++ }
$mcpList = claude mcp list 2>$null | Out-String
if ($mcpList -match 'wikitata') { Ok 'MCP registration visible to Claude CLI' } else { Warn2 'wikitata not in claude mcp list'; $v++ }
LogLocal 'stage10' ($(if ($v -eq 0) { 'validation_pass' } else { 'validation_fail' })) "errors:$v"

# ── STAGE 11 — MCP-Verified Handshake (ONBOARD-M6, task f8c367c2, north-star 8c047748 §5) ──
# Final gate: ask the LIVE MCP server (mcp.wikitata.com) to confirm this exact
# (user, device) pair resolves to a real wikiTaTa account with a usable config,
# and report platform health. The verdict prints HERE, before the terminal is
# done — a hard failure (server unreachable / device unknown / account missing)
# throws so nothing pretends the install worked (stops the irm|iex run without
# killing the window).
Banner 'STAGE 11 — MCP-Verified Handshake' 'Confirming Claude can see your wikiTaTa account — live, end-to-end'
Why 'This is the proof step: the live wikiTaTa MCP server confirms your account,'
Why 'this device, and platform health — end-to-end, before the terminal closes.'

$WT_MCP_BASE = if ($env:WT_MCP_BASE) { $env:WT_MCP_BASE } else { 'https://mcp.wikitata.com' }

if (-not $DeviceId) {
  LogLocal 'stage11' 'verify_fail' 'no_device_id'
  Write-Host '  FAIL: NOT VERIFIED — no device id from registration; cannot run the handshake.' -ForegroundColor Red
  Write-Host '  Remedy: re-run the personalized one-liner from start.wikitata.com/onboard (WT_JWT + WT_SB_ANON_KEY must be set)' -ForegroundColor Yellow
  Write-Host '  Help: request a new activation link at start.wikitata.com/request-token, or contact support' -ForegroundColor Yellow
  throw 'VERIFY failed: no device id'
}

$verifyUrl = "$WT_MCP_BASE/health/first-connect?user=$WT_USERNAME&device=$DeviceId"
$verify = $null
Write-Host "  → Contacting $WT_MCP_BASE ..." -ForegroundColor Cyan
for ($vh = 1; $vh -le 3; $vh++) {
  try { $verify = Invoke-RestMethod -Uri $verifyUrl -TimeoutSec 15; break }
  catch {
    # A 4xx verdict (device not recognized) carries its remedy in the JSON
    # body — read it instead of retrying blindly.
    $respBody = $null
    try { $respBody = $_.ErrorDetails.Message | ConvertFrom-Json } catch {}
    if ($respBody -and ($respBody.PSObject.Properties.Name -contains 'ok')) { $verify = $respBody; break }
    if ($vh -lt 3) { Write-Host "  Handshake attempt $vh/3 failed — retrying in 3s..." -ForegroundColor Yellow; Start-Sleep -Seconds 3 }
  }
}

if (-not $verify) {
  LogLocal 'stage11' 'verify_unreachable' $WT_MCP_BASE
  Write-Host '  FAIL: NOT VERIFIED — could not reach the wikiTaTa MCP server after 3 attempts.' -ForegroundColor Red
  Write-Host '  Remedy: check your internet connection, then re-run just the check:' -ForegroundColor Yellow
  Write-Host "    irm `"$verifyUrl`"" -ForegroundColor DarkGray
  Write-Host '  Help: re-run the one-liner from start.wikitata.com/onboard, or contact support' -ForegroundColor Yellow
  throw 'VERIFY failed: MCP server unreachable'
}

$script:VERIFIED_LINE = ''
if ($verify.ok -eq $true) {
  $pg = if ($verify.PSObject.Properties['probes_green']) { $verify.probes_green } else { $null }
  $pt = if ($verify.PSObject.Properties['probes_total']) { $verify.probes_total } else { $null }
  $probesMsg = if ($null -ne $pg -and $null -ne $pt) { "$pg/$pt health probes green" } else { 'health probes not reported' }
  $script:VERIFIED_LINE = "✅ VERIFIED — Claude can see your wikiTaTa account ($WT_USERNAME): config OK, $probesMsg. Open Claude and say hello."
  Write-Host "  $($script:VERIFIED_LINE)" -ForegroundColor Green
  LogLocal 'stage11' 'verify_pass' "probes:$pg/$pt"
  WtSvcUpsert 'onboard:verified' $null $WT_MCP_BASE 'active' 'first-connect-handshake'
} else {
  $gate   = if ($verify.PSObject.Properties['error'])  { $verify.error }  else { 'unknown_error' }
  $remedy = if ($verify.PSObject.Properties['remedy']) { $verify.remedy } else { 'Re-run the personalized one-liner from start.wikitata.com/onboard' }
  LogLocal 'stage11' 'verify_fail' $gate
  Write-Host "  FAIL: NOT VERIFIED — failed gate: $gate" -ForegroundColor Red
  Write-Host "  Remedy: $remedy" -ForegroundColor Yellow
  Write-Host '  Help: request a new activation link at start.wikitata.com/request-token, or contact support' -ForegroundColor Yellow
  throw "VERIFY failed: $gate"
}

# ── STAGE 12 — Final report ──────────────────────────────────────────────────
Banner 'COMPLETE' 'wikiTaTa is set up on this Windows machine'
if (($script:Errors + $v) -eq 0) { Write-Host "  PASS — everything installed and verified." -ForegroundColor Green }
else { Write-Host "  DONE with $($script:Errors + $v) issue(s) — see warnings above." -ForegroundColor Yellow }
# Re-print the handshake verdict — this is the line that must survive until the
# user reads it (ONBOARD-M6).
if ($script:VERIFIED_LINE) { Write-Host "  $($script:VERIFIED_LINE)" -ForegroundColor Green }
Write-Host "`n  Next steps:" -ForegroundColor White
Write-Host '  1. Open a NEW terminal (fresh PATH)'
Write-Host '  2. Run: claude'
Write-Host "  3. Say: hello  — wt_session_start verifies the MCP connection end-to-end"
Write-Host "  4. Visit: https://my.wikitata.com — your workspace`n"
WtSvcUpsert 'onboard:status' $null $CfgDir 'active' 'windows_complete'
LogLocal 'final' 'done' "errors:$($script:Errors + $v)"
