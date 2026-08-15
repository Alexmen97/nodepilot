# NodePilot — Roadmap

Stato delle funzionalità e direzione prevista. Questo file NON è una specifica
tecnica: i dettagli vivono in docs/ARCHITECTURE.md.

## Stable

- [x] Dashboard
- [x] Guest Detail
- [x] Log Proxmox
- [x] LXC Shell
- [x] Health Center V1
- [x] Backup & Snapshot Manager V1
- [x] Authentication / Login
- [x] Tour V2
- [x] PWA / responsive / IT-EN
- [x] NodePilot branding

## Next

### Open Source Preparation V1.1.1

- [x] repository pubblica con storia pulita (baseline v1.1.0)
- [x] LICENSE / SECURITY / CONTRIBUTING / THIRD_PARTY_NOTICES / docs/ARCHITECTURE.md
- [x] README pubblico e .npmignore
- [x] installer install.sh (Linux/macOS)
- [x] avvio automatico systemd (Linux) e LaunchAgent (macOS)
- [ ] screenshot del README
- [x] CI base su GitHub Actions

### Stabilization & Hardening V1.1

Consolidamento del progetto prima delle prossime macro-feature:

- [x] README aggiornato
- [x] config.example aggiornato
- [x] runtime permissions (config/auth/state 600)
- [x] security headers (CSP + X-Frame-Options + nosniff + Referrer-Policy)
- [x] Origin validation (API mutative autenticate + WebSocket Shell)
- [x] logout UX (completata in UX Polish V1.1)

### Technical Cleanup & Code Quality V1.1

- [x] demo legacy rimossa (backend + frontend + i18n)
- [x] SSE legacy rimosso (resta il fetch polling)
- [x] dead code rimosso (hashPassword, wsHandshakeToProxmox, wsAccept, parametro force)
- [x] `/api/tour/restart` deprecato senza riattivazione demo
- [x] PWA homelab-v11 + query asset aggiornate
- [x] documentazione allineata (nessun SSE come sistema attivo, nessuna demo automatica)

### UX Polish V1.1

- [x] logout nel drawer mobile (stessa logica, chiusura automatica)
- [x] username e testo informativo sessione in Impostazioni (IT/EN)
- [x] sottotitolo neutro fino al primo stato reale
- [x] boot offline con "Riprova" (nessun bypass del login)
- [x] chip Offline informativo su fallimenti reali delle API
- [x] PWA homelab-v12 (app.js?v=22, i18n.js?v=14)
- [x] bugfix login: submit reimpostato, overlay nascosto dopo Riprova

## Future candidates

Candidate non vincolanti, senza impegno di implementazione:

- gestione retention/schedule dei backup;
- restore/rollback/delete con conferme forti;
- notifiche;
- policy Health sull'età dei backup;
- monitoraggio avanzato cluster/quorum;
- integrazione PBS avanzata;
- vista power/UPS;
- overview di rete.

## Product principles

- no destructive actions by default;
- read-only first;
- multi-server first-class;
- no unnecessary polling;
- reuse existing Proxmox data;
- partial failure should not hide healthy servers;
- mobile/IT-EN/PWA remain release requirements;
- test on real data before declaring stable.
