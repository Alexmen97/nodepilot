'use strict';

/* Alert Engine — watchdog backend 24/7 per le notifiche NodePilot.
   Source of truth: lo stato è persistito in alert-state.json (600, atomico).
   Il frontend NON genera eventi: tutto nasce qui (o da observeSmart on-demand).
   Lifecycle: start()/stop(); timer unico non concorrente con unref();
   nessuna chiamata dopo stop() (graceful shutdown). */

const fs = require('fs');
const path = require('path');
const HealthCore = require('./public/health-core.js');

const TICK_MS = 30 * 1000;
const GAP_GRACE_MS = 60 * 1000;        /* gap tra tick > 60s -> 1 tick di grace */
const TASK_DEDUP_TTL_MS = 25 * 3600 * 1000; /* dedup task falliti (finestra 24h + margine) */
const TASK_NOT_FOUND_LIMIT = 3;         /* 404 consecutivi -> cleanup controllato */

const SOURCE_TTL = {
  storage: 60 * 1000,
  zfs: 120 * 1000,
  cluster: 60 * 1000,
  tasks: 60 * 1000,
  backupAge: 300 * 1000,
};

function createAlertEngine(opts) {
  const dataDir = (opts && opts.dataDir) || __dirname;
  const stateFile = path.join(dataDir, 'alert-state.json');
  const collectors = (opts && opts.collectors) || {};
  const notify = (opts && opts.notify) || (() => {});
  const getSettings = (opts && opts.getSettings) || (() => ({}));
  const log = (opts && opts.log) || (() => {});
  const now = (opts && opts.now) || Date.now;

  const samples = new Map();     /* metriche quantitative (HealthCore) */
  const states = new Map();      /* stati booleani persistiti */
  const pendingTasks = new Map();/* upid -> { kind, serverId, node, guestKey, guestLabel, startedAt, notifiedStarted } */
  const taskDedup = new Map();   /* upid -> ts notificato (dedup task falliti) */
  const lastSourceAt = {};

  let lastTickAt = 0;
  let timer = null;
  let ticking = false;
  let firstTick = true;
  let stopped = false;
  let dirty = false;
  let stateLoaded = false;
  let startupGracePending = false;      /* primo tick dopo stato vecchio: grace */

  /* categorie dei check per il cleanup: la mappa dice quale fonte alimenta
     quale prefisso. Un check viene rimosso SOLO se la sua fonte è stata
     raccolta con successo nel tick corrente e il check non è più presente. */
  const SOURCE_OF_PREFIX = [
    ['server:', 'status'], ['node:', 'status'],
    ['storage:', 'storage'],
    ['zfs:', 'zfs'],
    ['cluster:', 'cluster'], ['ha:', 'cluster'],
    ['backupAge:', 'backupAge'],
  ];
  const collectedOk = {
    status: false, storage: false, zfs: false,
    cluster: false, tasks: false, backupAge: false,
  };

  function loadState() {
    if (stateLoaded) return;
    stateLoaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!raw || typeof raw !== 'object') throw new Error('formato');
      const age = now() - (raw.savedAt || 0);
      /* savedAt è SOLO diagnostico: lo stato valido viene sempre caricato e
         riconciliato. Uno stato vecchio attiva la startup grace (nessun falso
         bad al primo tick), mai il riavvio da zero. */
      for (const [id, entry] of (raw.samples || [])) {
        if (id && entry && typeof entry === 'object') samples.set(id, entry);
      }
      for (const [id, entry] of (raw.states || [])) {
        if (id && entry && typeof entry === 'object') states.set(id, entry);
      }
      startupGracePending = !Number.isFinite(age) || age > GAP_GRACE_MS;
      log('[alert-engine] stato caricato (' + samples.size + ' samples, ' + states.size +
        ' states, eta ' + Math.floor((Number.isFinite(age) ? age : 0) / 3600000) + 'h)' +
        (startupGracePending ? ' -> startup grace' : ''));
    } catch (_) {
      /* file mancante o corrotto: fallback sicuro + bootstrap silenzioso */
      samples.clear();
      states.clear();
      startupGracePending = false; /* firstTick basta per il bootstrap */
      log('[alert-engine] alert-state assente/corrotto: bootstrap silenzioso');
    }
  }

  function saveState() {
    const payload = {
      savedAt: now(),
      samples: Array.from(samples.entries()),
      states: Array.from(states.entries()),
    };
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
    dirty = false;
  }

  function emit(rec) {
    notify(Object.assign({ ts: now() }, rec));
  }

  /* ---------- transizioni di stato (anti-flap, escalation, recovery) ---------- */

  function transition(checkId, st, desired, ctx, prevOverride) {
    const t = now();
    const prev = prevOverride !== undefined ? prevOverride : st.severity;
    if (prev === null && desired !== null) {
      /* nuovo alert: soppresso nel primo tick (baseline silenziosa) */
      if (!firstTick || (ctx && ctx.forceBaseline)) {
        st.alertNotified = true;
        emit({
          category: ctx.category,
          severity: desired,
          titleKey: ctx.titleKey,
          params: ctx.params || {},
          context: ctx.context || {},
          recovery: false,
          checkId,
        });
      }
      st.firstSeen = t;
    } else if (prev !== null && desired === null) {
      /* recovery: emessa anche al primo tick se l'alert era notificato
         (problema realmente esistito prima del restart) */
      if (st.alertNotified) {
        emit({
          category: ctx.category,
          severity: prev,
          titleKey: ctx.recoveryTitleKey || 'notifications.recovered',
          params: ctx.params || {},
          context: ctx.context || {},
          recovery: true,
          checkId,
        });
      }
      st.alertNotified = false;
    } else if (prev !== null && desired !== null && prev !== desired) {
      /* escalation / de-escalation */
      st.alertNotified = true;
      emit({
        category: ctx.category,
        severity: desired,
        titleKey: ctx.titleKey,
        params: ctx.params || {},
        context: ctx.context || {},
        recovery: false,
        checkId,
      });
    }
    st.severity = desired;
    st.lastTransition = t;
    dirty = true;
  }

  /* stato booleano con conferma: offline/failure richiede N tick consecutivi,
     clear dopo M osservazioni sane. In grace i bad non avanzano (wake). */
  function observeState(checkId, isBad, severity, ctx, grace) {
    let st = states.get(checkId);
    seenThisTick.add(checkId);
    if (!st) {
      st = { severity: null, firstSeen: null, lastObserved: null, lastTransition: null, bad: 0, ok: 0, alertNotified: false };
    }
    st.lastObserved = now();
    if (grace && isBad) {
      states.set(checkId, st);
      return st; /* grace: niente conferme negative */
    }
    if (isBad) { st.bad += 1; st.ok = 0; }
    else { st.ok += 1; st.bad = 0; }
    const confirmBad = (ctx && ctx.confirmBad) || 1;
    const confirmOk = (ctx && ctx.confirmOk) || 2;
    let desired = st.severity;
    if (isBad && st.bad >= confirmBad) desired = severity;
    else if (!isBad && st.severity !== null && st.ok >= confirmOk) desired = null;
    if (desired !== st.severity) transition(checkId, st, desired, ctx);
    states.set(checkId, st);
    return st;
  }

  /* metrica quantitativa: riusa HealthCore.healthHysteresis (2 campioni) */
  function observeHysteresis(checkId, value, thresholds, ctx, grace) {
    seenThisTick.add(checkId);
    const prev = (samples.get(checkId) || {}).severity || null;
    if (grace && value >= thresholds.warning) {
      return; /* grace: niente conferme negative */
    }
    const entry = HealthCore.healthHysteresis(samples, checkId, value, thresholds);
    if (entry.severity !== prev) {
      /* l'entry HC è già aggiornata da healthHysteresis: la transizione deve
         confrontare con la severità PRECEDENTE per emettere alert/recovery */
      transition(checkId, entry, entry.severity, ctx, prev);
    }
  }

  /* ---------- fonti (tick sequenziali, mai concorrenti) ---------- */

  async function checkServers(grace) {
    let status;
    try {
      status = await collectors.getStatus();
    } catch (e) {
      log('[alert-engine] getStatus fallito: ' + e.message);
      return;
    }
    collectedOk.status = true;
    const servers = (status && status.servers) || [];
    for (const s of servers) {
      const sid = s.id || '';
      const sname = s.name || sid;
      const serverCtx = {
        category: 'server',
        titleKey: 'health.serverOffline',
        recoveryTitleKey: 'notifications.recovered.server',
        confirmBad: 2,
        confirmOk: 2,
        params: { name: sname },
        context: { serverId: sid, serverName: sname },
      };
      observeState('server:' + sid + ':offline', !s.online, 'critical', serverCtx, grace);
      if (!s.online) {
        /* server offline: i nodi non sono osservabili; preserva i loro check
           (nessuna rimozione silenziosa e nessun falso recovery) */
        for (const id of Array.from(states.keys())) {
          if (id.startsWith('node:' + sid + ':')) seenThisTick.add(id);
        }
        continue;
      }
      const nodes = (s.nodes) || [];
      for (const n of nodes) {
        const nname = n.name || '?';
        const nodeCtx = {
          category: 'node',
          titleKey: 'health.nodeOffline',
          recoveryTitleKey: 'notifications.recovered.node',
          confirmBad: 2,
          confirmOk: 2,
          params: { node: nname },
          context: { serverId: sid, serverName: sname, node: nname },
        };
        observeState('node:' + sid + ':' + nname + ':offline', n.status !== 'online', 'critical', nodeCtx, grace);
      }
    }
  }

  async function checkStorage(grace) {
    let storages;
    try {
      storages = await collectors.getStorage();
    } catch (e) {
      log('[alert-engine] getStorage fallito: ' + e.message);
      return;
    }
    collectedOk.storage = true;
    const set = getSettings() || {};
    const th = {
      warning: (set.storage && set.storage.warning) / 100 || 0.85,
      critical: (set.storage && set.storage.critical) / 100 || 0.9,
    };
    for (const st of (storages || [])) {
      const sid = st.serverId || '';
      const sname = st.serverName || sid;
      const snode = st.node || '';
      const snameS = st.storage || '';
      const base = 'storage:' + sid + ':' + snode + ':' + snameS;
      const ctx = {
        category: 'storage',
        params: { storage: snameS },
        context: { serverId: sid, serverName: sname, node: snode, storage: snameS },
      };
      observeState(base + ':offline', st.active === false, 'warning',
        Object.assign({}, ctx, {
          titleKey: 'health.storageOffline',
          recoveryTitleKey: 'notifications.recovered.storage',
          confirmBad: 1,
          confirmOk: 1,
        }), grace);
      const ratio = typeof st.usedFraction === 'number' && Number.isFinite(st.usedFraction)
        ? st.usedFraction
        : (st.total > 0 && typeof st.used === 'number' ? st.used / st.total : null);
      if (ratio !== null) {
        observeHysteresis(base + ':usage', Math.max(0, Math.min(1, ratio)), th,
          Object.assign({}, ctx, {
            titleKey: 'health.storageHigh',
            recoveryTitleKey: 'notifications.recovered.storage',
            params: { storage: snameS, pct: Math.round(ratio * 100) },
          }), grace);
      } else {
        samples.delete(base + ':usage'); /* totali non disponibili: metrica non valutabile */
        dirty = true;
      }
    }
  }

  async function checkZfs(grace) {
    let pools;
    try {
      pools = await collectors.getZfs();
    } catch (e) {
      log('[alert-engine] getZfs fallito: ' + e.message);
      return;
    }
    collectedOk.zfs = true;
    for (const pool of (pools || [])) {
      const sid = pool.serverId || '';
      const sname = pool.serverName || sid;
      const snode = pool.node || '';
      const pname = pool.name || '';
      const base = 'zfs:' + sid + ':' + snode + ':' + pname;
      const stateStr = pool.detail && typeof pool.detail.state === 'string' && pool.detail.state !== ''
        ? pool.detail.state
        : (pool.health || '');
      const badState = HealthCore.HEALTH_ZFS_BAD.indexOf(String(stateStr).toUpperCase()) !== -1;
      const ctx = {
        category: 'zfs',
        params: { pool: pname, state: stateStr },
        context: { serverId: sid, serverName: sname, node: snode, pool: pname },
      };
      observeState(base + ':degraded', badState, 'critical',
        Object.assign({}, ctx, {
          titleKey: 'health.zfsDegraded',
          recoveryTitleKey: 'notifications.recovered.zfs',
          confirmBad: 1,
          confirmOk: 2,
        }), grace);
      const errs = pool.detail ? pool.detail.errors : null;
      const hasErrors = typeof errs === 'string' && errs.trim() !== '' && errs.trim() !== HealthCore.HEALTH_ZFS_ERRORS_OK;
      observeState(base + ':errors', hasErrors, 'critical',
        Object.assign({}, ctx, {
          titleKey: 'health.zfsErrors',
          recoveryTitleKey: 'notifications.recovered.zfs',
          params: { pool: pname, errors: errs },
          confirmBad: 1,
          confirmOk: 2,
        }), grace);
    }
  }

  async function checkCluster(grace) {
    let clusters;
    try {
      clusters = await collectors.getCluster();
    } catch (e) {
      log('[alert-engine] getCluster fallito: ' + e.message);
      return;
    }
    collectedOk.cluster = true;
    for (const c of (clusters || [])) {
      const sid = c.serverId || '';
      const sname = c.serverName || sid;
      if (c.cluster === true) {
        const quorumLost = c.quorate !== 1;
        observeState('cluster:' + sid + ':quorum', quorumLost, 'critical', {
          category: 'cluster',
          titleKey: 'health.quorumLost',
          recoveryTitleKey: 'notifications.recovered.cluster',
          confirmBad: 2,
          confirmOk: 2,
          params: {},
          context: { serverId: sid, serverName: sname },
        }, grace);
      }
      const services = (c.ha && Array.isArray(c.ha.services) && c.ha.services.length)
        ? c.ha.services
        : (c.haResources || []);
      for (const sv of services) {
        const sidKey = sv.sid || (sv.type ? sv.type + ':' + (sv.node || '?') : '?');
        const state = sv.state || '';
        observeState('ha:' + sid + ':' + sidKey + ':error', state === 'error', 'critical', {
          category: 'ha',
          titleKey: 'health.haError',
          recoveryTitleKey: 'notifications.recovered.ha',
          confirmBad: 2,
          confirmOk: 2,
          params: { sid: sidKey },
          context: { serverId: sid, serverName: sname, node: sv.node || null },
        }, grace);
      }
    }
  }

  /* task falliti (allowlist, finestra 24h, dedup per UPID) + UPID monitorati */
  async function checkTasks(grace) {
    let events;
    try {
      events = await collectors.getTasks();
    } catch (e) {
      log('[alert-engine] getTasks fallito: ' + e.message);
      return;
    }
    collectedOk.tasks = true;
    const nowS = Math.floor(now() / 1000);
    for (const t of (events || [])) {
      const severity = HealthCore.HEALTH_TASK_ALLOWLIST[t.type];
      if (!severity) continue;
      if (t.status === 'OK') continue;
      const endtime = Number(t.endtime) || 0;
      if (!(endtime > 0)) continue;
      const starttime = Number(t.starttime) || 0;
      if ((endtime || starttime) < nowS - HealthCore.HEALTH_TASK_WINDOW_S) continue;
      if (!t.upid || taskDedup.has(t.upid)) continue;
      taskDedup.set(t.upid, now());
      const sid = t.serverId || '';
      const sname = t.serverName || sid;
      emit({
        category: 'task',
        severity: severity === 'critical' ? 'critical' : 'warning',
        titleKey: severity === 'critical' ? 'health.backupFailed' : 'health.taskFailed',
        params: { taskType: t.type, upid: t.upid },
        context: { serverId: sid, serverName: sname, node: t.node || null },
        recovery: false,
        checkId: 'task:' + sid + ':' + t.upid,
      });
      dirty = true;
    }
    /* UPID monitorati (creati da NodePilot): started -> completed/failed.
       Classificazione terminale basata sugli stati reali dell'API Proxmox
       /nodes/{node}/tasks/{upid}/status:
         - status === 'stopped'            -> task terminato
         - exitstatus presente (anche con status non stopped, es. race PVE)
                                            -> task terminato
         - status === 'running'            -> task in corso (resta pending)
         - { status: 'notfound' } (404 o server rimosso)
                                            -> non più reperibile: streak e cleanup
       exitstatus 'OK' -> SUCCESS; qualunque altro (WARN/ERR/interrupted/
       assente) -> FAILED. Coerente con la route /api/tasks/status esistente. */
    if (typeof collectors.getTaskStatus === 'function' && pendingTasks.size > 0) {
      for (const [upid, pt] of Array.from(pendingTasks.entries())) {
        let st;
        try {
          st = await collectors.getTaskStatus({ serverId: pt.serverId, node: pt.node, upid });
        } catch (e) {
          continue; /* errore temporaneo: riprova al prossimo tick */
        }
        if (!st) continue;
        if (st.status === 'notfound') {
          /* task non più reperibile: contatore; dopo TASK_NOT_FOUND_LIMIT
             osservazioni consecutive -> cleanup controllato (niente loop) */
          pt.notFound = (pt.notFound || 0) + 1;
          if (pt.notFound >= TASK_NOT_FOUND_LIMIT) {
            pendingTasks.delete(upid);
            log('[alert-engine] upid non più reperibile, cleanup: ' + String(upid).slice(0, 40) + '...');
            dirty = true;
          }
          continue;
        }
        const terminal = st.status === 'stopped' ||
          (st.exitstatus !== undefined && st.exitstatus !== null);
        if (terminal) {
          const ok = st.exitstatus === 'OK';
          const kind = pt.kind === 'snapshot' ? 'snapshot' : 'backup';
          emit({
            category: 'task',
            severity: ok ? 'success' : 'critical',
            titleKey: ok
              ? (kind === 'snapshot' ? 'snapshot.task.done' : 'backup.task.done')
              : (kind === 'snapshot' ? 'snapshot.task.failed' : 'backup.task.failed'),
            params: {},
            context: {
              serverId: pt.serverId,
              node: pt.node,
              guestName: pt.guestLabel || null,
            },
            recovery: false,
            checkId: 'upid:' + upid + ':done',
          });
          pendingTasks.delete(upid);
          dirty = true;
        } else if (!pt.notifiedStarted) {
          pt.notifiedStarted = true;
          const kind = pt.kind === 'snapshot' ? 'snapshot' : 'backup';
          emit({
            category: 'task',
            severity: 'info',
            titleKey: kind === 'snapshot' ? 'snapshot.task.started' : 'backup.task.started',
            params: {},
            context: {
              serverId: pt.serverId,
              node: pt.node,
              guestName: pt.guestLabel || null,
            },
            recovery: false,
            checkId: 'upid:' + upid + ':started',
          });
          dirty = true;
        }
      }
    }
  }

  /* età dell'ultimo backup per guest (storage content, TTL 5 min) */
  async function checkBackupAge(grace) {
    let data;
    try {
      data = await collectors.getBackupAge();
    } catch (e) {
      log('[alert-engine] getBackupAge fallito: ' + e.message);
      return;
    }
    collectedOk.backupAge = true;
    const set = getSettings() || {};
    const warnDays = (set.backupAge && set.backupAge.warningDays) || 7;
    const critDays = (set.backupAge && set.backupAge.criticalDays) || 14;
    const nowS = Math.floor(now() / 1000);
    for (const bs of (data || [])) {
      const sid = bs.serverId || '';
      const sname = bs.serverName || sid;
      const lastByGuest = new Map();
      for (const b of (bs.backups || [])) {
        if (!b || b.vmid == null) continue;
        const k = (b.guestType || '?') + ':' + b.vmid;
        const prev = lastByGuest.get(k);
        if (!prev || (b.ctime || 0) > (prev.ctime || 0)) lastByGuest.set(k, b);
      }
      for (const [k, b] of lastByGuest) {
        const parts = k.split(':');
        const gtype = parts[0];
        const vmid = parts[1];
        if (!(b.ctime > 0)) continue;
        const days = (nowS - b.ctime) / 86400;
        let severity = null;
        if (days >= critDays) severity = 'critical';
        else if (days >= warnDays) severity = 'warning';
        const checkId = 'backupAge:' + sid + ':' + gtype + ':' + vmid;
        const ctx = {
          category: 'backup',
          titleKey: 'health.backupAge',
          recoveryTitleKey: 'notifications.recovered.backup',
          params: { days: Math.floor(days) },
          context: { serverId: sid, serverName: sname, guestType: gtype, guestId: Number(vmid) },
          confirmBad: 1,
          confirmOk: 1,
        };
        observeState(checkId, severity !== null, severity || 'warning', ctx, grace);
      }
    }
  }

  /* ---------- API pubblica ---------- */

  async function tickOnce() {
    if (ticking || stopped) return;
    ticking = true;
    if (!stateLoaded) loadState();
    seenThisTick.clear();
    collectedOk.status = false;
    collectedOk.storage = false;
    collectedOk.zfs = false;
    collectedOk.cluster = false;
    collectedOk.tasks = false;
    collectedOk.backupAge = false;
    const t = now();
    const gap = lastTickAt ? t - lastTickAt : 0;
    lastTickAt = t;
    const grace = gap > GAP_GRACE_MS || startupGracePending;
    startupGracePending = false;
    if (grace) log('[alert-engine] gap ' + gap + 'ms rilevato: tick di grace');
    try {
      await checkServers(grace);
      if (sourceDue('storage')) await checkStorage(grace);
      if (sourceDue('zfs')) await checkZfs(grace);
      if (sourceDue('cluster')) await checkCluster(grace);
      if (sourceDue('tasks')) await checkTasks(grace);
      if (sourceDue('backupAge')) await checkBackupAge(grace);
    } catch (e) {
      log('[alert-engine] tick error: ' + e.message);
    }
    /* cleanup: rimuove SOLO i check la cui fonte è stata raccolta con successo
       in questo tick e che non esistono più nel payload (risorsa rimossa).
       Se la fonte fallisce o non è dovuta, gli stati restano intatti. */
    const sourceOf = (id) => {
      for (const [prefix, source] of SOURCE_OF_PREFIX) {
        if (id.startsWith(prefix)) return source;
      }
      return null;
    };
    for (const id of Array.from(states.keys())) {
      const source = sourceOf(id);
      if (source && collectedOk[source] && !seenThisTick.has(id)) {
        states.delete(id);
        dirty = true;
      }
    }
    for (const id of Array.from(samples.keys())) {
      const source = sourceOf(id);
      if (source && collectedOk[source] && !seenThisTick.has(id)) {
        samples.delete(id);
        dirty = true;
      } else if (!source) {
        /* check on-demand (smart): TTL 30 giorni per igiene */
        const entry = samples.get(id);
        if (entry && entry.firstSeen && now() - entry.firstSeen > 30 * 24 * 3600 * 1000) {
          samples.delete(id);
          dirty = true;
        }
      }
    }
    for (const id of Array.from(states.keys())) {
      const source = sourceOf(id);
      if (!source) {
        const entry = states.get(id);
        if (entry && entry.lastObserved && now() - entry.lastObserved > 30 * 24 * 3600 * 1000) {
          states.delete(id);
          dirty = true;
        }
      }
    }
    for (const [upid, ts] of Array.from(taskDedup.entries())) {
      if (now() - ts > TASK_DEDUP_TTL_MS) taskDedup.delete(upid);
    }
    if (dirty) saveState();
    firstTick = false;
    ticking = false;
  }

  const seenThisTick = new Set();

  function sourceDue(name) {
    const t = now();
    if (!lastSourceAt[name]) { lastSourceAt[name] = t; return true; }
    if (t - lastSourceAt[name] >= SOURCE_TTL[name]) {
      lastSourceAt[name] = t;
      return true;
    }
    return false;
  }

  function start() {
    if (timer) return;
    loadState();
    log('[alert-engine] watchdog avviato (tick ' + (TICK_MS / 1000) + 's)');
    timer = setInterval(() => { tickOnce(); }, TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
    tickOnce(); /* primo tick immediato */
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (dirty) saveState();
    log('[alert-engine] watchdog fermato');
  }

  function trackTask(upid, serverId, node, kind, guestKey, guestLabel) {
    if (!upid) return;
    pendingTasks.set(upid, {
      kind, serverId, node, guestKey, guestLabel,
      startedAt: now(),
      notifiedStarted: false,
    });
  }

  /* lettura SMART on-demand (mai automatica): FAILED/settori/temp/wear */
  function observeSmart(smart, ctx) {
    if (!smart || !smart.checkedAt) return;
    const set = getSettings() || {};
    const dset = (set.disk) || {};
    const base = 'smart:' + (ctx.serverId || '') + ':' + (ctx.node || '') + ':' + (ctx.disk || '');
    const smartCtx = {
      category: 'disk',
      confirmBad: 1,
      confirmOk: 1,
      forceBaseline: true,
      context: {
        serverId: ctx.serverId,
        serverName: ctx.serverName,
        node: ctx.node,
        disk: ctx.disk,
      },
    };
    observeState(base + ':failed', smart.health === 'FAILED', 'critical',
      Object.assign({}, smartCtx, {
        titleKey: 'health.diskFailed',
        recoveryTitleKey: 'notifications.recovered.disk',
        params: { disk: ctx.disk },
      }), false);
    const sectors = [
      ['pending', 'health.diskPending'],
      ['reallocated', 'health.diskReallocated'],
      ['offlineUncorrectable', 'health.diskUncorrectable'],
    ];
    for (const [field, titleKey] of sectors) {
      const v = smart[field];
      if (typeof v !== 'number') continue;
      observeState(base + ':' + field, v > 0, 'warning',
        Object.assign({}, smartCtx, {
          titleKey,
          recoveryTitleKey: 'notifications.recovered.disk',
          params: { disk: ctx.disk, n: v },
        }), false);
    }
    if (typeof smart.temperature === 'number' && Number.isFinite(smart.temperature)) {
      const tempTh = {
        warning: (dset.temp && dset.temp.warning) || 55,
        critical: (dset.temp && dset.temp.critical) || 65,
      };
      /* lettura on-demand singola: notifica immediata oltre soglia
         (niente isteresi a 2 campioni su una lettura esplicita) */
      const sev = smart.temperature >= tempTh.critical ? 'critical'
        : (smart.temperature >= tempTh.warning ? 'warning' : null);
      observeState(base + ':temp', sev !== null, sev || 'warning',
        Object.assign({}, smartCtx, {
          titleKey: 'health.diskTemp',
          recoveryTitleKey: 'notifications.recovered.disk',
          params: { disk: ctx.disk, temp: Math.round(smart.temperature) },
        }), false);
    }
    if (typeof smart.wearRemaining === 'number' && smart.wearRemaining >= 0 && smart.wearRemaining <= 100) {
      const warn = (dset.wear && dset.wear.warning) || 10;
      const sev = smart.wearRemaining <= HealthCore.HEALTH_DISK_WEAR_CRITICAL
        ? 'critical'
        : (smart.wearRemaining <= warn ? 'warning' : null);
      const prev = (samples.get(base + ':wear') || {}).severity || null;
      if (sev === null) {
        const entry = samples.get(base + ':wear');
        if (entry && entry.severity !== null) {
          samples.delete(base + ':wear');
          transition(base + ':wear', entry, null, Object.assign({}, smartCtx, {
            titleKey: 'health.diskWear',
            recoveryTitleKey: 'notifications.recovered.disk',
            params: { disk: ctx.disk },
          }));
        }
      } else if (sev !== prev) {
        const entry = samples.get(base + ':wear') || { severity: null, firstSeen: null, alertNotified: false };
        transition(base + ':wear', entry, sev, Object.assign({}, smartCtx, {
          titleKey: 'health.diskWear',
          recoveryTitleKey: 'notifications.recovered.disk',
          params: { disk: ctx.disk, pct: Math.round(smart.wearRemaining) },
        }));
        samples.set(base + ':wear', entry);
      }
    }
    if (dirty) saveState();
  }

  return {
    start, stop, tickOnce, trackTask, observeSmart,
    getStateSize: () => ({ samples: samples.size, states: states.size }),
    getPendingCount: () => pendingTasks.size,
    get stateFile() { return stateFile; },
  };
}

module.exports = { createAlertEngine, TICK_MS, SOURCE_TTL };
