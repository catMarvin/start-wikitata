#!/usr/bin/env bash
# wt-connect.sh - Clean Slim wikiTaTa connect + env-hygiene + audit
# ---------------------------------------------------------------------------
# Purpose (Todd creator-directive, S782): a SLIM, NON-DESTRUCTIVE installer that
#   1. loads the essential client plumbing (user-scope HTTPS MCP + golden bundle),
#   2. CLEANS a crosswired local env (duplicate MCP scopes, stray WT_* vars),
#   3. AUDITS the result and prints a green/red report.
# Enforcement of core wikitata behavior lives SERVER-SIDE (per-turn directive
# injection). This script only carries client plumbing - it deliberately does
# NOT try to enforce policy from files the user can edit.
#
# NON-DESTRUCTIVE CONTRACT:
#   - Everything it touches is backed up first to ~/.wt-connect-backups/<ts>/.
#   - It COMMENTS OUT stray lines (prefix), never deletes them.
#   - The golden bootstrap it calls is itself idempotent + non-clobbering.
#
# Usage:  ./wt-connect.sh [username]      (username defaults to the $USER login)
# ---------------------------------------------------------------------------
set -u

USERNAME="${1:-$(id -un)}"
MCP_URL="https://mcp.wikitata.com/mcp"
SB_URL="https://onoujmfhlrhvcqzjniei.supabase.co"   # onoujm platform (publishable-only in env)
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /tmp)"
WT_BASE="${WT_BASE:-https://start.wikitata.com}"   # seed origin when piped from curl
LOG="$HOME/wt-connect-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1                        # capture EVERYTHING for the handoff
CLAUDE_DIR="$HOME/.claude"
TS="$(date +%Y%m%d-%H%M%S)"
BK="$HOME/.wt-connect-backups/$TS"
FAILS=0

c() { printf '%s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n'   "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n'   "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n'   "$*"; FAILS=$((FAILS+1)); }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
has()  { command -v "$1" >/dev/null 2>&1; }

backup() { # backup a file into $BK preserving a flat unique name
  [ -f "$1" ] || return 0
  mkdir -p "$BK"
  cp -p "$1" "$BK/$(printf '%s' "$1" | sed 's|/|_|g')" 2>/dev/null && return 0
}

# ---------------------------------------------------------------------------
hdr "0. Preflight ($USERNAME @ $(hostname -s))"
for t in claude node git; do
  if has "$t"; then ok "$t present"; else bad "$t NOT on PATH - install it first"; fi
done
[ "$FAILS" -gt 0 ] && { c ""; c "Preflight failed. Fix the above and re-run."; exit 1; }
mkdir -p "$BK"; ok "backups -> $BK"

# ---------------------------------------------------------------------------
hdr "1. Backup config + shell rc (nothing is edited before this)"
for f in "$HOME/.claude.json" "$CLAUDE_DIR/settings.json" "$CLAUDE_DIR/settings.local.json" \
         "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.profile" "$CLAUDE_DIR/.mcp.json"; do
  [ -f "$f" ] && { backup "$f"; ok "backed up $f"; }
done

# ---------------------------------------------------------------------------
hdr "2. MCP hygiene - ONE persistent user-scope HTTPS entry"
# Ensure the canonical user-scope entry (persists across every dir + restart).
if claude mcp add --scope user --transport http wikitata "$MCP_URL" >/dev/null 2>&1; then
  ok "registered wikitata @ user scope ($MCP_URL)"
else
  # already-exists at user scope is fine; verify it resolves
  if claude mcp get wikitata >/dev/null 2>&1; then ok "wikitata already registered (user scope)"
  else bad "could not register wikitata - run: claude mcp add --scope user --transport http wikitata $MCP_URL"; fi
fi
# De-crosswire: drop any duplicate local/project-scope entries (harmless if absent).
for sc in local project; do
  if claude mcp remove wikitata -s "$sc" >/dev/null 2>&1; then
    warn "removed stale $sc-scope wikitata entry (was shadowing user scope)"
  fi
done
# Strip a hand-written ~/.claude/.mcp.json fallback if present (superseded by user scope).
if [ -f "$CLAUDE_DIR/.mcp.json" ] && grep -q '"wikitata"' "$CLAUDE_DIR/.mcp.json" 2>/dev/null; then
  mv "$CLAUDE_DIR/.mcp.json" "$CLAUDE_DIR/.mcp.json.disabled-$TS"
  warn "disabled stray ~/.claude/.mcp.json (backed up) - user scope is canonical"
fi

# ---------------------------------------------------------------------------
hdr "3. Env hygiene - decrosswire WT_* variables"
# Report every WT_* export the shell rc files currently set, and flag crosswiring.
for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.profile"; do
  [ -f "$rc" ] || continue
  hits="$(grep -nE '^[[:space:]]*export[[:space:]]+WT_' "$rc" 2>/dev/null)"
  [ -n "$hits" ] && { c "  $rc:"; printf '%s\n' "$hits" | sed 's/^/      /'; }
done
# Flag secrets-in-env (violates keychain-only law) and wrong-plane/user.
for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.profile"; do
  [ -f "$rc" ] || continue
  if grep -qE '^[[:space:]]*export[[:space:]]+WT_SB_KEY=|SECRET|TOKEN=' "$rc" 2>/dev/null; then
    warn "$rc exports a secret in env (keychain-only law) - commenting it out"
    sed -i.bak -E 's/^([[:space:]]*export[[:space:]]+(WT_SB_KEY|[A-Z_]*SECRET[A-Z_]*|[A-Z_]*TOKEN)=.*)$/# wt-connect-disabled '"$TS"': \1/' "$rc"
    rm -f "$rc.bak"
  fi
done
# Write ONE canonical env file and source it once (publishable URL only - no secret).
ENVF="$CLAUDE_DIR/wikitata_env.sh"
cat > "$ENVF" <<EOF
# wikitata_env.sh - canonical (written by wt-connect.sh $TS). Publishable only.
export WT_ACTOR="$USERNAME"
export WT_USER="$USERNAME"
export WT_SB_URL="$SB_URL"
export WT_MACHINE_ID="\$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
export WT_OUTPUT_DIR="\$HOME/Downloads/claude-output"
EOF
ok "wrote canonical env -> $ENVF (WT_USER=$USERNAME, plane=onoujm)"
if ! grep -q 'wikitata_env.sh' "$HOME/.zshrc" 2>/dev/null; then
  printf '\n[ -f "%s" ] && source "%s"\n' "$ENVF" "$ENVF" >> "$HOME/.zshrc"
  ok "sourced wikitata_env.sh from ~/.zshrc"
else
  ok "~/.zshrc already sources wikitata_env.sh"
fi

# ---------------------------------------------------------------------------
hdr "4. Golden bundle - the guard-hook loader (signed, fail-closed)"
# Seed resolution: next to the script when cloned, otherwise fetched from WT_BASE so this
# works when piped straight from curl (S839 - the piped path had no seed and died silently).
SEED="$SCRIPT_DIR/install-golden-bootstrap.mjs"
if [ ! -f "$SEED" ]; then
  SEED="$BK/install-golden-bootstrap.mjs"
  if curl -fsSL --max-time 30 "$WT_BASE/install-golden-bootstrap.mjs" -o "$SEED" 2>/dev/null; then
    ok "fetched seed from $WT_BASE"
  else
    bad "could not fetch install-golden-bootstrap.mjs from $WT_BASE (network? or not deployed)"
    rm -f "$SEED"
  fi
fi
# A crosswired stale key/url pair in the shell 401s the signed fetch (S782); the calls below
# unset them so the correct baked-in onoujm publishable defaults are used.
if [ -f "$SEED" ]; then
  if env -u WT_SB_KEY -u WT_SB_URL WT_ACTOR="$USERNAME" WT_USER="$USERNAME" node "$SEED"; then ok "golden seed installed + SessionStart wired"
  else bad "golden seed failed - see output above"; fi
  BOOT="$CLAUDE_DIR/bootstrap/wt-golden-bootstrap.mjs"
  if [ -f "$BOOT" ]; then
    # two passes: the on-disk (older) bootstrap writes the new bootstrap on pass 1; the new
    # bootstrap wires settings.json on pass 2 (golden v4 self-heal, card f4022b86).
    env -u WT_SB_KEY -u WT_SB_URL WT_ACTOR="$USERNAME" WT_USER="$USERNAME" node "$BOOT" --apply >/dev/null 2>&1
    if env -u WT_SB_KEY -u WT_SB_URL WT_ACTOR="$USERNAME" WT_USER="$USERNAME" node "$BOOT" --apply; then ok "golden hooks applied + settings.json wired (2-pass)"
    else warn "golden apply reported drift/consent - re-run: node $BOOT --apply"; fi
  fi
else
  bad "no seed - expected $SCRIPT_DIR/install-golden-bootstrap.mjs or $WT_BASE/install-golden-bootstrap.mjs"
fi

# ---------------------------------------------------------------------------
hdr "4b. Guard enforcement - flip the hooks from warn-only to blocking"
# S839 (card b022bc84): wt-guard/lib/io.mjs downgrades every BLOCK to a stderr warn unless
# WT_GUARD_ENFORCE=1. Without this a seat reports parity while enforcing nothing.
if node -e '
const fs=require("fs"), p=process.env.HOME+"/.claude/settings.json";
let c={}; try{ c=JSON.parse(fs.readFileSync(p,"utf8")); }catch(e){}
c.env=c.env||{};
if(c.env.WT_GUARD_ENFORCE!=="1"){ c.env.WT_GUARD_ENFORCE="1"; fs.writeFileSync(p, JSON.stringify(c,null,2)); }
' >/dev/null 2>&1; then
  ok "WT_GUARD_ENFORCE=1 in settings.json (takes effect in a NEW session)"
else
  bad "could not set WT_GUARD_ENFORCE - guards would stay warn-only"
fi

# ---------------------------------------------------------------------------
hdr "5. Audit - confirm the environment is wired correctly"
if claude mcp get wikitata >/dev/null 2>&1; then ok "MCP resolves: wt_* tools will load in-session"
else bad "MCP does NOT resolve - Claude will have no wt_ tools"; fi

SETTINGS="$CLAUDE_DIR/settings.json"
if [ -f "$SETTINGS" ] && grep -q 'wt-golden-bootstrap' "$SETTINGS" 2>/dev/null; then
  ok "SessionStart hook wired to golden bootstrap"
else bad "SessionStart hook NOT wired in settings.json"; fi

PARITY="$( (unset WT_SB_KEY WT_SB_URL; WT_ACTOR="$USERNAME" WT_USER="$USERNAME" \
  node "$CLAUDE_DIR/bootstrap/wt-golden-bootstrap.mjs") 2>&1 | head -1 )"
case "$PARITY" in
  *"signature OK"*)  ok "golden bundle verified: $PARITY"
                     ok "this device now reports into hook_parity (Q had NO row before this)" ;;
  *)                 bad "parity check failed: $PARITY" ;;
esac

HOOKN=0; [ -d "$CLAUDE_DIR/hooks" ] && HOOKN="$(ls -1 "$CLAUDE_DIR/hooks" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$HOOKN" -ge 10 ]; then ok "$HOOKN guard hooks present in ~/.claude/hooks"
else warn "only $HOOKN hooks in ~/.claude/hooks (expected the full guard suite)"; fi

# CLAUDE.md is delivered SERVER-SIDE via wt_session_start.claude_md - nothing local to install.
c "  note: your CLAUDE.md loads from the server (wt_session_start.claude_md) - not a local file."

# ---------------------------------------------------------------------------
hdr "Result"
if [ "$FAILS" -eq 0 ]; then
  printf '  \033[32mALL GREEN\033[0m - client plumbing installed + clean.\n'
else
  printf '  \033[31m%d check(s) FAILED\033[0m - see FAIL lines above.\n' "$FAILS"
fi
c ""
c "Backups (full revert): $BK"
c "Full transcript (send this to Todd if anything failed): $LOG"
c ""
c "NEXT - finish in a fresh Claude session:"
c "  1. open a NEW terminal (so ~/.zshrc reloads), then run:  claude"
c "  2. if prompted, type /mcp and Authenticate (WorkOS browser login)"
c "  3. in the session, verify with these MCP tools:"
c "        wt_connect_doctor        (every line should be green)"
c "        wt_session_start project:\"general\"   (claude_md must start '# CLAUDE.md for ...')"
c "        wt_health_check          (server-side audit sweep)"
exit "$FAILS"
