# NodePilot — Changelog

Questo file riassume le release funzionali di NodePilot, dalla più
recente alla più vecchia, in una forma leggibile anche senza leggere il codice.
Git resta la fonte completa dello storico; docs/ARCHITECTURE.md resta la fonte
tecnica di dettaglio. Gli hash dei commit citati si riferiscono allo storico
privato precedente alla pubblicazione open source.

## v1.1.1 — Open Source Preparation

Status: **Stable** — nessuna modifica funzionale

- repository pubblica preparata con storia pulita a partire dalla baseline v1.1.0;
- LICENSE MIT (Copyright (c) 2026 Alexmen97);
- SECURITY.md, CONTRIBUTING.md e THIRD_PARTY_NOTICES.md (xterm.js, ws);
- docs/ARCHITECTURE.md (sostituisce i documenti interni, non pubblicati);
- README pubblico in inglese e .npmignore;
- config.example.json aggiornato (IP di esempio in rete TEST-NET);
- versione pacchetto 1.1.0 → 1.1.1.

API, autenticazione, Tour V2, Security Hardening e UX invariati; nessun asset
frontend modificato (nessun bump PWA).

## NodePilot Rebranding

Status: **Stable** — solo branding, **versione invariata** (`v1.1.0`)

- rinomina del progetto da "HomeLab Dashboard" / "Pulse Node Hex" a **NodePilot**;
- descrizione ufficiale: "Self-hosted Proxmox Infrastructure Dashboard";
- aggiornati titolo UI, topbar, testi statici e traduzioni IT/EN;
- manifest PWA aggiornato (name/short_name/description) e metadati HTML;
- cache Service Worker migrata a `nodepilot-v1` con cleanup delle vecchie cache `homelab-*` (stessa strategia, `/api/*` mai in cache);
- nessuna modifica funzionale: API, autenticazione, Tour V2, Security Hardening e logica backend invariati.

## UX Polish V1.1

Status: **Stable** (release commit: `3245571`)

PWA: **`homelab-v12`** · `app.js?v=22` · `i18n.js?v=14` (`style.css?v=12` invariato)

Funzionalità:

- logout anche dal drawer mobile (stessa logica di Impostazioni, chiusura automatica del drawer);
- username della sessione visibile in Impostazioni → Sessione, con testo informativo (12 ore di inattività / massimo 7 giorni), IT/EN;
- sottotitolo neutro "Connessione in corso…" fino al primo stato reale;
- boot offline distinto dall'errore di autenticazione, con pulsante "Riprova" (nessun bypass del login, nessun dato offline mostrato);
- chip Offline informativo guidato dai fallimenti reali delle chiamate API, rimosso al primo successo; non tocca 401/session expiry, caricamento dashboard, cache PWA o dati offline;
- bugfix: pulsante "Accedi" reimpostato dopo login riuscito; overlay di login nascosto dopo "Riprova".

Verificato:

- QA browser IT/EN, mobile 390px, offline reale con emulazione rete ripristinata, console a zero errori;
- PWA v11 → v12 con asset serviti corretti.

## Technical Cleanup & Code Quality V1.1

Status: **Stable** (release commit: `90928e4`)

PWA: **`homelab-v11`** · `app.js?v=21` · `i18n.js?v=13` (`style.css?v=12` invariato)

Rimozioni:

- modalità demo legacy completa: dati demo, `demoActive`, `demoStatus()`, campo `demo` da `/api/config` e `/api/state`, branch demo in `/api/action`, log demo allo startup;
- SSE legacy completo: `/api/events`, `sseClients`, `sseTimer`, `restartSseTimer()`; il polling fetch resta l'unico meccanismo di aggiornamento;
- dead code backend: `hashPassword`, `wsHandshakeToProxmox`, `wsAccept`, parametro `force` di `getStatus`;
- riferimenti demo nel frontend e chiavi i18n `conn.demo`.

Modifiche compatibili:

- `/api/tour/restart` deprecato: protetto come prima, NON riattiva più la demo (Tour V2 solo dati reali, riavvio client-side);
- `/api/state` mantenuto (leggero, senza campo `demo`);
- testi Tour in Impostazioni aggiornati IT/EN ("Rivedi il tour guidato", hint sui dati reali) con `data-i18n` corretti;
- ~230 righe rimosse da `server.js`.

Verificato:

- sintassi Node e `git diff --check` puliti; nessun riferimento residuo a demo/SSE nel codice;
- `/api/events` → 404; `/api/tour/restart` → `{ok, demo:false, deprecated:true}`; `/api/config` e `/api/state` senza campo `demo`;
- dashboard, Guest Detail, Monitoraggio, Backup & Snapshot e Tour V2 su dati reali funzionanti con console browser a zero errori;
- PWA v10 → v11 sugli asset serviti.

## Security Hardening V1.1

Status: **Stable** (release commit: `1f48eb0`)

PWA: **invariata** (`homelab-v10`) — nessun asset frontend modificato.

Ambito:

- security headers su tutte le risposte HTTP: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`;
- CSP compatibile con vanilla JS, PWA e xterm.js: `default-src 'self'` + hash dello script inline del tema + `style-src 'self' 'unsafe-inline'` (stili via innerHTML di app.js) + `connect-src 'self' ws: wss:`;
- Origin validation su tutte le richieste mutative autenticate (POST/DELETE): `Origin` → `Host`, fallback `Referer`, client senza header ammessi, mismatch → 403; GET ed endpoint auth pubblici (`login`/`session`/`logout`) esclusi;
- protezione WebSocket Shell prima dell'upgrade (Origin validation) con termproxy, lifecycle, resize e keepalive invariati;
- cookie, sessione, TTL e rate limit login invariati.

Verificato:

- 401 senza sessione; 403 Origin/Referer ostile su API e WebSocket; risposte attese con Origin corretto;
- dashboard, Guest Detail (5 tab), Monitoraggio, Backup & Snapshot, Log Proxmox e Shell xterm.js funzionanti sotto CSP con console browser a zero errori;
- create backup/snapshot: validazioni invariate (400), nessun artifact creato;
- nessuna modifica a `public/*`, nessun bump PWA, nessuna azione su VM/guest.

## Authentication + Tour V2

Status: **Stable**

Release commit: `1c313b3`

PWA: `homelab-v10` · `app.js?v=20` · `style.css?v=12` · `i18n.js?v=12`

Commit principali:

- `f4859d5` backend auth core
- `5c08e0a` frontend login/logout
- `696a78e` API/Shell enforcement
- `9d03c82` PWA auth security
- `e382d55` Tour V2
- `1c313b3` release finale

Funzionalità:

- login HomeLab con password locale (scrypt nativo, auth.json non tracciato);
- logout con cleanup completo;
- session cookie HttpOnly (SameSite=Lax, idle 12h, lifetime 7 giorni);
- protezione API globale e WebSocket Shell;
- session expiry centralizzata e multi-tab logout;
- BFCache/offline senza dati infrastrutturali stantii;
- PWA auth-safe;
- Tour V2 multi-view (15 step su dati reali);
- versioning tour e onboarding;
- mobile/IT-EN/a11y.

Limiti:

- sessioni non persistenti al restart del backend;
- nessun account multiplo;
- nessun email recovery;
- nessun MFA;
- una Shell già aperta resta valida fino alla chiusura anche se la sessione scade;
- tour in corso perso al refresh del browser;
- demo V1 legacy ancora presente nel backend ma non utilizzata.

## Backup & Snapshot Manager V1

Status: **Stable**

Release commit: `03ce5fc`

PWA: `homelab-v8` · `app.js?v=15` · `style.css?v=11` · `i18n.js?v=11`

Commit principali:

- `c9d6485` read APIs
- `9a6ada7` create APIs
- `4d48eea` global view
- `05cc0a4` guest actions
- `35b101b` keyboard fix
- `3e45d74` layering fix
- `03ce5fc` final release

Funzionalità principali:

- vista globale Backup & Snapshot;
- supporto multi-server;
- storage backup con capacità e stato;
- job schedulati (schedule, mode, compressione, retention);
- backup recenti con note e flag protected;
- stato ultimo backup per ogni guest (senza giudizi automatici);
- archivi orfani di guest eliminati;
- snapshot globali e per guest;
- 5ª tab Backup & Snapshot nel Guest Detail;
- creazione backup manuale (mode/compress/note/protected);
- creazione snapshot manuale (nome/descrizione, vmstate solo QEMU);
- task tracking tramite UPID con stato in corso/completato/fallito;
- cache on-demand con TTL e invalidazione automatica;
- deep-link da Health Center ("Apri backup");
- IT/EN, responsive, accessibilità;
- PWA `homelab-v8`.

Vincoli architetturali importanti:

- source of truth dei backup = storage content (mai i task);
- task vzdump usati solo per esito/durata, mai per attribuire archivi;
- la pseudo-entry snapshot `current` è filtrata nel backend;
- nessun nuovo polling globale;
- la creazione è disponibile solo dal Guest Detail in V1.

Limiti V1:

- no delete backup/snapshot;
- no restore/rollback;
- no retention editor;
- no schedule editor;
- no persistenza del tracker dopo il reload del browser.

QA eseguito:

- backup reale su un container LXC di test (backend e UI);
- snapshot reale su un container LXC di test (backend e UI);
- duplicate guard snapshot (409 backend e client);
- multi-server su due host PVE reali;
- regression Shell completa;
- transizione PWA v7 → v8 verificata.

Nota: alcuni artifact di test reali sono stati lasciati intenzionalmente
sull'ambiente PVE di QA per test futuri.

## Health Center V1

Status: **Stable**

Release commit: `ac47ff7`

PWA: `homelab-v7` · `app.js?v=12` · `style.css?v=8` · `i18n.js?v=9`

Commit principali:

- `950a5da` backend
- `7f9e011` engine
- `d693adc` UI
- `8844e7f` QEMU RAM
- `d8ebe24` guest modes/task alerts
- `bee285f` polish/i18n
- `ac47ff7` final release

Funzioni:

- vista Monitoraggio / Monitoring;
- stato complessivo healthy/warning/critical;
- CPU/RAM/rootfs/disco LXC;
- anti-flapping;
- expected state Always On / Manual / Ignore;
- task alerts;
- alert backup fallito;
- INFO per reboot/riavvii recenti;
- riepilogo infrastruttura;
- deep-link guest/log;
- IT/EN;
- responsive e accessibilità.

Finding importanti:

- per QEMU `mem > maxmem` non è RAM guest affidabile;
- `free_mem` prioritario se disponibile;
- disk health QEMU escluso in V1;
- gli INFO non alterano la severità globale;
- fetch task on-demand con TTL 60s.

Limiti:

- no storage/SMART;
- no notifiche;
- no soglie custom da UI;
- no policy sull'età dei backup.

## Foundation / Core Stable Features

Funzionalità di base stabili, rilasciate prima delle due release principali:

- Dashboard multi-server con statistiche e azioni sui guest;
- Guest Detail (panoramica, grafici, configurazione, task);
- Log Proxmox (task, sistema, cluster);
- Shell LXC via xterm.js;
- tema chiaro/scuro/sistema;
- IT/EN;
- responsive desktop/mobile;
- PWA con aggiornamento volontario;
- branding Pulse Node Hex.

Riferimenti storici verificati:

- branding: `daa0b5c`
- Shell rendering: `378be92`
- Shell cleanup: `a46a976`
- PWA update strategy: `fef039b`
- transizioni viste: `a55ecb0`
- split viste Log: `e5a9213`
