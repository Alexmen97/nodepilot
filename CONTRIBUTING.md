# Contributing to NodePilot

## Welcome

NodePilot is a self-hosted Proxmox Infrastructure Dashboard: a lightweight,
dependency-minimal Node.js app to manage and monitor one or more Proxmox VE
servers from the browser.

Contributions are welcome. Accepted contribution types include:

- bug fixes;
- new features;
- documentation improvements;
- UX improvements.

## Code of Conduct

By participating in this project, you agree to follow respectful and
constructive communication.

## Development Environment

Requirements:

- Node.js >= 22 (Node 24 LTS recommended);
- npm;
- Git.

```bash
git clone https://github.com/Alexmen97/nodepilot.git
cd nodepilot
npm ci
```

## Running Locally

Start the development server:

```bash
npm start
```

Then open <http://localhost:3100>.

Create a local `config.json` (you can start from `config.example.json`) with
your own Proxmox servers and set up a local dashboard password with
`npm run auth:set-password`.

The following files are local runtime files and must never be committed:

- `config.json`
- `auth.json`
- `state.json`

They are already covered by `.gitignore`.

## Project Structure

```text
server.js   # Node backend: API, auth, Proxmox client, WebSocket shell
public/     # frontend: HTML, JS, CSS, PWA and vendored assets
scripts/    # installer and helper scripts
deploy/     # systemd and LaunchAgent service templates
docs/       # architecture documentation and images
.github/    # CI workflow, issue templates and PR template
```

## Testing Before Pull Request

Before opening a pull request, run:

```bash
npm ci --omit=dev
npm audit --audit-level=high
node --check server.js
```

Also run `node --check` on every changed JavaScript file, and verify that:

- the GitHub Actions CI is green;
- no secrets or personal data are included in the diff;
- no runtime files (`config.json`, `auth.json`, `state.json`) are included.

Key development rules:

- keep changes minimal and focused;
- never hardcode Proxmox data (names, IPs, VMIDs, stats): everything comes
  from the API;
- no demo data: every feature works on real data only;
- frontend asset changes require the PWA cache bump in `public/sw.js` and the
  query-version bumps in `index.html`.

## Pull Requests

Create a dedicated branch:

```bash
git checkout -b feature/my-change
```

Then:

- describe clearly what the change does;
- explain why it is needed;
- attach screenshots for UI changes;
- keep pull requests small and focused.

The pull request template guides you through the required information.

## Commit Messages

Use short, descriptive commit messages. Examples:

```text
Add guest health metrics

Fix authentication redirect

Update documentation
```

## Reporting Bugs

Open an issue using the GitHub issue templates (bug report or feature
request). Do not include passwords, tokens, private IPs, or infrastructure
details in issues.

## Security Issues

For security-related reports, follow the process described in
[SECURITY.md](SECURITY.md). Do not use public issues for vulnerabilities and
do not share private email addresses.

## License

NodePilot is MIT licensed. See [LICENSE](LICENSE).
