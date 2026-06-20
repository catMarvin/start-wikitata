#!/usr/bin/env bash
# wt-superuser-install.sh — ONE-SHOT superuser machine install.
#
# Tier 1 (full dev env + superuser identity) is fully automated below. Tier 2
# (the elevated keychain secrets) is VAULT-GATED BY DESIGN — a script can't
# securely self-provision a fresh machine's secrets; that's the whole point of the
# vault gate. So this script does everything scriptable, then hands the final
# injection to your superuser Claude session (one sentence). Canon: card a0440173.
#
# Run on the new Mac (start.wikitata.com domain is mid-migration; use the
# project alias until it is repointed):
#   bash <(curl -fsSL https://start-wikitata-olive.vercel.app/wt-superuser-install.sh) [username]
# (defaults username to "todd"; override the source with WT_INSTALL_BASE=...)
set -euo pipefail
WT_USERNAME="${1:-todd}"
BASE="${WT_INSTALL_BASE:-https://start-wikitata-olive.vercel.app}"

echo "════════════════════════════════════════════════════════════"
echo "  wikiTaTa SUPERUSER install — $WT_USERNAME"
echo "════════════════════════════════════════════════════════════"
echo "Tier 1: full dev env (Node · Claude Code · Supabase/Vercel CLIs · MCP · repos)"
echo "        + superuser identity on the platform plane (onoujm)."
echo ""

# Tier 1 — the full installer, pinned to the superuser plane.
WT_PLANE=super WT_USERNAME="$WT_USERNAME" bash <(curl -fsSL "$BASE/setup.sh")

echo ""
echo "── Tier 2: full-power keychain check ─────────────────────────"
BOOT="$HOME/.local/bin/wt-superuser-bootstrap"
if [ ! -x "$BOOT" ]; then
  curl -fsSL "$BASE/wt-superuser-bootstrap" -o "$BOOT" 2>/dev/null && chmod +x "$BOOT" || true
fi
[ -x "$BOOT" ] && "$BOOT" || echo "(bootstrap helper unavailable — fetch later from $BASE/wt-superuser-bootstrap)"

cat <<'DONE'

════════════════════════════════════════════════════════════
  FINISH full superuser power — one step (then done):
════════════════════════════════════════════════════════════
  1. Quit + reopen Claude Code (it now starts as your superuser).
  2. In that Claude session, say:
        "bootstrap my superuser keychain secrets"
     → Claude injects the missing secrets from YOUR vault into this
       machine's keychain (zero-plaintext, vault→keychain). The vault is
       the gate — that is exactly why this last step is not scripted.
  3. Quit + reopen Claude Code once more → full superuser power.

  Reads/session-start work after step 1; writes/vault/deploys after step 3.
════════════════════════════════════════════════════════════
DONE
