# NodePilot — Self-hosted Proxmox Infrastructure Dashboard

Dashboard web self-hosted per gestire e monitorare uno o più server **Proxmox VE** (VM e container LXC) direttamente dal browser.

- **Backend**: Node.js (`server.js`), senza framework, unica dipendenza runtime `ws`
- **Frontend**: vanilla JavaScript/HTML/CSS, nessun bundler e nessun framework
- **Dati**: API Proxmox (`/api2/json`), sempre dati reali, nessun dato demo
- **PWA**: installabile, cache versionata, aggiornamento volontario

## Funzionalità

- **Dashboard multi-server** — stato dei server, statistiche globali e card VM/LXC per nodo
- **Azioni sui guest** — avvia / ferma / riavvia / sospendi / riprendi, con conferma
- **Guest Detail** — panoramica, grafici RRD CPU/RAM (1h/24h/7g/30g), configurazione, ultimi 25 task e tab Backup & Snapshot
- **Log Proxmox** — task, log di sistema e log cluster, con filtri e dettaglio del singolo task
- **Shell LXC** — terminale nel browser via xterm.js (termproxy/vncwebsocket), per container privileged e unprivileged
- **Monitoraggio (Health Center)** — stato healthy/warning/critical, soglie, expected state e alert sui task
- **Backup & Snapshot Manager V1** — backup, snapshot, storage e job schedulati, con creazione guidata e tracking UPID (read + create)
- **Autenticazione locale** — login utente/password, cookie di sessione HttpOnly, rate limit, API e WebSocket Shell protetti
- **Tour guidato V2** — 15 step sui dati reali, nessuna demo automatica
- **Tema** chiaro/scuro/sistema, **i18n IT/EN**, layout responsive mobile/desktop

## Requisiti

- Node.js >= 18
- uno o più server Proxmox VE raggiungibili dal backend

## Installazione e primo accesso

```bash
npm install
npm run auth:set-password   # crea/aggiorna la password di accesso alla dashboard (interattivo)
npm start
```

Apri [http://localhost:3100](http://localhost:3100) e accedi con la password impostata con `auth:set-password`.

Al primo login di un nuovo utente viene proposta un'introduzione con il tour; il tour può essere saltato o riavviato in qualsiasi momento da **Impostazioni → Riavvia tour**. Il tour gira solo sui dati reali già caricati.

## Configurazione dei server Proxmox

Aggiungi i server da **Impostazioni → Server** (nome, URL, utente, password, verifyTls) oppure crea `config.json` partendo da `config.example.json`:

```json
{
  "refreshMs": 10000,
  "autoRefreshEnabled": true,
  "theme": "system",
  "language": "it",
  "servers": [
    {
      "id": "pve-main",
      "name": "Proxmox Principale",
      "url": "https://192.168.1.10:8006",
      "user": "root@pam",
      "password": "LA_TUA_PASSWORD",
      "verifyTls": false
    }
  ],
  "health": {
    "guestModes": {
      "pve-main:nodo1:qemu:100": "alwayson"
    }
  }
}
```

- `verifyTls: false` serve di norma con i certificati self-signed di Proxmox.
- I nodi di ogni server vengono scoperti automaticamente dalle API: non esiste un campo `node` nella configurazione.
- `health.guestModes` (opzionale) associa `<serverId>:<node>:<tipo>:<vmid>` (tipo `qemu` o `lxc`) a `alwayson` o `ignore`; `manual` è il default e corrisponde all'assenza della chiave.
- `refreshMs` è l'intervallo di aggiornamento della dashboard (dalla UI: 5–60 secondi).

## Aggiornamento dei dati

La dashboard usa **fetch polling** con intervallo configurabile: i dati arrivano dalle API Proxmox tramite il backend, su richiesta del client.

## Autenticazione

- Password locale della dashboard: `npm run auth:set-password`, salvata come hash scrypt in `auth.json` (mai in chiaro, non tracciato da Git).
- Sessione: cookie `hl_session` HttpOnly, SameSite=Lax; idle 12 ore, durata massima 7 giorni; sessioni in memoria (il riavvio del backend richiede un nuovo login).
- Rate limit sul login: 5 tentativi falliti / 15 minuti per IP.
- Tutte le route API e il WebSocket della Shell richiedono una sessione valida.

Limiti V1: account singolo, niente MFA né recovery via email.

## File runtime e sicurezza

| File | Contenuto | Git | Permessi |
| --- | --- | --- | --- |
| `config.json` | server Proxmox (credenziali PVE) e preferenze | ignorato | 600 |
| `auth.json` | username e hash della password dashboard | ignorato | 600 |
| `state.json` | stato persistente (es. tour completato) | ignorato | 600 |

- **`config.json` contiene le credenziali Proxmox e deve avere permessi 600**; è già in `.gitignore` e non va mai committato.
- Applica `chmod 600 config.json auth.json state.json` dopo la creazione.
- Esponi la dashboard solo in rete locale o dietro un reverse proxy con HTTPS.

## Avvio e operatività

- Avvio: `npm start` (oppure `node server.js`), porta 3100 (override con `PORT`).
- Se il backend è supervisionato da PM2 (processo `server`), dopo modifiche a `server.js`: `pm2 restart server`.
- Per cambiare la password: `npm run auth:set-password` e riavvia il backend.

## Struttura

```text
NodePilot
├── server.js               # backend Node: API, auth, login PVE, WebSocket Shell
├── config.json             # configurazione locale (NON committare)
├── auth.json               # credenziali dashboard (NON committare)
├── state.json              # stato persistente (NON committare)
├── package.json            # script start e auth:set-password
├── scripts/set-password.js # setup password dashboard
└── public/
    ├── index.html          # struttura DOM, layout e modali
    ├── app.js              # logica frontend: polling, render, Guest Detail, shell
    ├── style.css           # tema e layout responsive
    ├── i18n.js             # traduzioni IT/EN
    ├── manifest.json       # PWA
    ├── sw.js               # service worker (cache versionata)
    └── vendor/             # xterm.js e addon (solo per LXC, nessun noVNC)
```

## Documentazione

- [AGENTS.md](AGENTS.md) — regole permanenti per lo sviluppo
- [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) — architettura verificata e handover
- [CHANGELOG.md](CHANGELOG.md) — release
- [ROADMAP.md](ROADMAP.md) — stato e direzione del progetto
