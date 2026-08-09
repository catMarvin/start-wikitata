#!/usr/bin/env node
// install-golden-bootstrap.mjs — the ONE-TIME onboarding SEED (card 2aae217c, Part B).
// Installs the self-healing config bootstrap + wires it as a SessionStart hook so every future
// session auto-checks parity against the signed golden bundle. Idempotent; never clobbers other hooks.
// The bootstrap itself is fetched from the signed golden bundle (single canonical source, hash+sig verified).
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const PINNED_PUBLIC_KEY_B64 = "evwYUjg2dN326mRE9kp46DrmL2TcIrzsenZyPM0lcBw=";
const SB_URL = process.env.WT_SB_URL || "https://onoujmfhlrhvcqzjniei.supabase.co";
const SB_KEY = process.env.WT_SB_KEY || "sb_publishable_dgNg9YFvNEDlvC4qXPrJcg_4uEtEQUT";
const CALLER = process.env.WT_ACTOR || process.env.WT_USER || "todd";
const CLAUDE_DIR = `${homedir()}/.claude`;
const BOOT_PATH = "bootstrap/wt-golden-bootstrap.mjs";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function verifySig(manifest, sig_b64) {
  if (!sig_b64) return false;
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(PINNED_PUBLIC_KEY_B64, "base64")]);
  return edVerify(null, Buffer.from(manifest, "utf8"), createPublicKey({ key: der, format: "der", type: "spki" }), Buffer.from(sig_b64, "base64"));
}

const r = await fetch(`${SB_URL}/rest/v1/rpc/wt_hook_bundle_current`, {
  method: "POST",
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json",
             "Content-Profile": "wikitata", "Accept-Profile": "wikitata" },
  body: JSON.stringify({ p_caller: CALLER }),
});
if (!r.ok) { console.error(`fetch golden failed: ${r.status} ${await r.text()}`); process.exit(1); }
const bundle = await r.json();
if (!bundle.ok || !bundle.live) { console.error("no live golden bundle"); process.exit(1); }
if (!verifySig(bundle.manifest_sha256, bundle.signature)) {
  console.error("⛔ golden bundle signature INVALID — refusing to install (fail-closed)."); process.exit(2);
}

const boot = bundle.files.find((f) => f.path === BOOT_PATH);
if (!boot) { console.error(`bundle has no ${BOOT_PATH}`); process.exit(1); }
if (sha256(Buffer.from(boot.content)) !== boot.sha256) { console.error("bootstrap content hash mismatch"); process.exit(2); }

// 1) write the bootstrap
const dst = `${CLAUDE_DIR}/${BOOT_PATH}`;
mkdirSync(dirname(dst), { recursive: true });
writeFileSync(dst, boot.content);
console.log(`✓ installed ${dst}`);

// 2) wire the SessionStart hook (idempotent, non-clobbering)
const sp = `${CLAUDE_DIR}/settings.json`;
const cfg = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf8")) : {};
cfg.hooks ??= {};
cfg.hooks.SessionStart ??= [];
const CMD = "node ~/.claude/bootstrap/wt-golden-bootstrap.mjs";
const already = JSON.stringify(cfg.hooks.SessionStart).includes("wt-golden-bootstrap");
if (already) {
  console.log("✓ SessionStart hook already wired — no change.");
} else {
  cfg.hooks.SessionStart.push({ hooks: [{ type: "command", command: CMD }] });
  writeFileSync(sp, JSON.stringify(cfg, null, 2));
  console.log("✓ wired SessionStart hook -> golden-bootstrap (report mode each session)");
}
console.log(`\n✅ seed installed. Golden bundle v${bundle.version} will be parity-checked every session start.`);
console.log("   Drift surfaces at session start; apply on consent: node ~/.claude/bootstrap/wt-golden-bootstrap.mjs --apply");
