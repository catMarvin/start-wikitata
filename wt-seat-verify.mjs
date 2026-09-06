#!/usr/bin/env node
// wt-seat-verify.mjs — the ONE per-seat wikiTaTa integrity audit (S783 cards 5e1be05e / f4022b86;
// S878 comprehensive rewrite, task ae4da44a). Runs on ANY seat (Dome/Q/Todd), as the seat's own user.
//
// WHAT IT ANSWERS, so nobody finds out 63 days later that a stray file was overriding the system:
//   1. IDENTITY   who this seat reports as (env / .cacp-user / device-id) vs who it is expected to be
//   2. GOLDEN     signed bundle status on disk (parity / behind / legacy bootstrap), what drifts
//   3. HOOKS      every wired hook executes; guards actually BLOCK; enforce flag; extra/.off/local overrides
//   4. MCP        which MCP servers Claude Code will load; wikitata reachable; permission denies on wt_ tools
//   5. INSTRUCTIONS  every CLAUDE.md / rules / commands / skills / agents / memory file Claude reads,
//                    scanned for instructions that subvert the card system ("write local markdown instead")
//   6. REPOS      every git checkout under the seat: CLAUDE.md, .claude/settings*, .mcp.json, .env* (names),
//                 local-ledger markdown (HANDOFF/NOTES/SESSION*.md, docs/sessions, .claude/*.md) — the evasion
//   7. KEYCHAIN   expected wikiTaTa items present (NAMES + presence only, never values)
//   8. ENV        rc-file exports of WT_/SUPABASE_/CLAUDE_/ANTHROPIC_ (names), launchd EnvironmentVariables keys
//   9. CACP/COORD live probe: directive-poll token accepted? coord-heartbeat blocked by gate-principal?
//  10. WRITE PATHS  real writes to the server, so the DB (not the seat) is the witness:
//                 wt_hook_parity_report (via bootstrap), wt_instruction_parity_report (per repo, --submit),
//                 wt_seat_audit_submit (full audit → wikitata.machine_boot_audit, needs the seat's API key)
//
// Never echoes a secret value (presence + length only). Every section is fault-isolated.
//   node wt-seat-verify.mjs [--user <wikitata-username>] [--json] [--submit] [--out <file>]
//                           [--root <dir> ...] [--fix-identity] [--apply-golden] [--enforce-cards-first]
// Exit 0 iff no FAIL.
import { readFileSync, existsSync, writeFileSync, mkdtempSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { homedir, tmpdir, hostname, userInfo } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const opts = (f) => argv.map((a, i) => (a === f ? argv[i + 1] : null)).filter(Boolean);
const JSON_OUT = flag('--json'), SUBMIT = flag('--submit');

const H = homedir();
const CLAUDE_DIR = `${H}/.claude`;
const HOOKS = `${CLAUDE_DIR}/hooks`;
const R = [];
const audit = { schema: 'wt-seat-verify/2', captured_at: new Date().toISOString() };
const add = (name, status, detail = '') => { R.push({ name, status, detail: String(detail).slice(0, 400) }); };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sha12 = (s) => sha(s).slice(0, 12);
// the golden fetch must ignore any crosswired shell WT_SB_* (the 401 bug, card f4022b86 #5)
const cleanEnv = { ...process.env }; delete cleanEnv.WT_SB_KEY; delete cleanEnv.WT_SB_URL;
const run = (bin, args, o = {}) => spawnSync(bin, args, { encoding: 'utf8', timeout: 25000, ...o });
const section = (name, fn) => { try { return fn(); } catch (e) { add(`${name}.error`, 'WARN', String(e && e.message || e).slice(0, 200)); audit[name] = { error: String(e && e.message || e).slice(0, 300) }; } };
const REDACT = (s) => String(s)
  .replace(/(--[a-z-]*token[= ])[^\s]+/gi, '$1REDACTED')
  .replace(/\b(sbp|sb_secret|sb_publishable|sk|ghp|github_pat|wt|xoxb|xoxp)_[A-Za-z0-9_.-]+/g, '$1_REDACTED')
  .replace(/Bearer\s+[^\s"']+/g, 'Bearer REDACTED')
  .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, 'JWT_REDACTED')
  .replace(/([A-Z_]*(KEY|SECRET|TOKEN|PASSWORD|PASS)[A-Z_]*\s*[=:]\s*)[^\s,;"']+/g, '$1REDACTED');

// ── Supabase constants: parsed from the golden bootstrap (single source), never from shell env ──
function sbConstants() {
  const cands = [`${CLAUDE_DIR}/bootstrap/wt-golden-bootstrap.mjs`, join(dirname(new URL(import.meta.url).pathname), 'install-golden-bootstrap.mjs')];
  for (const p of cands) {
    if (!existsSync(p)) continue;
    const t = readFileSync(p, 'utf8');
    const u = (t.match(/const SB_URL\s*=\s*process\.env\.WT_SB_URL\s*\|\|\s*"([^"]+)"/) || [])[1];
    const k = (t.match(/const SB_KEY\s*=\s*process\.env\.WT_SB_KEY\s*\|\|\s*"([^"]+)"/) || [])[1];
    if (u && k) return { url: u, key: k, from: p };
  }
  return null;
}
const SB = sbConstants();
async function rpc(fn, body, { bearer = null, timeoutMs = 20000 } = {}) {
  if (!SB) throw new Error('no SB constants (golden bootstrap absent)');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${SB.url}/rest/v1/rpc/${fn}`, {
      method: 'POST', signal: ctl.signal,
      headers: { apikey: SB.key, Authorization: `Bearer ${bearer || SB.key}`, 'Content-Type': 'application/json', 'Content-Profile': 'wikitata', 'Accept-Profile': 'wikitata' },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 300) }; }
    return { http: r.status, body: j };
  } finally { clearTimeout(t); }
}

// ═══ 1. IDENTITY ════════════════════════════════════════════════════════════
const cacpUserFile = (() => { try { return readFileSync(`${HOOKS}/.cacp-user`, 'utf8').trim(); } catch { return null; } })();
const deviceIdFile = (() => { try { return readFileSync(`${CLAUDE_DIR}/.device-id`, 'utf8').trim(); } catch { return null; } })();
const EXPECTED = opt('--user') || process.env.WT_ACTOR || process.env.WT_USER || cacpUserFile || null;
section('identity', () => {
  const ver = run('claude', ['--version']); const claudeVer = (ver.stdout || '').trim().split('\n')[0] || 'not-on-PATH';
  audit.identity = {
    os_user: userInfo().username, hostname: hostname(), home: H, expected_user: EXPECTED,
    env_WT_USER: process.env.WT_USER || null, env_WT_ACTOR: process.env.WT_ACTOR || null,
    cacp_user_file: cacpUserFile, device_id_file: deviceIdFile, claude_version: claudeVer, node: process.version,
    os_class: process.platform,
  };
  if (!EXPECTED) add('identity.expected', 'FAIL', 'no wikiTaTa username resolvable (pass --user <name>; WT_USER/WT_ACTOR unset; ~/.claude/hooks/.cacp-user absent)');
  else add('identity.expected', 'INFO', `expected=${EXPECTED} · os_user=${userInfo().username} · host=${hostname()}`);
  const conflicts = [['env.WT_USER', process.env.WT_USER], ['env.WT_ACTOR', process.env.WT_ACTOR], ['.cacp-user', cacpUserFile]]
    .filter(([, v]) => v && EXPECTED && v !== EXPECTED);
  if (conflicts.length) add('identity.conflict', 'FAIL', `this seat would report as ${conflicts.map(([k, v]) => `${k}=${v}`).join(', ')} — expected ${EXPECTED}. Fix: --fix-identity (writes .cacp-user) and remove the env export`);
  else add('identity.conflict', 'PASS', 'every identity source agrees');
  if (!cacpUserFile) add('identity.cacp-user', 'FAIL', '~/.claude/hooks/.cacp-user ABSENT — cacp-poll/heartbeat/coord/bootstrap all fall back to env or skip; the seat is invisible to CACP');
  if (!deviceIdFile) add('identity.device-id', 'WARN', '~/.claude/.device-id absent — hook_parity keys by hostname (legacy bootstrap) or a fresh uuid each run');
  if (flag('--fix-identity') && EXPECTED && cacpUserFile !== EXPECTED) {
    mkdirSync(HOOKS, { recursive: true }); writeFileSync(`${HOOKS}/.cacp-user`, EXPECTED + '\n', { mode: 0o600 });
    add('identity.fixed', 'PASS', `.cacp-user := ${EXPECTED}`);
  }
});

// ═══ 2. GOLDEN BUNDLE ═══════════════════════════════════════════════════════
section('golden', () => {
  const bp = `${CLAUDE_DIR}/bootstrap/wt-golden-bootstrap.mjs`;
  if (!existsSync(bp)) { add('golden.bootstrap', 'FAIL', 'bootstrap ABSENT — run install-golden-bootstrap.mjs (wt-connect.sh step 4)'); audit.golden = { present: false }; return; }
  const src = readFileSync(bp, 'utf8');
  const legacy = !/\.device-id/.test(src) || /\|\|\s*"todd"/.test(src);
  const env = { ...cleanEnv }; if (EXPECTED) { env.WT_ACTOR = EXPECTED; env.WT_USER = EXPECTED; }
  const b = run('node', [bp], { env });
  const out = (b.stdout || '') + (b.stderr || '');
  const line = (out.match(/golden (\S+) · signature OK · class=(\w+) · status=(\w+)/) || []);
  const drift = [...out.matchAll(/^\s{3}(\S+) \[(\w+)\]$/gm)].map((m) => ({ path: m[1], criticality: m[2] }));
  audit.golden = { present: true, bootstrap_sha12: sha12(src), legacy_bootstrap: legacy, version: line[1] || null, class: line[2] || null, status: line[3] || null, drift, output: REDACT(out).slice(0, 1500) };
  add('golden.signature', /signature OK/.test(out) ? 'PASS' : 'FAIL', line[1] ? `golden ${line[1]}` : REDACT(out).split('\n')[0].slice(0, 200));
  add('golden.parity', line[3] === 'parity' && !drift.length ? 'PASS' : 'FAIL', line[3] === 'parity' && !drift.length ? `${line[1]} (class=${line[2]})` : `${line[3] || 'unknown'} — ${drift.length} file(s) drift${drift.length ? ': ' + drift.map((d) => `${d.path}[${d.criticality}]`).join(', ').slice(0, 250) : ''} — apply: node ~/.claude/bootstrap/wt-golden-bootstrap.mjs --apply`);
  if (legacy) add('golden.bootstrap-legacy', 'FAIL', `bootstrap on disk is a LEGACY build (sha ${sha12(src)}): hard-codes caller "todd" and/or keys hook_parity by hostname — every report from this seat is misattributed until --apply replaces it`);
  if (flag('--apply-golden')) {
    const a = run('node', [bp, '--apply'], { env, timeout: 90000 });
    const ao = (a.stdout || '') + (a.stderr || '');
    add('golden.applied', /✅ applied/.test(ao) ? 'PASS' : 'FAIL', REDACT(ao).split('\n').filter(Boolean).slice(-1)[0] || `exit=${a.status}`);
  }
});

// ═══ 3. HOOKS + LOCAL OVERRIDES ═════════════════════════════════════════════
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const settings = readJson(`${CLAUDE_DIR}/settings.json`);
const settingsLocal = readJson(`${CLAUDE_DIR}/settings.local.json`);
const claudeJson = readJson(`${H}/.claude.json`);
const hookCount = (cfg) => Object.values((cfg && cfg.hooks) || {}).reduce((n, groups) => n + (groups || []).reduce((m, g) => m + ((g.hooks || []).length), 0), 0);
section('hooks', () => {
  if (!settings) { add('hooks.settings', 'FAIL', '~/.claude/settings.json missing or unparsable — NO hooks run'); audit.hooks = { settings: false }; return; }
  const payloads = {
    UserPromptSubmit: { hook_event_name: 'UserPromptSubmit', prompt: 'seatverify', cwd: H, session_id: 'seatverify' },
    Stop: { hook_event_name: 'Stop', stop_hook_active: false, cwd: H, session_id: 'seatverify' },
    PreToolUse: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: H, session_id: 'seatverify' },
    PostToolUse: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo ok' }, tool_response: { stdout: 'ok' }, cwd: H, session_id: 'seatverify' },
    SessionStart: { hook_event_name: 'SessionStart', source: 'startup', cwd: H, session_id: 'seatverify' },
  };
  const CRASH = /(\n\s+at\s|Error:|SyntaxError|ReferenceError|TypeError|command not found|ENOENT|Cannot find module)/;
  let ok = 0, blocked = 0, fail = 0; const bad = []; const wiredFiles = new Set();
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const g of (groups || [])) for (const h of (g.hooks || [])) {
      const parts = (h.command || '').trim().split(/\s+/); const bin = parts[0];
      const file = parts[1] && parts[1].replace(/^["']|["']$/g, '');
      if (file) wiredFiles.add(file.replace(/^~/, H).replace(/^\$HOME/, H));
      if (file && file.startsWith('/') && !existsSync(file)) { fail++; bad.push(`${basename(file)}:MISSING`); continue; }
      if ((file || '').endsWith('wt-golden-bootstrap.mjs')) { ok++; continue; }   // validated in §2
      const r = run(bin, parts.slice(1), { input: JSON.stringify(payloads[event] || { hook_event_name: event, cwd: H }) });
      const err = (r.stderr || '') + (r.error ? String(r.error) : '');
      if (r.status === null || (r.status !== 2 && CRASH.test(err))) { fail++; bad.push(`${basename(file || bin)}:${r.status === null ? 'TIMEOUT' : 'CRASH'}`); }
      else if (r.status === 2) blocked++; else ok++;
    }
  }
  add('hooks.execute', fail === 0 ? 'PASS' : 'FAIL', `${ok} ok · ${blocked} guard-block · ${fail} FAIL${bad.length ? ' — ' + bad.join(', ') : ''}`);
  // guard EFFECT — a real guard must BLOCK a real trip
  const sr = run('bash', [`${HOOKS}/secret-redact-guard.sh`], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat ~/.env.local' } }) });
  add('effect.secret-redact', sr.status === 2 ? 'PASS' : 'FAIL', sr.status === 2 ? 'blocks secret read' : `exit=${sr.status} (expected 2)`);
  if (existsSync(`${HOOKS}/forbidden-asks.sh`)) {
    const tx = join(mkdtempSync(join(tmpdir(), 'seatv-')), 't.jsonl');
    writeFileSync(tx, [JSON.stringify({ type: 'user', message: { content: 'x' } }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'do you want me to proceed with the deploy?' }] } })].join('\n') + '\n');
    const fa = run('bash', [`${HOOKS}/forbidden-asks.sh`], { input: JSON.stringify({ transcript_path: tx, session_id: 'seatverify' }), env: { ...process.env, WT_FORBIDDEN_MODE: 'block' } });
    const blk = /"decision"\s*:\s*"block"/.test(fa.stdout || '');
    add('effect.forbidden-asks', blk ? 'PASS' : 'FAIL', blk ? 'blocks a forbidden ask' : 'DEAD — did not block');
  }
  // enforce flag (S839 card b022bc84): without it every wt-guard BLOCK is downgraded to a warning
  const enforce = settings.env && settings.env.WT_GUARD_ENFORCE;
  add('hooks.enforce', enforce === '1' ? 'PASS' : 'FAIL', enforce === '1' ? 'WT_GUARD_ENFORCE=1' : `WT_GUARD_ENFORCE=${enforce ?? 'unset'} — guards warn-only; set settings.json env.WT_GUARD_ENFORCE="1"`);
  // local overrides: settings.local.json hooks/env/deny; permission denies on wt_ / mcp tools
  const denies = [...((settings.permissions || {}).deny || []), ...(((settingsLocal || {}).permissions || {}).deny || [])];
  const wtDeny = denies.filter((d) => /mcp__|wt_|wikitata/i.test(d));
  add('hooks.permission-deny', wtDeny.length ? 'FAIL' : 'PASS', wtDeny.length ? `DENY rules on wikiTaTa tools: ${wtDeny.join(', ').slice(0, 250)}` : `${denies.length} deny rule(s), none touch wt_/mcp tools`);
  const localHooks = hookCount(settingsLocal);
  if (settingsLocal) add('hooks.settings-local', localHooks || (settingsLocal.env && Object.keys(settingsLocal.env).length) ? 'WARN' : 'INFO', `settings.local.json present: ${localHooks} hook(s), env keys=${Object.keys(settingsLocal.env || {}).join(',') || 'none'} — local overrides are invisible to the golden bundle`);
  // extra / disabled hook files in ~/.claude/hooks that the golden bundle does not carry
  const files = existsSync(HOOKS) ? readdirSync(HOOKS).filter((f) => !f.startsWith('.')) : [];
  const off = files.filter((f) => /\.(off|disabled|bak)$/i.test(f));
  const unwired = files.filter((f) => /\.(sh|mjs|js|py)$/.test(f) && ![...wiredFiles].some((w) => w.endsWith('/' + f)) && !/^(redact-stream\.sh|now-notify\.sh|cacp-poll-format\.py|lib)$/.test(f));
  audit.hooks = { settings_hook_count: hookCount(settings), events: Object.keys(settings.hooks || {}), local_hook_count: localHooks, env_keys: Object.keys(settings.env || {}), deny: denies, hook_files: files, off_files: off, unwired_files: unwired, enforce: enforce ?? null };
  if (off.length) add('hooks.off-files', 'WARN', `${off.length} disabled/backup hook file(s): ${off.join(', ').slice(0, 200)}`);
  if (unwired.length) add('hooks.unwired-files', 'INFO', `${unwired.length} hook file(s) present but not wired: ${unwired.join(', ').slice(0, 200)}`);
});

// ═══ 4. MCP ═════════════════════════════════════════════════════════════════
await (async () => { try {
  const servers = Object.entries((claudeJson && claudeJson.mcpServers) || {}).map(([name, s]) => ({ name, type: s.type || (s.command ? 'stdio' : 'http'), url: s.url || null, command: s.command ? basename(String(s.command)) : null }));
  const projectServers = Object.entries((claudeJson && claudeJson.projects) || {}).filter(([, p]) => p && p.mcpServers && Object.keys(p.mcpServers).length).map(([dir, p]) => ({ dir, servers: Object.keys(p.mcpServers) }));
  const disabled = Object.entries((claudeJson && claudeJson.projects) || {}).filter(([, p]) => p && p.disabledMcpjsonServers && p.disabledMcpjsonServers.length).map(([dir, p]) => ({ dir, disabled: p.disabledMcpjsonServers }));
  const list = run('claude', ['mcp', 'list'], { timeout: 40000 });
  const listed = REDACT((list.stdout || '') + (list.stderr || '')).split('\n').filter((l) => /:\s/.test(l) && !/^Checking/.test(l)).map((l) => l.trim()).slice(0, 20);
  const wtListed = listed.filter((l) => /wikitata|mcp\.wikitata\.com/i.test(l));
  audit.mcp = { user_scope_servers: servers, project_scope_servers: projectServers, disabled_per_project: disabled, claude_mcp_list: listed };
  add('mcp.wikitata-registered', wtListed.length ? 'PASS' : 'FAIL', wtListed.length ? wtListed.join(' | ').slice(0, 300) : `no wikitata server in \`claude mcp list\` — Claude has NO wt_ tools here. Fix: claude mcp add --scope user --transport http wikitata https://mcp.wikitata.com/mcp`);
  if (wtListed.some((l) => /✗|failed|error/i.test(l))) add('mcp.wikitata-connect', 'FAIL', `wikitata server listed but failing: ${wtListed.join(' | ').slice(0, 250)}`);
  if (disabled.length) add('mcp.disabled-per-project', 'WARN', disabled.map((d) => `${basename(d.dir)}: ${d.disabled.join(',')}`).join(' | ').slice(0, 250));
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch('https://mcp.wikitata.com/health', { signal: ctl.signal }); audit.mcp.health_http = r.status; add('mcp.endpoint-reachable', r.status === 200 ? 'PASS' : 'WARN', `GET /health → ${r.status}${r.status === 403 ? ' (Cloudflare bot-challenge from this network; the connector passes CF-Access itself)' : ''}`); }
  catch (e) { audit.mcp.health_http = null; add('mcp.endpoint-reachable', 'FAIL', `mcp.wikitata.com unreachable: ${String(e.message || e).slice(0, 120)}`); }
  finally { clearTimeout(t); }
} catch (e) { add('mcp.error', 'WARN', String(e.message || e).slice(0, 200)); } })();

// ═══ 5. INSTRUCTION SOURCES — everything Claude reads as a rule ═════════════
// Patterns that subvert the card system. Each hit is a REVIEW line with the offending text.
const ANTI = [
  ['forbids-wikitata', /\b(do not|don'?t|never|stop|avoid|skip)\b[^.\n]{0,30}\b(write|writing|create|creating|use|using|call|calling|load|loading|run|running|log|logging|make|making)\b[^.\n]{0,30}\b(cards?|wiki ?items?|wikitata|wikiTaTa|the mcp|session[_ -]?start|session[_ -]?end|golden bundle|the hooks?)\b/i],
  ['local-md-ledger', /\b(write|save|keep|put|record|log|store|maintain|update)\b[^.\n]{0,60}\b(handoff|notes?|session|summary|ledger|progress|todo|memory|journal|log)\b[^.\n]{0,40}\.(md|markdown|txt)\b/i],
  ['instead-of-cards', /\b(instead of|rather than|in lieu of|not in)\b[^.\n]{0,40}\b(cards?|wikitata|wt_[a-z_]+|the mcp)\b/i],
  ['ledger-filename', /\b(HANDOFF|SESSION[_-]?(NOTES?|LOG|SUMMARY)|NOTES|LEDGER|PROGRESS|JOURNAL|WORKLOG|SCRATCH)\.md\b/],
  ['disables-guards', /\b(disable|turn off|bypass|ignore|remove|comment out)\b[^.\n]{0,40}\b(hooks?|guards?|golden|gate|bootstrap|redact|enforce)\b/i],
  ['enforce-off', /WT_GUARD_ENFORCE\s*[=:]\s*["']?(0|false|off)\b/i],
];
const scanText = (text, cap = 20) => {
  const hits = []; const lines = text.split('\n'); let inLaw = false;
  for (let i = 0; i < lines.length && hits.length < cap; i++) {
    const ln = lines[i]; if (ln.length > 600) continue;
    // the stamped cards-first LAW block names the retired ledgers on purpose — never a hit
    if (ln.includes('wt:cards-first-law')) { inLaw = true; continue; }
    if (inLaw) { if (ln.trim() === '') inLaw = false; continue; }
    for (const [label, re] of ANTI) if (re.test(ln)) { hits.push({ line: i + 1, kind: label, text: REDACT(ln.trim()).slice(0, 160) }); break; }
  }
  return hits;
};
const fileInfo = (p) => { const st = statSync(p); const t = readFileSync(p, 'utf8'); return { path: p.replace(H, '~'), bytes: st.size, sha12: sha12(t), mtime: st.mtime.toISOString().slice(0, 10), hits: scanText(t) }; };
const walk = (dir, depth, filter, out = [], skip = /^(node_modules|\.git|Library|\.Trash|\.cache|\.npm|\.nvm|dist|build|\.next|\.svelte-kit|vendor|Pods)$/) => {
  if (depth < 0 || !existsSync(dir)) return out;
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (skip.test(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, filter, out, skip); else if (filter(p, e.name)) out.push(p);
    if (out.length > 400) break;
  }
  return out;
};
section('instructions', () => {
  const srcs = [];
  for (const f of ['CLAUDE.md', 'CLAUDE.local.md']) if (existsSync(`${CLAUDE_DIR}/${f}`)) srcs.push({ kind: 'global', ...fileInfo(`${CLAUDE_DIR}/${f}`) });
  for (const d of ['rules', 'commands', 'agents']) for (const p of walk(`${CLAUDE_DIR}/${d}`, 2, (_, n) => n.endsWith('.md'))) srcs.push({ kind: d, ...fileInfo(p) });
  for (const p of walk(`${CLAUDE_DIR}/skills`, 3, (_, n) => n === 'SKILL.md')) srcs.push({ kind: 'skill', ...fileInfo(p) });
  for (const p of walk(`${CLAUDE_DIR}/projects`, 3, (p2, n) => n.endsWith('.md') && /\/memory\//.test(p2))) srcs.push({ kind: 'memory', ...fileInfo(p) });
  const withHits = srcs.filter((s) => s.hits.length);
  audit.instructions = { sources: srcs.slice(0, 120), count: srcs.length };
  add('instructions.sources', 'INFO', `${srcs.length} instruction file(s): ${Object.entries(srcs.reduce((a, s) => (a[s.kind] = (a[s.kind] || 0) + 1, a), {})).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (srcs.some((s) => s.kind === 'global')) add('instructions.global-claude-md', 'WARN', `local ~/.claude/CLAUDE.md present (${srcs.filter((s) => s.kind === 'global').map((s) => `${basename(s.path)} ${s.bytes}B sha ${s.sha12}`).join(', ')}) — for a non-sysadmin seat the CLAUDE.md is served by wt_session_start; a local copy layers on top`);
  add('instructions.anti-patterns', withHits.length ? 'REVIEW' : 'PASS', withHits.length ? withHits.map((s) => `${s.path}: ${s.hits.map((h) => `L${h.line} [${h.kind}] ${h.text}`).join(' ‖ ')}`).join(' ‖‖ ').slice(0, 900) : 'no card-system-subverting instruction found');
});

// ═══ 6. REPOS — every git checkout the seat works in ════════════════════════
const LEDGER_NAME = /(^|[\/_-])(handoff|hand-off|session[-_ ]?(notes?|log|summary)?|notes?|ledger|progress|journal|todo|scratch|worklog|memory|context|state)([-_ ][\w-]*)?\.md$/i;
const LEDGER_DIR = /\/(docs\/(sessions?|handoffs?|notes|journal)|notes?|handoffs?|sessions?|journal|\.claude)\/[^/]+\.md$/i;
section('repos', () => {
  const roots = opts('--root').length ? opts('--root') : [`${H}/git`, `${H}/Projects`, `${H}/projects`, `${H}/Developer`, `${H}/code`, `${H}/src`, `${H}/dev`, `${H}/work`, `${H}/Documents`, `${H}/Desktop`, H];
  const seen = new Set(); const repos = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const depth = root === H ? 1 : 3;
    const stack = [[root, depth]];
    while (stack.length) {
      const [dir, d] = stack.pop(); if (d < 0) continue;
      let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      if (ents.some((e) => e.name === '.git')) { if (!seen.has(dir)) { seen.add(dir); repos.push(dir); } continue; }
      for (const e of ents) if (e.isDirectory() && !/^(node_modules|Library|\.Trash|\.cache|\.npm|\.nvm|\.local|\.config|Applications|Music|Movies|Pictures|Downloads|\.[a-z])/.test(e.name)) stack.push([join(dir, e.name), d - 1]);
      if (repos.length > 80) break;
    }
  }
  const now = Date.now(); const D = 86400000;
  const out = [];
  for (const repo of repos.slice(0, 80)) {
    const g = (args) => (run('git', ['-C', repo, ...args], { timeout: 15000 }).stdout || '').trim();
    const remote = g(['remote', 'get-url', 'origin']).replace(/\/\/[^@\/]+@/, '//REDACTED@');
    const branch = g(['rev-parse', '--abbrev-ref', 'HEAD']);
    const porcelain = g(['status', '--porcelain']).split('\n').filter(Boolean);
    const untrackedMd = porcelain.filter((l) => /^\?\?.*\.md$/.test(l)).length;
    const claudeMds = walk(repo, 3, (_, n) => n === 'CLAUDE.md' || n === 'CLAUDE.local.md').map(fileInfo);
    const settingsRepo = ['.claude/settings.json', '.claude/settings.local.json'].filter((f) => existsSync(join(repo, f))).map((f) => { const j = readJson(join(repo, f)) || {}; return { file: f, hooks: hookCount(j), deny: ((j.permissions || {}).deny || []).filter((x) => /mcp__|wt_|wikitata/i.test(x)), env_keys: Object.keys(j.env || {}), enforce_off: !!(j.env && /^(0|false|off)$/i.test(String(j.env.WT_GUARD_ENFORCE))) }; });
    const mcpJson = existsSync(join(repo, '.mcp.json')) ? Object.keys((readJson(join(repo, '.mcp.json')) || {}).mcpServers || {}) : null;
    const envFiles = walk(repo, 2, (_, n) => /^\.env(\..+)?$/.test(n) && !/\.example$/.test(n)).map((p) => { const keys = readFileSync(p, 'utf8').split('\n').map((l) => (l.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/) || [])[1]).filter(Boolean); return { file: p.replace(repo, '.'), keys: keys.length, wt_keys: keys.filter((k) => /^(WT_|SUPABASE_|CLAUDE_|ANTHROPIC_)/.test(k) && /(KEY|SECRET|TOKEN|PASS)/.test(k)) }; });
    const mds = walk(repo, 4, (p, n) => n.endsWith('.md'));
    const ledgers = mds.filter((p) => LEDGER_NAME.test(p) || LEDGER_DIR.test(p)).map((p) => { const st = statSync(p); return { path: p.replace(repo, '.'), bytes: st.size, age_days: Math.round((now - st.mtimeMs) / D) }; });
    const recentLedgers = ledgers.filter((l) => l.age_days <= 30).sort((a, b) => a.age_days - b.age_days);
    const recentMd = mds.filter((p) => now - statSync(p).mtimeMs <= 7 * D).length;
    const hits = claudeMds.reduce((n, c) => n + c.hits.length, 0);
    const repoRow = { path: repo.replace(H, '~'), remote, branch, dirty: porcelain.length, untracked_md: untrackedMd, claude_md: claudeMds.slice(0, 10), settings: settingsRepo, mcp_json: mcpJson, env_files: envFiles.slice(0, 10), ledger_md_total: ledgers.length, ledger_md_recent: recentLedgers.slice(0, 25), md_modified_7d: recentMd, contradictions: hits, instruction_sha256: claudeMds.length ? sha(claudeMds.map((c) => c.sha12).join('|')) : null };
    out.push(repoRow);
  }
  audit.repos = out;
  add('repos.discovered', 'INFO', `${out.length} git checkout(s) under ${roots.filter(existsSync).map((r) => r.replace(H, '~')).join(',')}`);
  const drifting = out.filter((r) => r.contradictions || r.ledger_md_recent.length || r.settings.some((s) => s.deny.length || s.enforce_off) || r.env_files.some((e) => e.wt_keys.length));
  for (const r of drifting.slice(0, 40)) {
    const why = [];
    if (r.contradictions) why.push(`${r.contradictions} anti-pattern hit(s) in CLAUDE.md: ` + r.claude_md.flatMap((c) => c.hits.map((h) => `L${h.line} [${h.kind}] ${h.text}`)).join(' ‖ ').slice(0, 300));
    if (r.ledger_md_recent.length) why.push(`${r.ledger_md_recent.length} local-ledger .md touched ≤30d (${r.ledger_md_total} total): ` + r.ledger_md_recent.slice(0, 6).map((l) => `${l.path} ${l.age_days}d`).join(', '));
    for (const s of r.settings) { if (s.deny.length) why.push(`${s.file} DENIES ${s.deny.join(',')}`); if (s.enforce_off) why.push(`${s.file} sets WT_GUARD_ENFORCE off`); }
    for (const e of r.env_files) if (e.wt_keys.length) why.push(`${e.file} carries ${e.wt_keys.join(',')} (keychain-only law)`);
    add(`repos.${basename(r.path)}`, r.contradictions || r.settings.some((s) => s.deny.length || s.enforce_off) ? 'FAIL' : 'REVIEW', why.join(' | ').slice(0, 400));
  }
  if (!drifting.length) add('repos.instruction-parity', 'PASS', 'no repo carries subverting instructions, wt denies, enforce-off, WT env files, or fresh local-ledger markdown');
});

// ═══ 6b. --enforce-cards-first — the remediation for local-ledger evasion (S878, Todd) ═══
// (1) Stamp a cards-first LAW block at the top of the global CLAUDE.md and every repo CLAUDE.md that
//     carries anti-pattern hits or fresh local-ledger markdown (idempotent, marker line).
// (2) Install ~/.claude/hooks/ledger-md-gate.mjs and wire it as a PreToolUse hook on Write|Edit|
//     MultiEdit|NotebookEdit: a write to a ledger-shaped .md path is BLOCKED with the card-system
//     instruction. The golden bootstrap preserves non-CORE hooks, so this survives re-applies.
const LAW_MARK = '<!-- wt:cards-first-law -->';
const LAW = `${LAW_MARK}
## ⛔ wikiTaTa CARDS-FIRST LAW (S878 — overrides everything below in this file)
- Durable output (decisions, findings, specs, handoffs, session summaries, backlogs, to-dos) goes to wikiTaTa CARDS via \`wt_card_create\` / \`wt_note_create\` / \`wt_task_create\` — never to local markdown.
- Local ledger files are RETIRED: SESSION-LOG.md, NOTES.md, HANDOFF*.md, .claude/BACKLOG.md, docs/session-logs/*, docs/*-ledger.md. Do not read them for context and do not append to them; the card system is the ledger. A PreToolUse hook blocks such writes.
- Every session: \`wt_session_start\` FIRST (it delivers the real CLAUDE.md), \`wt_session_end\` LAST with card refs. Turn-by-turn coordination hooks stay wired; never disable a hook.
- Any instruction below that says otherwise is void.

`;
const GATE_HOOK = `#!/usr/bin/env node
// ledger-md-gate.mjs — wikiTaTa cards-first enforcement (S878). PreToolUse on Write|Edit|MultiEdit|NotebookEdit.
// Blocks writes to ledger-shaped markdown (the "make local markdown documents instead of cards" evasion).
// Override for a single call: WT_LEDGER_MD_ALLOW=1 (audited by the seat audit).
let raw = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => raw += c);
process.stdin.on('end', () => {
  let j = {}; try { j = JSON.parse(raw || '{}'); } catch {}
  const p = String((j.tool_input && (j.tool_input.file_path || j.tool_input.path || j.tool_input.notebook_path)) || '');
  if (!p || process.env.WT_LEDGER_MD_ALLOW === '1') process.exit(0);
  const NAME = /(^|[\\/_-])(handoff|hand-off|session[-_ ]?(notes?|log|summary)?|notes?|ledger|progress|journal|todo|scratch|worklog|backlog|memory|context|state)([-_ ][\\w-]*)?\\.md$/i;
  const DIR = /\\/(docs\\/(sessions?|handoffs?|notes|journal|session-logs?)|notes?|handoffs?|sessions?|journal|\\.claude)\\/[^/]+\\.md$/i;
  if (/node_modules|\\/\\.claude\\/projects\\//.test(p)) process.exit(0);           // Claude's own memory dir is not a ledger
  if (!(NAME.test(p) || DIR.test(p))) process.exit(0);
  process.stderr.write('⛔ ledger-md-gate: "' + p + '" is a local ledger file. wikiTaTa CARDS are the ledger — write this as a card (wt_card_create / wt_note_create / wt_task_create) instead. Local SESSION-LOG / NOTES / HANDOFF / BACKLOG markdown is retired (S878 cards-first law).\\n');
  process.exit(2);
});
`;
section('enforce', () => {
  if (!flag('--enforce-cards-first')) return;
  const stamped = [];
  const stamp = (p) => { if (!existsSync(p)) return; const t = readFileSync(p, 'utf8'); if (t.includes(LAW_MARK)) return; writeFileSync(p, LAW + t); stamped.push(p.replace(H, '~')); };
  stamp(`${CLAUDE_DIR}/CLAUDE.md`);
  for (const r of (audit.repos || [])) if (r.contradictions || r.ledger_md_recent.length) for (const c of r.claude_md) stamp(c.path.replace(/^~/, H));
  mkdirSync(HOOKS, { recursive: true });
  const hp = `${HOOKS}/ledger-md-gate.mjs`; writeFileSync(hp, GATE_HOOK, { mode: 0o755 });
  const sp = `${CLAUDE_DIR}/settings.json`; const cfg = readJson(sp) || {}; cfg.hooks = cfg.hooks || {}; cfg.hooks.PreToolUse = cfg.hooks.PreToolUse || [];
  const cmd = `node ${hp}`; let grp = cfg.hooks.PreToolUse.find((g) => g.matcher === 'Write|Edit|MultiEdit|NotebookEdit');
  if (!grp) { grp = { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [] }; cfg.hooks.PreToolUse.push(grp); }
  if (!grp.hooks.some((h) => h && h.command === cmd)) grp.hooks.push({ type: 'command', command: cmd });
  writeFileSync(sp, JSON.stringify(cfg, null, 2));
  const t = run('node', [hp], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: `${H}/git/x/SESSION-LOG.md` } }) });
  audit.enforce = { stamped, hook: hp.replace(H, '~'), gate_blocks_ledger_write: t.status === 2 };
  add('enforce.cards-first-law', 'PASS', `law stamped on ${stamped.length} file(s)${stamped.length ? ': ' + stamped.join(', ').slice(0, 250) : ' (all already stamped)'}`);
  add('enforce.ledger-md-gate', t.status === 2 ? 'PASS' : 'FAIL', t.status === 2 ? 'installed + wired (PreToolUse Write|Edit|MultiEdit|NotebookEdit) — a SESSION-LOG.md write is blocked' : `hook did not block (exit ${t.status})`);
});

// ═══ 7. KEYCHAIN — names + presence only ═══════════════════════════════════
const kc = (svc) => { try { execFileSync('/usr/bin/security', ['find-generic-password', '-a', userInfo().username, '-s', svc], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 4000 }); return true; } catch { try { execFileSync('/usr/bin/security', ['find-generic-password', '-s', svc], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 4000 }); return true; } catch { return false; } } };
const kcValue = (svc) => { try { return execFileSync('/usr/bin/security', ['find-generic-password', '-a', userInfo().username, '-s', svc, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim(); } catch { return null; } };
section('keychain', () => {
  if (process.platform !== 'darwin') { audit.keychain = { skipped: 'not darwin' }; return; }
  const expected = { WT_CACP_TOKEN: 'CACP heartbeat/poll (cacp-heartbeat.sh, cacp-poll.sh)', WT_GATE_PRINCIPAL: 'authenticated principal for coord-heartbeat / write gates (v17+)', 'wikitata-guard-secret': 'wt-guard audit inserts (service key)', 'wt-selfheal-token': 'self-heal poller device token', WT_API_KEY: 'this seat\'s wikiTaTa API key (seat-audit submit)' };
  const present = {}; for (const k of Object.keys(expected)) present[k] = kc(k);
  const dump = run('/usr/bin/security', ['dump-keychain'], { timeout: 10000, maxBuffer: 50 * 1024 * 1024 });
  const names = [...new Set([...(dump.stdout || '').matchAll(/"svce"<blob>="([^"]*)"/g)].map((m) => m[1]))].sort();
  audit.keychain = { expected_present: present, service_names: names.slice(0, 300), count: names.length };
  const missing = Object.entries(present).filter(([, v]) => !v).map(([k]) => k);
  add('keychain.expected', missing.length ? (missing.includes('WT_CACP_TOKEN') || missing.includes('WT_GATE_PRINCIPAL') ? 'FAIL' : 'WARN') : 'PASS', missing.length ? `missing: ${missing.map((m) => `${m} (${expected[m]})`).join('; ').slice(0, 350)}` : `all ${Object.keys(expected).length} present`);
});

// ═══ 8. ENV HYGIENE — rc exports + launchd env keys, names only ═════════════
section('env', () => {
  const rcs = ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile'].map((f) => `${H}/${f}`).filter(existsSync);
  const exports = [];
  for (const rc of rcs) readFileSync(rc, 'utf8').split('\n').forEach((ln, i) => { const m = ln.match(/^\s*export\s+((WT_|SUPABASE_|CLAUDE_|ANTHROPIC_|VERCEL_|CF_|GH_|GITHUB_)[A-Z0-9_]*)\s*=\s*(.*)$/); if (m) exports.push({ file: basename(rc), line: i + 1, name: m[1], value_bearing: !/^\s*["']?\$/.test(m[3]) && m[3].trim().length > 0 && !/\$\(.*security.*\)/.test(m[3]) }); });
  const crosswire = exports.filter((e) => /^WT_SB_(KEY|URL)$/.test(e.name)).length + ['WT_SB_KEY', 'WT_SB_URL'].filter((v) => process.env[v]).length;
  const secretsInEnv = exports.filter((e) => e.value_bearing && /(KEY|SECRET|TOKEN|PASS)/.test(e.name));
  const procVars = Object.keys(process.env).filter((k) => /^(WT_|SUPABASE_|CLAUDE_|ANTHROPIC_)/.test(k)).map((k) => ({ name: k, len: String(process.env[k]).length }));
  const agents = walk(`${H}/Library/LaunchAgents`, 0, (_, n) => n.endsWith('.plist')).map((p) => { const j = run('plutil', ['-convert', 'json', '-o', '-', p]); let keys = []; try { keys = Object.keys(JSON.parse(j.stdout || '{}').EnvironmentVariables || {}); } catch {} return { plist: basename(p), env_keys: keys }; }).filter((a) => a.env_keys.length);
  audit.env = { rc_exports: exports, process_vars: procVars, launchd_env: agents, crosswire };
  const rcCross = exports.filter((e) => /^WT_SB_(KEY|URL)$/.test(e.name)).length;
  add('env.no-crosswiring', rcCross ? 'FAIL' : crosswire ? 'WARN' : 'PASS', rcCross ? `${rcCross} WT_SB_* rc export(s) — crosswires the golden fetch (401); remove the source` : crosswire ? `WT_SB_* present in the process env (a sourced env file, not an rc export) — the bootstrap self-cleans them since v11; find the source: grep -rl WT_SB_KEY ~/.zshrc ~/.zprofile ~/.wikitata 2>/dev/null` : 'no WT_SB_* export or process var');
  add('env.secrets-in-env', secretsInEnv.length ? 'FAIL' : 'PASS', secretsInEnv.length ? `value-bearing secret export(s): ${secretsInEnv.map((e) => `${e.file}:${e.line} ${e.name}`).join(', ').slice(0, 250)} — keychain-only law (card e994f3f8)` : `${exports.length} WT-family export(s), none value-bearing secrets`);
  const idEnv = exports.filter((e) => /^WT_(USER|ACTOR)$/.test(e.name));
  if (idEnv.length) add('env.identity-export', 'INFO', idEnv.map((e) => `${e.file}:${e.line} ${e.name}`).join(', '));
  if (agents.length) add('env.launchd-env', 'WARN', `${agents.length} LaunchAgent(s) ship EnvironmentVariables: ${agents.map((a) => `${a.plist}[${a.env_keys.join(',')}]`).join(' ').slice(0, 250)} — plist env is dumpable by launchctl print (keychain-only law)`);
});

// ═══ 9. CACP + COORD — live probes ══════════════════════════════════════════
await (async () => { try {
  const tokenFile = `${HOOKS}/.cacp-token`;
  const tok = kcValue('WT_CACP_TOKEN') || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : null);
  const src = kcValue('WT_CACP_TOKEN') ? 'keychain' : existsSync(tokenFile) ? '.cacp-token file' : 'none';
  audit.cacp = { token_source: src, token_len: tok ? tok.length : 0 };
  if (!tok || !EXPECTED) add('cacp.token', 'FAIL', !tok ? 'no CACP token (keychain WT_CACP_TOKEN or ~/.claude/hooks/.cacp-token) — cacp-poll.sh + cacp-heartbeat.sh exit silently every turn' : 'no expected user');
  else {
    const r = await rpc('wt_directive_pending', { p_caller: EXPECTED, p_token: tok });
    const ok = r.http < 300 && !(r.body && r.body.code);
    audit.cacp.probe = { http: r.http, code: r.body && r.body.code || null, message: r.body && r.body.message ? String(r.body.message).slice(0, 120) : null };
    add('cacp.token', ok ? 'PASS' : 'FAIL', ok ? `accepted for caller ${EXPECTED} (from ${src})` : `REJECTED for caller ${EXPECTED}: ${r.body && (r.body.message || r.body.code) || r.http} — every cacp-poll/heartbeat has been failing silently (card 4f90eb1b)`);
  }
  // coord-heartbeat: does the gate block this seat?
  if (existsSync(`${HOOKS}/coord-heartbeat.sh`)) {
    const env = { ...process.env }; if (EXPECTED) env.WT_USER = EXPECTED;
    const c = run('bash', [`${HOOKS}/coord-heartbeat.sh`], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'seatverify', cwd: H, session_id: 'seatverify-' + Date.now().toString(36) }), env, timeout: 30000 });
    const o = (c.stdout || '') + (c.stderr || '');
    const blocked = /unverified principal|gate-principal|DE-AUTHED|mcp-connector-gate|BLOCK/i.test(o);
    const principal = kc('WT_GATE_PRINCIPAL');
    audit.coord = { blocked, principal_in_keychain: principal, output: REDACT(o).slice(0, 400) };
    add('coord.heartbeat', blocked ? 'FAIL' : 'PASS', blocked ? `heartbeat BLOCKED by the gate (${principal ? 'principal present but rejected' : 'no WT_GATE_PRINCIPAL in keychain'}) — this seat never appears in wikitata.session_state, so CACP collision detection cannot see it` : `heartbeat accepted (principal ${principal ? 'present' : 'absent'})`);
  }
} catch (e) { add('cacp.error', 'WARN', String(e.message || e).slice(0, 200)); } })();

// ═══ 10. WRITE PATHS — real server writes; the DB is the witness ════════════
await (async () => { try {
  const devId = deviceIdFile || hostname();
  audit.writes = { device_id: devId, submitted: false };
  if (!SUBMIT) { add('writes.submit', 'INFO', 'dry run — pass --submit to write instruction-parity rows per repo and the full audit to wikitata.machine_boot_audit'); return; }
  if (!EXPECTED) { add('writes.submit', 'FAIL', 'cannot submit without an expected user'); return; }
  // (a) instruction parity per repo → wikitata.instruction_parity + the guard.instruction_parity signal
  let ipOk = 0, ipFail = 0;
  for (const r of (audit.repos || [])) {
    const findings = { claude_md: r.claude_md.map((c) => ({ path: c.path, sha12: c.sha12, hits: c.hits })), ledger_md_recent: r.ledger_md_recent, settings: r.settings, env_files: r.env_files.map((e) => ({ file: e.file, wt_keys: e.wt_keys })), remote: r.remote, branch: r.branch };
    const x = await rpc('wt_instruction_parity_report', { p_caller: EXPECTED, p_device_id: devId, p_repo: basename(r.path), p_instruction_sha256: r.instruction_sha256, p_contradictions: r.contradictions + r.settings.filter((s) => s.deny.length || s.enforce_off).length, p_ledger_files: r.ledger_md_recent.length, p_findings: findings });
    if (x.http < 300 && x.body && x.body.ok) ipOk++; else ipFail++;
  }
  add('writes.instruction-parity', ipFail ? 'FAIL' : 'PASS', `${ipOk} repo row(s) written as ${EXPECTED}${ipFail ? `, ${ipFail} failed` : ''} → SELECT * FROM wikitata.instruction_parity WHERE username=wt_tokenize_actor_ro('${EXPECTED}')`);
  // (b) full audit → machine_boot_audit via wt_seat_audit_submit (needs the seat's API key; value never printed)
  let apiKey = process.env.WT_API_KEY || kcValue('WT_API_KEY') || kcValue('wikitata-api-key') || null;
  if (!apiKey && claudeJson) for (const s of Object.values(claudeJson.mcpServers || {})) { const a = s && s.headers && (s.headers.Authorization || s.headers.authorization); const m = a && String(a).match(/Bearer\s+(\S+)/); if (m) { apiKey = m[1]; break; } }
  // No API key on the seat → submit under the claimed username (same trust model as the parity
  // reporters; S878). The audit must land BEFORE the seat has credentials, or the gap is invisible.
  const summary = { results: R, ...audit };
  const s = await rpc('wt_seat_audit_submit', { p_token: apiKey || EXPECTED, p_hostname: hostname(), p_audit: summary }, { timeoutMs: 40000 });
  const ok = s.http < 300 && s.body && s.body.ok;
  audit.writes.submitted = !!ok; audit.writes.result = ok ? { device_id: s.body.device_id, username: s.body.username, enrolled: s.body.enrolled, via: s.body.via } : { http: s.http, error: s.body && (s.body.error || s.body.message || s.body.detail) };
  add('writes.seat-audit', ok ? 'PASS' : 'FAIL', ok ? `machine_boot_audit row written as ${s.body.username} via ${s.body.via || (apiKey ? 'api_key' : 'claimed_username')} for device ${String(s.body.device_id).slice(0, 8)} (enrolled=${s.body.enrolled})${EXPECTED && s.body.username !== EXPECTED ? ` — ⚠ API key belongs to ${s.body.username}, not ${EXPECTED}` : ''}${apiKey ? '' : ' — no WT_API_KEY on this seat (mint one for authenticated submits)'}` : `submit failed: ${s.http} ${JSON.stringify(s.body).slice(0, 200)}`);
} catch (e) { add('writes.error', 'FAIL', String(e.message || e).slice(0, 200)); } })();

// ═══ REPORT ═════════════════════════════════════════════════════════════════
const fails = R.filter((r) => r.status === 'FAIL').length, warns = R.filter((r) => r.status === 'WARN').length, reviews = R.filter((r) => r.status === 'REVIEW').length;
const outFile = opt('--out') || ((SUBMIT || flag('--out')) ? `${H}/wt-seat-audit-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json` : null);
if (outFile) writeFileSync(outFile, JSON.stringify({ results: R, ...audit }, null, 2));
if (JSON_OUT) { console.log(JSON.stringify({ results: R, ...audit })); }
else {
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`\n═══ wikiTaTa seat audit — ${userInfo().username}@${hostname()} · expected user: ${EXPECTED || '?'} ═══\n`);
  console.log(pad('CHECK', 30) + pad('STATUS', 8) + 'DETAIL');
  for (const r of R) console.log(pad(r.name, 30) + pad(r.status, 8) + r.detail);
  console.log(`\nSUMMARY: ${R.filter((r) => r.status === 'PASS').length} pass · ${warns} warn · ${reviews} review · ${fails} FAIL${outFile ? `\nJSON: ${outFile}` : ''}`);
}
process.exit(fails > 0 ? 1 : 0);
