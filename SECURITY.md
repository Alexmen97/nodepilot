# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.1.x | Yes |

NodePilot is a self-hosted tool: security fixes are released only for the
latest release line.

## Reporting a vulnerability

If you believe you have found a security vulnerability in NodePilot, please
report it privately and do **not** open a public issue:

1. open the **Security** tab of the GitHub repository and use
   **Report a vulnerability** (GitHub Security Advisory); or
2. if the repository is not public yet, contact the maintainer directly.

Please include:

- affected version and environment (OS, Node.js version, Proxmox VE version);
- steps to reproduce;
- impact assessment;
- any suggested fix.

You will receive an acknowledgement as soon as possible (normally within a
few days).

## Scope

In scope:

- `server.js` backend (HTTP API, authentication, Proxmox client, Shell WebSocket tunnel);
- the public frontend under `public/`;
- authentication and session handling;
- installer and startup scripts (when present).

Out of scope:

- Proxmox VE itself and its API/UI;
- third-party libraries (`ws`, xterm.js): report upstream;
- physical access, social engineering or an already compromised host;
- intentional misuse by an authenticated user.

## Security model

- Dashboard credentials: scrypt hash (N=32768, r=8, p=1, 16-byte salt) stored
  in `auth.json` (mode 600); plaintext passwords are never persisted.
- Sessions: in-memory, cookie `hl_session` HttpOnly + SameSite=Lax, 12 h idle
  timeout, 7 day absolute lifetime.
- Login rate limit: 5 failed attempts per 15 minutes per IP.
- Security headers on every response; the CSP pins the single inline theme
  script by hash.
- Origin validation on authenticated mutating requests and on the Shell
  WebSocket before the upgrade.
- Passwords, hashes, cookies and session ids are never logged.

## Recommendations for operators

- expose NodePilot only on a trusted network or behind a reverse proxy with HTTPS;
- keep Node.js and the application up to date;
- keep `config.json`, `auth.json` and `state.json` with mode 600;
- run the service with a dedicated, unprivileged account.

## Disclosure policy

Coordinated disclosure: private report, fix, public advisory after a
reasonable grace period. There is no bug bounty program.
