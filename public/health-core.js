'use strict';

/* HealthCore — primitive condivise del motore Health.
   Pattern UMD: nel browser definisce window.HealthCore (script tag), in Node.js
   viene esportato con module.exports (require). Nessun bundler.
   Collocazione in public/: il server serve solo public/ come asset statici,
   quindi il file deve stare qui per essere caricato dal browser senza introdurre
   una route statica dedicata; il backend lo richiede come modulo normale.
   Le funzioni di stato ricevono la Map 'samples' come primo parametro:
   UI e backend mantengono stati separati senza duplicare la logica. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HealthCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* soglie quantitative (rapporti 0..1) */
  const HEALTH_THRESHOLDS = {
    node: {
      cpu: { warning: 0.8, critical: 0.95 },
      ram: { warning: 0.9, critical: 0.96 },
      rootfs: { warning: 0.8, critical: 0.9 }
    },
    guest: {
      cpu: { warning: 0.8, critical: 0.95 },
      ram: { warning: 0.85, critical: 0.95 }
    },
    lxc: { disk: { warning: 0.8, critical: 0.9 } }
  };

  /* finestre temporali (secondi) per gli alert informativi */
  const HEALTH_RECENT_REBOOT_S = 15 * 60;
  const HEALTH_RECENT_RESTART_S = 5 * 60;

  const HEALTH_SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

  /* task alerts: allowlist -> severity; eventi conclusi, nessuna isteresi */
  const HEALTH_TASK_ALLOWLIST = {
    vzdump: 'critical',
    vzstart: 'warning', qmstart: 'warning',
    vzstop: 'warning', vzshutdown: 'warning', qmstop: 'warning', qmshutdown: 'warning',
    vzreboot: 'warning', qmreboot: 'warning',
    qmmigrate: 'warning', qmsnapshot: 'warning',
    vzrestore: 'warning', qmrestore: 'warning', qmclone: 'warning'
  };
  const HEALTH_TASK_WINDOW_S = 24 * 3600;

  const HEALTH_ZFS_BAD = ['DEGRADED', 'FAULTED', 'UNAVAIL'];
  const HEALTH_ZFS_ERRORS_OK = 'No known data errors';
  const HEALTH_LOAD_WARN_MULT = 1.5;
  const HEALTH_DISK_WEAR_CRITICAL = 5;

  function healthRatio(value, max) {
    return typeof value === 'number' && Number.isFinite(value) &&
      typeof max === 'number' && Number.isFinite(max) && max > 0 ? value / max : null;
  }

  function healthThresholdSeverity(ratio, thresholds) {
    if (ratio === null) return null;
    if (ratio >= thresholds.critical) return 'critical';
    if (ratio >= thresholds.warning) return 'warning';
    return null;
  }

  /* applica lo stato di un check: severity null rimuove lo stato (e il firstSeen).
     firstSeen resta stabile finché l'alert resta attivo; nuovo ts alla ricomparsa. */
  function healthApplyState(samples, id, entry, severity) {
    if (severity === null) {
      entry.severity = null;
      entry.firstSeen = null;
      samples.delete(id);
      return;
    }
    if (entry.severity !== severity && !entry.firstSeen) entry.firstSeen = Date.now();
    entry.severity = severity;
    samples.set(id, entry);
  }

  /* check immediato (senza isteresi): offline/unknown/stopped/rootfs/disk/info */
  function healthImmediate(samples, id, severity) {
    const entry = samples.get(id) || { severity: null, firstSeen: null };
    healthApplyState(samples, id, entry, severity);
    return entry;
  }

  /* isteresi CPU/RAM: 2 campioni consecutivi per cambiare livello.
     Mantiene il livello corrente finché non c'è una conferma, quindi:
     NORMAL -> 96% x2 = CRITICAL; WARNING -> 96% x2 = CRITICAL;
     CRITICAL -> 90% x2 = WARNING (downgrade, non sparire); CRITICAL -> 20% x2 = rimosso. */
  function healthHysteresis(samples, id, value, thresholds) {
    const entry = samples.get(id) || { crit: 0, warn: 0, ok: 0, severity: null, firstSeen: null };
    if (value >= thresholds.critical) {
      entry.crit += 1; entry.warn = 0; entry.ok = 0;
    } else if (value >= thresholds.warning) {
      entry.warn += 1; entry.crit = 0; entry.ok = 0;
    } else {
      entry.ok += 1; entry.crit = 0; entry.warn = 0;
    }
    let desired = null;
    if (entry.crit >= 2) desired = 'critical';
    else if (entry.warn >= 2) desired = 'warning';
    else if (entry.ok >= 2) desired = null;
    else desired = entry.severity; /* campioni insufficienti: mantieni lo stato corrente */
    if (desired === null && entry.severity === null) {
      /* nessun alert attivo: conserva lo streak (accumulo campioni) senza firstSeen */
      samples.set(id, entry);
      return entry;
    }
    healthApplyState(samples, id, entry, desired);
    return entry;
  }

  /* stati/eventi: alert immediato quando isBad, clear solo dopo N osservazioni
     sane consecutive (evita flap su timeout singoli o transitori). */
  function healthState(samples, id, severity, isBad, clearAfter) {
    const entry = samples.get(id) || { ok: 0, severity: null, firstSeen: null };
    if (isBad) {
      entry.ok = 0;
      healthApplyState(samples, id, entry, severity);
      return entry;
    }
    entry.ok += 1;
    if (entry.severity !== null && entry.ok >= (clearAfter || 1)) {
      healthApplyState(samples, id, entry, null);
      return entry;
    }
    samples.set(id, entry);
    return entry;
  }

  /* load average: INFO se load1 >= cpus, WARNING se >= 1.5*cpus (2 campioni,
     downgrade a scalino; MAI CRITICAL). */
  function healthLoadHysteresis(samples, id, load1, cpus) {
    const entry = samples.get(id) || { warn: 0, info: 0, ok: 0, severity: null, firstSeen: null };
    const warnAt = cpus * HEALTH_LOAD_WARN_MULT;
    if (load1 >= warnAt) { entry.warn += 1; entry.info = 0; entry.ok = 0; }
    else if (load1 >= cpus) { entry.info += 1; entry.warn = 0; entry.ok = 0; }
    else { entry.ok += 1; entry.warn = 0; entry.info = 0; }
    let desired = null;
    if (entry.warn >= 2) desired = 'warning';
    else if (entry.info >= 2) desired = 'info';
    else if (entry.ok >= 2) desired = null;
    else desired = entry.severity;
    if (desired === null && entry.severity === null) {
      samples.set(id, entry);
      return entry;
    }
    healthApplyState(samples, id, entry, desired);
    return entry;
  }

  return {
    HEALTH_THRESHOLDS,
    HEALTH_RECENT_REBOOT_S,
    HEALTH_RECENT_RESTART_S,
    HEALTH_SEVERITY_ORDER,
    HEALTH_TASK_ALLOWLIST,
    HEALTH_TASK_WINDOW_S,
    HEALTH_ZFS_BAD,
    HEALTH_ZFS_ERRORS_OK,
    HEALTH_LOAD_WARN_MULT,
    HEALTH_DISK_WEAR_CRITICAL,
    healthRatio,
    healthThresholdSeverity,
    healthApplyState,
    healthImmediate,
    healthHysteresis,
    healthState,
    healthLoadHysteresis,
  };
});
