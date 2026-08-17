'use strict';

/* Telegram provider — delivery backend-only (FASE 2A).
   Nessuna dipendenza: fetch nativo Node (>=22). Funziona con il browser
   completamente chiuso: è il watchdog backend a generare gli eventi e a
   consegnarli. Il Notification Center UI (FASE 2B) NON ha alcun ruolo.
   Il delivery è isolato dal tick: coda con concorrenza 1, nessun await nel
   tick del watchdog, nessun timer orfano, shutdown bounded. */

const TELEGRAM_API = 'https://api.telegram.org/bot';
const SEND_TIMEOUT_MS = 10 * 1000;
const MAX_RETRY_AFTER_MS = 5 * 1000;   /* cap per retry_after di Telegram */
const FLUSH_SHUTDOWN_MS = 2 * 1000;    /* attesa massima flush in stop() */

/* mapping errori Telegram -> codici sanitizzati (mai body/URL grezzi) */
function mapTelegramError(status) {
  if (status === 400) return 'invalid_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'chat_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'telegram_unavailable';
  return 'telegram_error_' + status;
}

function createTelegramSender(opts) {
  const fetchImpl = (opts && opts.fetchImpl) || ((...a) => fetch(...a));
  const log = (opts && opts.log) || (() => {});

  /* invio singolo con timeout AbortController; ritorna { status, retryAfter? }
     oppure { status: 'timeout' } / { status: 'network_error' } */
  async function requestOnce(token, chatId, text) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(TELEGRAM_API + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          parse_mode: '', /* testo semplice: nessun HTML/Markdown */
        }),
        signal: ctrl.signal,
      });
      let retryAfter = 0;
      if (res.status === 429) {
        try {
          const ra = Number(res.headers.get('retry-after'));
          if (Number.isFinite(ra) && ra > 0) retryAfter = Math.min(ra * 1000, MAX_RETRY_AFTER_MS);
        } catch (_) { /* header assente: cap di default */ }
      }
      return { status: res.status, retryAfter };
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
        return { status: 'timeout' };
      }
      return { status: 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  function isTransient(status) {
    return status === 'timeout' || status === 'network_error' ||
      status === 429 || (typeof status === 'number' && status >= 500);
  }

  /* invio con retry: MASSIMO 1 retry, solo errori transient.
     Per 429 rispetta retry_after (capped a 5s). MAI retry per 4xx. */
  async function sendMessage(token, chatId, text) {
    let r = await requestOnce(token, chatId, text);
    if (isTransient(r.status)) {
      if (r.retryAfter > 0) {
        await new Promise((res) => {
          const t = setTimeout(res, r.retryAfter);
          if (typeof t.unref === 'function') t.unref();
        });
      }
      log('[telegram] retry dopo stato ' + r.status);
      r = await requestOnce(token, chatId, text);
    }
    if (r.status === 200) return { ok: true };
    return { ok: false, code: mapTelegramError(r.status), status: r.status };
  }

  return { sendMessage };
}

/* ---------- formattazione messaggi (IT/EN, contesto sanitizzato) ---------- */

const SEV = {
  critical: { it: 'CRITICO', en: 'CRITICAL', icon: '🔴' },
  warning: { it: 'ATTENZIONE', en: 'WARNING', icon: '🟠' },
  info: { it: 'INFO', en: 'INFO', icon: 'ℹ️' },
  success: { it: 'SUCCESSO', en: 'SUCCESS', icon: '✅' },
};

/* titleKey conosciute -> { it, en } (titolo) + eventuali righe contestuali */
const TITLES = {
  'health.serverOffline': { it: 'Server offline', en: 'Server offline' },
  'health.nodeOffline': { it: 'Nodo offline', en: 'Node offline' },
  'health.storageHigh': { it: 'Storage quasi pieno', en: 'Storage nearly full' },
  'health.storageOffline': { it: 'Storage non attivo', en: 'Storage not active' },
  'health.zfsDegraded': { it: 'Pool ZFS degradato', en: 'ZFS pool degraded' },
  'health.zfsErrors': { it: 'Errori ZFS rilevati', en: 'ZFS errors detected' },
  'health.quorumLost': { it: 'Quorum cluster perso', en: 'Cluster quorum lost' },
  'health.haError': { it: 'Errore servizio HA', en: 'HA service error' },
  'health.backupFailed': { it: 'Backup fallito', en: 'Backup failed' },
  'health.backupAge': { it: 'Backup non aggiornato', en: 'Backup outdated' },
  'health.taskFailed': { it: 'Task Proxmox fallito', en: 'Proxmox task failed' },
  'health.diskFailed': { it: 'SMART disk FAILED', en: 'SMART disk FAILED' },
  'health.diskPending': { it: 'Settori pendenti SMART', en: 'SMART pending sectors' },
  'health.diskReallocated': { it: 'Settori riallocati SMART', en: 'SMART reallocated sectors' },
  'health.diskUncorrectable': { it: 'Settori non correggibili', en: 'Uncorrectable sectors' },
  'health.diskTemp': { it: 'Temperatura disco elevata', en: 'High disk temperature' },
  'health.diskWear': { it: 'Vita residua SSD bassa', en: 'Low SSD wear remaining' },
  'backup.task.started': { it: 'Backup avviato', en: 'Backup started' },
  'backup.task.done': { it: 'Backup completato', en: 'Backup completed' },
  'backup.task.failed': { it: 'Backup fallito', en: 'Backup failed' },
  'snapshot.task.started': { it: 'Snapshot avviato', en: 'Snapshot started' },
  'snapshot.task.done': { it: 'Snapshot completato', en: 'Snapshot completed' },
  'snapshot.task.failed': { it: 'Snapshot fallito', en: 'Snapshot failed' },
  'notifications.recovered': { it: 'Problema risolto', en: 'Issue resolved' },
  'notifications.recovered.server': { it: 'Server nuovamente online', en: 'Server back online' },
  'notifications.recovered.node': { it: 'Nodo nuovamente online', en: 'Node back online' },
  'notifications.recovered.storage': { it: 'Storage nuovamente attivo', en: 'Storage back active' },
  'notifications.recovered.zfs': { it: 'Pool ZFS nuovamente sano', en: 'ZFS pool healthy again' },
  'notifications.recovered.cluster': { it: 'Quorum cluster ripristinato', en: 'Cluster quorum restored' },
  'notifications.recovered.ha': { it: 'Servizio HA ripristinato', en: 'HA service restored' },
  'notifications.recovered.backup': { it: 'Backup nuovamente aggiornato', en: 'Backup fresh again' },
  'notifications.recovered.disk': { it: 'Disco nuovamente sano', en: 'Disk healthy again' },
};

function fmtTime(ts, language) {
  try {
    return new Date(ts).toLocaleString(language === 'en' ? 'en-GB' : 'it-IT', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (_) {
    return String(ts);
  }
}

function ctxLine(label, value) {
  if (value === null || value === undefined || value === '') return null;
  return label + ': ' + String(value);
}

/* messaggio leggibile da un record notifica; fallback sicuro (mai raw object) */
function formatMessage(rec, language) {
  const lang = language === 'en' ? 'en' : 'it';
  const titleDef = TITLES[rec.titleKey];
  const title = titleDef ? titleDef[lang] : (SEV[rec.severity] ? SEV[rec.severity][lang] : 'Notifica');
  const sevDef = SEV[rec.severity];
  const header = rec.recovery
    ? '🟢 ' + (lang === 'it' ? 'RISOLTO' : 'RESOLVED') + ' — ' + title
    : (sevDef ? sevDef.icon + ' ' + (lang === 'it' ? sevDef.it : sevDef.en).toUpperCase() + ' — ' + title : title);
  const c = rec.context || {};
  const lines = [];
  lines.push(ctxLine(lang === 'it' ? 'Server' : 'Server', c.serverName || c.serverId));
  lines.push(ctxLine(lang === 'it' ? 'Nodo' : 'Node', c.node));
  lines.push(ctxLine(lang === 'it' ? 'Storage' : 'Storage', c.storage));
  lines.push(ctxLine(lang === 'it' ? 'Pool' : 'Pool', c.pool));
  lines.push(ctxLine(lang === 'it' ? 'Guest' : 'Guest', c.guestName || (c.guestId != null ? c.guestId : null)));
  lines.push(ctxLine(lang === 'it' ? 'Disco' : 'Disk', c.disk));
  const p = rec.params || {};
  if (p.pct !== undefined) lines.push((lang === 'it' ? 'Uso' : 'Usage') + ': ' + p.pct + '%');
  if (p.days !== undefined) lines.push((lang === 'it' ? 'Giorni' : 'Days') + ': ' + p.days);
  if (p.temp !== undefined) lines.push('Temp: ' + p.temp + '°C');
  if (p.n !== undefined) lines.push((lang === 'it' ? 'Conteggio' : 'Count') + ': ' + p.n);
  lines.push(ctxLine(lang === 'it' ? 'Ora' : 'Time', fmtTime(rec.ts, lang)));
  const body = lines.filter(Boolean).join('\n');
  return body ? header + '\n' + body : header;
}

/* ---------- coda delivery (concorrenza 1, isolata dal tick) ---------- */

function createTelegramDelivery(opts) {
  const sender = (opts && opts.sender) || createTelegramSender(opts);
  const getSettings = (opts && opts.getSettings) || (() => ({}));
  const updateDelivery = (opts && opts.updateDelivery) || (() => {});
  const log = (opts && opts.log) || (() => {});
  const queue = [];
  let busy = false;
  let stopped = false;

  /* filtro eventi: recovery usa telegram.events.recovery, altrimenti severity */
  function shouldSend(rec, set) {
    if (!set || set.enabled !== true) return false;
    if (!set.botToken || !set.chatId) return false;
    const ev = set.events || {};
    if (rec.recovery === true) return ev.recovery !== false;
    const key = rec.severity === 'success' ? 'success' : rec.severity;
    return ev[key] === true;
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length > 0) {
      const rec = queue.shift();
      const set = getSettings();
      if (!shouldSend(rec, set)) continue; /* filtrato: nessun delivery status */
      updateDelivery(rec.id, { provider: 'telegram', status: 'pending', at: Date.now() });
      try {
        const text = formatMessage(rec, set.language || 'it');
        const res = await sender.sendMessage(set.botToken, set.chatId, text);
        if (res.ok) {
          updateDelivery(rec.id, { provider: 'telegram', status: 'sent', at: Date.now() });
        } else {
          log('[telegram] invio fallito: ' + (res.code || res.status) + ' (id ' + rec.id + ')');
          updateDelivery(rec.id, { provider: 'telegram', status: 'failed', at: Date.now(), error: res.code || String(res.status) });
        }
      } catch (e) {
        log('[telegram] errore delivery: ' + e.message + ' (id ' + rec.id + ')');
        updateDelivery(rec.id, { provider: 'telegram', status: 'failed', at: Date.now(), error: 'delivery_error' });
      }
    }
    busy = false;
  }

  function enqueue(rec) {
    if (stopped || !rec || !rec.id) return;
    queue.push(rec);
    pump(); /* fire-and-forget: il tick del watchdog NON attende */
  }

  /* flush bounded per graceful shutdown: attende al più FLUSH_SHUTDOWN_MS */
  function flush() {
    return new Promise((resolve) => {
      const deadline = Date.now() + FLUSH_SHUTDOWN_MS;
      const check = () => {
        if (queue.length === 0 && !busy) return resolve();
        if (Date.now() >= deadline) return resolve();
        const t = setTimeout(check, 50);
        if (typeof t.unref === 'function') t.unref();
      };
      check();
    });
  }

  function stop() {
    stopped = true;
    /* il pump completa la coda già accodata (flush bounded);
       stopped blocca solo i NUOVI enqueue */
    return flush();
  }

  return {
    enqueue, flush, stop, formatMessage,
    getQueueLength: () => queue.length,
    get isBusy() { return busy; },
  };
}

module.exports = {
  createTelegramSender,
  createTelegramDelivery,
  formatMessage,
  mapTelegramError,
  TELEGRAM_API,
  SEND_TIMEOUT_MS,
};
