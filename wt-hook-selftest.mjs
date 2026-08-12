#!/usr/bin/env node
// wt-hook-selftest.mjs (card f4022b86) — VERIFY, don't assume. Invokes EVERY hook wired in
// ~/.claude/settings.json with a synthetic payload for its event, and reports whether each
// actually executes: OK (clean exit) / BLOCK (exit 2 decision — a working guard) / FAIL (crash,
// stack trace, missing file, ENOENT, or timeout). Also runs the golden bootstrap in report mode.
//   node wt-hook-selftest.mjs
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

// use the correct baked defaults even if the shell crosswires these (the 401 bug)
delete process.env.WT_SB_KEY; delete process.env.WT_SB_URL;

const H = homedir();
const SETTINGS = `${H}/.claude/settings.json`;
if (!existsSync(SETTINGS)) { console.error("no ~/.claude/settings.json"); process.exit(2); }
const cfg = JSON.parse(readFileSync(SETTINGS, "utf8"));

const payloads = {
  UserPromptSubmit: { hook_event_name: "UserPromptSubmit", prompt: "selftest ping", cwd: H, session_id: "selftest" },
  Stop:             { hook_event_name: "Stop", stop_hook_active: false, cwd: H, session_id: "selftest" },
  PreToolUse:       { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo selftest" }, cwd: H, session_id: "selftest" },
  PostToolUse:      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo selftest" }, tool_response: { stdout: "ok" }, cwd: H, session_id: "selftest" },
  SessionStart:     { hook_event_name: "SessionStart", source: "startup", cwd: H, session_id: "selftest" },
};
const CRASH = /(\n\s+at\s|Error:|SyntaxError|ReferenceError|TypeError|command not found|ENOENT|Traceback \(|Cannot find module)/;

const rows = []; let ok = 0, blocked = 0, crash = 0;
for (const [event, groups] of Object.entries(cfg.hooks || {})) {
  for (const g of (groups || [])) {
    for (const h of (g.hooks || [])) {
      const cmd = (h.command || "").trim();
      const base = cmd.split("/").pop();
      const parts = cmd.split(/\s+/);
      const bin = parts[0];
      const args = parts.slice(1);
      const file = args[0] && args[0].replace(/^["']|["']$/g, "");
      if (file && file.startsWith("/") && !existsSync(file)) { rows.push([event, base, "MISSING FILE", "FAIL"]); crash++; continue; }
      const payload = JSON.stringify(payloads[event] || { hook_event_name: event, cwd: H });
      const r = spawnSync(bin, args, { input: payload, timeout: 20000, encoding: "utf8" });
      const errtxt = (r.stderr || "") + (r.error ? String(r.error) : "");
      const timedOut = r.status === null;
      const crashed = timedOut || (r.status !== 2 && CRASH.test(errtxt));
      let status;
      if (crashed) { status = "FAIL"; crash++; }
      else if (r.status === 2) { status = "BLOCK(ok)"; blocked++; }
      else { status = "OK"; ok++; }
      rows.push([event, base, timedOut ? "TIMEOUT" : ("exit=" + r.status), status, crashed ? errtxt.replace(/\n/g, " ").slice(0, 140) : ""]);
    }
  }
}

console.log("═══ wikiTaTa hook self-test — every wired hook invoked live ═══\n");
const w = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(w("EVENT", 17) + w("HOOK", 30) + w("RESULT", 10) + "STATUS");
for (const r of rows) console.log(w(r[0], 17) + w(r[1], 30) + w(r[2], 10) + r[3] + (r[4] ? "  :: " + r[4] : ""));
console.log(`\nSUMMARY: ${ok} OK · ${blocked} guard-blocks-work · ${crash} FAIL   (total ${rows.length})`);

console.log("\n─ golden bootstrap (report mode: signature + parity) ─");
const b = spawnSync("node", [`${H}/.claude/bootstrap/wt-golden-bootstrap.mjs`], { encoding: "utf8", timeout: 25000 });
console.log(((b.stdout || "") + (b.stderr || "")).trim() || "(no output)");

process.exit(crash > 0 ? 1 : 0);
