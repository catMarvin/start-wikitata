# start-wikitata

Developer onboarding for wikiTaTa. One command sets up your entire Mac development environment.

## Quick Start

```bash
npx @wikitata/start
```

This starts a local server and opens a setup wizard in your browser. The wizard walks you through:

- Git + SSH key setup
- Node.js, Homebrew, Docker, PostgreSQL
- Claude Code, Supabase CLI, Vercel CLI
- wikiTaTa repo clone + MCP configuration
- Shell tools (wt_autolink, wt_start, wt_end)

Each step has **Test** (verify it works), **Run** (execute in built-in terminal), and **I already have this** (skip).

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 18+ (the wizard helps you install this if missing)
- An invite code from Todd

## What This Does

1. Starts a local HTTP + WebSocket server on port 3737
2. Opens `http://localhost:3737` in your browser
3. Provides an interactive terminal (xterm.js) so you can run commands without leaving the page
4. Walks through setup steps based on your experience level
5. Verifies your invite code against the wikiTaTa lobby
6. Clones the private repo and configures Claude Code

## Manual Start

```bash
git clone https://github.com/catMarvin/start-wikitata.git
cd start-wikitata
npm install
node server.js
```

## Security

This public repo contains **no production secrets**. The lobby Supabase is a sandboxed free-tier project with only onboarding tables. The private wikiTaTa repo and production database are only accessed after authentication.
