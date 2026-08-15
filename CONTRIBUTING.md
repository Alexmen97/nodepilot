# Contributing to NodePilot

Thanks for your interest! NodePilot is intentionally small and
dependency-minimal; contributions that keep it that way are very welcome.

## Ways to contribute

- report bugs and propose features via GitHub Issues;
- improve documentation and translations (Italian/English);
- submit small, focused fixes and features via Pull Requests.

## Getting started

Prerequisites: Node.js >= 18 and npm.

```bash
git clone https://github.com/Alexmen97/nodepilot.git
cd nodepilot
npm ci
npm run auth:set-password   # creates local dashboard credentials (auth.json, ignored)
npm start                   # http://localhost:3100
```

There is no build step and no bundler: frontend files under `public/` are
served as-is.

## Development guidelines

- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing existing
  behavior.
- Keep changes minimal and focused; do not refactor unrelated code.
- Never hardcode Proxmox data (server names, IPs, VMIDs, stats): everything
  must come from the API.
- No demo data: every feature must work on real data only.
- Do not modify the termproxy/vncwebsocket Shell protocol without a verified
  diagnosis.
- Runtime files (`config.json`, `auth.json`, `state.json`) must never be
  committed.
- After changing `server.js`, restart the backend before testing.
- Frontend asset changes require a PWA cache bump in `public/sw.js` and the
  query-version bumps in `index.html`.

## Before opening a pull request

- `node --check` on every changed JavaScript file;
- `git diff --check` clean;
- browser QA: zero console errors, IT/EN, light/dark theme, mobile width;
- changes touching the Proxmox API tested against real data where possible;
- no secrets or personal data in the diff.

## Conventions

- one logical change per pull request;
- describe what changed, why, and how it was tested;
- update the documentation when behavior changes.

All contributions are licensed under the project's MIT license.
