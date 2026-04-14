#!/usr/bin/env node
// wikiTaTa Setup Server — HTTP + WebSocket terminal
// Usage: npx @wikitata/start
//    or: node server.js

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = parseInt(process.env.PORT || '3737', 10);

// ── Preflight checks ────────────────────────────────────────────────────────

const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

function preflight() {
  let ok = true;

  // Node version
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    console.error(`  ${R}Error:${X} Node.js v${process.versions.node} detected — v18+ required.`);
    console.error(`  ${D}Run: brew install node${X}`);
    ok = false;
  }

  // setup.html exists
  const htmlPath = join(__dirname, 'setup.html');
  if (!existsSync(htmlPath)) {
    console.error(`  ${R}Error:${X} setup.html not found in ${__dirname}`);
    console.error(`  ${D}Try: git pull${X}`);
    ok = false;
  }

  // ws module
  try {
    await import('ws');
  } catch {
    console.error(`  ${R}Error:${X} ws module not installed.`);
    console.error(`  ${D}Run: npm install${X}`);
    ok = false;
  }

  if (!ok) {
    console.error(`\n  ${R}Preflight failed.${X} Fix the issues above and try again.\n`);
    process.exit(1);
  }
}

await preflight();

// ── HTTP Server (serves setup.html) ──────────────────────────────────────────

const httpServer = createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html' || req.url === '/setup.html') {
    const html = readFileSync(join(__dirname, 'setup.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '0.1.0' }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── WebSocket Terminal ───────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const shell = process.env.SHELL || '/bin/zsh';
  const env = { ...process.env, TERM: 'xterm-256color' };

  let proc;
  try {
    proc = spawn(shell, ['-l'], {
      env,
      cwd: process.env.HOME,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', data: 'Failed to spawn shell: ' + err.message }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: 'server_info', pty: false, shell, pid: proc.pid }));

  proc.stdout.on('data', (data) => {
    try { ws.send(JSON.stringify({ type: 'output', data: data.toString() })); } catch (_) {}
  });

  proc.stderr.on('data', (data) => {
    try { ws.send(JSON.stringify({ type: 'output', data: data.toString() })); } catch (_) {}
  });

  proc.on('exit', (code) => {
    try { ws.send(JSON.stringify({ type: 'exit', code })); } catch (_) {}
    ws.close();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input' && proc.stdin.writable) {
        proc.stdin.write(msg.data);
      } else if (msg.type === 'resize') {
        // No PTY resize in spawn mode — ignore gracefully
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    try { proc.kill(); } catch (_) {}
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  wikiTaTa Developer Setup                    ║');
  console.log(`  ║  ${url}                     ║`);
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  // Auto-open browser
  const openCmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(openCmd, [url], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
});
