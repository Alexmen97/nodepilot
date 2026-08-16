# NodePilot — Architecture

Public architecture overview for contributors and operators. It describes
verified behavior of the current release; details may evolve across versions.

## 1. Stack

- **Backend**: Node.js (>= 22, Node 24 LTS recommended), framework-free, single runtime dependency
  (`ws`). Serves the static frontend, exposes the JSON API and proxies the
  Proxmox WebSocket console.
- **Frontend**: vanilla JavaScript/HTML/CSS in `public/`. No bundler, no
  framework, no build step.
- **PWA**: `public/manifest.json` + `public/sw.js` for offline shell and
  asset caching.
- **Data source**: Proxmox VE API (`/api2/json`) over HTTPS. The dashboard
  always renders real API data; there is no demo mode.

## 2. File structure

```text
nodepilot
├── server.js               # backend: API, routing, auth, Proxmox login, WS shell
├── package.json            # start and auth:set-password scripts
├── config.example.json     # template for the local config.json
├── scripts/set-password.js # dashboard password setup (scrypt hash)
└── public/
    ├── index.html          # DOM structure, layout, modals
    ├── app.js              # frontend logic: polling, rendering, guest detail, shell
    ├── style.css           # theme and responsive layout
    ├── i18n.js             # Italian/English translations
    ├── manifest.json       # PWA metadata
    ├── sw.js               # service worker (versioned cache)
    ├── icons/              # app icons (svg + png variants)
    └── vendor/             # xterm.js (LXC shell) and noVNC 1.7.0 (QEMU console)
```

## 3. Backend (server.js)

- HTTP server on port `3100` (override with the `PORT` env var).
- Runtime paths are relative to the project directory:
  `config.json`, `auth.json`, `state.json`.
- Proxmox login uses `/api2/json/access/ticket` with the credentials stored
  in `config.json`; no API tokens are required.
- Logging is minimal: passwords, hashes, cookies and session ids are never
  written to logs.

### Main endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/status` | servers, nodes, guests and stats (polling source) |
| GET/POST | `/api/config`, `/api/prefs` | dashboard preferences |
| GET/POST/DELETE | `/api/servers` | local Proxmox server entries |
| GET/POST | `/api/refresh`, `/api/autorefresh` | polling interval and toggle |
| POST | `/api/action` | guest start/stop/shutdown/reboot/suspend/resume |
| POST | `/api/logs/tasks`, `/api/logs/system`, `/api/logs/cluster`, `/api/logs/detail` | Proxmox logs (tasks, syslog, cluster, task detail) |
| GET | `/api/guest/detail` | status + config + last 25 tasks of a guest |
| GET | `/api/guest/rrd` | RRD CPU/RAM series (hour/day/week/month) |
| GET/POST | `/api/backup/storages`, `/api/backup/list`, `/api/backup/jobs`, `/api/backup/create` | Backup Manager V1 (read + create) |
| GET/POST | `/api/snapshot/list`, `/api/snapshot/create` | snapshots (read + create) |
| POST | `/api/auth/change-password` | change the dashboard password (auth required; invalidates all sessions) |
| POST | `/api/tasks/status` | one request / one response task status |
| POST | `/api/health/prefs` | Health Center expected state per guest |
| POST | `/api/auth/login`, `/api/auth/logout`; GET `/api/auth/session` | local authentication |
| POST | `/api/vnc/prep` | QEMU console: creates the Proxmox vncproxy and returns an opaque single-use prepId + temporary RFB credentials |
| WS | `/api/shell/ws` | LXC shell tunnel (session checked before upgrade) |
| WS | `/api/vnc/ws` | QEMU VNC console tunnel (session + Origin checked before upgrade; opaque prepId, single-use, 60 s TTL) |

Partial failures are handled explicitly: multi-server endpoints return
`{ ok, ..., errors }` and the UI keeps healthy servers visible.

## 4. Frontend and polling

- The dashboard uses **fetch polling** only (configurable 5–60 s). There is no
  SSE or WebSocket push for status data.
- Views: **Dashboard**, **Log Proxmox**, **Monitoraggio** (Health Center),
  **Backup & Snapshot**.
- `switchView()` in `app.js` centralizes view changes and applies the shared
  entrance animation (`sectionIn`, transform+opacity only,
  `prefers-reduced-motion` aware).
- Theme (light/dark/system) is applied by a single inline script in
  `index.html`; language switching (IT/EN) is custom in `public/i18n.js`.

## 5. Guest Detail

Side panel opened by clicking a VM/LXC card. Five tabs:

1. **Overview** — uptime, CPU, RAM, disk, network, tags, notes.
2. **Charts** — CPU/RAM from `/api/guest/rrd` with 1h/24h/7d/30d selector.
3. **Configuration** — key/values of the Proxmox guest config.
4. **Tasks** — last 25 Proxmox tasks of the guest with real status.
5. **Backup & Snapshot** — latest backup, history, real snapshots and guided
   creation.

- Action bar: Start / Stop / Restart / Shell (LXC only); actions reuse
  `/api/action`.
- State lives in the global `detailState` object
  (`key, serverId, node, type, vmid, tab, tf, data, rrd, loading`).
- Desktop: fixed right panel (max 520 px); mobile: full width.

### RRD charts

- CPU: Proxmox returns `cpu` as 0..1, the UI shows `cpu * 100`.
- RAM: `(mem / maxmem) * 100` per point using that point's `maxmem`;
  points without valid `mem`/`maxmem` are skipped.
- Empty points (only `time`) exist on week/month timeframes and are ignored.
- `null`/`undefined`/`NaN` values are filtered before drawing.
- Redraws: on timeframe change (new fetch), on panel resize, and from cache on
  theme change — never an extra RRD fetch.

### Task status rules

- `exitstatus` is NOT a reliable source (the Proxmox `/tasks` endpoint does
  not always return it).
- `status === "OK"` → completed; `status === "running"` or missing
  `endtime` → in progress (the only animated state); finished with a
  different status → error; otherwise → unknown.
- Never infer status from the task name.

## 6. LXC Shell (xterm.js + termproxy)

```text
xterm.js → dashboard backend → Proxmox /termproxy → /vncwebsocket → LXC console
```

- Protocol: initial auth `user:ticket\n`; input `0:<byte_length>:<data>`;
  resize `1:<cols>:<rows>:`; keepalive `2`.
- **noVNC is not used for the LXC shell**: it is an RFB/VNC client and is not
  the correct client for the textual termproxy stream. `/termproxy` must not
  be replaced with `/vncproxy`.
- The console prompt arrives only after the initial resize frame.
- `xterm.css` must always be loaded from `public/vendor/xterm.css`.
- `closeShell()` is the single cleanup point (WebSocket, keepalive timer,
  ResizeObserver, xterm dispose, session references, fullscreen reset).
- The shell works for privileged and unprivileged containers; container
  passwords are never stored by the dashboard.

## 6.1 QEMU VNC console (noVNC)

```text
noVNC (public/vendor/novnc) -> dashboard backend -> Proxmox /vncproxy
-> /vncwebsocket -> vncterm/QEMU
```

- Available for **running QEMU VMs** from the Guest Detail action bar
  ("Console" button); LXC guests keep the xterm.js Shell unchanged.
- **Two-phase flow**: `POST /api/vnc/prep` (session + Origin guarded) creates
  the Proxmox vncproxy, stores `{ ticket, port, user, password }` in memory
  under a cryptographically random, opaque, single-use `prepId` (60 s TTL)
  and returns only `prepId` + temporary RFB credentials. Then the frontend
  opens `WS /api/vnc/ws?prepId=...`: session and Origin are verified before
  the upgrade, the prep entry is deleted before use, and the backend relays
  raw bytes to Proxmox `/vncwebsocket`. The `vncticket` exists only in the
  backend->Proxmox URL and never reaches the browser.
- The tunnel is a transparent binary relay (no `user:ticket` auth frame, which
  belongs only to the Shell termproxy path): the RFB/VeNCrypt/TLS+PLAIN
  handshake is performed end-to-end by noVNC with the temporary credentials.
- noVNC 1.7.0 is vendored unmodified under `public/vendor/novnc/` (core +
  pako, MPL-2.0/MIT, see `THIRD_PARTY_NOTICES.md`) and loaded on demand with a
  dynamic `import()` from `public/vnc-console.js` (no bundler, no npm
  dependencies, no CSP changes).
- `window.VNCConsole.close()` is the single idempotent cleanup point
  (RFB disconnect, credentials and prepId wiped, fullscreen reset); it is
  also called on logout, session expiry and password change.
- Out of scope in V1: clipboard, serial console, serial0 fallback, Console
  button on dashboard cards, SPICE.

## 7. PWA and caching (sw.js)

- Versioned cache (`CACHE = 'nodepilot-v4'`, bumped per release that changes
  frontend assets); `index.html` references assets with incremental query
  versions (`app.js?v=N`, `style.css?v=N`, `i18n.js?v=N`).
- HTML navigations: network-first, cache fallback only when offline.
- Same-origin static assets: stale-while-revalidate.
- `/api/*`: completely bypassed by the service worker — never cached.
- When `sw.js` changes, a toast offers a voluntary update (click to reload);
  there is never an automatic `controllerchange → reload` (it would interrupt
  the Shell or in-progress operations).

## 8. Authentication and sessions

- Dashboard credentials live in `auth.json` (gitignored, mode 600):
  `username` + scrypt `passwordHash` (N=32768, r=8, p=1, 16-byte salt).
  Created or reset with `npm run auth:set-password` followed by a backend
  restart.
- Sessions are **in-memory**: a backend restart invalidates them (V1 decision).
- Cookie `hl_session`: HttpOnly, SameSite=Lax, Path=/, 12 h sliding idle
  timeout, 7 day absolute lifetime; `Secure` only over HTTPS.
- Login rate limit: 5 failures / 15 min per IP → 429 + Retry-After; generic
  error message (no user enumeration).
- All `/api/*` routes require a session except login/session/logout; static
  assets stay public. The Shell WebSocket verifies the session before the
  upgrade.
- V1 limits: single account, no MFA, no email recovery, no persisted tokens.

## 9. Health Center

- Third main view, read-only, derived from the already-collected status data:
  no parallel polling and no new periodic Proxmox calls.
- `evaluateHealth(status, guestModes, taskAlerts)` is pure (no side effects);
  thresholds are centralized in `HEALTH_THRESHOLDS`.
- Anti-flapping: 2 consecutive samples for CPU/RAM; rootfs/disk/status alerts
  are immediate.
- Expected state per guest: `Manual` (default) / `Always On` (stopped →
  critical) / `Ignore`.
- Task alerts: on-demand `/api/logs/tasks` only while the view is open, 24 h
  window, allowlist (backup → critical; start/stop/reboot/migrate/snapshot/
  restore/clone → warning; `vncproxy`, `vncshell`, `aptupdate`,
  `push_file` never alert).
- QEMU RAM prefers the guest-agent `free_mem`; without it, `mem > maxmem`
  means RAM is not evaluable (no false critical). Disk health is LXC-only.

## 10. Backup & Snapshot Manager V1

- V1 scope: **read + create** only. Out of scope: delete, rollback, restore,
  retention/schedule editors, PBS advanced features, notifications,
  persistence of the task tracker across browser reloads.
- Backups source of truth = **storage content**, never vzdump tasks (jobs with
  multiple vmid have an empty task id).
- Create endpoints validate everything before POSTing to Proxmox (storage
  exists, guest exists, snapshot name duplicates → 409, `vmstate` only for
  QEMU) and respond immediately with the UPID; there is no backend polling.
- Frontend caches are on-demand with TTL (storages/jobs 60 s, backups/snapshots
  30 s) and targeted invalidation when a tracked task completes.
- `activeTask`: one active create at a time, ~2.5 s poll only while running,
  suspended while the tab is hidden, 30 min soft timeout with "Check now"
  (never cancels the Proxmox task).

## 11. Security hardening

- Every response carries:
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy: strict-origin-when-cross-origin` and a strict CSP
  (`default-src 'self'`, pinned inline script hash, `style-src 'self'
  'unsafe-inline'`, `connect-src 'self' ws: wss:`).
  `style-src 'unsafe-inline'` is required because `app.js` generates
  `style=` attributes via innerHTML.
- **CSP hash caveat**: `script-src` pins the hash of the single inline theme
  script in `index.html`. If that script changes, the hash in
  `SECURITY_HEADERS` (`server.js`) must be updated or the theme stops
  working.
- Origin validation: authenticated mutating requests (POST/DELETE under
  `/api/*`) compare `Origin` (fallback `Referer`) with `Host`;
  mismatch → 403. GETs and the public auth endpoints are excluded. The Shell
  WebSocket runs the same check before the upgrade.

## 12. Runtime files and permissions

| File | Content | Permissions |
| --- | --- | --- |
| `config.json` | Proxmox servers (credentials) + preferences | 600 |
| `auth.json` | username + scrypt hash | 600 |
| `state.json` | persistent state (e.g. tour completed) | 600 |

All three are gitignored and created locally at runtime; they must never be
committed and must stay readable only by the service user.

## 13. Operational notes

- After any change to `server.js`, restart the backend process before
  browser testing: a stale backend serving a new frontend produces 404s on
  new endpoints.
- Backend restarts invalidate all sessions (in-memory sessions).
- Any process manager works (`nohup`, systemd, PM2); the project itself does
  not depend on one.
- Frontend changes require the PWA cache/version bump before testing,
  otherwise a stale service worker can make a patch look unapplied.
