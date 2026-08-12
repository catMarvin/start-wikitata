#!/usr/bin/env node
// wt-seat-verify.mjs — comprehensive per-seat wikiTaTa integrity verifier (S783, cards 5e1be05e / f4022b86).
// Runs on ANY seat (Dome/Q/Todd). Verifies EFFECT + provisioning, not just presence, and prints a
// PASS/WARN/FAIL table. Never echoes a secret value (presence + length only). Exit 0 iff no FAIL.
//   node wt-seat-verify.mjs
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const H = homedir();
const HOOKS = `${H}/.claude/hooks`;
const R = [];
const add = (name, status, detail = '') => { R.push({ name, status, detail }); };
// the golden fetch must ignore any crosswired shell WT_SB_* (the 401 bug, card f4022b86 #5)
const cleanEnv = { ...process.env }; delete cleanEnv.WT_SB_KEY; delete cleanEnv.WT_SB_URL;
const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', timeout: 25000, ...opts });

// ── 1. Golden bundle: signature (fail-closed) + on-disk parity ──────────────
{
  const b = run('node', [`${H}/.claude/bootstrap/wt-golden-bootstrap.mjs`], { env: cleanEnv });
  const out = (b.stdout || '') + (b.stderr || '');
  const ver = (out.match(/golden v(\d+)/) || [])[1] || '?';
  add('golden.signature', /signature OK/.test(out) ? 'PASS' : 'FAIL', `v${ver}`);
  add('golden.parity', /status=parity/.test(out) ? 'PASS' : 'WARN',
    /status=parity/.test(out) ? `v${ver}` : `behind — re-apply bootstrap --apply`);
  add('golden.class', (out.match(/class=(\w+)/) || [])[1] ? 'INFO' : 'WARN', (out.match(/class=(\w+)/) || [])[1] || 'unknown');
}

// ── 2. Every wired hook EXECUTES (0 FAIL) — invoke live with a synthetic payload ──
{
  const SETTINGS = `${H}/.claude/settings.json`;
  if (!existsSync(SETTINGS)) { add('hooks.execute', 'FAIL', 'no settings.json'); }
  else {
    const cfg = JSON.parse(readFileSync(SETTINGS, 'utf8'));
    const payloads = {
      UserPromptSubmit: { hook_event_name: 'UserPromptSubmit', prompt: 'seatverify', cwd: H, session_id: 'seatverify' },
      Stop: { hook_event_name: 'Stop', stop_hook_active: false, cwd: H, session_id: 'seatverify' },
      PreToolUse: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: H, session_id: 'seatverify' },
      PostToolUse: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo ok' }, tool_response: { stdout: 'ok' }, cwd: H, session_id: 'seatverify' },
      SessionStart: { hook_event_name: 'SessionStart', source: 'startup', cwd: H, session_id: 'seatverify' },
    };
    const CRASH = /(\n\s+at\s|Error:|SyntaxError|ReferenceError|TypeError|command not found|ENOENT|Cannot find module)/;
    let ok = 0, blocked = 0, fail = 0; const bad = [];
    for (const [event, groups] of Object.entries(cfg.hooks || {})) {
      for (const g of (groups || [])) for (const h of (g.hooks || [])) {
        const parts = (h.command || '').trim().split(/\s+/); const bin = parts[0];
        const file = parts[1] && parts[1].replace(/^["']|["']$/g, '');
        if (file && file.startsWith('/') && !existsSync(file)) { fail++; bad.push(`${file.split('/').pop()}:MISSING`); continue; }
        // the SessionStart bootstrap does a live signed-fetch — its output is validated in §1, not here
        if ((file || '').endsWith('wt-golden-bootstrap.mjs')) { ok++; continue; }
        const r = run(bin, parts.slice(1), { input: JSON.stringify(payloads[event] || { hook_event_name: event, cwd: H }) });
        const err = (r.stderr || '') + (r.error ? String(r.error) : '');
        if (r.status === null || (r.status !== 2 && CRASH.test(err))) { fail++; bad.push(`${(file||bin).split('/').pop()}:${r.status===null?'TIMEOUT':'CRASH'}`); }
        else if (r.status === 2) blocked++; else ok++;
      }
    }
    add('hooks.execute', fail === 0 ? 'PASS' : 'FAIL', `${ok} ok · ${blocked} guard-block · ${fail} FAIL${bad.length ? ' — ' + bad.join(', ') : ''}`);
  }
}

// ── 3. Guard EFFECT — a real guard must BLOCK a real trip (not just run) ─────
{
  // secret-redact-guard.sh: `cat ~/.env.local` must exit 2
  const sr = run('bash', [`${HOOKS}/secret-redact-guard.sh`], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat ~/.env.local' } }) });
  add('effect.secret-redact', sr.status === 2 ? 'PASS' : 'FAIL', sr.status === 2 ? 'blocks secret read' : `exit=${sr.status} (expected 2)`);

  // forbidden-asks.sh (the revived jq guard): a forbidden ask must emit {"decision":"block"}
  if (existsSync(`${HOOKS}/forbidden-asks.sh`)) {
    const tx = join(mkdtempSync(join(tmpdir(), 'seatv-')), 't.jsonl');
    writeFileSync(tx, [
      JSON.stringify({ type: 'user', message: { content: 'x' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'do you want me to proceed with the deploy?' }] } }),
    ].join('\n') + '\n');
    const fa = run('bash', [`${HOOKS}/forbidden-asks.sh`], { input: JSON.stringify({ transcript_path: tx, session_id: 'seatverify' }), env: { ...process.env, WT_FORBIDDEN_MODE: 'block' } });
    const blocked = /"decision"\s*:\s*"block"/.test(fa.stdout || '');
    add('effect.forbidden-asks', blocked ? 'PASS' : 'FAIL', blocked ? 'jq-revive verified (blocks a forbidden ask)' : 'DEAD — did not block (jq -sr regression?)');
  }
}

// ── 4. Env hygiene — the 401 crosswiring bug must be absent ──────────────────
{
  const rcs = ['.zshrc', '.zprofile', '.bashrc', '.profile'].map(f => `${H}/${f}`).filter(existsSync);
  let live = 0;
  for (const rc of rcs) for (const ln of readFileSync(rc, 'utf8').split('\n'))
    if (/^\s*export\s+WT_SB_(KEY|URL)=/.test(ln)) live++;   // count only, never print the value
  // ALSO check the running process env — a WT_SB_* set by any path (rc, sourced file, launchd, MCP)
  // crosswires the golden fetch (the 401 Dome hit). The v11 bootstrap self-cleans, but flag the source.
  const procVars = ['WT_SB_KEY', 'WT_SB_URL'].filter(v => process.env[v]);
  const bad = live + procVars.length;
  add('env.no-crosswiring', bad === 0 ? 'PASS' : 'WARN',
    bad === 0 ? 'no WT_SB_* export or process var'
      : `${live} rc export(s)${procVars.length ? ' + process: ' + procVars.join(',') : ''} — v11 bootstrap self-cleans, but find+remove the source`);
}

// ── 5. wt-guard secret provisioning (env → .env → keychain) — presence only ──
{
  const envSet = !!(process.env.SUPABASE_SECRET_KEY || process.env.WT_SB_KEY);
  const dotenv = existsSync(`${H}/.claude/wt-guard/.env`);
  let keychain = false;
  try { keychain = !!execFileSync('security', ['find-generic-password', '-a', process.env.USER || '', '-s', 'wikitata-guard-secret', '-w'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  const has = envSet || dotenv || keychain;
  add('wt-guard.secret', has ? 'PASS' : 'WARN',
    has ? `via ${[envSet && 'env', dotenv && '.env', keychain && 'keychain'].filter(Boolean).join('+')}` : 'absent — wt-guard audit inert (provision via keychain wikitata-guard-secret)');
}

// ── report ──────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\n═══ wikiTaTa seat integrity — ${process.env.USER || 'user'}@${run('hostname', []).stdout?.trim() || '?'} ═══\n`);
console.log(pad('CHECK', 26) + pad('STATUS', 8) + 'DETAIL');
for (const r of R) console.log(pad(r.name, 26) + pad(r.status, 8) + r.detail);
const fails = R.filter(r => r.status === 'FAIL').length;
const warns = R.filter(r => r.status === 'WARN').length;
console.log(`\nSUMMARY: ${R.filter(r => r.status === 'PASS').length} pass · ${warns} warn · ${fails} FAIL`);
process.exit(fails > 0 ? 1 : 0);
