'use strict';

/* Notification Store — store persistente (notifications.json).
   Solo backend: il frontend legge via API, nessun endpoint di ingestion.
   Scrittura atomica (tmp + rename), permessi 600, retention 200 record / 30 gg.
   Lo store persiste SEMPRE gli eventi dell'Alert Engine: notifications.center.
   enabled controlla solo la visibilità del Notification Center nella UI
   (FASE 2), MAI l'esistenza degli eventi. Telegram (FASE 2) non dipenderà
   mai da center.enabled. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_RECORDS = 200;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function createNotifications(opts) {
  const dataDir = (opts && opts.dataDir) || __dirname;
  const file = path.join(dataDir, 'notifications.json');
  let items = [];
  let loaded = false;

  function now() {
    return Date.now();
  }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      items = Array.isArray(raw) ? raw.filter((r) => r && typeof r === 'object') : [];
    } catch (_) {
      items = []; /* file mancante o corrotto: fallback sicuro */
    }
    prune();
    loaded = true;
  }

  function saveAtomic() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function prune() {
    const t = now();
    items = items.filter((r) => r.ts && t - r.ts <= MAX_AGE_MS);
    if (items.length > MAX_RECORDS) items = items.slice(0, MAX_RECORDS);
  }

  function add(rec) {
    if (!loaded) load();
    /* lo store è l'unica fonte per id/ts/read/delivery: il record in ingresso
       (es. da alert-engine con clock iniettato nei test) non deve poterli
       sovrascrivere, altrimenti prune/retention userebbero timestamp incoerenti */
    const item = {
      id: crypto.randomBytes(8).toString('hex'),
      ts: now(),
      read: false,
      delivery: null,
    };
    if (rec && typeof rec === 'object') {
      for (const k of Object.keys(rec)) {
        if (k === 'ts' || k === 'id' || k === 'read' || k === 'delivery') continue;
        item[k] = rec[k];
      }
    }
    items.unshift(item);
    prune();
    saveAtomic();
    return item;
  }

  function list() {
    if (!loaded) load();
    return { notifications: items, unreadCount: items.filter((r) => !r.read).length };
  }

  function markRead(id) {
    if (!loaded) load();
    const it = items.find((r) => r.id === id);
    if (!it) return false;
    if (!it.read) {
      it.read = true;
      saveAtomic();
    }
    return true;
  }

  function markAllRead() {
    if (!loaded) load();
    let changed = false;
    for (const r of items) {
      if (!r.read) { r.read = true; changed = true; }
    }
    if (changed) saveAtomic();
    return changed;
  }

  /* aggiorna lo stato di delivery di un record (es. telegram pending/sent/failed).
     Persistenza atomica; record inesistente -> false. */
  function updateDelivery(id, provider, status, extra) {
    if (!loaded) load();
    const it = items.find((r) => r.id === id);
    if (!it) return false;
    const d = { provider, status, at: now() };
    if (extra && typeof extra === 'object') Object.assign(d, extra);
    it.delivery = d;
    saveAtomic();
    return true;
  }

  /* Reconciliation startup: ogni delivery del provider ancora 'pending'
     (scritto da un processo precedente, quindi MAI 'in corso' nel processo
     corrente) diventa uno stato terminale 'failed' con error 'interrupted'.
     NIENTE reinvio automatico: un retry dopo restart potrebbe duplicare
     messaggi già consegnati ma non ancora marcati 'sent' localmente.
     Ritorna il numero di record riconciliati. */
  function reconcilePendingDeliveries(provider, at) {
    if (!loaded) load();
    const t = at || now();
    let changed = 0;
    for (const r of items) {
      if (r.delivery && r.delivery.provider === provider && r.delivery.status === 'pending') {
        r.delivery = { provider, status: 'failed', error: 'interrupted', at: t };
        changed += 1;
      }
    }
    if (changed > 0) saveAtomic();
    return changed;
  }

  function remove(id) {
    if (!loaded) load();
    const before = items.length;
    items = items.filter((r) => r.id !== id);
    if (items.length !== before) {
      saveAtomic();
      return true;
    }
    return false;
  }

  function clear() {
    items = [];
    saveAtomic();
  }

  function count() {
    if (!loaded) load();
    return items.length;
  }

  return {
    load, add, list, markRead, markAllRead, remove, clear, updateDelivery,
    reconcilePendingDeliveries,
    count,
    get file() { return file; },
  };
}

module.exports = { createNotifications, MAX_RECORDS, MAX_AGE_MS };
