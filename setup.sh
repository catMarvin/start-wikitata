#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# wikiTaTa — Developer Setup
# One script. Checks everything. Installs what's missing. Configures Claude.
# ═══════════════════════════════════════════════════════════════════════════════

set -uo pipefail

# ── Accept username as argument (pre-filled from web page) ───────────────────
WT_USERNAME="${1:-}"

# ── Colors + Symbols ─────────────────────────────────────────────────────────

R='\033[0;31m'; G='\033[0;32m'; Y='\033[0;33m'; B='\033[0;34m'
C='\033[0;36m'; D='\033[2m'; BD='\033[1m'; RST='\033[0m'
OK="${G}✓${RST}"
FAIL="${R}✗${RST}"
WARN="${Y}⚠${RST}"
ARROW="${C}→${RST}"
BAR="${D}═══════════════════════════════════════════════════════════════${RST}"

STEP=0
TOTAL=7
ERRORS=0
SKIPPED=0

# ── Helpers ──────────────────────────────────────────────────────────────────

step_header() {
  STEP=$((STEP + 1))
  clear
  printf '\n\n\n'
  echo -e "  ${BAR}"
  echo -e "  ${BD}wikiTaTa Developer Setup${RST}                          ${D}step $STEP of $TOTAL${RST}"
  echo -e "  ${BAR}"
  printf '\n'
  echo -e "  ${BD}${C}$1${RST}"
  echo -e "  ${D}$2${RST}"
  printf '\n'
}

ok()    { echo -e "  ${OK}  $1"; }
fail()  { echo -e "  ${FAIL}  $1"; ERRORS=$((ERRORS + 1)); }
warn()  { echo -e "  ${WARN}  $1"; }
info()  { echo -e "  ${ARROW}  $1"; }
dim()   { echo -e "  ${D}$1${RST}"; }
blank() { echo ""; }

wait_for_enter() {
  blank
  echo -e "  ${D}────────────────────────────────────────────────${RST}"
  read -p "  Press Enter to continue... " _unused
}

has() { command -v "$1" >/dev/null 2>&1; }

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 1: Xcode Command Line Tools
# ═══════════════════════════════════════════════════════════════════════════════

step_header "Xcode Command Line Tools" "Git and build essentials for macOS"

if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode already installed"
  ok "$(git --version)"
  SKIPPED=$((SKIPPED + 1))
else
  info "Installing Xcode Command Line Tools..."
  blank
  xcode-select --install 2>/dev/null
  blank
  echo -e "  ${Y}${BD}A system popup should appear.${RST}"
  echo -e "  ${Y}Click Install and wait for it to finish (2-5 minutes).${RST}"
  blank
  read -p "  Press Enter when the install is done... " _unused
  blank

  if xcode-select -p >/dev/null 2>&1; then
    ok "Xcode installed successfully"
    ok "$(git --version)"
  else
    fail "Xcode install didn't complete — try running xcode-select --install manually"
  fi
fi

wait_for_enter

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 2: Homebrew
# ═══════════════════════════════════════════════════════════════════════════════

step_header "Homebrew" "macOS package manager — makes installing everything else clean"

if has brew; then
  ok "Homebrew already installed"
  dim "$(brew --version | head -1)"
  SKIPPED=$((SKIPPED + 1))
else
  info "Installing Homebrew..."
  blank
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  blank

  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile 2>/dev/null
  eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null

  if has brew; then
    ok "Homebrew installed"
    dim "$(brew --version | head -1)"
  else
    fail "Homebrew not found after install"
    info "Try opening a new terminal tab and running: brew --version"
  fi
fi

wait_for_enter

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 3: Node.js
# ═══════════════════════════════════════════════════════════════════════════════

step_header "Node.js" "Required for Claude Code, the setup wizard, and all CLI tools"

if has node; then
  NODE_V=$(node -v)
  ok "Node.js already installed — $NODE_V"
  dim "npm $(npm -v)"
  SKIPPED=$((SKIPPED + 1))
else
  if has brew; then
    info "Installing Node.js via Homebrew..."
    brew install node
    blank

    if has node; then
      ok "Node.js installed — $(node -v)"
      dim "npm $(npm -v)"
    else
      fail "Node.js install failed — try: brew install node"
    fi
  else
    fail "Can't install Node.js — Homebrew not available"
    info "Go back and install Homebrew first, then re-run this script"
  fi
fi

wait_for_enter

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 4: CLI Tools (Claude Code, Supabase, Vercel)
# ═══════════════════════════════════════════════════════════════════════════════

step_header "CLI Tools" "Claude Code, Supabase CLI, Vercel CLI"

if ! has npm; then
  fail "npm not found — Node.js is required for this step"
else
  # Claude Code
  if has claude; then
    ok "Claude Code $(claude --version 2>/dev/null | head -1 || echo 'installed')"
  else
    info "Installing Claude Code..."
    npm install -g @anthropic-ai/claude-code 2>&1 | tail -2
    has claude && ok "Claude Code installed" || fail "Claude Code install failed"
  fi

  # Supabase CLI
  if has supabase; then
    ok "Supabase CLI $(supabase --version 2>/dev/null | head -1)"
  else
    info "Installing Supabase CLI..."
    if has brew; then
      brew install supabase/tap/supabase 2>&1 | tail -2
    else
      npm install -g supabase 2>&1 | tail -2
    fi
    has supabase && ok "Supabase CLI installed" || fail "Supabase CLI install failed"
  fi

  # Vercel CLI
  if has vercel; then
    ok "Vercel CLI $(vercel --version 2>/dev/null | head -1)"
  else
    info "Installing Vercel CLI..."
    npm install -g vercel@latest 2>&1 | tail -2
    has vercel && ok "Vercel CLI installed" || fail "Vercel CLI install failed"
  fi
fi

wait_for_enter

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 5: Identity
# ═══════════════════════════════════════════════════════════════════════════════

step_header "Your Identity" "wikiTaTa username — assigned to you when you were invited"

if [ -n "${WT_USERNAME:-}" ]; then
  ok "Username from environment: $WT_USERNAME"
else
  blank
  read -p "  Your wikiTaTa username: " WT_USERNAME
  blank

  if [ -z "$WT_USERNAME" ]; then
    fail "Username required. Check your invite from the wikiTaTa team."
    exit 1
  fi
  ok "Username: $WT_USERNAME"
fi

wait_for_enter

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 6: Clone wikiTaTa + Configure Claude Code
# ═══════════════════════════════════════════════════════════════════════════════

step_header "wikiTaTa Repo + Claude Config" "Clone the private repo and configure Claude Code"

HOME_DIR="$HOME"
mkdir -p "$HOME_DIR/git"

# Clone
if [ -d "$HOME_DIR/git/wikitata" ]; then
  ok "Repo already cloned"
  if [ -f "$HOME_DIR/git/wikitata/wt-mcp-server/index.js" ]; then
    ok "wt-mcp-server found"
  else
    warn "wt-mcp-server/index.js missing — may need: cd ~/git/wikitata && git pull"
  fi
else
  info "Cloning wikitata repo..."
  if git clone git@github.com:catMarvin/wikitata.git "$HOME_DIR/git/wikitata" 2>/dev/null; then
    ok "Cloned via SSH"
  elif git clone https://github.com/catMarvin/wikitata.git "$HOME_DIR/git/wikitata" 2>/dev/null; then
    ok "Cloned via HTTPS"
    warn "SSH failed — you may need to add your SSH key for push access"
  else
    fail "Could not clone — check your SSH key is added to GitHub"
  fi
fi

blank

# Claude config
mkdir -p "$HOME_DIR/.claude"
MCP_PATH="$HOME_DIR/git/wikitata/wt-mcp-server/index.js"

dim "Writing ~/.claude/.mcp.json"
cat > "$HOME_DIR/.claude/.mcp.json" << EOF
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": [
        "-y",
        "@supabase/mcp-server-supabase@latest",
        "--access-token",
        "sbp_v0_03a48bd302ba80ab5c454a5113135c7e5d0b95d7"
      ]
    },
    "wikitata": {
      "command": "node",
      "args": ["$MCP_PATH"],
      "env": {
        "WT_USER": "$WT_USERNAME",
        "WT_SB_URL": "https://onoujmfhlrhvcqzjniei.supabase.co",
        "WT_SB_KEY": "sb_publishable_QMzEps5hwDAVp0RI2uFlkQ_VyPGa2MK"
      }
    }
  }
}
EOF
ok ".mcp.json"

if [ ! -f "$HOME_DIR/.claude/settings.json" ]; then
  dim "Writing ~/.claude/settings.json"
  cat > "$HOME_DIR/.claude/settings.json" << 'SEOF'
{
  "permissions": {
    "allow": [
      "Bash", "Read", "Write", "Edit", "Glob", "Grep",
      "Agent", "WebFetch", "WebSearch", "mcp__*"
    ]
  }
}
SEOF
  ok "settings.json"
else
  ok "settings.json (exists — kept)"
fi

dim "Writing ~/.claude/CLAUDE.md"
cat > "$HOME_DIR/.claude/CLAUDE.md" << 'CEOF'
# CLAUDE.md — wikiTaTa Universal Bootstrap
# This file loads for every session, regardless of repo or user.
# All user-specific config is loaded from Supabase via wt_session_start.

## RULE 0 — SESSION START SOP (mandatory, no exceptions)

1. Call wt_session_start({ project: "[current repo name or 'general']" })
   This returns your identity, session ID, prime directive, messages,
   card index, safety rules, and your personal CLAUDE.md config.
   Follow your CLAUDE.md card as primary config for the session.

2. State: PRIME DIRECTIVE + card count + any messages.

3. On-demand card loading only:
     wt_card_t2     — key-points when topic comes up
     wt_card_read   — full content when actively working
     wt_card_search — find cards by keyword

4. End greeting with wt_autolink reminder.

## PERMANENT CONSTANTS

Supabase primary: onoujmfhlrhvcqzjniei
BLOCKED:          iswxpsrcudtsnzwmmpvx (never touch)

## UNIVERSAL RULES

- NEVER deploy without explicit user instruction
- NEVER use bare # comments in bash (zsh parse error)
- Safety rules from wt_session_start override everything
CEOF
ok "CLAUDE.md"

wait_for_enter

# ═══════════════════════════════════════════════════════════════════════════════
# STEP 7: Shell Tools + Environment
# ═══════════════════════════════════════════════════════════════════════════════

step_header "Shell Tools" "wt_autolink, wt_start, wt_end + environment variables"

ZSHRC="$HOME_DIR/.zshrc"
[ -f "$ZSHRC" ] || touch "$ZSHRC"

# Shell baseline
BASELINE_MARKER="# wt-baseline-configured"
if ! grep -q "$BASELINE_MARKER" "$ZSHRC" 2>/dev/null; then
  dim "Configuring zsh baseline..."
  cat >> "$ZSHRC" << 'ZEOF'

# wt-baseline-configured
HISTFILE=~/.zsh_history
HISTSIZE=50000
SAVEHIST=50000
setopt SHARE_HISTORY HIST_IGNORE_ALL_DUPS HIST_REDUCE_BLANKS
setopt AUTO_CD AUTO_PUSHD PUSHD_IGNORE_DUPS
setopt NO_CLOBBER CORRECT
autoload -Uz compinit && compinit -u
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'
autoload -Uz vcs_info
precmd() { vcs_info }
zstyle ':vcs_info:git:*' formats ' %F{yellow}(%b)%f'
setopt PROMPT_SUBST
PROMPT='%F{cyan}%1~%f${vcs_info_msg_0_} %F{white}$%f '
export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
export EDITOR="nano"
alias ll='ls -lahG'
alias gs='git status'
alias gd='git diff'
alias gl='git log --oneline -15'
alias gp='git push'
ZEOF
  ok "zsh baseline (history, completion, prompt, aliases)"
else
  ok "zsh baseline already configured"
fi

# Shell tools
SHELL_SCRIPT="$HOME_DIR/git/wikitata/shell-scripts/wikitata_env.sh"
if [ -f "$SHELL_SCRIPT" ]; then
  if ! grep -q "wikitata_env.sh" "$ZSHRC" 2>/dev/null; then
    echo "source $SHELL_SCRIPT 2>/dev/null" >> "$ZSHRC"
    ok "wikitata_env.sh added to .zshrc"
  else
    ok "wikitata_env.sh already in .zshrc"
  fi
else
  warn "Shell scripts not found — will be available after repo update"
fi

# Env vars
if ! grep -q "WT_ACTOR" "$ZSHRC" 2>/dev/null; then
  cat >> "$ZSHRC" << ENVEOF
export WT_ACTOR=$WT_USERNAME
export WT_SB_URL=https://onoujmfhlrhvcqzjniei.supabase.co
export WT_OUTPUT_DIR=~/Downloads/claude-output
ENVEOF
  mkdir -p "$HOME_DIR/Downloads/claude-output"
  ok "WT environment variables"
else
  ok "WT environment variables already set"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════════════════════════════════════

clear
printf '\n\n\n'
echo -e "  ${BAR}"
echo -e "  ${BD}wikiTaTa Developer Setup${RST}                          ${G}${BD}Complete${RST}"
echo -e "  ${BAR}"
printf '\n'

if [ "$ERRORS" -eq 0 ]; then
  echo -e "  ${G}${BD}All steps passed.${RST}"
else
  echo -e "  ${Y}${BD}$ERRORS issue(s) found${RST} — review the warnings above."
fi

if [ "$SKIPPED" -gt 0 ]; then
  dim "$SKIPPED step(s) were already done — skipped automatically."
fi

printf '\n'
echo -e "  ${BD}Files created:${RST}"
dim "  ~/.claude/.mcp.json        Supabase + wikiTaTa MCP"
dim "  ~/.claude/settings.json    Tool permissions"
dim "  ~/.claude/CLAUDE.md        Universal bootstrap"

printf '\n'
echo -e "  ${BAR}"
printf '\n'
echo -e "  ${BD}What to do now:${RST}"
printf '\n'
echo -e "  ${BD}1.${RST} Open a ${BD}new terminal${RST} window"
echo -e "  ${BD}2.${RST} Type:  ${C}${BD}claude${RST}"
echo -e "  ${BD}3.${RST} Say:   ${C}${BD}start session sop${RST}"
printf '\n'
echo -e "  Claude will know who you are: ${G}${BD}$WT_USERNAME${RST}"
printf '\n'
echo -e "  ${BAR}"
printf '\n'

# Open browser back to completion page
open "https://catmarvin.github.io/start-wikitata/?done=1" 2>/dev/null
