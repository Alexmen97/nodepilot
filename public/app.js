'use strict';

/* ---------- stato ---------- */

const state = {
  status: null,
  health: null,
  config: { servers: [], refreshMs: 10000, autoRefreshEnabled: true, theme: 'system', language: 'it', tourCompleted: false },
  history: { cpu: [], ram: [] },
  busy: new Set(),
  editingServerId: null,
  tourRunning: false,
  isRefreshing: false,
  refreshQueued: false,
};

const $ = (id) => document.getElementById(id);

/* ---------- autenticazione frontend (Fase 2) ---------- */

const authState = { authenticated: false, user: null };

/* UX Polish V1.1: stato del sottotitolo e conteggi per il cambio lingua senza refetch */
let statusLoadedOnce = false;
let lastOnlineCount = 0;
let lastServerCount = 0;
let authExpiryHandled = false;
let authChannel = null;
try { authChannel = new BroadcastChannel('homelab-auth'); } catch (_) { authChannel = null; }
/* modale cambio password: durante il submit la chiusura e' bloccata */
let changePasswordBusy = false;

/* wrapper fetch centralizzato: un SOLO flusso 401 -> sessione scaduta */
const __origFetch = window.fetch;
window.fetch = function (input, init) {
  const p = __origFetch.apply(this, arguments);
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.indexOf('/api/') === 0 && url.indexOf('/api/auth/') !== 0) {
    p.then((res) => {
      if (res.status === 401) handleSessionExpired();
      /* indicatore offline: si spegne SOLO su una chiamata API riuscita */
      if (res.ok && url.indexOf('/api/status') === 0) setOfflineUi(false);
    }).catch(() => {
      /* errore di rete reale (non HTTP): fonte primaria dell'indicatore offline */
      setOfflineUi(true);
    });
  }
  return p;
};

/* indicatore offline informativo (UX Polish V1.1): guidato dai fallimenti REALI
   delle chiamate API; navigator.onLine mostra ma NON nasconde mai; non sostituisce
   la gestione errori esistente (401/refresh) e non blocca mai la UI. */
function setOfflineUi(offline) {
  const chip = $('offlineChip');
  if (!chip) return;
  chip.hidden = !offline;
  if (offline) {
    chip.textContent = t('offline');
    chip.title = t('offline');
    chip.setAttribute('aria-label', t('offline'));
  }
}
window.addEventListener('offline', () => setOfflineUi(true));

function showLogin() {
  authState.authenticated = false;
  authState.user = null;
  statusLoadedOnce = false;
  const submit = $('authSubmit');
  if (submit) { submit.disabled = false; submit.textContent = t('auth.login'); }
  $('subtitle').textContent = t('conn.connecting');
  updateSessionUser();
  $('authBackdrop').hidden = false;
  $('authError').hidden = true;
  $('authNotice').hidden = true;
  $('authRetry').hidden = true;
  $('authPassword').value = '';
  try { $('authUsername').focus(); } catch (_) { /* ignora */ }
}

function hideLogin() {
  $('authBackdrop').hidden = true;
}

function showAuthError(msg) {
  const el = $('authError');
  el.hidden = false;
  el.textContent = msg;
}

function showAuthNotice(msg) {
  const el = $('authNotice');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

function mapAuthError(status, data) {
  if (status === 429) return t('auth.tooMany');
  if (status === 503) return t('auth.notConfigured');
  if (data && data.error) return data.error;
  return t('auth.invalid');
}

/* stop di tutto il lavoro locale SENZA toccare i task PVE gia' avviati */
function stopFrontendWork() {
  stopAutoRefresh();
  stopTaskTimer();
  if (shellWs) {
    try { closeShell(); } catch (_) { /* ignora */ }
  }
  if (window.VNCConsole) {
    try { window.VNCConsole.close(); } catch (_) { /* ignora */ }
  }
  if (detailState.key) closeGuestDetail();
  document.querySelectorAll('.modal-backdrop').forEach((m) => {
    if (m.id !== 'authBackdrop') m.hidden = true;
  });
  /* la modale cambio password non deve trattenere password nella UI */
  const cpForm = $('changePasswordForm');
  if (cpForm) cpForm.reset();
  const cpErr = $('cpError');
  if (cpErr) { cpErr.hidden = true; cpErr.textContent = ''; }
  changePasswordBusy = false;
  closeDrawer();
  if (!$('tourBackdrop').hidden) {
    $('tourBackdrop').hidden = true;
    tourIndex = -1;
    tourTarget = null;
    tourOpenedGd = false;
    tourOpenedSettings = false;
    state.tourRunning = false;
  }
  state.status = null;
  state.health = null;
  backupData = { storages: [], jobs: [], backups: [], snapshots: [], taskEvents: [], errors: [], fetchedAt: 0, loading: false, loaded: false };
  backupCache.storages.clear();
  backupCache.jobs.clear();
  backupCache.backups.clear();
  backupCache.snapshots.clear();
  backupCache.tasks = { at: 0, data: null, error: false };
  guestBackupCache.clear();
  Object.keys(LOGS_CACHE).forEach((k) => delete LOGS_CACHE[k]);
  healthTaskCache.data = null;
  healthTaskCache.fetchedAt = 0;
  healthTaskCache.fetching = false;
  healthTaskCache.error = false;
  for (const k of Object.keys(healthSourceCache)) {
    if (k === 'smart') healthSourceCache.smart.clear();
    else healthSourceCache[k] = { at: 0, data: null, errors: [], fetching: false };
  }
  smartQueue.length = 0;
  smartBusy = false;
  healthDiskOpen.clear();
  healthFilters.severity = 'all';
  healthFilters.server = 'all';
  healthSectionsInit = false;
  activeTask = null;
  logsData = [];
  backupShowAll = false;
  clearDashboardDom();
}

function localCleanupAndShowLogin(notify) {
  stopFrontendWork();
  showLogin();
  if (notify) toast(t('auth.loggedOut'), 'info');
}

/* rimuove ogni dato infrastrutturale renderizzato dal DOM (post-logout/expiry) */
function clearDashboardDom() {
  ['serversGrid', 'logsBody', 'logsMobile', 'logsBanner', 'logsErrors', 'healthAttentionList', 'healthInfoList', 'healthInfraList',
    'backupGuestList', 'backupRecentList', 'backupSnapshotList', 'backupJobList', 'backupStorageList',
    'gd-tab-overview', 'gd-tab-config', 'gd-tab-tasks', 'gdBackupLast', 'gdBackupHistory', 'gdSnapshotList', 'gdBackupTask',
    'logDetailGrid', 'logDetailOutput'
  ].forEach((id) => {
    const el = $(id);
    if (el) el.innerHTML = '';
  });
  ['statServersVal', 'statVmsVal', 'statLxcVal', 'statCpuVal', 'statRamVal'].forEach((id) => {
    const el = $(id);
    if (el) el.textContent = (id === 'statCpuVal' || id === 'statRamVal') ? '0%' : '0';
  });
  ['healthCardCritical', 'healthCardWarning', 'healthCardServer', 'healthCardGuest',
    'backupCardGuests', 'backupCardFailed', 'backupCardSnapshots', 'backupCardFree',
    'healthBannerTitle', 'healthBannerSub', 'lastUpdate', 'backupUpdated', 'logsUpdated', 'logsPageInfo',
    'guestDetailTitle', 'guestDetailSubtitle', 'connText', 'subtitle'
  ].forEach((id) => {
    const el = $(id);
    if (el) el.textContent = '—';
  });
  const chip = $('connChip');
  if (chip) chip.className = 'status-chip offline';
}

function handleSessionExpired() {
  if (!authState.authenticated || authExpiryHandled) return;
  authExpiryHandled = true;
  toast(t('auth.expired'), 'err');
  localCleanupAndShowLogin(false);
  try { if (authChannel) authChannel.postMessage('expired'); } catch (_) { /* ignora */ }
}

/* BFCache / back button: alla riesumazione della pagina ri-verifica la sessione */
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  fetch('/api/auth/session')
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok || !d.authenticated) {
        if (authState.authenticated) localCleanupAndShowLogin(false);
        else showLogin();
      }
    })
    .catch(() => {
      if (authState.authenticated) localCleanupAndShowLogin(false);
      else showLogin();
    });
});

if (authChannel) {
  authChannel.onmessage = (e) => {
    if (e.data === 'logout' || e.data === 'expired') {
      if (authState.authenticated) localCleanupAndShowLogin(false);
    }
  };
}

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('authSubmit');
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  btn.disabled = true;
  btn.textContent = t('auth.loading');
  $('authError').hidden = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      authState.authenticated = true;
      authState.user = (data.user && data.user.username) || username;
      updateSessionUser();
      authExpiryHandled = false;
      $('authPassword').value = '';
      hideLogin();
      loadDashboard();
      return;
    }
    showAuthError(mapAuthError(res.status, data));
    btn.disabled = false;
    btn.textContent = t('auth.login');
  } catch (_) {
    showAuthError(t('auth.network'));
    btn.disabled = false;
    btn.textContent = t('auth.login');
  }
};

$('btnAuthShow').onclick = () => {
  const input = $('authPassword');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('btnAuthShow').title = t(show ? 'auth.hide' : 'auth.show');
  $('btnAuthShow').setAttribute('aria-label', t(show ? 'auth.hide' : 'auth.show'));
};

$('btnLogout').onclick = async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) { /* ignora */ }
  localCleanupAndShowLogin(true);
  try { if (authChannel) authChannel.postMessage('logout'); } catch (_) { /* ignora */ }
};

/* username della sessione nelle Impostazioni (nessuna logica auth toccata) */
function updateSessionUser() {
  const el = $('sessionUser');
  if (!el) return;
  el.textContent = authState.user ? t('session.user', { user: authState.user }) : '—';
}

/* Esci dal drawer mobile: stessa logica di #btnLogout, nessuna duplicazione */
$('btnDrawerLogout').onclick = () => {
  closeDrawer();
  $('btnLogout').click();
};

/* ---------- cambio password (Impostazioni -> Sicurezza) ---------- */

function openChangePasswordModal() {
  if (changePasswordBusy) return;
  $('cpError').hidden = true;
  $('cpError').textContent = '';
  $('changePasswordForm').reset();
  $('cpSubmit').disabled = false;
  $('cpSubmit').textContent = t('auth.change.submit');
  $('changePasswordModal').hidden = false;
  $('cpCurrent').focus();
}

function closeChangePasswordModal() {
  if (changePasswordBusy) return;
  $('changePasswordModal').hidden = true;
  $('changePasswordForm').reset();
  $('cpError').hidden = true;
  $('cpError').textContent = '';
  $('cpSubmit').disabled = false;
  $('cpSubmit').textContent = t('auth.change.submit');
}

$('btnChangePassword').onclick = openChangePasswordModal;

$('changePasswordForm').onsubmit = async (e) => {
  e.preventDefault();
  if (changePasswordBusy) return;
  const err = $('cpError');
  err.hidden = true;
  err.textContent = '';
  const currentPassword = $('cpCurrent').value;
  const newPassword = $('cpNew').value;
  const confirmPassword = $('cpConfirm').value;
  if (newPassword !== confirmPassword) {
    err.textContent = t('auth.change.mismatch');
    err.hidden = false;
    return;
  }
  changePasswordBusy = true;
  const btn = $('cpSubmit');
  btn.disabled = true;
  btn.textContent = t('auth.change.loading');
  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      /* successo: nessuna sessione mantenuta, pulizia completa e login */
      $('changePasswordForm').reset();
      err.hidden = true;
      err.textContent = '';
      changePasswordBusy = false;
      stopFrontendWork();
      showLogin();
      showAuthNotice(t('auth.change.success'));
      try { if (authChannel) authChannel.postMessage('logout'); } catch (_) { /* ignora */ }
      return;
    }
    if (data && data.authenticated === false) {
      /* sessione non piu' valida: flusso esistente di pulizia */
      changePasswordBusy = false;
      localCleanupAndShowLogin(false);
      return;
    }
    if (res.status === 429 || (data && data.code === 'RATE_LIMITED')) {
      err.textContent = t('auth.change.tooMany');
    } else if (res.status === 401 || (data && data.code === 'WRONG_CURRENT')) {
      err.textContent = t('auth.change.wrongCurrent');
    } else if (data && data.code === 'TOO_SHORT') {
      err.textContent = t('auth.change.tooShort');
    } else if (data && data.code === 'TOO_LONG') {
      err.textContent = t('auth.change.tooLong');
    } else if (data && data.code === 'SAME_PASSWORD') {
      err.textContent = t('auth.change.same');
    } else if (data && data.code === 'NOT_CONFIGURED') {
      err.textContent = t('auth.notConfigured');
    } else if (res.status === 403) {
      err.textContent = t('auth.change.origin');
    } else {
      err.textContent = t('auth.change.error');
    }
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = t('auth.change.submit');
  } catch (_) {
    err.textContent = t('auth.network');
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = t('auth.change.submit');
  } finally {
    changePasswordBusy = false;
  }
};

/* ---------- i18n ---------- */

function t(key, vars) {
  const lang = langPref() || state.config.language || 'it';
  let str = (I18N[lang] && I18N[lang][key]) || I18N.it[key] || key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k]));
    }
  }
  return str;
}

function langPref() {
  try {
    return (JSON.parse(localStorage.getItem('hl_prefs') || '{}').language) || null;
  } catch (_) {
    return null;
  }
}

function setLangPref(lang) {
  try {
    const prefs = JSON.parse(localStorage.getItem('hl_prefs') || '{}');
    prefs.language = lang;
    localStorage.setItem('hl_prefs', JSON.stringify(prefs));
  } catch (_) { /* ignora */ }
}

function applyLanguage() {
  const lang = langPref() || state.config.language || 'it';
  document.documentElement.lang = lang;
  $('languageSelect').value = lang;
  /* elementi con data-i18n */
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    if (el.classList.contains('drawer-item')) return; /* gestiti sotto con span */
    el.textContent = t(el.dataset.i18n);
  });
  /* aggiorna i testi statici */
  $('subtitle').textContent = statusLoadedOnce
    ? t('conn.subtitle', { online: lastOnlineCount, total: lastServerCount })
    : t('conn.connecting');
  $('connText').textContent = t('conn.offline');
  $('btnAddServer').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> ' + t('add.server');
  $('btnRefresh').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 3 21 9 15 9"></polyline></svg> ' + t('refresh');
  $('autoToggle').title = t('auto.toggle.title');
  $('autoToggleText').textContent = t('auto.on');
  $('refreshSelect').closest('.auto-refresh').title = t('auto.interval.title');
  $('btnSettings').title = t('settings');
  $('btnHamburger').title = t('settings');
  $('drawerTitle').textContent = t('app.title');
  $('btnDrawerSettings').querySelector('span').textContent = t('settings.text');
  $('btnDrawerInfo').querySelector('span').textContent = t('info.text');
  $('btnDrawerLogout').querySelector('span').textContent = t('auth.logout');
  updateSessionUser();
  document.querySelectorAll('.drawer-item[data-view]').forEach((b) => {
    if (b.dataset.i18n) b.querySelector('span').textContent = t(b.dataset.i18n + '.text');
  });
  $('settingsModal').querySelector('.modal-head h2').textContent = t('settings.title');
  $('serverModalTitle').textContent = state.editingServerId ? t('server.edit.title') : t('server.add.title');
  $('btnSubmitServer').textContent = state.editingServerId ? t('server.save.btn') : t('server.add.btn');
  $('fName').placeholder = t('server.name.ph');
  $('fUrl').placeholder = t('server.url.ph');
  $('fUser').placeholder = t('server.user.ph');
  $('fPassword').placeholder = state.editingServerId ? t('server.pass.edit.ph') : t('server.pass.ph');
  $('fVerifyTlsLabel').textContent = t('server.tls');
  $('btnTest').textContent = t('server.test');
  $('btnDeleteServer').textContent = t('server.delete.btn');
  $('deleteServerField').querySelector('label').textContent = t('server.delete.label');
  $('deleteServerField').querySelector('.hint').textContent = t('server.delete.hint');
  $('logSearch').placeholder = t('logs.searchPh.' + logsTab);
  populateLogNodeFilters();
  /* selettore server dei log */
  const sel = $('logServerFilter');
  const current = sel.value;
  sel.innerHTML = '<option value="all">' + t('logs.all') + '</option>' +
    (state.config.servers || []).map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
  sel.value = current;
  /* sezioni impostazioni */
  const fields = $('settingsModal').querySelectorAll('.modal-body > .field');
  if (fields[0]) fields[0].querySelector('label').textContent = t('settings.appearance');
  if (fields[1]) fields[1].querySelector('label').textContent = t('settings.language');
  if (fields[2]) fields[2].querySelector('label').textContent = t('settings.tour');
  if (fields[2]) fields[2].querySelector('.toggle-row span').textContent = t('settings.tour.label');
  if (fields[2]) fields[2].querySelector('#btnRestartTour').textContent = t('settings.tour.restart');
  if (fields[2]) fields[2].querySelector('.hint').textContent = t('settings.tour.hint');
  /* segmented control */
  const seg = $('themeSegmented');
  seg.querySelector('[data-theme="light"]').textContent = t('settings.theme.light');
  seg.querySelector('[data-theme="dark"]').textContent = t('settings.theme.dark');
  seg.querySelector('[data-theme="system"]').textContent = t('settings.theme.system');
  /* tour */
  $('tourSkip').textContent = t('tour.skip');
  $('tourPrev').textContent = t('tour.prev');
  $('tourNext').textContent = t('tour.next');
  if (tourIndex >= 0) showTourStep(tourIndex);
  updateTourBadge();
  renderAll();
}

/* ---------- navigazione ---------- */

let currentView = 'dashboard';

/* animazione di entrata condivisa per viste e tab.
   la classe viene aggiunta in modo sincrono, nello stesso ciclo in cui la
   sezione e' stata resa visibile: il primo frame dipinto e' gia' animato
   (niente pre-flash). cleanup via animationend (one-shot): nessun timer
   arbitrario, nessuna opacity bloccata. */
function cancelEnter(el) {
  if (!el) return;
  el.classList.remove('view-enter', 'tab-enter');
  if (el._enterDone) {
    el.removeEventListener('animationend', el._enterDone);
    el.removeEventListener('animationcancel', el._enterDone);
    el._enterDone = null;
  }
}

function playEnter(el, cls) {
  if (!el) return;
  cancelEnter(el);
  el.classList.add(cls);
  el._enterDone = function done() {
    el.classList.remove(cls);
    el.removeEventListener('animationend', done);
    el.removeEventListener('animationcancel', done);
    el._enterDone = null;
  };
  el.addEventListener('animationend', el._enterDone);
  /* hidden=true o rimozione della classe interrompono l'animazione:
     animationcancel garantisce il cleanup anche in quel caso */
  el.addEventListener('animationcancel', el._enterDone);
}

function switchView(view) {
  currentView = view;
  if (view !== 'backup') backupFocusGuest = null; /* reset focus deep-link navigando altrove */
  /* pulizia transizioni residue prima del cambio vista: copre anche il caso
     in cui l'animazione e' stata interrotta prima del primo paint (nessun
     animationend/animationcancel emesso dal browser) */
  cancelEnter($('statsRow'));
  cancelEnter($('serversSection'));
  cancelEnter($('logsSection'));
  cancelEnter($('healthSection'));
  cancelEnter($('backupSection'));
  document.querySelectorAll('#logsFilters, #logsTableWrap, .logs-pagination').forEach(cancelEnter);
  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  document.querySelectorAll('.drawer-item[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  $('serversSection').hidden = view !== 'dashboard';
  $('logsSection').hidden = view !== 'logs';
  $('healthSection').hidden = view !== 'health';
  $('backupSection').hidden = view !== 'backup';
  $('btnDrawerSettings').classList.remove('active');
  if (view === 'logs') setLogTab(logsTab, false);
  closeDrawer();
  /* transizione della vista in entrata: la vecchia sezione e' gia' nascosta */
  if (view === 'dashboard') {
    playEnter($('statsRow'), 'view-enter');
    playEnter($('serversSection'), 'view-enter');
  } else if (view === 'logs') {
    playEnter($('logsSection'), 'view-enter');
  } else if (view === 'health') {
    renderHealth();
    playEnter($('healthSection'), 'view-enter');
  } else if (view === 'backup') {
    loadBackupView(false);
    playEnter($('backupSection'), 'view-enter');
  }
}

document.querySelectorAll('.nav-btn').forEach((b) => {
  b.onclick = () => switchView(b.dataset.view);
});
document.querySelectorAll('.drawer-item[data-view]').forEach((b) => {
  b.onclick = () => switchView(b.dataset.view);
});

/* ---------- drawer mobile ---------- */

function openDrawer() {
  $('drawerBackdrop').hidden = false;
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => $('drawerBackdrop').classList.add('open'));
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawerBackdrop').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => { $('drawerBackdrop').hidden = true; }, 300);
}

$('btnHamburger').onclick = openDrawer;
$('btnDrawerClose').onclick = closeDrawer;
$('drawerBackdrop').onclick = closeDrawer;
$('btnDrawerSettings').onclick = () => {
  closeDrawer();
  document.querySelectorAll('.drawer-item').forEach((b) => b.classList.remove('active'));
  $('btnDrawerSettings').classList.add('active');
  $('settingsModal').hidden = false;
  loadConfig();
};
$('btnDrawerInfo').onclick = () => {
  closeDrawer();
  $('infoModal').hidden = false;
};

/* ---------- log Proxmox: 3 tab (system / tasks / cluster) ---------- */

let logsTab = 'tasks'; /* default: Task */
let logsData = [];     /* dati della tab attiva */
let logsPage = 1;
let logsLoading = false;
const LOGS_PER_PAGE = 50;
const LOGS_CACHE = {}; /* cache semplice per tab: { tasks: {serverId, period, data}, ... } */

function eventTypeLabel(type) {
  if (!type) return t('logs.unknown');
  if (type.startsWith('vz')) return 'LXC';
  if (type.startsWith('qemu')) return 'VM';
  return t('logs.typeSys');
}

function eventOpLabel(type) {
  if (!type) return t('logs.unknown');
  const map = {
    vzstart: 'START', vzstop: 'STOP', vzshutdown: 'SHUTDOWN', vzreboot: 'REBOOT',
    qmstart: 'START', qmstop: 'STOP', qmshutdown: 'SHUTDOWN', qmreboot: 'REBOOT',
    vzdump: 'BACKUP', qmrestore: 'RESTORE', qmclone: 'CLONE', qmmigrate: 'MIGRATE',
    qmsnapshot: 'SNAPSHOT', vzsnapshot: 'SNAPSHOT', qmcreate: 'CREATE', qmdestroy: 'DESTROY',
    vzcreate: 'CREATE', vzdestroy: 'DESTROY', auth: 'LOGIN',
  };
  return map[type] || type.toUpperCase();
}

function statusClass(status) {
  if (status === 'OK') return 'ok';
  if (status === 'ERR' || status === 'ERROR') return 'err';
  if (status === 'RUNNING') return 'run';
  return 'info';
}

function statusLabel(status) {
  if (status === 'OK') return t('logs.success');
  if (status === 'ERR' || status === 'ERROR') return t('logs.error');
  if (status === 'RUNNING') return t('logs.running');
  return status || t('logs.unknown');
}

function fmtLogTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString(state.config.language || 'it');
}

function fmtLogDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString(state.config.language || 'it', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(start, end) {
  if (!start) return '—';
  const d = (end || start) - start;
  if (d < 1) return '<1s';
  return d + 's';
}

/* severità syslog: normalizza pri (0..7) in categorie con traduzione */
function severityInfo(pri) {
  const p = Number(pri);
  if (p === 0 || p === 1 || p === 2) return { key: 'crit', cls: 'crit' };
  if (p === 3) return { key: 'err', cls: 'err' };
  if (p === 4) return { key: 'warn', cls: 'warn' };
  if (p === 5) return { key: 'notice', cls: 'notice' };
  if (p === 6) return { key: 'info', cls: 'info' };
  if (p === 7) return { key: 'debug', cls: 'debug' };
  return { key: 'info', cls: 'info' };
}

function severityLabel(pri) {
  return t('logs.sev.' + severityInfo(pri).key);
}

function periodSeconds(period) {
  return { '1h': 3600, '24h': 86400, '7d': 604800, '30d': 2592000 }[period] || 86400;
}

function logServerId() {
  return $('logServerFilter').value === 'all' ? null : $('logServerFilter').value;
}

function logPeriod() {
  return $('logPeriodFilter').value;
}

function logCacheKey() {
  return logsTab + ':' + (logServerId() || 'all') + ':' + logPeriod();
}

function setLogTab(tab, animate) {
  logsTab = tab;
  logsPage = 1;
  $('logSearch').placeholder = t('logs.searchPh.' + tab);
  document.querySelectorAll('.logs-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.logtab === tab);
  });
  /* filtri visibili solo per la tab corrente */
  document.querySelectorAll('[data-logfilter]').forEach((el) => {
    el.hidden = !el.dataset.logfilter.split(' ').includes(tab);
  });
  /* colonne tabella per la tab corrente */
  const cols = {
    tasks: ['time', 'server', 'node', 'type', 'resource', 'event', 'status'],
    system: ['time', 'server', 'node', 'service', 'message'],
    cluster: ['time', 'server', 'node', 'severity', 'service', 'message', 'user'],
  }[tab] || [];
  document.querySelectorAll('#logsTable th[data-logcol]').forEach((th) => {
    th.hidden = !cols.includes(th.dataset.logcol);
  });
  const cached = LOGS_CACHE[logCacheKey()];
  /* micro-transizione del solo contenuto sotto la tab bar (filtri e tabella).
     salta al primo ingresso nella vista (la sezione ha gia' view-enter),
     salta la tabella se sara' nascosta dal loading (nessuna doppia fade)
     e non tocca loading/errori/empty: mai riparte su Aggiorna. */
  if (animate !== false) {
    document.querySelectorAll('#logsFilters, #logsTableWrap, .logs-pagination').forEach((el) => {
      if (el.hidden) return;
      if (!cached && el.id === 'logsTableWrap') return;
      playEnter(el, 'tab-enter');
    });
  }
  if (cached) {
    logsData = cached;
    renderLogBanner();
    renderLogs();
  } else {
    loadLogs();
  }
}

async function loadLogs(force) {
  if (logsLoading) return;
  const key = logCacheKey();
  if (!force && LOGS_CACHE[key]) {
    logsData = LOGS_CACHE[key];
    renderLogBanner();
    renderLogs();
    return;
  }
  logsLoading = true;
  const btn = $('btnLogsRefresh');
  btn.classList.add('spinning');
  $('logsLoading').hidden = false;
  $('logsTableWrap').hidden = true;
  $('logsErrors').hidden = true;
  $('logsBanner').hidden = true;
  try {
    const endpoint = { tasks: '/api/logs/tasks', system: '/api/logs/system', cluster: '/api/logs/cluster' }[logsTab];
    const body = { serverId: logServerId() };
    if (logsTab === 'tasks') {
      const now = Math.floor(Date.now() / 1000);
      body.since = now - periodSeconds(logPeriod());
      body.until = now;
      body.limit = 200;
    } else if (logsTab === 'system') {
      body.limit = 500;
      /* since in formato data (l'API syslog non accetta epoch) */
      const d = new Date(Date.now() - periodSeconds(logPeriod()) * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      body.since = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    logsData = data.events || [];
    LOGS_CACHE[key] = logsData;
    renderLogErrors(data.errors || []);
    renderLogBanner();
    logsPage = 1;
    renderLogs();
    populateLogNodeFilters();
    $('logsUpdated').textContent = t('updated') + ' ' + new Date().toLocaleTimeString(state.config.language || 'it');
  } catch (e) {
    logsData = [];
    renderLogErrors([{ serverName: '', error: e.message }]);
    /* errore totale: mostra SOLO ERROR, mai EMPTY */
    $('logsEmpty').hidden = true;
    $('logsTable').style.display = 'none';
    $('logsMobile').style.display = 'none';
    $('logsPageInfo').textContent = '1 / 1';
    $('logsPrev').disabled = true;
    $('logsNext').disabled = true;
  } finally {
    logsLoading = false;
    btn.classList.remove('spinning');
    $('logsLoading').hidden = true;
    $('logsTableWrap').hidden = false;
  }
}

function renderLogErrors(errors) {
  const box = $('logsErrors');
  if (!errors || !errors.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = errors.map((e) =>
    '<div class="logs-error-item">⚠️ ' + (e.serverName ? t('logs.unreachable', { name: e.serverName }) + ' — ' : '') + esc(e.error) + '</div>'
  ).join('');
}

function renderLogBanner() {
  const banner = $('logsBanner');
  if (logsTab !== 'cluster') {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  const standalone = logsData.some((e) => e.standalone);
  if (!standalone) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = '<span>ℹ️ ' + t('logs.standalone') + '</span>';
}

function filteredLogs() {
  const search = $('logSearch').value.trim().toLowerCase();
  const period = logPeriod();
  const now = Date.now() / 1000;
  const periodSec = periodSeconds(period);
  if (logsTab === 'tasks') {
    const status = $('logStatusFilter').value;
    const type = $('logTypeFilter').value;
    return logsData.filter((e) => {
      if (status !== 'all' && e.status !== status) return false;
      if (type === 'vm' && !e.type.startsWith('qemu')) return false;
      if (type === 'lxc' && !e.type.startsWith('vz')) return false;
      if (type === 'sys' && (e.type.startsWith('qemu') || e.type.startsWith('vz'))) return false;
      if (now - (e.starttime || 0) > periodSec) return false;
      if (search) {
        const hay = ((e.serverName || '') + ' ' + (e.node || '') + ' ' + (e.vmid || '') + ' ' + (e.type || '') + ' ' + (e.user || '') + ' ' + statusLabel(e.status)).toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }
  if (logsTab === 'system') {
    const node = $('logNodeFilter').value;
    return logsData.filter((e) => {
      if (node !== 'all' && e.node !== node) return false;
      if (e.ts && now - e.ts > periodSec) return false;
      if (search) {
        const hay = ((e.node || '') + ' ' + (e.service || '') + ' ' + (e.message || '') + ' ' + (e.t || '')).toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }
  /* cluster */
  const node = $('logClusterNodeFilter').value;
  const sev = $('logSeverityFilter').value;
  return logsData.filter((e) => {
    if (node !== 'all' && e.node !== node) return false;
    if (sev !== 'all' && severityInfo(e.pri).key !== sev) return false;
    if (now - (e.time || 0) > periodSec) return false;
    if (search) {
      const hay = ((e.node || '') + ' ' + (e.tag || '') + ' ' + (e.msg || '') + ' ' + (e.user || '') + ' ' + severityLabel(e.pri)).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function renderLogs() {
  const list = filteredLogs();
  const totalPages = Math.max(1, Math.ceil(list.length / LOGS_PER_PAGE));
  if (logsPage > totalPages) logsPage = totalPages;
  const pageItems = list.slice((logsPage - 1) * LOGS_PER_PAGE, logsPage * LOGS_PER_PAGE);
  $('logsPageInfo').textContent = logsPage + ' / ' + totalPages;
  $('logsPrev').disabled = logsPage <= 1;
  $('logsNext').disabled = logsPage >= totalPages;
  /* EMPTY solo se non ci sono errori visibili (ERROR ed EMPTY sono mutuamente esclusivi) */
  const hasErrors = !$('logsErrors').hidden;
  $('logsEmpty').hidden = hasErrors || list.length > 0;
  if (logsTab === 'cluster' && !logsData.length) {
    $('logsEmpty').querySelector('p').textContent = t('logs.clusterEmpty');
    $('logsEmpty').querySelector('span').textContent = '';
  } else {
    $('logsEmpty').querySelector('p').textContent = t('logs.empty');
    $('logsEmpty').querySelector('span').textContent = t('logs.emptyHint');
  }
  $('logsTable').style.display = list.length ? '' : 'none';
  $('logsMobile').style.display = list.length ? '' : 'none';
  if (logsTab === 'tasks') {
    $('logsBody').innerHTML = pageItems.map((e) => {
      const sc = statusClass(e.status);
      const dot = sc === 'ok' ? '🟢' : sc === 'err' ? '🔴' : sc === 'run' ? '🟠' : '🔵';
      return '<tr data-upid="' + esc(e.upid) + '" data-server="' + esc(e.serverId) + '" data-node="' + esc(e.node) + '">' +
        '<td>' + fmtLogTime(e.starttime) + '</td>' +
        '<td>' + esc(e.serverName) + '</td>' +
        '<td>' + esc(e.node) + '</td>' +
        '<td>' + eventTypeLabel(e.type) + '</td>' +
        '<td>' + (e.vmid ? esc(e.vmid) : '—') + '</td>' +
        '<td>' + eventOpLabel(e.type) + '</td>' +
        '<td class="log-status ' + sc + '">' + dot + ' ' + statusLabel(e.status) + '</td>' +
      '</tr>';
    }).join('');
    $('logsMobile').innerHTML = pageItems.map((e) => {
      const sc = statusClass(e.status);
      const dot = sc === 'ok' ? '✓' : sc === 'err' ? '✕' : sc === 'run' ? '◐' : '•';
      return '<div class="log-card" data-upid="' + esc(e.upid) + '" data-server="' + esc(e.serverId) + '" data-node="' + esc(e.node) + '">' +
        '<div class="log-card-top"><span class="log-status ' + sc + '">' + dot + ' ' + eventOpLabel(e.type) + '</span><span class="log-card-time">' + fmtLogTime(e.starttime) + '</span></div>' +
        '<div class="log-card-mid">' + esc(e.serverName) + ' · ' + eventTypeLabel(e.type) + (e.vmid ? ' ' + esc(e.vmid) : '') + '</div>' +
        '<div class="log-card-bottom">' + fmtLogDate(e.starttime) + ' · ' + fmtDuration(e.starttime, e.endtime) + '</div>' +
      '</div>';
    }).join('');
  } else if (logsTab === 'system') {
    $('logsBody').innerHTML = pageItems.map((e) => {
      const msg = e.message || e.t || '';
      return '<tr data-sysmsg="' + esc(e.t || '') + '">' +
        '<td>' + (e.ts ? fmtLogDate(e.ts) : '—') + '</td>' +
        '<td>' + esc(e.serverName) + '</td>' +
        '<td>' + esc(e.node) + '</td>' +
        '<td>' + esc(e.service || '—') + '</td>' +
        '<td class="log-msg-cell" title="' + esc(msg) + '">' + esc(msg) + '</td>' +
      '</tr>';
    }).join('');
    $('logsMobile').innerHTML = pageItems.map((e) => {
      const msg = e.message || e.t || '';
      return '<div class="log-card" data-sysmsg="' + esc(e.t || '') + '">' +
        '<div class="log-card-top"><span class="log-card-service">' + esc(e.service || '—') + '</span><span class="log-card-time">' + (e.ts ? fmtLogDate(e.ts) : '—') + '</span></div>' +
        '<div class="log-card-mid">' + esc(e.serverName) + ' · ' + esc(e.node) + '</div>' +
        '<div class="log-card-msg">' + esc(msg) + '</div>' +
      '</div>';
    }).join('');
  } else {
    $('logsBody').innerHTML = pageItems.map((e) => {
      const sev = severityInfo(e.pri);
      return '<tr data-cluster-msg="' + esc(e.msg || '') + '">' +
        '<td>' + (e.time ? fmtLogDate(e.time) : '—') + '</td>' +
        '<td>' + esc(e.serverName) + '</td>' +
        '<td>' + esc(e.node || '—') + '</td>' +
        '<td class="log-sev ' + sev.cls + '">' + severityLabel(e.pri) + '</td>' +
        '<td>' + esc(e.tag || '—') + '</td>' +
        '<td class="log-msg-cell" title="' + esc(e.msg || '') + '">' + esc(e.msg || '') + '</td>' +
        '<td>' + esc(e.user || '—') + '</td>' +
      '</tr>';
    }).join('');
    $('logsMobile').innerHTML = pageItems.map((e) => {
      const sev = severityInfo(e.pri);
      return '<div class="log-card" data-cluster-msg="' + esc(e.msg || '') + '">' +
        '<div class="log-card-top"><span class="log-sev ' + sev.cls + '">' + severityLabel(e.pri) + '</span><span class="log-card-time">' + (e.time ? fmtLogDate(e.time) : '—') + '</span></div>' +
        '<div class="log-card-mid">' + esc(e.serverName) + ' · ' + esc(e.node || '—') + ' · ' + esc(e.tag || '—') + '</div>' +
        '<div class="log-card-msg">' + esc(e.msg || '') + '</div>' +
        '<div class="log-card-bottom">' + (e.user ? t('logs.detail.user') + ': ' + esc(e.user) : '') + '</div>' +
      '</div>';
    }).join('');
  }
}

/* popola i filtri Nodo (system/cluster) dai dati caricati, mantenendo la selezione */
function populateLogNodeFilters() {
  const nodes = [...new Set(logsData.map((e) => e.node).filter(Boolean))].sort();
  ['logNodeFilter', 'logClusterNodeFilter'].forEach((id) => {
    const sel = $(id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="all">' + t('logs.allNodes') + '</option>' +
      nodes.map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
    sel.value = nodes.includes(current) ? current : 'all';
  });
}

async function showLogDetail(upid, serverId, node) {
  try {
    const res = await fetch('/api/logs/detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upid, serverId, node }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    const e = logsData.find((x) => x.upid === upid && x.serverId === serverId);
    const sc = statusClass(e ? e.status : '');
    const rows = [
      [t('logs.detail.server'), e ? e.serverName : '—'],
      [t('logs.detail.node'), e ? e.node : node],
      [t('logs.detail.vmid'), e && e.vmid ? e.vmid : '—'],
      [t('logs.detail.type'), e ? eventTypeLabel(e.type) : '—'],
      [t('logs.detail.op'), e ? eventOpLabel(e.type) : '—'],
      [t('logs.detail.user'), e ? e.user : '—'],
      [t('logs.detail.start'), e ? fmtLogDate(e.starttime) : '—'],
      [t('logs.detail.end'), e && e.endtime ? fmtLogDate(e.endtime) : '—'],
      [t('logs.detail.duration'), e ? fmtDuration(e.starttime, e.endtime) : '—'],
      [t('logs.detail.status'), e ? '<span class="log-status ' + sc + '">' + statusLabel(e.status) + '</span>' : '—'],
      [t('logs.detail.upid'), upid],
      [t('logs.detail.pid'), e && e.pid ? e.pid : '—'],
    ];
    $('logDetailGrid').innerHTML = rows.map(([k, v]) =>
      '<div class="log-detail-item"><span class="log-detail-key">' + k + '</span><span class="log-detail-val">' + v + '</span></div>'
    ).join('');
    const out = data.log || [];
    $('logDetailOutputField').hidden = !out.length;
    $('logDetailOutput').textContent = out.map((l) => l.t || '').join('\n');
    $('logDetailModal').hidden = false;
  } catch (err) {
    toast(err.message, 'err');
  }
}

document.querySelectorAll('.logs-tab').forEach((b) => {
  b.onclick = () => setLogTab(b.dataset.logtab);
});
$('btnLogsRefresh').onclick = () => loadLogs(true);
$('logsPrev').onclick = () => { if (logsPage > 1) { logsPage--; renderLogs(); } };
$('logsNext').onclick = () => { if (logsPage < Math.ceil(filteredLogs().length / LOGS_PER_PAGE)) { logsPage++; renderLogs(); } };
/* cambio server/periodo: invalida la cache della tab e ricarica */
['logServerFilter', 'logPeriodFilter'].forEach((id) => {
  $(id).onchange = () => {
    delete LOGS_CACHE[logCacheKey()];
    logsPage = 1;
    loadLogs();
  };
});
/* filtri client-side: nessun fetch, solo re-render */
['logStatusFilter', 'logTypeFilter', 'logNodeFilter', 'logClusterNodeFilter', 'logSeverityFilter'].forEach((id) => {
  $(id).onchange = () => { logsPage = 1; renderLogs(); };
});
$('logSearch').oninput = () => { logsPage = 1; renderLogs(); };

/* ---------- shell LXC (xterm.js via termproxy/vncwebsocket) ---------- */

let shellTerm = null;
let shellWs = null;
let shellFit = null;
let shellPingTimer = null;
let shellResizeObserver = null;
let shellLastCols = 0;
let shellLastRows = 0;
let shellAuthenticated = false;

function fitAndResize() {
  if (!shellFit || !shellTerm || !shellAuthenticated || !shellWs || shellWs.readyState !== 1) return;
  shellFit.fit();
  if (shellTerm.cols !== shellLastCols || shellTerm.rows !== shellLastRows) {
    shellLastCols = shellTerm.cols;
    shellLastRows = shellTerm.rows;
    shellWs.send('1:' + shellTerm.cols + ':' + shellTerm.rows + ':');
  }
}
let shellKey = null;

function setShellStatus(msg, cls, showReconnect) {
  $('shellStatusText').textContent = msg;
  $('shellStatus').className = 'shell-status' + (cls ? ' ' + cls : '');
  $('btnShellReconnect').hidden = !showReconnect;
}

function findGuest(serverId, node, type, vmid) {
  const s = (state.status && state.status.servers || []).find((x) => x.id === serverId);
  if (!s) return null;
  const n = (s.nodes || []).find((x) => x.name === node);
  if (!n) return null;
  const list = type === 'lxc' ? n.lxc : n.vms;
  return (list || []).find((g) => String(g.id) === String(vmid));
}

async function openShell(key) {
  const [serverId, node, type, vmid] = key.split(':');
  if (type !== 'lxc') return;
  const s = state.config.servers.find((x) => x.id === serverId);
  if (!s) return;
  const guest = findGuest(serverId, node, type, vmid);
  if (!guest || guest.status !== 'running') {
    toast(t('shell.needStart') || 'Guest non in esecuzione', 'err');
    return;
  }
  shellKey = key;
  $('shellTitle').textContent = '>_ ' + guest.name + ' · LXC ' + vmid;
  setShellStatus(t('shell.connecting') || 'Connessione...', '', false);
  $('shellModal').hidden = false;

  const termContainer = $('shellTerminal');
  termContainer.innerHTML = '';

  try {
    shellTerm = new Terminal({
      cursorBlink: true,
      theme: { background: '#0a0e1a' },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14
    });
    shellFit = new FitAddon.FitAddon();
    shellTerm.loadAddon(shellFit);
    shellTerm.open(termContainer);
    shellLastCols = 0;
    shellLastRows = 0;
    shellAuthenticated = false;
    shellResizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAndResize());
    });
    shellResizeObserver.observe(termContainer);



    const wsUrl = '/api/shell/ws?serverId=' + encodeURIComponent(serverId) +
      '&node=' + encodeURIComponent(node) +
      '&vmid=' + vmid +
      '&type=lxc';

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    shellWs = new WebSocket(protocol + '//' + location.host + wsUrl);
    shellWs.binaryType = 'arraybuffer';

    shellWs.onopen = () => {
      setShellStatus('Autenticazione...', '', false);
    };

    shellWs.onmessage = (e) => {
      const data = typeof e.data === 'string' ? e.data : new Uint8Array(e.data);
      if (!shellAuthenticated) {
        const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
        if (str.includes('OK')) {
          shellAuthenticated = true;
          setShellStatus('Inizializzazione terminale...', '', false);

          shellPingTimer = setInterval(() => {
            if (shellWs && shellWs.readyState === 1) {
              shellWs.send(new TextEncoder().encode('2'));
            }
          }, 30000);

          requestAnimationFrame(() => {
            fitAndResize();
            setShellStatus('Connesso', 'ok', false);
          });
        }
      }
      shellTerm.write(data);
    };

    shellWs.onclose = () => {
      setShellStatus('Disconnesso', 'err', true);
    };

    shellWs.onerror = () => {
      setShellStatus('Errore di connessione', 'err', true);
    };

    shellTerm.onData((data) => {
            if (shellAuthenticated && shellWs && shellWs.readyState === 1) {
        const bytes = new TextEncoder().encode(data);
        const prefix = new TextEncoder().encode("0:" + bytes.length + ":");
        const payload = new Uint8Array(prefix.length + bytes.length);
        payload.set(prefix);
        payload.set(bytes, prefix.length);
                shellWs.send(payload);
      }
    });



  } catch (e) {
    setShellStatus('Errore: ' + e.message, 'err', true);
  }
}

function closeShell() {
  if (shellResizeObserver) {
    shellResizeObserver.disconnect();
    shellResizeObserver = null;
  }
  if (shellPingTimer) {
    clearInterval(shellPingTimer);
    shellPingTimer = null;
  }
  if (shellWs) {
    shellWs.close();
    shellWs = null;
  }
  if (shellTerm) {
    shellTerm.dispose();
    shellTerm = null;
  }
  shellFit = null;
  shellKey = null;
  shellAuthenticated = false;
  const shellModalEl = $('shellModal');
  const shellWin = shellModalEl.querySelector('.shell-modal');
  if (shellWin) shellWin.classList.remove('shell-fullscreen');
  shellModalEl.hidden = true;
  const term = $('shellTerminal');
  while (term.firstChild) term.removeChild(term.firstChild);
}

document.addEventListener('click', (e) => {
  const shellBtn = e.target.closest('[data-shell]');
  if (shellBtn) {
    const shellKey = shellBtn.dataset.shell;
    // If Guest Detail is open, close it first (backdrop must be gone before shell opens)
    if (detailState.key) {
      closeGuestDetail();
    }
    openShell(shellKey);
    return;
  }
  const vncBtn = e.target.closest('[data-vnc]');
  if (vncBtn) {
    const vncKey = vncBtn.dataset.vnc;
    /* come per la Shell: il Guest Detail viene chiuso prima della Console */
    if (detailState.key) {
      closeGuestDetail();
    }
    if (window.VNCConsole) window.VNCConsole.open(vncKey);
    return;
  }
});

$('shellModal').querySelector('[data-close]').onclick = closeShell;
$('btnShellReconnect').onclick = () => {
  if (shellKey) openShell(shellKey);
};
$('btnShellFullscreen').onclick = () => {
  const m = $('shellModal').querySelector('.shell-modal');
  m.classList.toggle('shell-fullscreen');
  requestAnimationFrame(() => fitAndResize());
};



document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-upid]');
  if (row && currentView === 'logs') {
    showLogDetail(row.dataset.upid, row.dataset.server, row.dataset.node);
    return;
  }
  /* log di sistema / cluster: espansione leggera del messaggio completo */
  const sys = e.target.closest('[data-sysmsg]');
  if (sys && currentView === 'logs') {
    sys.classList.toggle('expanded');
    return;
  }
  const cl = e.target.closest('[data-cluster-msg]');
  if (cl && currentView === 'logs') {
    cl.classList.toggle('expanded');
  }
});

function applyTheme() {
  const theme = state.config.theme || 'system';
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('theme-dark', dark);
  document.documentElement.classList.toggle('theme-light', !dark);
  if (detailState.tab === 'graphs' && detailState.rrd) {
    redrawGuestDetailGraphs();
  }
  document.querySelectorAll('#themeSegmented [data-theme]').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === theme);
  });
  try {
    const prefs = JSON.parse(localStorage.getItem('hl_prefs') || '{}');
    prefs.theme = theme;
    localStorage.setItem('hl_prefs', JSON.stringify(prefs));
  } catch { /* ignora */ }
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((state.config.theme || 'system') === 'system') applyTheme();
});

/* ---------- utility ---------- */

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function fmtRate(n) {
  if (!n) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + units[i];
}

function fmtUptime(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + 'g ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

/* descrizione CPU del nodo: 16 core / 32 thread (o solo "32 CPU" se i core non sono esposti) */
function nodeCpuLabel(n) {
  const ci = n.cpuinfo || {};
  if (ci.cores && ci.cpus) return ci.cores + ' ' + t('core') + ' / ' + ci.cpus + ' ' + t('thread');
  if (ci.cpus) return ci.cpus + ' CPU';
  return (n.maxcpu || 1) + ' CPU';
}

function nodeCpuModel(n) {
  const ci = n.cpuinfo || {};
  return ci.model || '';
}

function fmtPct(v) {
  return Math.round((v || 0) * 100) + '%';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function barClass(pct) {
  if (pct >= 0.85) return 'crit';
  if (pct >= 0.65) return 'warn';
  return '';
}

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  const icons = { ok: '✅', err: '⚠️', info: '💡' };
  el.innerHTML = '<span class="t-icon">' + (icons[type] || '💡') + '</span><span>' + esc(msg) + '</span>';
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, 3800);
}

/* ---------- orologio ---------- */

function tickClock() {
  const now = new Date();
  $('clockTime').textContent = now.toLocaleTimeString('it-IT');
  $('clockDate').textContent = now.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
}
setInterval(tickClock, 1000);
tickClock();

/* ---------- sparkline ---------- */

function drawSpark(canvasId, values, color) {
  const c = $(canvasId);
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 90, h = c.clientHeight || 34;
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const max = Math.max(...values, 0.01);
  g.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - (v / max) * (h - 4) - 2;
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  });
  g.strokeStyle = color;
  g.lineWidth = 1.8;
  g.lineJoin = 'round';
  g.stroke();
  g.lineTo(w, h);
  g.lineTo(0, h);
  g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '44');
  grad.addColorStop(1, color + '00');
  g.fillStyle = grad;
  g.fill();
}

/* ---------- rendering ---------- */

function renderStats() {
  const s = state.status;
  if (!s) return;
  const servers = s.servers || [];
  const nodes = servers.flatMap((x) => x.nodes || []);
  const guests = nodes.flatMap((n) => [...(n.vms || []), ...(n.lxc || [])]);
  const running = guests.filter((g) => g.status === 'running');
  const cpuAvg = nodes.length ? nodes.reduce((a, n) => a + (n.cpu || 0), 0) / nodes.length : 0;
  const ramAvg = nodes.length ? nodes.reduce((a, n) => a + (n.maxmem ? (n.mem || 0) / n.maxmem : 0), 0) / nodes.length : 0;

  animateNumber($('statServersVal'), servers.length);
  animateNumber($('statVmsVal'), running.filter((g) => g.type === 'qemu').length);
  animateNumber($('statLxcVal'), running.filter((g) => g.type === 'lxc').length);
  $('statCpuVal').textContent = fmtPct(cpuAvg);
  $('statRamVal').textContent = fmtPct(ramAvg);

  state.history.cpu.push(cpuAvg);
  state.history.ram.push(ramAvg);
  if (state.history.cpu.length > 40) state.history.cpu.shift();
  if (state.history.ram.length > 40) state.history.ram.shift();
  drawSpark('sparkCpu', state.history.cpu, '#4f8cff');
  drawSpark('sparkRam', state.history.ram, '#7c5cff');
}

function animateNumber(el, target) {
  const current = parseFloat(el.dataset.v || '0');
  if (current === target) return;
  el.dataset.v = target;
  const start = performance.now();
  const dur = 600;
  function step(t) {
    const k = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(current + (target - current) * eased);
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function guestActionsHtml(g, key) {
  const running = g.status === 'running';
  const paused = g.status === 'paused';
  const stopped = g.status === 'stopped';
  const busy = state.busy.has(key);
  const btn = (action, label, cls, disabled) =>
    '<button class="' + (cls || '') + '" data-action="' + action + '" data-key="' + key + '"' + (disabled || busy ? ' disabled' : '') + '>' + label + '</button>';
  let html = '';
  if (running) {
    html += btn('shutdown', t('action.shutdown'), 'danger');
    html += btn('reboot', t('action.reboot'));
    html += btn('suspend', t('action.suspend'));
  } else if (paused) {
    html += btn('resume', t('action.resume'));
    html += btn('stop', t('action.stop'), 'danger');
  } else if (stopped) {
    html += btn('start', '▶ ' + t('action.start'), '');
  }
  /* pulsante Shell solo per LXC: disponibile se running, disabilitato se stopped */
  if (g.type === 'lxc') {
    html += '<button type="button" class="shell-btn" data-shell="' + key + '"' + (running ? '' : ' disabled title="' + t('shell.needStart') + '"') + '>>_ ' + t('shell.open') + '</button>';
  }
  return html;
}

function guestCardHtml(g, i, key) {
  const memPct = g.maxmem ? g.mem / g.maxmem : 0;
  /* balloon: VM QEMU con ballooning attivo; la barra resta visivamente <= 100% */
  const balloon = g.type === 'qemu' && g.maxmem > 0 && g.mem > g.maxmem;
  const barPct = Math.min(1, memPct);
  const diskPct = g.maxdisk ? g.disk / g.maxdisk : 0;
  const icon = g.type === 'lxc' ? '📦' : '💻';
  return '<div class="guest-card ' + g.status + '" data-status="' + g.status + '" data-key="' + esc(key) + '" style="animation-delay:' + (i * 0.06) + 's">' +
    '<div class="guest-top">' +
      '<div class="guest-icon">' + icon + '</div>' +
      '<div style="min-width:0">' +
        '<div class="guest-name" title="' + esc(g.name) + '">' + esc(g.name) + '</div>' +
        '<div class="guest-meta">' + (g.type === 'lxc' ? t('lxc') : t('vms')) + ' · ' + t('id') + ' ' + g.id + ' · ' + (g.cpus || 1) + ' ' + t('vcpu') + '</div>' +
      '</div>' +
      '<span class="guest-status">' + esc(g.status) + '</span>' +
    '</div>' +
    '<div class="guest-bars">' +
      '<div class="mini-bar"><span class="m-label">' + t('cpu') + '</span><div class="bar"><div class="bar-fill ' + barClass(g.cpu) + '" data-metric="cpu" style="transform:scaleX(' + (g.cpu || 0) + ')"></div></div><span class="m-value" data-metric="cpu">' + fmtPct(g.cpu) + '</span></div>' +
      '<div class="mini-bar"><span class="m-label">' + t('ram') + '</span>' + (balloon ? '<span class="balloon-badge">' + t('gd.balloon') + '</span>' : '') + '<div class="bar"><div class="bar-fill ' + barClass(barPct) + '" data-metric="mem" style="transform:scaleX(' + (barPct || 0) + ')"></div></div><span class="m-value" data-metric="mem">' + fmtBytes(g.mem) + '</span></div>' +
      '<div class="mini-bar"><span class="m-label">' + t('disk') + '</span><div class="bar"><div class="bar-fill ' + barClass(diskPct) + '" data-metric="disk" style="transform:scaleX(' + (diskPct || 0) + ')"></div></div><span class="m-value" data-metric="disk">' + fmtPct(diskPct) + '</span></div>' +
    '</div>' +
    '<div class="guest-net">' +
      '<span data-net="in">↓ RX <b>' + fmtRate(g.netin) + '</b></span>' +
      '<span data-net="out">↑ TX <b>' + fmtRate(g.netout) + '</b></span>' +
      '<span data-net="up">⏱ <b>' + fmtUptime(g.uptime) + '</b></span>' +
    '</div>' +
    '<div class="guest-actions">' + guestActionsHtml(g, key) + '</div>' +
  '</div>';
}

function setBar(el, pct) {
  if (!el) return;
  el.style.transform = 'scaleX(' + (pct || 0) + ')';
  el.className = 'bar-fill ' + barClass(pct);
}

function buildServersHtml(servers) {
  return servers.map((server, si) => {
    const nodes = server.nodes || [];
    const nodeHtml = nodes.map((n) => {
      const guestKey = (g) => server.id + ':' + n.name + ':' + g.type + ':' + g.id;
      const vms = (n.vms || []).slice().sort((a, b) => a.id - b.id);
      const lxcs = (n.lxc || []).slice().sort((a, b) => a.id - b.id);
      const cpuPct = n.cpu || 0;
      const memPct = n.maxmem ? n.mem / n.maxmem : 0;
      const cpuTitle = nodeCpuModel(n);
      const cpuLabel = nodeCpuLabel(n);
      return '<div class="node-stats">' +
        '<div class="node-stat" title="' + esc(cpuTitle) + '"><div class="label">CPU · ' + esc(n.name) + '</div><div class="value">' + fmtPct(cpuPct) + ' · ' + cpuLabel + '</div>' +
          '<div class="bar"><div class="bar-fill ' + barClass(cpuPct) + '" data-metric="cpu" style="transform:scaleX(' + (cpuPct || 0) + ')"></div></div></div>' +
        '<div class="node-stat"><div class="label">RAM · ' + esc(n.name) + '</div><div class="value">' + fmtBytes(n.mem) + ' / ' + fmtBytes(n.maxmem) + '</div>' +
          '<div class="bar"><div class="bar-fill ' + barClass(memPct) + '" data-metric="mem" style="transform:scaleX(' + (memPct || 0) + ')"></div></div></div>' +
      '</div>' +
      '<div class="guests">' +
        vms.map((g, i) => guestCardHtml(g, i, guestKey(g))).join('') +
        lxcs.map((g, i) => guestCardHtml(g, i + vms.length, guestKey(g))).join('') +
      '</div>';
    }).join('');
    const online = server.online !== false;
    return '<div class="server-card glass ' + (online ? '' : 'offline') + '" style="animation-delay:' + (si * 0.1) + 's">' +
      '<div class="server-head">' +
        '<div class="server-title">' +
          '<div class="server-avatar">🖥️</div>' +
          '<div style="min-width:0">' +
            '<div class="server-name">' + esc(server.name) + '</div>' +
            '<div class="server-url">' + esc(server.url || '') + '</div>' +
          '</div>' +
        '</div>' +
        '<span class="server-badge"><span class="dot"></span>' + (online ? t('online') : t('offline')) + '</span>' +
        '<button type="button" class="server-edit-btn" data-edit-server="' + esc(server.id) + '" title="Modifica server" aria-label="Modifica server">✏️</button>' +
      '</div>' +
      (server.error ? '<div class="server-error">⚠️ ' + esc(server.error) + '</div>' : '') +
      nodeHtml +
    '</div>';
  }).join('');
}

function serversSignature(servers) {
  return servers.map((sv) =>
    sv.id + ':' + (sv.online !== false ? 1 : 0) + (sv.error ? ':E' : '') + ':' +
    (sv.nodes || []).map((n) => n.name + ':' +
      (n.vms || []).slice().sort((a, b) => a.id - b.id).map((g) => 'v' + g.id).join('') + ':' +
      (n.lxc || []).slice().sort((a, b) => a.id - b.id).map((g) => 'l' + g.id).join('')
    ).join(',')
  ).join('|');
}

function updateServers(servers) {
  const grid = $('serversGrid');
  servers.forEach((server, si) => {
    const card = grid.children[si];
    if (!card) return;
    const online = server.online !== false;
    card.classList.toggle('offline', !online);
    const badge = card.querySelector('.server-badge');
    if (badge) badge.innerHTML = '<span class="dot"></span>' + (online ? 'Online' : 'Offline');
    const errEl = card.querySelector('.server-error');
    if (server.error) {
      if (!errEl) {
        const div = document.createElement('div');
        div.className = 'server-error';
        div.textContent = '⚠️ ' + server.error;
        card.insertBefore(div, card.querySelector('.node-stats'));
      } else {
        errEl.textContent = '⚠️ ' + server.error;
      }
    } else if (errEl) {
      errEl.remove();
    }
    (server.nodes || []).forEach((n, ni) => {
      const nodeStats = card.querySelectorAll('.node-stats')[ni];
      if (!nodeStats) return;
      const stats = nodeStats.querySelectorAll('.node-stat');
      const cpuPct = n.cpu || 0;
      const memPct = n.maxmem ? n.mem / n.maxmem : 0;
      if (stats[0]) {
        stats[0].querySelector('.value').textContent = fmtPct(cpuPct) + ' · ' + nodeCpuLabel(n);
        const model = nodeCpuModel(n);
        if (model) stats[0].title = model;
        setBar(stats[0].querySelector('.bar-fill'), cpuPct);
      }
      if (stats[1]) {
        stats[1].querySelector('.value').textContent = fmtBytes(n.mem) + ' / ' + fmtBytes(n.maxmem);
        setBar(stats[1].querySelector('.bar-fill'), memPct);
      }
      const guestsWrap = nodeStats.nextElementSibling;
      if (!guestsWrap) return;
      /* letture DOM raggruppate: una sola scansione, cache dei riferimenti */
      const cardByKey = new Map();
      const refs = new Map();
      guestsWrap.querySelectorAll('.guest-card').forEach((c) => {
        cardByKey.set(c.dataset.key, c);
        refs.set(c, {
          actions: c.querySelector('.guest-actions'),
          status: c.querySelector('.guest-status'),
          cpuBar: c.querySelector('[data-metric="cpu"]'),
          memBar: c.querySelector('[data-metric="mem"]'),
          diskBar: c.querySelector('[data-metric="disk"]'),
          cpuVal: c.querySelector('.m-value[data-metric="cpu"]'),
          memVal: c.querySelector('.m-value[data-metric="mem"]'),
          diskVal: c.querySelector('.m-value[data-metric="disk"]'),
          netIn: c.querySelector('[data-net="in"] b'),
          netOut: c.querySelector('[data-net="out"] b'),
          netUp: c.querySelector('[data-net="up"] b'),
        });
      });
      const guests = [...(n.vms || []), ...(n.lxc || [])];
      guests.forEach((g) => {
        const key = server.id + ':' + n.name + ':' + g.type + ':' + g.id;
        const gc = cardByKey.get(key);
        if (!gc) return;
        const r = refs.get(gc);
        if (!r) return;
        /* se nessuna operazione e' in corso su questo guest, ripristina i pulsanti */
        if (!state.busy.has(key)) {
          const html = guestActionsHtml(g, key);
          if (r.actions.innerHTML !== html) r.actions.innerHTML = html;
        }
        /* MAI interpretare un errore API come stato reale: conserva l'ultimo stato valido */
        if (g.status === 'error' || g.status === 'unknown') {
          return;
        }
        if (gc.dataset.status !== g.status) {
          /* aggiorna solo badge e classe: la card resta nello stesso posto */
          gc.dataset.status = g.status;
          gc.className = 'guest-card ' + g.status;
          r.status.textContent = g.status;
          return;
        }
        const memPctG = g.maxmem ? Math.min(1, g.mem / g.maxmem) : 0;
        const diskPctG = g.maxdisk ? g.disk / g.maxdisk : 0;
        setBar(r.cpuBar, g.cpu);
        setBar(r.memBar, memPctG);
        setBar(r.diskBar, diskPctG);
        if (r.cpuVal.textContent !== fmtPct(g.cpu)) r.cpuVal.textContent = fmtPct(g.cpu);
        if (r.memVal.textContent !== fmtBytes(g.mem)) r.memVal.textContent = fmtBytes(g.mem);
        if (r.diskVal.textContent !== fmtPct(diskPctG)) r.diskVal.textContent = fmtPct(diskPctG);
        r.netIn.textContent = fmtRate(g.netin);
        r.netOut.textContent = fmtRate(g.netout);
        r.netUp.textContent = fmtUptime(g.uptime);
      });
    });
  });
}

function renderServers() {
  const grid = $('serversGrid');
  const s = state.status;
  if (!s) {
    grid.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    return;
  }
  const servers = s.servers || [];
  if (!servers.length) {
    grid.innerHTML = '<div class="glass" style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-dim)">' +
      t('empty.servers') + '</div>';
    return;
  }
  const sig = serversSignature(servers);
  if (grid.dataset.sig !== sig) {
    grid.dataset.sig = sig;
    grid.innerHTML = buildServersHtml(servers);
  }
  updateServers(servers);
}

function renderAll() {
  renderStats();
  renderServers();
  if (currentView === 'health') renderHealth();
  if (currentView === 'backup') renderBackup();
  const s = state.status;
  if (s) {
    $('lastUpdate').textContent = t('updated') + ' ' + new Date(s.at || Date.now()).toLocaleTimeString(state.config.language || 'it');
    const onlineCount = (s.servers || []).filter((x) => x.online !== false).length;
    const chip = $('connChip');
    chip.className = 'status-chip ' + (onlineCount ? 'online' : 'offline');
    $('connText').textContent = onlineCount ? t('conn.online', { n: onlineCount }) : t('conn.offline');
    const mini = $('miniStatus');
    mini.className = 'mini-status ' + (onlineCount ? 'online' : 'offline');
    const ds = $('drawerStatus');
    ds.className = 'drawer-status ' + (onlineCount ? 'online' : 'offline');
    $('drawerStatusText').textContent = onlineCount ? t('conn.online', { n: onlineCount }) : t('conn.offline');
    statusLoadedOnce = true;
    lastOnlineCount = onlineCount;
    lastServerCount = (s.servers || []).length;
    $('subtitle').textContent = t('conn.subtitle', { online: onlineCount, total: (s.servers || []).length });
  }
}

/* ---------- azioni ---------- */



/* ---------- Guest Detail Dettagli ---------- */

let detailState = {
  key: null,
  serverId: null,
  node: null,
  type: null,
  vmid: null,
  name: null,
  tab: 'overview',
  tf: 'hour',
  data: null,
  rrd: null,
  loading: false
};

let guestDetailInitialized = false;
function initGuestDetail() {
  if (guestDetailInitialized) return; /* un solo set di listener anche dopo re-login */
  guestDetailInitialized = true;
  $('guestDetailBackdrop').querySelector('[data-guest-detail-close]').onclick = closeGuestDetail;
  $('guestDetailBackdrop').onclick = (e) => {
    if (e.target === $('guestDetailBackdrop')) closeGuestDetail();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailState.key) {
      if (e.defaultPrevented) return; /* ESC gia' gestito da una modale create */
      /* le modali create (piu' in primo piano) hanno la precedenza su ESC:
         non chiudere anche il Guest Detail sotto */
      if (!$('backupCreateModal').hidden || !$('snapshotCreateModal').hidden) return;
      closeGuestDetail();
    }
  });

  document.querySelectorAll('.guest-detail-tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.guest-detail-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      detailState.tab = btn.dataset.tab;
      renderGuestDetailTab();
    };
  });

  document.querySelectorAll('#guestDetailTfSelector .tf-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#guestDetailTfSelector .tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      detailState.tf = btn.dataset.tf;
      fetchGuestDetailRRD();
    };
  });

  window.addEventListener('resize', () => {
    if (detailState.key && detailState.tab === 'graphs' && detailState.rrd) {
      redrawGuestDetailGraphs();
    }
  });
}

function openGuestDetail(serverId, node, type, vmid) {
  detailState.serverId = serverId;
  detailState.node = node;
  detailState.type = type;
  detailState.vmid = vmid;
  detailState.key = serverId + ':' + node + ':' + type + ':' + vmid;
  detailState.data = null;
  detailState.rrd = null;
  detailState.tab = 'overview';

  const s = state.config.servers.find(x => x.id === serverId);
  const guest = findGuest(serverId, node, type, vmid);
  if (!s || !guest) return;

  detailState.name = guest.name;

  /* modalità Monitoraggio del guest: da state.config.health.guestModes (già caricata) */
  const gm = healthGuestModes();
  $('guestHealthMode').value = gm[detailState.key] === 'alwayson' || gm[detailState.key] === 'ignore' ? gm[detailState.key] : 'manual';

  // Populate Header immediately from polling data
  $('guestDetailTitle').textContent = guest.name;
  $('guestDetailSubtitle').textContent = `${type.toUpperCase()} ${vmid} · ${node}`;
  const iconHtml = type === 'qemu'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect><path d="M6 8h.01"></path><path d="M10 8h.01"></path><path d="M14 8h.01"></path><path d="M6 12h12"></path><path d="M6 16h12"></path></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>';
  $('guestDetailIcon').innerHTML = iconHtml;
  $('guestDetailStatusDot').className = 'guest-detail-status-dot ' + (guest.status === 'running' ? 'running' : 'stopped');

  // Actions
  const dk = detailState.key;
  const isRun = guest.status === 'running';
  const btnStart = '<button class="ghost-btn" data-action="start" data-key="' + dk + '" ' + (isRun ? 'disabled' : '') + '>' + t('action.confirm.start') + '</button>';
  const btnStop = '<button class="danger-btn" data-action="stop" data-key="' + dk + '" ' + (!isRun ? 'disabled' : '') + '>' + t('action.confirm.stop') + '</button>';
  const btnReboot = '<button class="ghost-btn" data-action="reboot" data-key="' + dk + '" ' + (!isRun ? 'disabled' : '') + '>' + t('action.confirm.reboot') + '</button>';
  const btnVnc = type === 'qemu' ? '<button class="primary-btn" data-vnc="' + dk + '" ' + (!isRun ? 'disabled title="' + t('vnc.needStart') + '"' : '') + '>🖥️ ' + t('vnc.open') + '</button>' : '';
  const btnShell = type === 'lxc' ? '<button class="primary-btn" data-shell="' + dk + '" ' + (!isRun ? 'disabled' : '') + '>>_ ' + t('gd.shell') + '</button>' : '';
  $('guestDetailActions').innerHTML = btnStart + btnStop + btnReboot + btnVnc + btnShell;

  $('guestDetailBackdrop').classList.add('active');
  $('guestDetailLoading').classList.remove('hidden');
  document.querySelectorAll('.guest-detail-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.guest-detail-tab').forEach(b => b.classList.remove('active'));
  const firstTab = document.querySelector('.guest-detail-tab[data-tab="overview"]');
  if (firstTab) firstTab.classList.add('active');

  fetchGuestDetailData();
}

function closeGuestDetail() {
  $('guestDetailBackdrop').classList.remove('active');
  detailState.key = null;
  detailState.name = null;
  detailState.serverId = null;
  detailState.node = null;
  detailState.type = null;
  detailState.vmid = null;
  detailState.data = null;
  detailState.rrd = null;
}

async function fetchGuestDetailData() {
  if (!detailState.key) return;
  detailState.loading = true;
  try {
    const url = '/api/guest/detail?serverId=' + encodeURIComponent(detailState.serverId) +
      '&node=' + encodeURIComponent(detailState.node) +
      '&type=' + encodeURIComponent(detailState.type) +
      '&vmid=' + encodeURIComponent(detailState.vmid);
    const res = await fetch(url);
    let data;
    try { data = await res.json(); } catch (_) { data = {}; }
    if (res.ok && data.ok) {
      detailState.data = data;
      renderGuestDetailTab();
      if (detailState.tab === 'graphs') fetchGuestDetailRRD();
    } else {
      const errMsg = (data && data.error) ? data.error : ('HTTP ' + res.status);
      console.error('fetchGuestDetailData error:', errMsg);
      document.querySelectorAll('.guest-detail-panel').forEach(function(p) { p.classList.add('hidden'); });
      var ov = $('gd-tab-overview');
      ov.innerHTML = '<div class="gd-error">' + t('gd.error') + '</div>';
      ov.classList.remove('hidden');
    }
  } catch (e) {
    console.error('fetchGuestDetailData network error:', e);
    document.querySelectorAll('.guest-detail-panel').forEach(function(p) { p.classList.add('hidden'); });
    var ov = $('gd-tab-overview');
    ov.innerHTML = '<div class="gd-error">' + t('gd.error') + '</div>';
    ov.classList.remove('hidden');
  } finally {
    detailState.loading = false;
    $('guestDetailLoading').classList.add('hidden');
  }
}
async function fetchGuestDetailRRD() {
  if (!detailState.key) return;
  if (detailState.tab === 'graphs') {
    $('guestDetailGraphs').innerHTML = '<div class="gd-graphs-loading">' + t('gd.loading') + '</div>';
  }
  try {
    const res = await fetch(`/api/guest/rrd?serverId=${detailState.serverId}&node=${detailState.node}&type=${detailState.type}&vmid=${detailState.vmid}&timeframe=${detailState.tf}`);
    const json = await res.json();
    if (json.ok) {
      detailState.rrd = json.data;
      if (detailState.tab === 'graphs') renderGuestDetailGraphs();
    } else if (detailState.tab === 'graphs') {
      $('guestDetailGraphs').innerHTML = '<div class="gd-graphs-loading">' + t('gd.error') + '</div>';
    }
  } catch (e) {
    console.error('Fetch rrd error:', e);
    if (detailState.tab === 'graphs') {
      $('guestDetailGraphs').innerHTML = '<div class="gd-graphs-loading">' + t('gd.error') + '</div>';
    }
  }
}

function renderGuestDetailTab() {
  if (!detailState.data) return;
  document.querySelectorAll('.guest-detail-panel').forEach(p => p.classList.add('hidden'));
  $('gd-tab-' + detailState.tab).classList.remove('hidden');

  if (detailState.tab === 'overview') renderGuestDetailOverview();
  else if (detailState.tab === 'config') renderGuestDetailConfig();
  else if (detailState.tab === 'tasks') renderGuestDetailTasks();
  else if (detailState.tab === 'graphs' && !detailState.rrd) fetchGuestDetailRRD();
  else if (detailState.tab === 'graphs') renderGuestDetailGraphs();
  else if (detailState.tab === 'backup') fetchGuestBackup(false);
}

function renderGuestDetailOverview() {
  const d = detailState.data.status || {};
  const c = detailState.data.config || {};

  const uptime = fmtUptime(d.uptime || 0);
  const cpuVal = ((d.cpu || 0) * 100).toFixed(1) + '%';
  const cpuMax = d.cpus || 1;
  const ramUse = fmtBytes(d.mem || 0);
  const ramMax = fmtBytes(d.maxmem || 0);
  const ramPct = d.maxmem ? ((d.mem / d.maxmem) * 100).toFixed(1) : 0;
  const ramBarPct = Math.min(100, ramPct);
  /* balloon: VM QEMU con ballooning attivo (mem reale > maxmem) */
  const balloon = detailState.type === 'qemu' && d.maxmem > 0 && d.mem > d.maxmem;

  let diskStr = '—', diskPct = 0;
  if (d.maxdisk) {
    diskStr = fmtBytes(d.disk || 0) + ' / ' + fmtBytes(d.maxdisk);
    diskPct = ((d.disk || 0) / d.maxdisk) * 100;
  }

  let netStr = fmtBytes(d.netin || 0) + ' / ' + fmtBytes(d.netout || 0);

  let ipStr = '—';
  if (detailState.type === 'qemu') {
    ipStr = (d.agent === 1) ? 'Agent OK' : 'No Agent';
  }

  let tagsHtml = '';
  if (d.tags) {
    tagsHtml = '<div class="ov-tags">' + d.tags.split(/[;,]/).map(t => `<span class="ov-tag">${t.trim()}</span>`).join('') + '</div>';
  }

  const html = `
    <div class="ov-grid" style="grid-template-columns: 1fr 1fr;">
      <div class="ov-card">
        <span class="ov-label">${t('gd.uptime')}</span>
        <span class="ov-val">${uptime}</span>
      </div>
      <div class="ov-card">
        <span class="ov-label">${t('gd.node')}</span>
        <span class="ov-val">${detailState.node}</span>
      </div>
      <div class="ov-card" style="grid-column: 1 / -1;">
        <span class="ov-label">${t('gd.cpu')} (${cpuMax} Cores)</span>
        <span class="ov-val">${cpuVal}</span>
        <div class="ov-bar-wrap"><div class="ov-bar" style="width: ${Math.min(100, (d.cpu || 0)*100)}%;"></div></div>
      </div>
      <div class="ov-card" style="grid-column: 1 / -1;">
        <span class="ov-label">${t('gd.ram')}${balloon ? ' <span class="balloon-badge">' + t('gd.balloon') + '</span>' : ''}</span>
        <span class="ov-val">${ramUse} / ${ramMax}</span>
        <div class="ov-bar-wrap"><div class="ov-bar" style="width: ${ramBarPct}%;"></div></div>
      </div>
      <div class="ov-card" style="grid-column: 1 / -1;">
        <span class="ov-label">${t('gd.disk')}</span>
        <span class="ov-val">${diskStr}</span>
        ${d.maxdisk ? `<div class="ov-bar-wrap"><div class="ov-bar" style="width: ${Math.min(100, diskPct)}%;"></div></div>` : ''}
      </div>
      <div class="ov-card" style="grid-column: 1 / -1;">
        <span class="ov-label">${t('gd.net')}</span>
        <span class="ov-val">${netStr}</span>
      </div>
      ${tagsHtml ? `<div class="ov-card" style="grid-column: 1 / -1;"><span class="ov-label">${t('gd.tags')}</span>${tagsHtml}</div>` : ''}
      ${c.description ? `<div class="ov-card" style="grid-column: 1 / -1;"><span class="ov-label">${t('gd.notes')}</span><span class="ov-val" style="white-space: pre-wrap; font-size: 13px; color: var(--text-mut);">${c.description}</span></div>` : ''}
    </div>
  `;
  $('gd-tab-overview').innerHTML = html;
}

function renderGuestDetailConfig() {
  const c = detailState.data.config || {};
  let html = '<div class="cfg-list">';

  const keys = Object.keys(c).sort();
  for (const k of keys) {
    if (k === 'digest' || k === 'description') continue;
    html += `
      <div class="cfg-item">
        <span class="cfg-key">${k}</span>
        <span class="cfg-val">${c[k]}</span>
      </div>
    `;
  }

  html += '</div>';
  $('gd-tab-config').innerHTML = html;
}

function renderGuestDetailTasks() {
  const tasks = detailState.data.tasks || [];
  if (tasks.length === 0) {
    $('gd-tab-tasks').innerHTML = `<div style="text-align: center; color: var(--text-mut); padding: 20px;">${t('gd.empty_tasks')}</div>`;
    return;
  }

  let html = '<div class="task-list">';
  for (const t of tasks) {
    const st = String(t.status || '');
    const ended = (t.endtime || 0) > 0;
    let cls, icon;
    if (st === 'OK' || st === 'stopped') {
      cls = 'ok'; icon = '✓';
    } else if (st === 'running' || (!ended && st === '')) {
      cls = 'running'; icon = '↻';
    } else if (ended && st !== 'OK' && st !== 'stopped') {
      cls = 'err'; icon = '✕';
    } else {
      cls = 'unknown'; icon = '•';
    }
    const date = new Date((t.starttime || 0) * 1000).toLocaleString();
    const errMsg = cls === 'err' ? `<div class="task-err" title="${st}">${st}</div>` : '';
    html += `
      <div class="task-item ${cls}">
        <div class="task-icon">${icon}</div>
        <div class="task-info">
          <div class="task-title">${t.type}</div>
          <div class="task-meta">${date} · ${t.user || 'sys'}</div>
          ${errMsg}
        </div>
      </div>
    `;
  }
  html += '</div>';
  $('gd-tab-tasks').innerHTML = html;
}

function renderGuestDetailGraphs() {
  const rrd = detailState.rrd || [];
  let html = `
    <div class="graph-card">
      <div class="graph-title">CPU Usage (%)</div>
      <canvas id="gdCpuCanvas" class="graph-canvas"></canvas>
    </div>
    <div class="graph-card">
      <div class="graph-title">RAM Usage</div>
      <canvas id="gdRamCanvas" class="graph-canvas"></canvas>
    </div>
  `;
  $('guestDetailGraphs').innerHTML = html;

  requestAnimationFrame(() => {
    redrawGuestDetailGraphs();
  });
}

function redrawGuestDetailGraphs() {
  const rrd = detailState.rrd || [];
  drawRrdCanvas('gdCpuCanvas', rrd, 'cpu', (d) => (d.cpu || 0) * 100);
  /* RAM: scala dinamica - se il balloon supera il 100% si sale oltre, senza nascondere dati */
  const memVals = rrd.filter((d) => d.mem != null && d.maxmem > 0).map((d) => (d.mem / d.maxmem) * 100);
  const memMax = memVals.length ? Math.max(...memVals, 100) : 100;
  const memCeil = Math.ceil((memMax - 0.0001) / 50) * 50;
  drawRrdCanvas('gdRamCanvas', rrd, 'mem', (d) => (d.mem / (d.maxmem || 0)) * 100, { yMax: Math.max(100, memCeil) });
}

function drawRrdCanvas(id, data, key, transform, opts) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.offsetWidth;
  const h = canvas.clientHeight || canvas.offsetHeight;
  if (w <= 0 || h <= 0) return;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const valid = data.filter((d) => {
    const v = d[key];
    const m = d.maxmem;
    if (v === undefined || v === null || isNaN(v)) return false;
    if (key === 'mem' && (m === undefined || m === null || m <= 0)) return false;
    return true;
  });
  if (valid.length === 0) return;

  const vals = valid.map((d) => transform(d));
  const max = Math.max(...vals, 1, opts && opts.yMax ? opts.yMax : 1);
  const min = 0;
  const pad = 4;
  const yLabelW = 30;

  const isDark = !document.documentElement.classList.contains('theme-light');
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(26, 35, 64, 0.1)';
  const lineColor = isDark ? '#4f8cff' : '#2f6bff';
  const fillTop = isDark ? 'rgba(79, 140, 255, 0.35)' : 'rgba(47, 107, 255, 0.25)';
  const fillBottom = isDark ? 'rgba(79, 140, 255, 0)' : 'rgba(47, 107, 255, 0)';
  const labelColor = isDark ? 'rgba(232, 237, 249, 0.55)' : 'rgba(26, 35, 64, 0.55)';

  const plotH = h - 18;
  const yFor = (v) => pad + plotH - ((v - min) / (max - min)) * (plotH - pad * 2);

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let i = 0; i <= 2; i++) {
    const y = pad + (plotH - pad * 2) * (i / 2);
    ctx.beginPath();
    ctx.moveTo(yLabelW, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  /* label discrete sull'asse Y (100% / 50% / 0%), allineate alle linee di griglia */
  ctx.fillStyle = labelColor;
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  /* scala dinamica: 0/50/100 oppure 0/50/100/max reale se si supera il 100% */
  const ySteps = max > 100 ? [0, 50, 100, max] : [0, 50, 100];
  for (let i = 0; i < ySteps.length; i++) {
    const v = ySteps[i];
    const y = pad + (plotH - pad * 2) * (1 - v / max);
    ctx.fillText(Math.round(v) + '%', yLabelW - 4, y);
  }

  const xFor = (i) => (valid.length === 1 ? yLabelW + (w - yLabelW) / 2 : yLabelW + (i / (valid.length - 1)) * (w - yLabelW));

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, fillTop);
  grad.addColorStop(1, fillBottom);
  ctx.beginPath();
  ctx.moveTo(yLabelW, h);
  for (let i = 0; i < vals.length; i++) ctx.lineTo(xFor(i), yFor(vals[i]));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < vals.length; i++) {
    const x = xFor(i);
    const y = yFor(vals[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.fillStyle = labelColor;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  const t0 = valid[0].time;
  const t1 = valid[valid.length - 1].time;
  if (t0 !== undefined && t1 !== undefined) {
    const fmt = (ts) => {
      const d = new Date(ts * 1000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return hh + ':' + mm;
    };
    ctx.textAlign = 'left';
    ctx.fillText(fmt(t0), yLabelW, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText(fmt(t1), w, h - 2);
  }
}


async function runAction(btn) {
  const key = btn.dataset.key;
  const [serverId, node, type, vmid] = key.split(':');
  const action = btn.dataset.action;

  // Determine guest name: from card DOM or from detailState (when called from Guest Detail)
  const fromCard = btn.closest('.guest-card');
  let guestName;
  if (fromCard) {
    guestName = fromCard.querySelector('.guest-name') ? fromCard.querySelector('.guest-name').textContent : '';
  } else if (detailState.name) {
    guestName = detailState.name;
  } else {
    console.error('runAction: cannot determine guest name for key', key);
    toast(t('action.failed') + ': guest sconosciuto', 'err');
    return;
  }

  const ok = await confirmDialog(t('action.confirm.' + action) + ' "' + guestName + '"?', action === 'stop' || action === 'shutdown' ? 'danger' : 'default');
  if (!ok) return;

  state.busy.add(key);
  btn.disabled = true;
  btn.textContent = t('action.' + ({ start: 'starting', reboot: 'rebooting', shutdown: 'shutting', stop: 'stopping', suspend: 'suspending', resume: 'resuming' }[action] || 'starting'));
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId, node, vmid: Number(vmid), action, type, name: guestName }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    toast(t('action.sent', { action }), 'ok');
    setTimeout(function() {
      refresh();
      // If Guest Detail is still open for the same guest, refresh its data too
      if (detailState.key === key) {
        fetchGuestDetailData();
      }
    }, 1200);
  } catch (e) {
    toast(t('action.failed') + ' ' + guestName + ': ' + e.message, 'err');
  } finally {
    state.busy.delete(key);
    renderAll();
  }
}
function confirmDialog(text, kind) {
  return new Promise((resolve) => {
    $('confirmText').textContent = text;
    $('confirmTitle').textContent = t('confirm.title');
    const okBtn = $('confirmOk');
    okBtn.className = kind === 'danger' ? 'danger-btn' : 'primary-btn';
    okBtn.textContent = t('confirm.ok');
    document.querySelectorAll('#confirmModal [data-close]').forEach((b) => {
      if (b.textContent.trim() === 'Annulla' || b.textContent.trim() === 'Cancel') b.textContent = t('confirm.cancel');
    });
    $('confirmModal').hidden = false;
    const done = (v) => {
      $('confirmModal').hidden = true;
      okBtn.onclick = null;
      document.querySelectorAll('#confirmModal [data-close]').forEach((b) => (b.onclick = null));
      resolve(v);
    };
    okBtn.onclick = () => done(true);
    document.querySelectorAll('#confirmModal [data-close]').forEach((b) => (b.onclick = () => done(false)));
  });
}

/* ---------- rete ---------- */

async function refresh() {
  if (state.isRefreshing) {
    state.refreshQueued = true; /* accoda un refresh al termine di quello in corso */
    return;
  }
  state.isRefreshing = true;
  const btn = $('btnRefresh');
  btn.classList.add('spinning');
  try {
    const res = await fetch('/api/status');
    if (res.status === 401) return; /* gestito centralmente dal wrapper auth */
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Errore');
    state.status = data;
    /* Health: UNA valutazione per refresh; il rendering avviene solo a vista attiva */
    state.health = evaluateHealth(
      state.status,
      (state.config && state.config.health && state.config.health.guestModes) || {},
      healthTaskCache.data || [],
      healthExtrasPayload(),
      healthSettings()
    );
    renderAll();
  } catch (e) {
    /* offline: nessun dato infrastrutturale deve restare visibile */
    toast(t('auth.offline'), 'err');
    localCleanupAndShowLogin(false);
  } finally {
    btn.classList.remove('spinning');
    state.isRefreshing = false;
    if (state.refreshQueued) {
      state.refreshQueued = false;
      refresh();
    }
  }
}

/* ---------- auto refresh: un solo timer ---------- */

let autoRefreshTimer = null;

function startAutoRefresh(ms) {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  if (state.config.autoRefreshEnabled === false) {
    autoRefreshTimer = null;
    return;
  }
  autoRefreshMs = ms;
  autoRefreshTimer = setInterval(refresh, ms);
}

/* polling in background: sospende il timer quando la tab non è visibile;
   al ritorno refresh immediato e ripristino dell'intervallo normale. */
let autoRefreshMs = 10000;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopAutoRefresh();
  } else if (state.config.autoRefreshEnabled !== false) {
    refresh();
    startAutoRefresh(autoRefreshMs);
  }
});

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function updateAutoRefreshUI() {
  const enabled = state.config.autoRefreshEnabled !== false;
  const toggle = $('autoToggle');
  toggle.classList.toggle('on', enabled);
  toggle.classList.toggle('off', !enabled);
  toggle.setAttribute('aria-pressed', String(enabled));
  $('autoToggleText').textContent = enabled ? 'ON' : 'OFF';
  $('refreshSelect').closest('.auto-refresh').classList.toggle('disabled', !enabled);
}

/* ---------- impostazioni ---------- */

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
    $('refreshSelect').value = String(state.config.refreshMs || 10000);
    updateHealthSettingsUI();
    applyTheme();
    applyLanguage();
  } catch { /* ignora */ }
}

function openServerModal(mode, server) {
  state.editingServerId = mode === 'edit' && server ? server.id : null;
  $('serverModalTitle').textContent = mode === 'edit' ? t('server.edit.title') : t('server.add.title');
  $('btnSubmitServer').textContent = mode === 'edit' ? t('server.save.btn') : t('server.add.btn');
  $('deleteServerField').hidden = mode !== 'edit';
  $('serverForm').reset();
  $('fVerifyTls').checked = false;
  $('fPassword').placeholder = t('server.pass.ph');
  $('fPassword').required = true;
  if (mode === 'edit' && server) {
    $('fName').value = server.name;
    $('fUrl').value = server.url;
    $('fUser').value = server.user;
    $('fPassword').placeholder = t('server.pass.edit.ph');
    $('fPassword').required = false;
    $('fVerifyTls').checked = server.verifyTls !== false;
  }
  $('serverModal').hidden = false;
  $('fName').focus();
}

function closeServerModal() {
  $('serverModal').hidden = true;
  state.editingServerId = null;
}

/* ---------- init ---------- */

$('btnSettings').onclick = () => {
  $('settingsModal').hidden = false;
  loadConfig();
};

$('btnAddServer').onclick = () => openServerModal('add');

document.addEventListener('click', (e) => {
  const card = e.target.closest('.guest-card');
  if (card && !e.target.closest('button')) {
    const key = card.dataset.key;
    if (key) {
      const [serverId, node, type, vmid] = key.split(':');
      openGuestDetail(serverId, node, type, vmid);
    }
  }

  const editBtn = e.target.closest('[data-edit-server]');
  if (editBtn) {
    const s = state.config.servers.find((x) => x.id === editBtn.dataset.editServer);
    if (s) openServerModal('edit', s);
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (btn) runAction(btn);
});

document.querySelectorAll('.modal-backdrop').forEach((m) => {
  /* La Shell ha il suo ciclo di vita (closeShell): NON sovrascrivere il
     binding [data-close] e chiudi con cleanup anche dal click sul backdrop. */
  if (m.id === 'shellModal') {
    m.addEventListener('click', (e) => {
      if (e.target === m) closeShell();
    });
    return;
  }
  /* La Console VNC ha il suo ciclo di vita in vnc-console.js (close):
     qui si evita SOLO il binding generico, il wiring e' nel suo modulo. */
  if (m.id === 'vncModal') {
    return;
  }
  /* modale cambio password: chiusura con cleanup dei campi; bloccata
     durante il submit (changePasswordBusy) */
  if (m.id === 'changePasswordModal') {
    m.addEventListener('click', (e) => {
      if (e.target === m) closeChangePasswordModal();
    });
    m.querySelectorAll('[data-close]').forEach((b) => {
      b.onclick = closeChangePasswordModal;
    });
    return;
  }
  m.addEventListener('click', (e) => {
    if (e.target === m) m.hidden = true;
  });
  m.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => { m.hidden = true; };
  });
});

$('serverForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    id: state.editingServerId || undefined,
    name: $('fName').value,
    url: $('fUrl').value,
    user: $('fUser').value,
    password: $('fPassword').value || undefined,
    verifyTls: $('fVerifyTls').checked,
  };
  try {
    const res = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    const wasEdit = !!state.editingServerId;
    closeServerModal();
    toast(wasEdit ? t('server.updated') : t('server.added'), 'ok');
    await loadConfig();
    refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
};

$('btnDeleteServer').onclick = async () => {
  const id = state.editingServerId;
  const s = state.config.servers.find((x) => x.id === id);
  if (!s) return;
  const ok = await confirmDialog(t('server.delete.confirm', { name: s.name }), 'danger');
  if (!ok) return;
  try {
    const res = await fetch('/api/servers/' + encodeURIComponent(id), { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    closeServerModal();
    toast(t('server.deleted'), 'ok');
    await loadConfig();
    refresh();
  } catch (err) {
    toast(err.message, 'err');
  }
};

/* ---------- tour guidato ---------- */

const TOUR_VERSION = 2;

const tourSteps = [
  {
    view: 'dashboard',
    target: null,
    intro: true,
    titleKey: 'tour.1.title',
    textKey: 'tour.1.text',
  },
  {
    view: 'dashboard',
    target: '#statsRow',
    titleKey: 'tour.2.title',
    textKey: 'tour.2.text',
  },
  {
    view: 'dashboard',
    target: '#serversGrid',
    titleKey: 'tour.3.title',
    textKey: 'tour.3.text',
  },
  {
    view: 'dashboard',
    target: '.guest-card',
    titleKey: 'tour.4.title',
    textKey: 'tour.4.text',
  },
  {
    view: 'dashboard',
    before: tourOpenGuestDetail,
    target: '.guest-detail-content',
    delay: 1300,
    titleKey: 'tour.5.title',
    textKey: 'tour.5.text',
  },
  {
    view: 'dashboard',
    target: '.guest-detail-tabs',
    titleKey: 'tour.6.title',
    textKey: 'tour.6.text',
  },
  {
    view: 'dashboard',
    skipIf: () => !tourShellTarget(),
    target: () => tourShellTarget(),
    titleKey: 'tour.7.title',
    textKey: 'tour.7.text',
  },
  {
    view: 'health',
    before: tourCloseGuestDetail,
    titleKey: 'tour.8.title',
    target: '#healthBanner',
    textKey: 'tour.8.text',
  },
  {
    view: 'backup',
    titleKey: 'tour.9.title',
    target: '#backupSection .health-cards',
    textKey: 'tour.9.text',
  },
  {
    view: 'backup',
    titleKey: 'tour.10.title',
    target: '#backupSubSnapshots',
    textKey: 'tour.10.text',
  },
  {
    view: 'dashboard',
    before: tourOpenGuestBackupTab,
    target: '#gd-tab-backup',
    delay: 1800,
    titleKey: 'tour.11.title',
    textKey: 'tour.11.text',
  },
  {
    view: 'logs',
    before: tourCloseGuestDetail,
    titleKey: 'tour.12.title',
    target: '#logsFilters',
    textKey: 'tour.12.text',
  },
  {
    view: 'dashboard',
    before: tourOpenSettings,
    titleKey: 'tour.13.title',
    target: '#themeSegmented',
    delay: 500,
    textKey: 'tour.13.text',
  },
  {
    view: 'dashboard',
    titleKey: 'tour.14.title',
    target: '#btnLogout',
    textKey: 'tour.14.text',
  },
  {
    view: 'dashboard',
    target: null,
    titleKey: 'tour.15.title',
    textKey: 'tour.15.text',
  },
];

let tourIndex = -1;
let tourTarget = null;
let tourOpenedGd = false;
let tourOpenedSettings = false;

/* guest dinamico: mai VMID hardcoded. Priorita': LXC running, QEMU running,
   primo LXC, primo QEMU; null se non ci sono guest. */
function tourGuest() {
  const servers = (state.status && state.status.servers) || [];
  let firstLxc = null;
  let firstQemu = null;
  for (const s of servers) {
    for (const n of (s.nodes || [])) {
      for (const g of (n.lxc || [])) {
        if (!firstLxc) firstLxc = { serverId: s.id, node: n.name, type: 'lxc', vmid: g.id, name: g.name };
        if (g.status === 'running') return { serverId: s.id, node: n.name, type: 'lxc', vmid: g.id, name: g.name };
      }
      for (const g of (n.vms || [])) {
        if (!firstQemu) firstQemu = { serverId: s.id, node: n.name, type: 'qemu', vmid: g.id, name: g.name };
        if (g.status === 'running') return { serverId: s.id, node: n.name, type: 'qemu', vmid: g.id, name: g.name };
      }
    }
  }
  return firstLxc || firstQemu || null;
}

function tourShellTarget() {
  const btn = document.querySelector('#guestDetail [data-shell]:not([disabled])');
  return btn || null;
}

function tourOpenGuestDetail() {
  const g = tourGuest();
  if (!g) return;
  tourOpenedGd = true;
  openGuestDetail(g.serverId, g.node, g.type, g.vmid);
}

function tourOpenGuestBackupTab() {
  tourOpenGuestDetail();
  setTimeout(() => {
    const tab = document.querySelector('.guest-detail-tab[data-tab="backup"]');
    if (tab) tab.click();
  }, 1200);
}

function tourCloseGuestDetail() {
  if (detailState.key) closeGuestDetail();
}

function tourOpenSettings() {
  tourOpenedSettings = true;
  $('settingsModal').hidden = false;
}

function spotlight(el) {
  const spot = $('tourSpotlight');
  const backdrop = $('tourBackdrop');
  tourTarget = el;
  if (!el) {
    spot.style.display = 'none';
    backdrop.classList.add('dim-all');
    return;
  }
  spot.style.display = 'block';
  backdrop.classList.remove('dim-all');
  const r = el.getBoundingClientRect();
  spot.style.left = (r.left - 8) + 'px';
  spot.style.top = (r.top - 8) + 'px';
  spot.style.width = (r.width + 16) + 'px';
  spot.style.height = (r.height + 16) + 'px';
}

/* mantiene il foro allineato al target durante scroll e resize */
let tourScrollRaf = null;
window.addEventListener('scroll', () => {
  if (tourIndex < 0 || !tourTarget) return;
  if (tourScrollRaf) return;
  tourScrollRaf = requestAnimationFrame(() => {
    tourScrollRaf = null;
    spotlight(tourTarget);
  });
}, { capture: true, passive: true });
window.addEventListener('resize', () => {
  if (tourIndex >= 0 && tourTarget) spotlight(tourTarget);
});

async function showTourStep(i) {
  const step = tourSteps[i];
  /* skip condizionale (guest assenti, nessun pulsante Shell, ecc.) */
  if (step.skipIf && step.skipIf()) {
    nextTourStep(1);
    return;
  }
  tourIndex = i;
  if (step.view) switchView(step.view);
  if (step.before) step.before();
  $('tourStepNum').textContent = i + 1;
  $('tourStepTotal').textContent = tourSteps.length;
  $('tourTitle').textContent = t(step.titleKey);
  $('tourText').innerHTML = t(step.textKey);
  $('tourPrev').hidden = i === 0;
  $('tourNext').textContent = i === 0
    ? t('tour.start')
    : (i === tourSteps.length - 1 ? t('tour.finish') : t('tour.next'));
  await new Promise((r) => setTimeout(r, step.delay || 90));
  let target = null;
  if (step.target) {
    target = typeof step.target === 'function' ? step.target() : document.querySelector(step.target);
  }
  spotlight(target);
  if (target && target.scrollIntoView) {
    try { target.scrollIntoView({ behavior: 'auto', block: 'center' }); } catch (_) { /* ignora */ }
    setTimeout(() => spotlight(target), 60);
  }
}

function nextTourStep(dir) {
  let n = tourIndex + dir;
  while (n >= 0 && n < tourSteps.length && tourSteps[n].skipIf && tourSteps[n].skipIf()) n += dir;
  if (n >= tourSteps.length) {
    endTour(true);
    return;
  }
  showTourStep(n);
}

/* Il tour NON usa piu' la modalita' demo: gira sui dati reali, solo navigazione
   ed evidenziazione. Nessuna preferenza modificata, nessuna azione PVE. */
function startTour() {
  state.tourRunning = true;
  tourOpenedGd = false;
  tourOpenedSettings = false;
  closeDrawer();
  $('tourBackdrop').hidden = false;
  showTourStep(0);
}

/* save=false: interruzione (ESC o logout) -> il completamento NON viene salvato.
   save=true: fine o skip esplicito -> salva tourCompletedVersion. */
async function endTour(save) {
  $('tourBackdrop').hidden = true;
  if (tourOpenedSettings) $('settingsModal').hidden = true;
  if (tourOpenedGd && detailState.key) closeGuestDetail();
  closeDrawer();
  tourIndex = -1;
  tourTarget = null;
  tourOpenedGd = false;
  tourOpenedSettings = false;
  state.tourRunning = false;
  switchView('dashboard');
  if (save) {
    try {
      const res = await fetch('/api/tour/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: TOUR_VERSION }),
      });
      const data = await res.json();
      if (data.ok) {
        state.config.tourCompleted = true;
        state.config.tourCompletedVersion = TOUR_VERSION;
        updateTourBadge();
        toast(t('tour.done'), 'ok');
      }
    } catch (_) { /* ignora */ }
  }
}

$('btnRestartTour').onclick = () => {
  $('settingsModal').hidden = true;
  startTour();
};
$('tourSkip').onclick = () => endTour(true);
$('tourPrev').onclick = () => { if (tourIndex > 0) nextTourStep(-1); };
$('tourNext').onclick = () => {
  if (tourIndex < tourSteps.length - 1) nextTourStep(1);
  else endTour(true);
};

document.addEventListener('keydown', (e) => {
  if ($('tourBackdrop').hidden) return;
  if (e.key === 'Escape') endTour(false);
  if (e.key === 'ArrowRight') $('tourNext').click();
  if (e.key === 'ArrowLeft') $('tourPrev').click();
});

/* badge discreto per utenti con tour precedente (V1): nessun popup */
function updateTourBadge() {
  const el = $('tourNewBadge');
  if (!el) return;
  const cfg = state.config;
  el.hidden = !(cfg.tourCompleted && !cfg.tourCompletedVersion);
}

$('tourNewBadge').onclick = () => {
  $('settingsModal').hidden = true;
  startTour();
};

/* ESC chiude SOLO la modale standard in primo piano (l'ultima visibile nel DOM).
   Guest Detail, Shell e Tour hanno i propri handler e non vengono toccati. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('tourBackdrop').hidden) return;   /* gestito dal tour */
  if (!$('backupCreateModal').hidden) { e.preventDefault(); closeBackupCreateModal(); return; }
  if (!$('snapshotCreateModal').hidden) { e.preventDefault(); closeSnapshotCreateModal(); return; }
  if (detailState.key) return;             /* gestito dal Guest Detail */
  if (!$('shellModal').hidden) return;     /* la Shell non si chiude con ESC */
  if (!$('vncModal').hidden) return;       /* la Console non si chiude con ESC */
  if (!$('changePasswordModal').hidden) {  /* durante il submit ESC non fa nulla */
    if (changePasswordBusy) return;
    closeChangePasswordModal();
    return;
  }
  const modals = ['settingsModal', 'serverModal', 'confirmModal', 'logDetailModal', 'infoModal'];
  for (let i = modals.length - 1; i >= 0; i--) {
    const m = document.getElementById(modals[i]);
    if (m && !m.hidden) { m.hidden = true; return; }
  }
});

$('btnTest').onclick = async () => {
  const btn = $('btnTest');
  btn.classList.add('spinning');
  btn.disabled = true;
  try {
    const res = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: $('fUrl').value,
        user: $('fUser').value,
        password: $('fPassword').value,
        verifyTls: $('fVerifyTls').checked,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    toast(t('server.test.ok', { version: data.version + (data.release ? ' (' + data.release + ')' : '') }), 'ok');
  } catch (err) {
    const msg = /certificate|TLS|SSL/i.test(err.message)
      ? t('server.test.cert')
      : t('server.test.fail', { msg: err.message });
    toast(msg, 'err');
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
};

$('btnRefresh').onclick = refresh;

/* ---------- bootstrap autenticato ---------- */

async function loadDashboard() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    state.config = cfg;
    const ms = cfg.refreshMs || 10000;
    $('refreshSelect').value = String(ms);
    applyTheme();
    applyLanguage();
    initGuestDetail();
    updateAutoRefreshUI();
    startAutoRefresh(ms);
    refresh();
    updateTourBadge();
    /* nuovo utente (mai visto alcun tour): intro con Inizia/Salta, non invasivo */
    if (!cfg.tourCompleted && !cfg.tourCompletedVersion) {
      setTimeout(startTour, 800);
    }
  } catch (_) {
    localCleanupAndShowLogin(false);
  }
}

async function bootApp() {
  applyLanguage();
  try {
    const res = await fetch('/api/auth/session');
    const data = await res.json();
    if (res.ok && data.ok && data.authenticated) {
      authState.authenticated = true;
      authState.user = (data.user && data.user.username) || null;
      updateSessionUser();
      authExpiryHandled = false;
      hideLogin();
      loadDashboard();
    } else {
      showLogin();
    }
  } catch (_) {
    /* errore di RETE al boot (distinto da 401): login + stato offline + Riprova.
       Nessun bypass del login, nessun dato offline mostrato. */
    showLogin();
    showAuthError(t('auth.offline'));
    $('authRetry').hidden = false;
  }
}

$('authRetry').onclick = () => {
  $('authRetry').hidden = true;
  $('authError').hidden = true;
  bootApp();
};

bootApp();

/* badge versione: metadata decorativo da /api/version, UNA sola fetch al boot.
   Errore -> badge resta nascosto, nessun toast/errore UI, nessun salvataggio. */
async function fetchAppVersion() {
  try {
    const res = await fetch('/api/version');
    if (!res.ok) return;
    const data = await res.json();
    if (data && typeof data.version === 'string' && data.version) {
      const badge = $('versionBadge');
      if (badge) {
        badge.textContent = 'v' + data.version;
        badge.hidden = false;
      }
    }
  } catch (_) {
    /* degradazione silenziosa */
  }
}

fetchAppVersion();

/* tema: segmented control */
document.querySelectorAll('#themeSegmented [data-theme]').forEach((btn) => {
  btn.onclick = async () => {
    const theme = btn.dataset.theme;
    try {
      const res = await fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
      state.config.theme = theme;
      applyTheme();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
});

/* lingua: select */
$('languageSelect').onchange = async (e) => {
  const language = e.target.value;
  try {
    const res = await fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    state.config.language = language;
    setLangPref(language);
    applyLanguage();
  } catch (err) {
    toast(err.message, 'err');
    e.target.value = state.config.language || 'it';
  }
};

$('autoToggle').onclick = async () => {
  const enabled = state.config.autoRefreshEnabled === false;
  try {
    const res = await fetch('/api/autorefresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    state.config.autoRefreshEnabled = enabled;
    updateAutoRefreshUI();
    if (enabled) {
      startAutoRefresh(state.config.refreshMs || 10000);
      toast(t('toast.auto.on'), 'ok');
    } else {
      stopAutoRefresh();
      toast(t('toast.auto.off'), 'info');
    }
  } catch (err) {
    toast(err.message, 'err');
  }
};

$('refreshSelect').onchange = async (e) => {
  const ms = Number(e.target.value);
  try {
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshMs: ms }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    state.config.refreshMs = ms;
    startAutoRefresh(ms); /* cancella il timer precedente e ne crea uno solo */
    toast(t('toast.auto.interval', { sec: ms / 1000 }), 'ok');
  } catch (err) {
    toast(err.message, 'err');
    e.target.value = String(state.config.refreshMs || 10000);
  }
};

/* ---------- PWA ---------- */

/* ---------- Health engine (FASE 2): puro, nessun side effect ---------- */

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

/* stato volatile anti-flapping: id check -> { crit, warn, ok, severity, firstSeen }.
   Nessuna persistenza: al reload riparte da zero (accettato in V1). */
const healthSamples = new Map();

const HEALTH_SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/* task alerts (FASE 4): allowlist -> severity; eventi conclusi, nessuna isteresi */
const HEALTH_TASK_ALLOWLIST = {
  vzdump: 'critical',
  vzstart: 'warning', qmstart: 'warning',
  vzstop: 'warning', vzshutdown: 'warning', qmstop: 'warning', qmshutdown: 'warning',
  vzreboot: 'warning', qmreboot: 'warning',
  qmmigrate: 'warning', qmsnapshot: 'warning',
  vzrestore: 'warning', qmrestore: 'warning', qmclone: 'warning'
};
const HEALTH_TASK_WINDOW_S = 24 * 3600;
const HEALTH_TASK_TTL_MS = 60000;

/* ---------- Health: soglie configurabili e costanti ---------- */

const HEALTH_SETTING_DEFAULTS = {
  storage: { warning: 85, critical: 90 },
  backupAge: { warningDays: 7, criticalDays: 14 },
  swap: { warning: 80, critical: 90 },
  disk: { temp: { warning: 55, critical: 65 }, wear: { warning: 10 } },
};

/* merge ricorsivo client (gruppi annidati come disk.temp) */
function mergeSettingClient(def, user) {
  if (def && typeof def === 'object' && !Array.isArray(def)) {
    const out = {};
    for (const key of Object.keys(def)) {
      const u = user && typeof user === 'object' && !Array.isArray(user) ? user[key] : undefined;
      out[key] = (def[key] && typeof def[key] === 'object' && !Array.isArray(def[key]))
        ? mergeSettingClient(def[key], u)
        : (Number.isFinite(Number(u)) ? Number(u) : def[key]);
    }
    return out;
  }
  return def;
}

/* impostazioni effettive: config.json (health.settings) + default; un gruppo
   invalido ricade sui default. Pura, nessun side effect. */
function healthSettings() {
  const s = state.config && state.config.health && state.config.health.settings;
  const out = {};
  for (const [group, def] of Object.entries(HEALTH_SETTING_DEFAULTS)) {
    const user = s && typeof s === 'object' && !Array.isArray(s) ? s[group] : null;
    out[group] = mergeSettingClient(def, user);
  }
  const pctOk = (g) => g.warning >= 1 && g.warning <= 99 && g.critical >= 2 && g.critical <= 100 && g.warning < g.critical;
  if (!pctOk(out.storage)) out.storage = { ...def.storage };
  if (!pctOk(out.swap)) out.swap = { ...def.swap };
  const b = out.backupAge;
  if (!(b.warningDays >= 1 && b.warningDays <= 365 && b.criticalDays >= 2 && b.criticalDays <= 365 && b.warningDays < b.criticalDays)) {
    out.backupAge = { ...def.backupAge };
  }
  /* disk: temperatura (warning < critical, range sensati) e vita residua
     (warning > 5 fisso critico, <= 100) */
  const d = out.disk;
  if (!(d.temp.warning >= 20 && d.temp.warning <= 90 && d.temp.critical >= 21 && d.temp.critical <= 95 && d.temp.warning < d.temp.critical)) {
    out.disk.temp = { ...def.disk.temp };
  }
  if (!(d.wear.warning > 5 && d.wear.warning <= 100)) {
    out.disk.wear = { ...def.disk.wear };
  }
  return out;
}

const HEALTH_ZFS_BAD = ['DEGRADED', 'FAULTED', 'UNAVAIL'];
const HEALTH_ZFS_ERRORS_OK = 'No known data errors';
const HEALTH_LOAD_WARN_MULT = 1.5;
/* SMART V2.1: inventory 5 min, lettura per disco 15 min (mai auto-refetch) */
const SMART_TTL_MS = 15 * 60 * 1000;
const HEALTH_DISK_WEAR_CRITICAL = 5;

/* ---------- Backup & Snapshot Manager (FASE 3: vista globale READ) ---------- */

const BACKUP_TTL = { storages: 60000, jobs: 60000, backups: 30000, snapshots: 30000, tasks: 60000 };
const BACKUP_RECENT_LIMIT = 12;
const BACKUP_SNAPSHOT_CONCURRENCY = 4;

/* cache frontend on-demand: nessun timer, invalidazione per TTL o Aggiorna */
const backupCache = {
  storages: new Map(),  /* serverId -> { at, data, error } */
  jobs: new Map(),
  backups: new Map(),
  snapshots: new Map(), /* "serverId:node:type:vmid" -> { at, data, error } */
  tasks: { at: 0, data: null, error: false },
};

let backupData = {
  storages: [], jobs: [], backups: [], snapshots: [], taskEvents: [],
  errors: [], fetchedAt: 0, loading: false, loaded: false,
};
let backupShowAll = false;
let backupFocusGuest = null; /* deep-link Health: { serverId, vmid, type } temporaneo */

/* elenco guest reale da state.status (nessuna nuova call, nessun polling) */
function backupGuestList() {
  const out = [];
  for (const s of (state.status && state.status.servers) || []) {
    for (const n of (s.nodes || [])) {
      for (const g of (n.vms || [])) out.push({ serverId: s.id, serverName: s.name, node: n.name, type: 'qemu', vmid: g.id, name: g.name });
      for (const g of (n.lxc || [])) out.push({ serverId: s.id, serverName: s.name, node: n.name, type: 'lxc', vmid: g.id, name: g.name });
    }
  }
  return out;
}

/* server da interrogare: online secondo state.status; offline -> errore parziale */
function backupServerTargets() {
  const targets = [];
  const errors = [];
  const statusServers = (state.status && state.status.servers) || [];
  const known = new Set();
  for (const s of statusServers) {
    known.add(s.id);
    if (s.online === false) {
      errors.push({ serverId: s.id, serverName: s.name, error: t('health.offline') });
      continue;
    }
    targets.push({ id: s.id, name: s.name });
  }
  if (!statusServers.length) {
    for (const s of (state.config && state.config.servers) || []) {
      if (!known.has(s.id)) targets.push({ id: s.id, name: s.name });
    }
  }
  return { targets, errors };
}

/* fetch JSON con controllo ok coerente col backend */
async function backupFetch(url, opts) {
  const res = await fetch(url, opts);
  let data;
  try { data = await res.json(); } catch (_) { data = {}; }
  if (!res.ok || !data.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

/* concurrency limit per gli snapshot globali (nessun worker/timer permanente) */
function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  return Promise.all(Array.from({ length: n }, worker)).then(() => out);
}

/* tempo relativo: adesso / n min fa / n h fa / n gg fa */
function fmtRelTime(ts) {
  if (!ts) return '—';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return t('backup.time.now');
  if (diff < 3600) return Math.floor(diff / 60) + ' ' + t('backup.time.min');
  if (diff < 86400) return Math.floor(diff / 3600) + ' ' + t('backup.time.hour');
  return Math.floor(diff / 86400) + ' ' + t('backup.time.day');
}

/* fetch on-demand completo (solo a vista aperta o su click Aggiorna). TTL in cache,
   zero polling: nessun setInterval, nessuna chiamata dentro /api/status. */
async function loadBackupView(force) {
  if (backupData.loading || currentView !== 'backup') return;
  backupData.loading = true;
  const btn = $('btnBackupRefresh');
  const isFirst = !backupData.loaded;
  if (isFirst) {
    $('backupLoading').hidden = false;
    $('backupContent').hidden = true;
    $('backupStatus').hidden = true;
  } else {
    btn.classList.add('spinning');
  }
  try {
    const now = Date.now();
    backupData.errors = [];
    backupData.storages = [];
    backupData.jobs = [];
    backupData.backups = [];
    backupData.snapshots = [];
    const { targets, errors } = backupServerTargets();
    backupData.errors.push(...errors);

    await Promise.all(targets.map(async (srv) => {
      const sid = encodeURIComponent(srv.id);
      /* storages (TTL 60s) */
      const sc = backupCache.storages.get(srv.id);
      if (!force && sc && now - sc.at < BACKUP_TTL.storages) {
        backupData.storages.push(...(sc.data || []));
      } else {
        try {
          const d = await backupFetch('/api/backup/storages?serverId=' + sid);
          backupCache.storages.set(srv.id, { at: Date.now(), data: d.storages || [], error: null });
          backupData.storages.push(...(d.storages || []));
          for (const e of d.errors || []) backupData.errors.push(e);
        } catch (e) {
          backupCache.storages.set(srv.id, { at: Date.now(), data: [], error: e.message });
          backupData.errors.push({ serverId: srv.id, serverName: srv.name, error: e.message });
        }
      }
      /* backups (TTL 30s) */
      const bc = backupCache.backups.get(srv.id);
      if (!force && bc && now - bc.at < BACKUP_TTL.backups) {
        backupData.backups.push(...(bc.data || []));
      } else {
        try {
          const d = await backupFetch('/api/backup/list?serverId=' + sid);
          backupCache.backups.set(srv.id, { at: Date.now(), data: d.backups || [], error: null });
          backupData.backups.push(...(d.backups || []));
          for (const e of d.errors || []) backupData.errors.push(e);
        } catch (e) {
          backupCache.backups.set(srv.id, { at: Date.now(), data: [], error: e.message });
          backupData.errors.push({ serverId: srv.id, serverName: srv.name, error: e.message });
        }
      }
      /* jobs (TTL 60s) */
      const jc = backupCache.jobs.get(srv.id);
      if (!force && jc && now - jc.at < BACKUP_TTL.jobs) {
        backupData.jobs.push(...(jc.data || []));
      } else {
        try {
          const d = await backupFetch('/api/backup/jobs?serverId=' + sid);
          backupCache.jobs.set(srv.id, { at: Date.now(), data: d.jobs || [], error: null });
          backupData.jobs.push(...(d.jobs || []));
        } catch (e) {
          backupCache.jobs.set(srv.id, { at: Date.now(), data: [], error: e.message });
          backupData.errors.push({ serverId: srv.id, serverName: srv.name, error: e.message });
        }
      }
    }));

    /* task vzdump falliti 24h: riusa cache Health se fresca, altrimenti fetch on-demand (TTL 60s) */
    if (healthTaskCache.data && now - healthTaskCache.fetchedAt < HEALTH_TASK_TTL_MS) {
      backupData.taskEvents = healthTaskCache.data;
    } else if (!force && backupCache.tasks.data && now - backupCache.tasks.at < BACKUP_TTL.tasks) {
      backupData.taskEvents = backupCache.tasks.data;
    } else {
      try {
        const sec = Math.floor(now / 1000);
        const d = await backupFetch('/api/logs/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ since: sec - 86400, until: sec, limit: 200 }),
        });
        backupCache.tasks = { at: Date.now(), data: d.events || [], error: false };
        backupData.taskEvents = d.events || [];
      } catch (_) {
        backupCache.tasks = { at: Date.now(), data: [], error: true };
        backupData.taskEvents = [];
      }
    }

    /* snapshot reali: guest da state.status, concorrenza limitata a 4, TTL 30s */
    const guests = backupGuestList();
    await mapWithLimit(guests, BACKUP_SNAPSHOT_CONCURRENCY, async (g) => {
      const key = g.serverId + ':' + g.node + ':' + g.type + ':' + g.vmid;
      const sn = backupCache.snapshots.get(key);
      if (!force && sn && now - sn.at < BACKUP_TTL.snapshots) {
        backupData.snapshots.push(...(sn.data || []));
        return;
      }
      try {
        const d = await backupFetch('/api/snapshot/list?serverId=' + encodeURIComponent(g.serverId) +
          '&node=' + encodeURIComponent(g.node) + '&type=' + g.type + '&vmid=' + g.vmid);
        backupCache.snapshots.set(key, { at: Date.now(), data: d.snapshots || [], error: null });
        backupData.snapshots.push(...(d.snapshots || []));
      } catch (e) {
        backupCache.snapshots.set(key, { at: Date.now(), data: [], error: e.message });
        backupData.errors.push({ serverId: g.serverId, serverName: g.serverName, node: g.node, guest: g.type + ' ' + g.vmid, error: e.message });
      }
    });

    backupData.fetchedAt = Date.now();
    backupData.loaded = true;
    renderBackup();
  } catch (e) {
    backupData.errors.push({ error: e.message });
    if (!backupData.loaded) {
      $('backupStatus').hidden = false;
      $('backupStatus').textContent = '⚠️ ' + t('backup.loadError') + ': ' + e.message;
    }
    renderBackup();
  } finally {
    backupData.loading = false;
    btn.classList.remove('spinning');
    $('backupLoading').hidden = true;
  }
}

/* badge piccolo riusabile */
function backupBadge(cls, text) {
  return '<span class="backup-badge ' + cls + '">' + esc(text) + '</span>';
}

function backupTypeLabel(type) {
  return type === 'qemu' ? t('vms') : type === 'lxc' ? t('lxc') : '?';
}

/* risoluzione nome guest di un archivio (serverId + vmid + guestType, node best-effort) */
function backupGuestNameFor(b, guests) {
  return guests.find((g) => g.serverId === b.serverId && String(g.vmid) === String(b.vmid) && (!b.guestType || g.type === b.guestType)) || null;
}

function renderBackupErrors() {
  const box = $('backupErrors');
  const errors = backupData.errors || [];
  if (!errors.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = errors.slice(0, 5).map((e) =>
    '<div class="logs-error-item">⚠️ ' + (e.serverName ? esc(e.serverName) + ' — ' : '') + (e.node ? esc(e.node) + ' — ' : '') + (e.guest ? esc(e.guest) + ' — ' : '') + esc(e.error) + '</div>'
  ).join('');
  if (errors.length > 5) {
    box.innerHTML += '<div class="logs-error-item">⚠️ ' + t('backup.moreErrors', { n: errors.length - 5 }) + '</div>';
  }
}

function renderBackup() {
  if (!backupData.loaded) return;
  const guests = backupGuestList();
  const backups = backupData.backups;
  const snapshots = backupData.snapshots;
  const jobs = backupData.jobs;
  const storages = backupData.storages;

  /* card riepilogo */
  let withBackup = 0;
  for (const g of guests) {
    const has = backups.some((b) => b.serverId === g.serverId && String(b.vmid) === String(g.vmid) && (!b.guestType || b.guestType === g.type));
    if (has) withBackup++;
  }
  const failed24 = (backupData.taskEvents || []).filter((e) => e.type === 'vzdump' && e.endtime > 0 && e.status !== 'OK').length;
  let free = 0;
  for (const st of storages) free += st.avail || 0;
  $('backupCardGuests').textContent = withBackup + ' / ' + guests.length;
  $('backupCardFailed').textContent = String(failed24);
  $('backupCardSnapshots').textContent = String(snapshots.length);
  $('backupCardFree').textContent = fmtBytes(free);
  $('backupUpdated').textContent = t('updated') + ' ' + new Date(backupData.fetchedAt).toLocaleTimeString(state.config.language || 'it');

  renderBackupErrors();

  /* errore totale: nessun dato e almeno un errore -> solo stato ERROR */
  const hasAny = backups.length || snapshots.length || jobs.length || storages.length;
  if (!hasAny && (backupData.errors || []).length) {
    $('backupStatus').hidden = false;
    $('backupStatus').textContent = '⚠️ ' + t('backup.loadError');
    $('backupContent').hidden = true;
    return;
  }
  $('backupStatus').hidden = true;
  $('backupContent').hidden = false;

  /* sezione guest: Mai prima, poi i piu' vecchi, i recenti in fondo (nessuna policy) */
  const guestRows = guests.map((g) => {
    const mine = backups.filter((b) => b.serverId === g.serverId && String(b.vmid) === String(g.vmid) && (!b.guestType || b.guestType === g.type));
    const last = mine.length ? mine.reduce((a, b2) => ((b2.ctime || 0) > (a.ctime || 0) ? b2 : a)) : null;
    return { g, last };
  }).sort((a, b) => (a.last ? (a.last.ctime || 0) : -1) - (b.last ? (b.last.ctime || 0) : -1));
  $('backupGuestList').innerHTML = guestRows.map(({ g, last }) => {
    const title = esc(g.name) + ' ' + backupBadge('backup-badge--type', backupTypeLabel(g.type) + ' ' + g.vmid) +
      (last ? '' : ' ' + backupBadge('backup-badge--never', t('backup.never')));
    const meta = '<span>' + t('backup.lastBackup') + ': ' + (last ? fmtRelTime(last.ctime) : '—') + '</span>' +
      (last ? '<span>' + t('backup.size') + ': ' + fmtBytes(last.size) + '</span>' : '') +
      '<span>' + esc(g.serverName) + '</span>';
    return '<div class="backup-row" role="listitem" data-bk-guest="' + esc(g.serverId) + '|' + esc(g.vmid) + '|' + esc(g.type) + '">' +
      '<div class="backup-row-main"><div class="backup-row-title">' + title + '</div>' +
      '<div class="backup-row-meta">' + meta + '</div></div>' +
      '</div>';
  }).join('');
  $('backupGuestEmpty').hidden = guestRows.length > 0;

  /* deep-link Health: evidenzia e porta al guest richiesto, senza filtri permanenti */
  if (backupFocusGuest) {
    const focusKey = backupFocusGuest.serverId + '|' + backupFocusGuest.vmid + '|' + (backupFocusGuest.type || '');
    const row = $('backupGuestList').querySelector('[data-bk-guest="' + focusKey.replace(/"/g, '\"') + '"]');
    if (row) {
      row.classList.add('backup-row--focus');
      if (!backupFocusGuest.scrolled) {
        backupFocusGuest.scrolled = true;
        requestAnimationFrame(() => row.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      }
    }
  }

  /* backup recenti: ctime desc, primi 12 + "Mostra tutti" */
  const sorted = backups.slice().sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
  const shown = backupShowAll ? sorted : sorted.slice(0, BACKUP_RECENT_LIMIT);
  $('backupRecentList').innerHTML = shown.map((b) => {
    const g = backupGuestNameFor(b, guests);
    const title = g
      ? esc(g.name) + ' ' + backupBadge('backup-badge--type', backupTypeLabel(g.type) + ' ' + g.vmid)
      : 'VMID ' + esc(b.vmid) + ' ' + backupBadge('backup-badge--type', backupTypeLabel(b.guestType)) + ' ' + backupBadge('backup-badge--orphan', t('backup.orphan'));
    const meta = '<span>' + esc(b.serverName) + ' · ' + esc(b.storage) + '</span>' +
      '<span>' + fmtLogDate(b.ctime) + ' (' + fmtRelTime(b.ctime) + ')</span>' +
      '<span>' + t('backup.size') + ': ' + fmtBytes(b.size) + '</span>';
    const badges = (b.protected ? ' ' + backupBadge('backup-badge--protected', '🔒 ' + t('backup.protected')) : '');
    return '<div class="backup-row" role="listitem">' +
      '<div class="backup-row-main">' +
        '<div class="backup-row-title">' + title + badges + '</div>' +
        (b.notes ? '<div class="backup-notes">' + t('backup.notes') + ': ' + esc(b.notes) + '</div>' : '') +
        '<div class="backup-row-meta">' + meta + '</div>' +
      '</div></div>';
  }).join('');
  $('backupRecentEmpty').hidden = sorted.length > 0;
  $('btnBackupShowAll').hidden = sorted.length <= BACKUP_RECENT_LIMIT;
  if (!$('btnBackupShowAll').hidden) {
    $('btnBackupShowAll').textContent = t(backupShowAll ? 'backup.showLess' : 'backup.showAll');
  }

  /* snapshot reali (current gia' filtrato dal backend) */
  const snapSorted = snapshots.slice().sort((a, b) => (b.snaptime || 0) - (a.snaptime || 0));
  $('backupSnapshotList').innerHTML = snapSorted.map((s) => {
    const g = guests.find((x) => x.serverId === s.serverId && x.node === s.node && x.type === s.type && String(x.vmid) === String(s.vmid));
    const title = esc(s.name) + (g ? ' — ' + esc(g.name) + ' ' + backupBadge('backup-badge--type', backupTypeLabel(s.type) + ' ' + s.vmid) : '');
    const meta = '<span>' + esc(s.serverName) + (s.node ? ' · ' + esc(s.node) : '') + '</span>' +
      (s.snaptime ? '<span>' + fmtLogDate(s.snaptime) + ' (' + fmtRelTime(s.snaptime) + ')</span>' : '') +
      (s.type === 'qemu' && s.vmstate === true ? '<span>' + t('snapshot.ramState') + ': ✓</span>' : '');
    return '<div class="backup-row" role="listitem"><div class="backup-row-main">' +
      '<div class="backup-row-title">' + title + '</div>' +
      (s.description ? '<div class="backup-notes">' + t('snapshot.description') + ': ' + esc(String(s.description).trim()) + '</div>' : '') +
      '<div class="backup-row-meta">' + meta + '</div></div></div>';
  }).join('');
  $('backupSnapshotEmpty').hidden = snapSorted.length > 0;

  /* job schedulati */
  const pruneText = (p) => {
    if (!p || typeof p !== 'object') return '—';
    return Object.entries(p).map(([k, v]) => esc(k) + '=' + esc(v)).join(', ');
  };
  $('backupJobList').innerHTML = jobs.map((j) => {
    const selection = j.all ? t('backup.allGuests') : (j.vmid || '—');
    const title = esc(j.id || '—') + ' ' + (j.enabled ? backupBadge('backup-badge--enabled', t('job.enabled')) : backupBadge('backup-badge--disabled', t('job.disabled')));
    const meta = '<span>' + t('job.schedule') + ': ' + esc(j.schedule || '—') + '</span>' +
      '<span>' + esc(j.storage || '—') + '</span>' +
      '<span>' + t('job.mode') + ': ' + esc(j.mode || '—') + '</span>' +
      '<span>' + t('job.compress') + ': ' + esc(j.compress || '—') + '</span>' +
      '<span>' + t('job.retention') + ': ' + pruneText(j.pruneBackups) + '</span>' +
      (j.notesTemplate ? '<span>' + t('backup.notes') + ': ' + esc(j.notesTemplate) + '</span>' : '');
    return '<div class="backup-row" role="listitem"><div class="backup-row-main">' +
      '<div class="backup-row-title">' + title + '</div>' +
      '<div class="backup-row-meta">' + meta + '</div>' +
      '<div class="backup-notes">' + t('backup.selection') + ': ' + esc(selection) + '</div>' +
      '</div></div>';
  }).join('');
  $('backupJobEmpty').hidden = jobs.length > 0;

  /* storage compatibili */
  $('backupStorageList').innerHTML = storages.map((st) => {
    const total = st.total || 0;
    const used = st.used || 0;
    const pct = total ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;
    const fillCls = pct >= 90 ? ' crit' : pct >= 80 ? ' warn' : '';
    const title = esc(st.storage) + ' ' + backupBadge('backup-badge--type', esc(st.type || '—')) + ' ' +
      (st.active ? backupBadge('backup-badge--enabled', t('online')) : backupBadge('backup-badge--disabled', t('offline')));
    const meta = '<span>' + esc(st.serverName) + (st.node ? ' · ' + esc(st.node) : '') + '</span>' +
      '<span>' + t('backup.size') + ': ' + fmtBytes(used) + ' / ' + fmtBytes(total) + '</span>' +
      '<span>' + t('backup.free') + ': ' + fmtBytes(st.avail || 0) + '</span>';
    return '<div class="backup-row" role="listitem"><div class="backup-row-main">' +
      '<div class="backup-row-title">' + title + '</div>' +
      '<div class="backup-row-meta">' + meta + '</div></div>' +
      '<div class="backup-bar"><div class="backup-bar-fill' + fillCls + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
      '<span class="backup-bar-pct">' + Math.round(pct) + '%</span>' +
      '</div>';
  }).join('');
  $('backupStorageEmpty').hidden = storages.length > 0;
}

$('btnBackupRefresh').onclick = () => loadBackupView(true);
$('btnBackupShowAll').onclick = () => { backupShowAll = !backupShowAll; renderBackup(); };

/* ---------- Backup & Snapshot Manager (FASE 4: Guest Detail + create + tracking) ---------- */

const GUEST_BACKUP_TTL = 30000;      /* cache guest-scoped 30s */
const TASK_POLL_MS = 2500;           /* poll action-scoped del solo task attivo */
const TASK_SOFT_TIMEOUT_MS = 30 * 60 * 1000; /* soft: mai dichiarare failure */
const SNAP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/; /* UI max 40 (schema PVE) */

const guestBackupCache = new Map(); /* key -> { at, backups, snapshots } */
let guestBackupLoading = false;

/* tracker action-scoped: UNA create attiva alla volta (V1). Sopravvive alla
   chiusura del panel; nessun timer duplicato al reopen; nessun polling globale. */
let activeTask = null;
let activeTaskTimer = null;
let activeTaskPolling = false;
let backupModalTrigger = null;
let snapshotModalTrigger = null;

/* ---------- Guest Detail: fetch/cache/render ---------- */

async function fetchGuestBackup(force) {
  const key = detailState.key;
  if (!key) return;
  const cached = guestBackupCache.get(key);
  const now = Date.now();
  if (!force && cached && now - cached.at < GUEST_BACKUP_TTL) {
    renderGuestBackupTab();
    return;
  }
  if (guestBackupLoading) return;
  guestBackupLoading = true;
  $('gdBackupLoading').hidden = false;
  $('gdBackupError').hidden = true;
  $('gdBackupBody').hidden = true;
  try {
    const [bRes, sRes] = await Promise.all([
      backupFetch('/api/backup/list?serverId=' + encodeURIComponent(detailState.serverId) + '&node=' + encodeURIComponent(detailState.node) + '&vmid=' + detailState.vmid),
      backupFetch('/api/snapshot/list?serverId=' + encodeURIComponent(detailState.serverId) + '&node=' + encodeURIComponent(detailState.node) + '&type=' + detailState.type + '&vmid=' + detailState.vmid),
    ]);
    guestBackupCache.set(key, { at: Date.now(), backups: bRes.backups || [], snapshots: sRes.snapshots || [] });
    renderGuestBackupTab();
  } catch (e) {
    $('gdBackupLoading').hidden = true;
    $('gdBackupError').hidden = false;
    $('gdBackupError').textContent = '⚠️ ' + t('backup.loadError') + ': ' + e.message;
  } finally {
    guestBackupLoading = false;
  }
}

function renderGuestBackupTab() {
  const key = detailState.key;
  if (!key || detailState.tab !== 'backup') return;
  const c = guestBackupCache.get(key);
  const backups = c ? c.backups : [];
  const snapshots = c ? c.snapshots : [];
  $('gdBackupLoading').hidden = true;
  $('gdBackupError').hidden = true;
  $('gdBackupBody').hidden = false;

  renderActiveTaskPanel();

  /* blocco BACKUP: ultimo + storico recente (max 5) */
  const last = backups.length ? backups.reduce((a, b) => ((b.ctime || 0) > (a.ctime || 0) ? b : a)) : null;
  $('gdBackupLast').innerHTML = last
    ? '<div class="backup-row" role="listitem"><div class="backup-row-main">' +
        '<div class="backup-row-title">' + fmtLogDate(last.ctime) + ' (' + fmtRelTime(last.ctime) + ')' +
          (last.protected ? ' ' + backupBadge('backup-badge--protected', '🔒 ' + t('backup.protected')) : '') + '</div>' +
        (last.notes ? '<div class="backup-notes">' + t('backup.notes') + ': ' + esc(last.notes) + '</div>' : '') +
        '<div class="backup-row-meta"><span>' + esc(last.storage) + '</span><span>' + t('backup.size') + ': ' + fmtBytes(last.size) + '</span></div>' +
      '</div></div>'
    : '<div class="backup-empty">' + t('backup.noBackups') + '</div>';
  const history = backups.filter((b) => b !== last).slice(0, 5);
  $('gdBackupHistory').innerHTML = history.length
    ? '<div class="gd-history-title">' + t('backup.history') + '</div>' +
      history.map((b) =>
        '<div class="gd-history-row">' +
          '<span>' + fmtLogDate(b.ctime) + ' · ' + fmtRelTime(b.ctime) + '</span>' +
          '<span>' + fmtBytes(b.size) + '</span>' +
          '<span>' + esc(b.storage) + '</span>' +
          (b.protected ? backupBadge('backup-badge--protected', '🔒') : '') +
        '</div>').join('')
    : '';

  /* blocco SNAPSHOT */
  $('gdSnapshotCount').textContent = String(snapshots.length);
  $('gdSnapshotList').innerHTML = snapshots.length
    ? snapshots.map((s) =>
        '<div class="backup-row" role="listitem"><div class="backup-row-main">' +
          '<div class="backup-row-title">' + esc(s.name) +
            (s.type === 'qemu' && s.vmstate === true ? ' ' + backupBadge('backup-badge--type', t('snapshot.ramState') + ' ✓') : '') + '</div>' +
          (s.description ? '<div class="backup-notes">' + t('snapshot.description') + ': ' + esc(String(s.description).trim()) + '</div>' : '') +
          '<div class="backup-row-meta">' + (s.snaptime ? '<span>' + fmtLogDate(s.snaptime) + ' (' + fmtRelTime(s.snaptime) + ')</span>' : '') + '</div>' +
        '</div></div>').join('')
    : '<div class="backup-empty">' + t('backup.noSnapshots') + '</div>';
}

/* ---------- task tracker action-scoped ---------- */

function fmtElapsedMs(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
}

function taskRunning() {
  return activeTask && (activeTask.status === 'running' || activeTask.status === 'soft-timeout');
}

function startTaskTracking(upid, serverId, node, kind, guestKey, guestLabel) {
  if (taskRunning()) {
    toast(t('backup.task.busy'), 'err');
    return false;
  }
  stopTaskTimer();
  activeTask = { upid, serverId, node, kind, guestKey, guestLabel, startedAt: Date.now(), status: 'running', exitstatus: null, lastError: null };
  renderActiveTaskPanel();
  pollTaskOnce(true);
  return true;
}

function stopTaskTimer() {
  if (activeTaskTimer) {
    clearTimeout(activeTaskTimer);
    activeTaskTimer = null;
  }
}

async function pollTaskOnce(immediate) {
  if (!activeTask) return;
  if (activeTaskPolling && !immediate) return;
  activeTaskPolling = true;
  try {
    const d = await backupFetch('/api/tasks/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: activeTask.serverId, node: activeTask.node, upid: activeTask.upid }),
    });
    if (!activeTask) { activeTaskPolling = false; return; }
    if (d.status === 'stopped') {
      activeTask.status = d.exitstatus === 'OK' ? 'done' : 'error';
      activeTask.exitstatus = d.exitstatus || null;
      stopTaskTimer();
      onTaskFinished(activeTask);
    } else {
      renderActiveTaskPanel();
      scheduleNextPoll();
    }
  } catch (e) {
    if (!activeTask) { activeTaskPolling = false; return; }
    activeTask.lastError = e.message;
    renderActiveTaskPanel();
    scheduleNextPoll();
  } finally {
    activeTaskPolling = false;
  }
}

function scheduleNextPoll() {
  stopTaskTimer();
  if (!activeTask || activeTask.status !== 'running') return;
  /* pagina nascosta: sospendi il polling visivo (il check riparte su visible) */
  if (document.visibilityState === 'hidden') return;
  if (Date.now() - activeTask.startedAt >= TASK_SOFT_TIMEOUT_MS) {
    activeTask.status = 'soft-timeout';
    renderActiveTaskPanel();
    toast(t('backup.task.stillRunning'), 'info');
    return; /* nessun timer automatico: check manuale disponibile */
  }
  activeTaskTimer = setTimeout(() => pollTaskOnce(false), TASK_POLL_MS);
}

function onTaskFinished(task) {
  renderActiveTaskPanel();
  /* invalidazione mirata delle cache: la nuova risorsa appare senza reload */
  if (task.kind === 'backup') {
    backupCache.backups.delete(task.serverId);
    guestBackupCache.delete(task.guestKey);
  } else {
    backupCache.snapshots.delete(task.guestKey);
    guestBackupCache.delete(task.guestKey);
  }
  if (detailState.key === task.guestKey && detailState.tab === 'backup') {
    fetchGuestBackup(true);
  }
  if (currentView === 'backup') loadBackupView(true);
  const ok = task.status === 'done';
  toast(t(ok ? (task.kind === 'backup' ? 'backup.task.done' : 'snapshot.task.done') : (task.kind === 'backup' ? 'health.backupFailed' : 'snapshot.task.failed')), ok ? 'ok' : 'err');
}

function renderActiveTaskPanel() {
  const el = $('gdBackupTask');
  if (!el) return;
  if (!activeTask) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  const a = activeTask;
  const running = taskRunning();
  const stateKey = running ? (a.status === 'soft-timeout' ? 'backup.task.stillRunning' : 'backup.task.running') : (a.status === 'done' ? 'backup.task.completed' : 'backup.task.failed');
  const cls = running ? 'running' : a.status;
  let html = '<div class="gd-task gd-task--' + cls + '" role="status" aria-live="polite">';
  html += running ? '<span class="spinner-ring" aria-hidden="true"></span>' : '<span class="gd-task-icon">' + (a.status === 'done' ? '✓' : '✕') + '</span>';
  html += '<div class="gd-task-body">' +
    '<span class="gd-task-title">' + esc(t(a.kind === 'backup' ? 'backup.task.kind' : 'snapshot.task.kind')) + ' · ' + esc(a.guestLabel || '') + '</span>' +
    '<span class="gd-task-sub">' + t(stateKey) + (running ? ' · ' + fmtElapsedMs(Date.now() - a.startedAt) : '') + (a.lastError && !running ? ' · ' + esc(a.lastError) : '') + '</span>' +
    '</div>';
  if (a.status === 'soft-timeout' || a.status === 'error') {
    html += '<div class="gd-task-actions">';
    if (a.status === 'soft-timeout') html += '<button type="button" class="ghost-btn" data-gd-task-check>' + t('backup.task.check') + '</button>';
    html += '<button type="button" class="ghost-btn" data-gd-task-log>' + t('health.action.openLog') + '</button>';
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

$('gd-tab-backup').addEventListener('click', (e) => {
  const check = e.target.closest('[data-gd-task-check]');
  if (check && activeTask) { renderActiveTaskPanel(); pollTaskOnce(true); return; }
  const log = e.target.closest('[data-gd-task-log]');
  if (log && activeTask) { showLogDetail(activeTask.upid, activeTask.serverId, activeTask.node); return; }
});

/* visibility: al ritorno in primo piano check immediato del task, senza timer nuovi */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeTask && activeTask.status === 'running') {
    stopTaskTimer();
    pollTaskOnce(true);
  }
});

/* ---------- modali create ---------- */

function showCreateError(el, text) {
  el.hidden = false;
  el.textContent = '⚠️ ' + text;
}

function mapCreateError(status, data) {
  if (status === 400) return t('backup.err.input') + ': ' + ((data && data.error) || '');
  if (status === 403) return t('backup.err.permission') + (data && data.error ? ': ' + data.error : '');
  if (status === 404) return t('backup.err.notfound');
  if (status === 409) return t('snapshot.exists');
  return data && data.error ? data.error : (t('backup.networkError') + ' HTTP ' + status);
}

function closeBackupCreateModal() {
  $('backupCreateModal').hidden = true;
  if (backupModalTrigger && typeof backupModalTrigger.focus === 'function') backupModalTrigger.focus();
  backupModalTrigger = null;
}

function closeSnapshotCreateModal() {
  $('snapshotCreateModal').hidden = true;
  if (snapshotModalTrigger && typeof snapshotModalTrigger.focus === 'function') snapshotModalTrigger.focus();
  snapshotModalTrigger = null;
}

function openBackupCreateModal() {
  if (taskRunning()) { toast(t('backup.task.busy'), 'err'); return; }
  if (!detailState.key) return;
  backupModalTrigger = document.activeElement && document.activeElement.id ? document.activeElement : null;
  $('backupGuestField').value = detailState.name + ' · ' + detailState.type.toUpperCase() + ' ' + detailState.vmid + ' · ' + detailState.node;
  $('backupStorageSelect').innerHTML = '<option value="">' + t('backup.loading') + '</option>';
  $('backupStorageHint').textContent = '';
  $('backupStorageHint').classList.remove('err');
  $('backupModeSelect').value = 'snapshot';
  $('backupCompressSelect').value = 'zstd';
  $('backupNotesInput').value = '';
  $('backupProtectedCheck').checked = false;
  $('backupCreateForm').hidden = false;
  $('backupCreateReview').hidden = true;
  $('backupCreateError').hidden = true;
  const next = $('btnBackupNext');
  next.disabled = false;
  next.textContent = t('backup.confirmBtn');
  updateBackupModeHint();
  updateBackupNotesCount();
  $('backupCreateModal').hidden = false;
  loadBackupStoragesForGuest();
}

async function loadBackupStoragesForGuest() {
  const sid = detailState.serverId;
  const now = Date.now();
  let list = [];
  const cached = backupCache.storages.get(sid);
  if (cached && now - cached.at < BACKUP_TTL.storages) {
    list = cached.data || [];
  } else {
    try {
      const d = await backupFetch('/api/backup/storages?serverId=' + encodeURIComponent(sid));
      backupCache.storages.set(sid, { at: Date.now(), data: d.storages || [], error: null });
      list = d.storages || [];
    } catch (e) {
      backupCache.storages.set(sid, { at: Date.now(), data: [], error: e.message });
    }
  }
  const sel = $('backupStorageSelect');
  const compatible = list.filter((st) => st.node === detailState.node || (st.nodes || []).includes(detailState.node));
  if (!compatible.length) {
    sel.innerHTML = '<option value="">' + t('backup.noStorage') + '</option>';
    sel.disabled = true;
    $('btnBackupNext').disabled = true;
    $('backupStorageHint').textContent = t('backup.noStorage');
    $('backupStorageHint').classList.add('err');
    return;
  }
  sel.disabled = false;
  sel.innerHTML = compatible.map((st) => '<option value="' + esc(st.storage) + '">' + esc(st.storage) + ' — ' + fmtBytes(st.avail || 0) + ' ' + t('backup.free') + '</option>').join('');
  sel.value = compatible[0].storage;
  $('btnBackupNext').disabled = false;
  $('backupStorageHint').textContent = '';
  if (!$('backupCreateModal').hidden) sel.focus();
}

function updateBackupModeHint() {
  const mode = $('backupModeSelect').value;
  const hint = $('backupModeHint');
  hint.textContent = t('backup.mode.' + mode + '.hint');
  hint.classList.toggle('warn', mode === 'stop');
}

function updateBackupNotesCount() {
  $('backupNotesCount').textContent = $('backupNotesInput').value.length + '/256';
}

$('btnGdCreateBackup').onclick = openBackupCreateModal;
$('btnGdCreateSnapshot').onclick = openSnapshotCreateModal;
$('backupModeSelect').onchange = updateBackupModeHint;
$('backupNotesInput').oninput = updateBackupNotesCount;
$('backupStorageSelect').onchange = () => { $('btnBackupNext').disabled = !$('backupStorageSelect').value; };

$('btnBackupNext').onclick = () => {
  const storage = $('backupStorageSelect').value;
  if (!storage) return;
  const mode = $('backupModeSelect').value;
  const compress = $('backupCompressSelect').value;
  const notes = $('backupNotesInput').value.trim();
  if (notes.length > 256) { showCreateError($('backupCreateError'), t('backup.notesTooLong')); return; }
  const rows = [
    [t('backup.guest'), $('backupGuestField').value],
    [t('backup.storage'), storage],
    [t('backup.mode'), t('backup.mode.' + mode)],
    [t('backup.compress'), compress],
    [t('backup.protectedLabel'), $('backupProtectedCheck').checked ? t('job.enabled') : t('job.disabled')],
  ].map(([k, v]) => '<div class="backup-review-row"><span>' + esc(k) + '</span><span>' + esc(v) + '</span></div>').join('');
  const warn = mode === 'stop' ? '<div class="backup-review-warn">⚠️ ' + t('backup.mode.stop.warn') + '</div>' : '';
  $('backupReviewBox').innerHTML = rows + warn;
  $('backupCreateForm').hidden = true;
  $('backupCreateReview').hidden = false;
  $('btnBackupConfirm').focus();
};

$('btnBackupBack').onclick = () => {
  $('backupCreateReview').hidden = true;
  $('backupCreateForm').hidden = false;
  $('btnBackupNext').focus();
};

$('btnBackupConfirm').onclick = async () => {
  const btn = $('btnBackupConfirm');
  btn.disabled = true;
  btn.textContent = t('backup.starting');
  $('backupCreateError').hidden = true;
  const payload = {
    serverId: detailState.serverId,
    node: detailState.node,
    vmid: Number(detailState.vmid),
    storage: $('backupStorageSelect').value,
    mode: $('backupModeSelect').value,
    compress: $('backupCompressSelect').value,
    notes: $('backupNotesInput').value.trim(),
    protected: $('backupProtectedCheck').checked,
  };
  try {
    const res = await fetch('/api/backup/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) {
      showCreateError($('backupCreateError'), mapCreateError(res.status, d));
      btn.disabled = false;
      btn.textContent = t('backup.confirm');
      return;
    }
    const guestLabel = detailState.name + ' · ' + detailState.type.toUpperCase() + ' ' + detailState.vmid;
    startTaskTracking(d.upid, d.serverId || payload.serverId, d.node || payload.node, 'backup', detailState.key, guestLabel);
    closeBackupCreateModal();
    if (detailState.tab === 'backup') renderActiveTaskPanel();
    toast(t('backup.started'), 'ok');
  } catch (e) {
    showCreateError($('backupCreateError'), t('backup.networkError') + ': ' + e.message);
    btn.disabled = false;
    btn.textContent = t('backup.confirm');
  }
};

function openSnapshotCreateModal() {
  if (taskRunning()) { toast(t('backup.task.busy'), 'err'); return; }
  if (!detailState.key) return;
  snapshotModalTrigger = document.activeElement && document.activeElement.id ? document.activeElement : null;
  $('snapshotGuestField').value = detailState.name + ' · ' + detailState.type.toUpperCase() + ' ' + detailState.vmid + ' · ' + detailState.node;
  $('snapshotNameInput').value = '';
  $('snapshotDescInput').value = '';
  $('snapshotVmstateCheck').checked = false;
  $('snapshotVmstateRow').hidden = detailState.type !== 'qemu';
  $('snapshotCreateError').hidden = true;
  $('btnSnapshotCreate').disabled = false;
  $('btnSnapshotCreate').textContent = t('snapshot.create');
  $('snapshotCreateModal').hidden = false;
  $('snapshotNameInput').focus();
}

$('btnSnapshotCreate').onclick = async () => {
  const name = $('snapshotNameInput').value.trim();
  const desc = $('snapshotDescInput').value.trim();
  const errEl = $('snapshotCreateError');
  errEl.hidden = true;
  if (!name || name === 'current' || !SNAP_NAME_RE.test(name)) {
    showCreateError(errEl, t('snapshot.nameInvalid'));
    return;
  }
  if (desc.length > 256) {
    showCreateError(errEl, t('backup.notesTooLong'));
    return;
  }
  /* pre-check duplicati dalla cache guest (il backend resta autoritativo: 409) */
  const cached = guestBackupCache.get(detailState.key);
  if (cached && (cached.snapshots || []).some((s) => s.name === name)) {
    showCreateError(errEl, t('snapshot.exists'));
    return;
  }
  const btn = $('btnSnapshotCreate');
  btn.disabled = true;
  btn.textContent = t('backup.starting');
  const payload = {
    serverId: detailState.serverId,
    node: detailState.node,
    type: detailState.type,
    vmid: Number(detailState.vmid),
    name,
    description: desc,
  };
  if (detailState.type === 'qemu' && $('snapshotVmstateCheck').checked) payload.vmstate = true;
  try {
    const res = await fetch('/api/snapshot/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) {
      showCreateError(errEl, mapCreateError(res.status, d));
      btn.disabled = false;
      btn.textContent = t('snapshot.create');
      return;
    }
    const guestLabel = detailState.name + ' · ' + detailState.type.toUpperCase() + ' ' + detailState.vmid;
    startTaskTracking(d.upid, d.serverId || payload.serverId, d.node || payload.node, 'snapshot', detailState.key, guestLabel);
    closeSnapshotCreateModal();
    if (detailState.tab === 'backup') renderActiveTaskPanel();
    toast(t('snapshot.started'), 'ok');
  } catch (e) {
    showCreateError(errEl, t('backup.networkError') + ': ' + e.message);
    btn.disabled = false;
    btn.textContent = t('snapshot.create');
  }
};

/* focus restore anche per chiusure via backdrop/[data-close] (binding generico) */
['backupCreateModal', 'snapshotCreateModal'].forEach((id) => {
  const m = document.getElementById(id);
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) {
      if (id === 'backupCreateModal') { backupModalTrigger && backupModalTrigger.focus(); backupModalTrigger = null; }
      else { snapshotModalTrigger && snapshotModalTrigger.focus(); snapshotModalTrigger = null; }
    }
  });
});

/* cache task Health: fetch on-demand solo a vista Monitoraggio aperta, TTL 60s */
const healthTaskCache = { data: null, fetchedAt: 0, fetching: false, error: false };

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
function healthApplyState(id, entry, severity) {
  if (severity === null) {
    entry.severity = null;
    entry.firstSeen = null;
    healthSamples.delete(id);
    return;
  }
  if (entry.severity !== severity && !entry.firstSeen) entry.firstSeen = Date.now();
  entry.severity = severity;
  healthSamples.set(id, entry);
}

/* check immediato (senza isteresi): offline/unknown/stopped/rootfs/disk/info */
function healthImmediate(id, severity) {
  const entry = healthSamples.get(id) || { severity: null, firstSeen: null };
  healthApplyState(id, entry, severity);
  return entry;
}

/* isteresi CPU/RAM: 2 campioni consecutivi per cambiare livello.
   Mantiene il livello corrente finché non c'è una conferma, quindi:
   NORMAL -> 96% x2 = CRITICAL; WARNING -> 96% x2 = CRITICAL;
   CRITICAL -> 90% x2 = WARNING (downgrade, non sparire); CRITICAL -> 20% x2 = rimosso. */
function healthHysteresis(id, value, thresholds) {
  const entry = healthSamples.get(id) || { crit: 0, warn: 0, ok: 0, severity: null, firstSeen: null };
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
    healthSamples.set(id, entry);
    return entry;
  }
  healthApplyState(id, entry, desired);
  return entry;
}

/* stati/eventi V2: alert immediato quando isBad, clear solo dopo N osservazioni
   sane consecutive (evita flap su timeout singoli o transitori). */
function healthState(id, severity, isBad, clearAfter) {
  const entry = healthSamples.get(id) || { ok: 0, severity: null, firstSeen: null };
  if (isBad) {
    entry.ok = 0;
    healthApplyState(id, entry, severity);
    return entry;
  }
  entry.ok += 1;
  if (entry.severity !== null && entry.ok >= (clearAfter || 1)) {
    healthApplyState(id, entry, null);
    return entry;
  }
  healthSamples.set(id, entry);
  return entry;
}

/* load average: INFO se load1 >= cpus, WARNING se >= 1.5*cpus (2 campioni,
   downgrade a scalino; MAI CRITICAL in V2.0). */
function healthLoadHysteresis(id, load1, cpus) {
  const entry = healthSamples.get(id) || { warn: 0, info: 0, ok: 0, severity: null, firstSeen: null };
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
    healthSamples.set(id, entry);
    return entry;
  }
  healthApplyState(id, entry, desired);
  return entry;
}

function healthAlert(id, severity, category, titleKey, descriptionKey, params, serverId, serverName, node, guestType, guestId, guestName, ts, extra) {
  const x = extra && typeof extra === 'object' ? extra : {};
  return {
    id,
    severity,
    category,
    titleKey,
    descriptionKey,
    params: params || {},
    serverId,
    serverName,
    node: node || null,
    guestType: guestType || null,
    guestId: guestId || null,
    guestName: guestName || null,
    ts,
    source: x.source || 'status',
    storage: x.storage || null,
    pool: x.pool || null,
    detail: x.detail || null,
    action: null /* azioni in FASE 4 */
  };
}

/* motore Health V2: riceve status + guestModes + taskAlerts + fonti on-demand
   (extras) + soglie configurabili (settings).
   NON fa fetch, NON tocca il DOM, NON crea timer, NON modifica config/Proxmox. */
function evaluateHealth(status, guestModes, taskAlerts, extras, settings) {
  const alerts = [];
  const seen = new Set();
  const servers = [];
  const summary = { state: 'healthy', critical: 0, warning: 0, info: 0, serversTotal: 0, serversOnline: 0, guestsTotal: 0, guestsRunning: 0 };
  const modes = guestModes && typeof guestModes === 'object' ? guestModes : {};
  const ex = extras && typeof extras === 'object' ? extras : {};
  const set = settings && typeof settings === 'object' ? settings : healthSettings();

  /* dettaglio "Perché lo vedo?": valore/soglia/fonte/suggerimento (chiavi i18n) */
  const detailFor = (current, threshold, unit, sourceKey, suggestionKey) => ({
    current: current === null || current === undefined ? '' : String(current),
    threshold: threshold === null || threshold === undefined ? '' : String(threshold),
    unit: unit || '',
    sourceLabel: sourceKey || null,
    suggestionKey: suggestionKey || null,
  });
  const withChecked = (detail, ts) => { detail.checkedAt = ts; return detail; };
  const pct = (v) => Math.round(v * 100);

  const push = (a) => {
    alerts.push(a);
    seen.add(a.id);
    if (a.severity === 'critical') summary.critical += 1;
    else if (a.severity === 'warning') summary.warning += 1;
    else summary.info += 1;
  };

  const list = status && Array.isArray(status.servers) ? status.servers : [];
  summary.serversTotal = list.length;

  for (const s of list) {
    const serverId = s.id || '';
    const serverName = s.name || serverId;
    const online = !!s.online;
    if (online) summary.serversOnline += 1;
    const serverEntry = { id: serverId, name: serverName, online, nodes: [] };
    servers.push(serverEntry);

    if (!online) {
      /* server offline: UN CRITICAL immediato, clear dopo 2 refresh online
         consecutivi (V2 anti-flap); poi skip nodi/guest (dati stale o assenti). */
      const entry = healthState('server:' + serverId + ':offline', 'critical', true, 2);
      push(healthAlert('server:' + serverId + ':offline', 'critical', 'server', 'health.serverOffline', 'health.serverOffline.desc', { name: serverName }, serverId, serverName, null, null, null, null, entry.firstSeen));
      continue;
    }
    /* osservazione sana del server: accumula il contatore per il clear; finché
       la finestra non è chiusa l'alert resta visibile (anti-flap V2). */
    const offEntry = healthState('server:' + serverId + ':offline', null, false, 2);
    seen.add('server:' + serverId + ':offline');
    if (offEntry.severity) {
      push(healthAlert('server:' + serverId + ':offline', 'critical', 'server', 'health.serverOffline', 'health.serverOffline.desc', { name: serverName }, serverId, serverName, null, null, null, null, offEntry.firstSeen));
    }

    const nodes = Array.isArray(s.nodes) ? s.nodes : [];
    for (const n of nodes) {
      const nodeName = n.name || '?';
      const nodeStatus = n.status === 'online' || n.status === 'offline' || n.status === 'unknown' ? n.status : 'unknown';
      const nodeEntry = {
        name: nodeName,
        status: nodeStatus,
        cpu: typeof n.cpu === 'number' && Number.isFinite(n.cpu) ? n.cpu : null,
        ram: healthRatio(n.mem, n.maxmem),
        rootfs: healthRatio(n.rootfs && n.rootfs.used, n.rootfs && n.rootfs.total),
        swap: n.swap && typeof n.swap.total === 'number' && n.swap.total > 0 && typeof n.swap.used === 'number'
          ? Math.max(0, Math.min(1, n.swap.used / n.swap.total))
          : null,
        loadavg: Array.isArray(n.loadavg) ? n.loadavg : null,
        cpus: n.cpuinfo && Number.isFinite(Number(n.cpuinfo.cpus)) ? Number(n.cpuinfo.cpus) : null,
        guestsTotal: 0,
        guestsRunning: 0
      };
      serverEntry.nodes.push(nodeEntry);

      if (nodeStatus === 'offline') {
        /* offline immediato, clear dopo 2 osservazioni online consecutive */
        const entry = healthState('node:' + serverId + ':' + nodeName + ':offline', 'critical', true, 2);
        push(healthAlert('node:' + serverId + ':' + nodeName + ':offline', 'critical', 'node', 'health.nodeOffline', 'health.nodeOffline.desc', { node: nodeName }, serverId, serverName, nodeName, null, null, null, entry.firstSeen));
        continue;
      }
      if (nodeStatus === 'unknown') {
        const entry = healthImmediate('node:' + serverId + ':' + nodeName + ':unknown', 'warning');
        push(healthAlert('node:' + serverId + ':' + nodeName + ':unknown', 'warning', 'node', 'health.nodeUnknown', 'health.nodeUnknown.desc', { node: nodeName }, serverId, serverName, nodeName, null, null, null, entry.firstSeen));
        continue;
      }
      /* nodo online: accumula il contatore per il clear; l'alert resta visibile
         finché la finestra di 2 osservazioni sane non si chiude. */
      const nodeOffEntry = healthState('node:' + serverId + ':' + nodeName + ':offline', null, false, 2);
      seen.add('node:' + serverId + ':' + nodeName + ':offline');
      if (nodeOffEntry.severity) {
        push(healthAlert('node:' + serverId + ':' + nodeName + ':offline', 'critical', 'node', 'health.nodeOffline', 'health.nodeOffline.desc', { node: nodeName }, serverId, serverName, nodeName, null, null, null, nodeOffEntry.firstSeen));
      }

      /* --- risorse nodo (solo online) --- */
      if (nodeEntry.cpu !== null) {
        const checkId = 'node:' + serverId + ':' + nodeName + ':cpu-high';
        const entry = healthHysteresis(checkId, nodeEntry.cpu, HEALTH_THRESHOLDS.node.cpu);
        seen.add(checkId); /* conserva lo streak anche senza alert attivo */
        if (entry.severity) {
          push(healthAlert(checkId, entry.severity, 'node', 'health.cpuHigh', 'health.cpuHigh.desc', { node: nodeName, pct: Math.round(nodeEntry.cpu * 100) }, serverId, serverName, nodeName, null, null, null, entry.firstSeen));
        }
      }
      if (nodeEntry.ram !== null) {
        const checkId = 'node:' + serverId + ':' + nodeName + ':ram-high';
        const entry = healthHysteresis(checkId, nodeEntry.ram, HEALTH_THRESHOLDS.node.ram);
        seen.add(checkId);
        if (entry.severity) {
          push(healthAlert(checkId, entry.severity, 'node', 'health.ramHigh', 'health.ramHigh.desc', { node: nodeName, pct: Math.round(nodeEntry.ram * 100) }, serverId, serverName, nodeName, null, null, null, entry.firstSeen));
        }
      }
      if (nodeEntry.rootfs !== null) {
        const entry = healthImmediate('node:' + serverId + ':' + nodeName + ':rootfs-high', healthThresholdSeverity(nodeEntry.rootfs, HEALTH_THRESHOLDS.node.rootfs));
        if (entry.severity) {
          push(healthAlert('node:' + serverId + ':' + nodeName + ':rootfs-high', entry.severity, 'node', 'health.rootfsHigh', 'health.rootfsHigh.desc', { node: nodeName, pct: Math.round(nodeEntry.rootfs * 100) }, serverId, serverName, nodeName, null, null, null, entry.firstSeen));
        }
      }
      /* --- swap nodo (solo se presente e total > 0): soglie configurabili --- */
      if (nodeEntry.swap !== null) {
        const checkId = 'node:' + serverId + ':' + nodeName + ':swap-high';
        const th = { warning: set.swap.warning / 100, critical: set.swap.critical / 100 };
        const entry = healthHysteresis(checkId, nodeEntry.swap, th);
        seen.add(checkId);
        if (entry.severity) {
          const thr = th[entry.severity === 'critical' ? 'critical' : 'warning'];
          push(healthAlert(checkId, entry.severity, 'node', 'health.swapHigh', 'health.swapHigh.desc',
            { node: nodeName, pct: pct(nodeEntry.swap) }, serverId, serverName, nodeName, null, null, null, entry.firstSeen,
            { detail: detailFor(pct(nodeEntry.swap) + '%', pct(thr) + '%', '%', 'health.source.nodeStatus', 'health.hint.swapHigh') }));
        }
      }
      /* --- load average: INFO >= cpus, WARNING >= 1.5*cpus, mai CRITICAL --- */
      if (nodeEntry.loadavg && nodeEntry.cpus && nodeEntry.cpus > 0) {
        const checkId = 'node:' + serverId + ':' + nodeName + ':load-high';
        const load1 = nodeEntry.loadavg[0];
        const entry = healthLoadHysteresis(checkId, load1, nodeEntry.cpus);
        seen.add(checkId);
        if (entry.severity === 'warning' || entry.severity === 'info') {
          push(healthAlert(checkId, entry.severity, 'node', 'health.loadHigh', 'health.loadHigh.desc',
            { node: nodeName, load1: Number(load1.toFixed(2)), cpus: nodeEntry.cpus }, serverId, serverName, nodeName, null, null, null, entry.firstSeen,
            { detail: detailFor(Number(load1.toFixed(2)), nodeEntry.cpus, '', 'health.source.nodeStatus', 'health.hint.loadHigh') }));
        }
      }
      if (typeof n.uptime === 'number' && n.uptime > 0 && n.uptime < HEALTH_RECENT_REBOOT_S) {
        const entry = healthImmediate('node:' + serverId + ':' + nodeName + ':recent-reboot', 'info');
        push(healthAlert('node:' + serverId + ':' + nodeName + ':recent-reboot', 'info', 'node', 'health.recentReboot', 'health.recentReboot.desc', { node: nodeName, minutes: Math.max(1, Math.floor(n.uptime / 60)) }, serverId, serverName, nodeName, null, null, null, entry.firstSeen));
      }

      /* --- guest --- */
      const guests = []
        .concat(Array.isArray(n.vms) ? n.vms : [])
        .concat(Array.isArray(n.lxc) ? n.lxc : []);
      for (const g of guests) {
        const guestType = g.type === 'qemu' ? 'qemu' : 'lxc';
        const guestId = g.id;
        const guestName = g.name || ('Guest ' + guestId);
        const key = serverId + ':' + nodeName + ':' + guestType + ':' + guestId;
        const mode = modes[key];
        const guestMode = mode === 'alwayson' || mode === 'manual' || mode === 'ignore' ? mode : 'manual';
        if (guestMode === 'ignore') continue; /* escluso dal monitoring e dai conteggi */
        nodeEntry.guestsTotal += 1;
        summary.guestsTotal += 1;
        const gStatus = g.status || 'unknown';
        if (gStatus === 'running') {
          nodeEntry.guestsRunning += 1;
          summary.guestsRunning += 1;
        }
        if (gStatus === 'stopped' && guestMode === 'alwayson') {
          const entry = healthImmediate('guest:' + key + ':stopped', 'critical');
          push(healthAlert('guest:' + key + ':stopped', 'critical', 'guest', 'health.guestStopped', 'health.guestStopped.desc', { guestName }, serverId, serverName, nodeName, guestType, guestId, guestName, entry.firstSeen));
        } else if (gStatus === 'error' || gStatus === 'unknown') {
          const entry = healthImmediate('guest:' + key + ':status', 'warning');
          push(healthAlert('guest:' + key + ':status', 'warning', 'guest', 'health.guestStatus', 'health.guestStatus.desc', { guestName }, serverId, serverName, nodeName, guestType, guestId, guestName, entry.firstSeen));
        }
        if (gStatus === 'running') {
          if (typeof g.cpu === 'number' && Number.isFinite(g.cpu)) {
            const checkId = 'guest:' + key + ':cpu-high';
            const entry = healthHysteresis(checkId, g.cpu, HEALTH_THRESHOLDS.guest.cpu);
            seen.add(checkId);
            if (entry.severity) {
              push(healthAlert(checkId, entry.severity, 'guest', 'health.cpuHigh', 'health.cpuHigh.desc', { guestName, pct: Math.round(g.cpu * 100) }, serverId, serverName, nodeName, guestType, guestId, guestName, entry.firstSeen));
            }
          }
          if (typeof g.maxmem === 'number' && g.maxmem > 0) {
            const checkId = 'guest:' + key + ':ram-high';
            let ramRatio = null;
            if (guestType === 'qemu' && typeof g.freemem === 'number' && g.freemem >= 0) {
              /* PRIORITÀ 1: guest agent disponibile -> uso reale = maxmem - freemem.
                 PVE 9.2 espone freemem (in passato free_mem): il collector normalizza.
                 freemem = 0 è un valore VALIDO (uso 100%); clamp anti-negativo. */
              ramRatio = Math.max(0, g.maxmem - g.freemem) / g.maxmem;
              if (!Number.isFinite(ramRatio)) ramRatio = null;
            } else if (guestType === 'qemu' && typeof g.mem === 'number' && g.mem > g.maxmem) {
              /* PRIORITÀ 2: QEMU senza metrica guest affidabile e mem > maxmem
                 (artefatto balloon/accounting) -> RAM Health NON valutabile.
                 Nessun alert e id non visto -> il cleanup rimuove lo stato precedente. */
              ramRatio = null;
            } else if (typeof g.mem === 'number') {
              /* PRIORITÀ 3: metrica standard mem/maxmem (LXC sempre qui) */
              ramRatio = g.mem / g.maxmem;
            }
            if (ramRatio !== null) {
              const entry = healthHysteresis(checkId, ramRatio, HEALTH_THRESHOLDS.guest.ram);
              seen.add(checkId);
              if (entry.severity) {
                push(healthAlert(checkId, entry.severity, 'guest', 'health.ramHigh', 'health.ramHigh.desc', { guestName, pct: Math.round(ramRatio * 100) }, serverId, serverName, nodeName, guestType, guestId, guestName, entry.firstSeen));
              }
            }
          }
          if (typeof g.uptime === 'number' && g.uptime > 0 && g.uptime < HEALTH_RECENT_RESTART_S) {
            const entry = healthImmediate('guest:' + key + ':recent-restart', 'info');
            push(healthAlert('guest:' + key + ':recent-restart', 'info', 'guest', 'health.guestRestarted', 'health.guestRestarted.desc', { guestName, minutes: Math.max(1, Math.floor(g.uptime / 60)) }, serverId, serverName, nodeName, guestType, guestId, guestName, entry.firstSeen));
          }
          if (guestType === 'lxc' && typeof g.maxdisk === 'number' && g.maxdisk > 0 && typeof g.disk === 'number' && g.disk >= 0) {
            const entry = healthImmediate('guest:' + key + ':disk-high', healthThresholdSeverity(g.disk / g.maxdisk, HEALTH_THRESHOLDS.lxc.disk));
            if (entry.severity) {
              push(healthAlert('guest:' + key + ':disk-high', entry.severity, 'guest', 'health.diskHigh', 'health.diskHigh.desc', { guestName, pct: Math.round((g.disk / g.maxdisk) * 100) }, serverId, serverName, nodeName, guestType, guestId, guestName, entry.firstSeen));
            }
          }
          /* --- lock: guest occupato da un task Proxmox (INFO, transitorio) --- */
          {
            const checkId = 'guest:' + key + ':locked';
            const entry = healthState(checkId, 'info', !!g.lock, 1);
            seen.add(checkId);
            if (entry.severity) {
              push(healthAlert(checkId, 'info', 'guest', 'health.guestLocked', 'health.guestLocked.desc',
                { guestName, lock: g.lock }, serverId, serverName, nodeName, guestType, guestId, guestName, entry.firstSeen,
                { detail: detailFor(g.lock, '-', '', 'health.source.nodeStatus', 'health.hint.guestLocked') }));
            }
          }
          /* --- QMP: QEMU in esecuzione ma stato interno non running (INFO,
                 mai "crashed": l'API non permette di distinguerlo in modo affidabile) --- */
          if (guestType === 'qemu' && typeof g.qmpstatus === 'string' && g.qmpstatus !== '' && g.qmpstatus !== 'running') {
            const checkId = 'guest:' + key + ':qmp';
            const entry = healthState(checkId, 'info', true, 1);
            seen.add(checkId);
            if (entry.severity) {
              push(healthAlert(checkId, 'info', 'guest', 'health.guestQmp', 'health.guestQmp.desc',
                { guestName, qmpstatus: g.qmpstatus }, serverId, serverName, nodeName, guestType, guestId, guestName, entry.firstSeen,
                { detail: detailFor(g.qmpstatus, 'running', '', 'health.source.nodeStatus', 'health.hint.guestQmp') }));
            }
          }
        }
      }
    }
  }

  /* ---------- Health V2.0 Core: storage / ZFS / cluster-HA / backup ---------- */

  /* --- storage (fonte on-demand /api/health/storage) --- */
  for (const st of (ex.storages || [])) {
    const sid = st.serverId || '';
    const snode = st.node || '';
    const sname = st.storage || '';
    const base = 'storage:' + sid + ':' + snode + ':' + sname;
    const th = { warning: set.storage.warning / 100, critical: set.storage.critical / 100 };
    if (st.active === false) {
      const entry = healthState(base + ':offline', 'warning', true, 1);
      seen.add(base + ':offline');
      push(healthAlert(base + ':offline', 'warning', 'storage', 'health.storageOffline', 'health.storageOffline.desc',
        { storage: sname }, sid, st.serverName || sid, snode, null, null, null, entry.firstSeen,
        { storage: sname, source: 'storage', detail: detailFor('-', '-', '', 'health.source.storageStatus', 'health.hint.storageOffline') }));
    } else {
      healthState(base + ':offline', null, false, 1);
      seen.add(base + ':offline');
    }
    if (st.enabled === false) {
      const entry = healthState(base + ':disabled', 'info', true, 1);
      seen.add(base + ':disabled');
      push(healthAlert(base + ':disabled', 'info', 'storage', 'health.storageDisabled', 'health.storageDisabled.desc',
        { storage: sname }, sid, st.serverName || sid, snode, null, null, null, entry.firstSeen,
        { storage: sname, source: 'storage', detail: detailFor('-', '-', '', 'health.source.storageStatus', 'health.hint.storageDisabled') }));
    } else {
      healthState(base + ':disabled', null, false, 1);
      seen.add(base + ':disabled');
    }
    const ratio = typeof st.usedFraction === 'number' && Number.isFinite(st.usedFraction) ? st.usedFraction
      : (st.total > 0 && typeof st.used === 'number') ? st.used / st.total : null;
    const highId = base + ':high';
    seen.add(highId);
    if (ratio !== null) {
      const entry = healthHysteresis(highId, Math.max(0, Math.min(1, ratio)), th);
      if (entry.severity) {
        const thr = th[entry.severity === 'critical' ? 'critical' : 'warning'];
        push(healthAlert(highId, entry.severity, 'storage', 'health.storageHigh', 'health.storageHigh.desc',
          { storage: sname, pct: pct(ratio) }, sid, st.serverName || sid, snode, null, null, null, entry.firstSeen,
          { storage: sname, source: 'storage', detail: detailFor(pct(ratio) + '%', pct(thr) + '%', '%', 'health.source.storageStatus', 'health.hint.storageHigh') }));
      }
    } else {
      healthSamples.delete(highId); /* totali non disponibili: metrica non valutabile */
    }
  }

  /* --- ZFS (fonte on-demand /api/health/zfs) --- */
  for (const pool of (ex.pools || [])) {
    const sid = pool.serverId || '';
    const snode = pool.node || '';
    const pname = pool.name || '';
    const base = 'zfs:' + sid + ':' + snode + ':' + pname;
    const stateStr = pool.detail && typeof pool.detail.state === 'string' && pool.detail.state !== '' ? pool.detail.state : (pool.health || '');
    const badState = HEALTH_ZFS_BAD.includes(String(stateStr).toUpperCase());
    if (badState) {
      const entry = healthState(base + ':degraded', 'critical', true, 1);
      seen.add(base + ':degraded');
      push(healthAlert(base + ':degraded', 'critical', 'zfs', 'health.zfsDegraded', 'health.zfsDegraded.desc',
        { pool: pname, state: stateStr }, sid, pool.serverName || sid, snode, null, null, null, entry.firstSeen,
        { pool: pname, source: 'zfs', detail: detailFor(stateStr, 'ONLINE', '', 'health.source.zfsStatus', 'health.hint.zfsDegraded') }));
    } else {
      healthState(base + ':degraded', null, false, 1);
      seen.add(base + ':degraded');
    }
    const errs = pool.detail ? pool.detail.errors : null;
    const hasErrors = typeof errs === 'string' && errs.trim() !== '' && errs.trim() !== HEALTH_ZFS_ERRORS_OK;
    if (hasErrors) {
      const entry = healthState(base + ':errors', 'critical', true, 1);
      seen.add(base + ':errors');
      push(healthAlert(base + ':errors', 'critical', 'zfs', 'health.zfsErrors', 'health.zfsErrors.desc',
        { pool: pname, errors: errs }, sid, pool.serverName || sid, snode, null, null, null, entry.firstSeen,
        { pool: pname, source: 'zfs', detail: detailFor(errs, HEALTH_ZFS_ERRORS_OK, '', 'health.source.zfsStatus', 'health.hint.zfsErrors') }));
    } else {
      healthState(base + ':errors', null, false, 1);
      seen.add(base + ':errors');
    }
    const capRatio = typeof pool.free === 'number' && typeof pool.size === 'number' && pool.size > 0
      ? Math.max(0, Math.min(1, 1 - pool.free / pool.size)) : null;
    const capId = base + ':capacity';
    seen.add(capId);
    if (capRatio !== null) {
      const th = { warning: set.storage.warning / 100, critical: set.storage.critical / 100 };
      const entry = healthHysteresis(capId, capRatio, th);
      if (entry.severity) {
        const thr = th[entry.severity === 'critical' ? 'critical' : 'warning'];
        push(healthAlert(capId, entry.severity, 'zfs', 'health.zfsCapacity', 'health.zfsCapacity.desc',
          { pool: pname, pct: pct(capRatio) }, sid, pool.serverName || sid, snode, null, null, null, entry.firstSeen,
          { pool: pname, source: 'zfs', detail: detailFor(pct(capRatio) + '%', pct(thr) + '%', '%', 'health.source.zfsStatus', 'health.hint.zfsCapacity') }));
      }
    } else {
      healthSamples.delete(capId);
    }
    /* scrub: parsing best effort della stringa scan; stringa non interpretabile
       -> nessun alert inventato. INFO/WARNING riemesso solo quando cambia lo scan. */
    if (pool.detail && typeof pool.detail.scan === 'string' && pool.detail.scan.trim() !== '') {
      const scan = pool.detail.scan;
      const mErr = /with (\d+) errors/i.exec(scan);
      const inProgress = /in progress/i.test(scan);
      let severity = null;
      if (!inProgress && mErr) severity = Number(mErr[1]) > 0 ? 'warning' : 'info';
      const scrubId = base + ':scrub';
      const entry = healthSamples.get(scrubId) || { severity: null, firstSeen: null, scan: null };
      if (entry.scan !== scan) {
        entry.scan = scan;
        entry.firstSeen = null;
        entry.severity = null;
      }
      healthApplyState(scrubId, entry, severity);
      seen.add(scrubId);
      if (entry.severity === 'warning') {
        push(healthAlert(scrubId, 'warning', 'zfs', 'health.zfsScrubErrors', 'health.zfsScrubErrors.desc',
          { pool: pname }, sid, pool.serverName || sid, snode, null, null, null, entry.firstSeen,
          { pool: pname, source: 'zfs', detail: detailFor(scan, '-', '', 'health.source.zfsStatus', 'health.hint.zfsScrubErrors') }));
      } else if (entry.severity === 'info') {
        push(healthAlert(scrubId, 'info', 'zfs', 'health.zfsScrubOk', 'health.zfsScrubOk.desc',
          { pool: pname }, sid, pool.serverName || sid, snode, null, null, null, entry.firstSeen,
          { pool: pname, source: 'zfs', detail: detailFor(scan, '-', '', 'health.source.zfsStatus', null) }));
      }
    }
  }

  /* --- cluster / HA (fonte on-demand /api/health/cluster) --- */
  for (const c of (ex.clusters || [])) {
    const sid = c.serverId || '';
    const srv = c.serverName || sid;
    if (c.cluster === true && c.quorate === 0) {
      const id = 'cluster:' + sid + ':quorum';
      const entry = healthState(id, 'critical', true, 2);
      seen.add(id);
      push(healthAlert(id, 'critical', 'cluster', 'health.quorumLost', 'health.quorumLost.desc',
        {}, sid, srv, null, null, null, null, entry.firstSeen,
        { source: 'cluster', detail: detailFor('-', '-', '', 'health.source.clusterStatus', 'health.hint.quorumLost') }));
    } else if (c.cluster === true) {
      const id = 'cluster:' + sid + ':quorum';
      const qEntry = healthState(id, null, false, 2);
      seen.add(id);
      if (qEntry.severity) {
        push(healthAlert(id, 'critical', 'cluster', 'health.quorumLost', 'health.quorumLost.desc',
          {}, sid, srv, null, null, null, null, qEntry.firstSeen,
          { source: 'cluster', detail: detailFor('-', '-', '', 'health.source.clusterStatus', 'health.hint.quorumLost') }));
      }
    }
    const services = (c.ha && Array.isArray(c.ha.services) && c.ha.services.length) ? c.ha.services : (c.haResources || []);
    for (const sv of services) {
      const sidKey = sv.sid || (sv.type ? sv.type + ':' + (sv.node || '?') : '?');
      const state = sv.state || '';
      if (state === 'error') {
        const id = 'ha:' + sid + ':' + sidKey + ':error';
        const entry = healthState(id, 'critical', true, 2);
        seen.add(id);
        push(healthAlert(id, 'critical', 'ha', 'health.haError', 'health.haError.desc',
          { sid: sidKey }, sid, srv, sv.node || null, null, null, null, entry.firstSeen,
          { source: 'ha', detail: detailFor(state, 'started', '', 'health.source.haStatus', 'health.hint.haError') }));
      } else if (state === 'stopped') {
        const id = 'ha:' + sid + ':' + sidKey + ':stopped';
        const entry = healthState(id, 'warning', true, 2);
        seen.add(id);
        push(healthAlert(id, 'warning', 'ha', 'health.haStopped', 'health.haStopped.desc',
          { sid: sidKey }, sid, srv, sv.node || null, null, null, null, entry.firstSeen,
          { source: 'ha', detail: detailFor(state, 'started', '', 'health.source.haStatus', 'health.hint.haStopped') }));
      } else {
        const idE = 'ha:' + sid + ':' + sidKey + ':error';
        const idS = 'ha:' + sid + ':' + sidKey + ':stopped';
        const eE = healthState(idE, null, false, 2); seen.add(idE);
        const eS = healthState(idS, null, false, 2); seen.add(idS);
        /* finestra di clear: l'alert resta visibile finché non si chiude */
        if (eE.severity) {
          push(healthAlert(idE, 'critical', 'ha', 'health.haError', 'health.haError.desc',
            { sid: sidKey }, sid, srv, sv.node || null, null, null, null, eE.firstSeen,
            { source: 'ha', detail: detailFor('error', 'started', '', 'health.source.haStatus', 'health.hint.haError') }));
        }
        if (eS.severity) {
          push(healthAlert(idS, 'warning', 'ha', 'health.haStopped', 'health.haStopped.desc',
            { sid: sidKey }, sid, srv, sv.node || null, null, null, null, eS.firstSeen,
            { source: 'ha', detail: detailFor('stopped', 'started', '', 'health.source.haStatus', 'health.hint.haStopped') }));
        }
      }
    }
  }

  /* --- backup: età dell'ultimo archivio per guest (fonte storage content) --- */
  const bSet = set.backupAge;
  const nowS = Math.floor(Date.now() / 1000);
  const backupsByGuest = new Map();
  const jobsByServer = new Map();
  for (const bs of (ex.backups || [])) {
    for (const b of (bs.backups || [])) {
      if (!b || b.vmid == null) continue;
      const k = (bs.serverId || '') + ':' + (b.guestType || '?') + ':' + b.vmid;
      const prev = backupsByGuest.get(k);
      if (!prev || (b.ctime || 0) > (prev.ctime || 0)) backupsByGuest.set(k, b);
    }
    for (const j of (bs.jobs || [])) {
      if (!j || !j.enabled) continue;
      const arr = jobsByServer.get(bs.serverId) || [];
      arr.push(j);
      jobsByServer.set(bs.serverId, arr);
    }
  }
  const jobCovers = (serverId, vmid) => (jobsByServer.get(serverId) || []).some((j) => {
    if (j.all) return true;
    const raw = j.vmid == null ? '' : String(j.vmid);
    if (!raw.trim()) return false;
    return raw.split(',').map((x) => Number(String(x).trim()))
      .filter((x) => Number.isFinite(x) && x > 0).includes(Number(vmid));
  });
  for (const s of list) {
    if (!s.online) continue;
    const sid = s.id || '';
    const sname = s.name || sid;
    for (const nd of (s.nodes || [])) {
      for (const g of [].concat(Array.isArray(nd.vms) ? nd.vms : [], Array.isArray(nd.lxc) ? nd.lxc : [])) {
        const gkey = sid + ':' + (g.type === 'qemu' ? 'qemu' : 'lxc') + ':' + g.id;
        const last = backupsByGuest.get(gkey);
        if (last && last.ctime) {
          const days = (nowS - last.ctime) / 86400;
          let severity = null;
          if (days >= bSet.criticalDays) severity = 'critical';
          else if (days >= bSet.warningDays) severity = 'warning';
          const id = 'backup:' + gkey + ':age';
          seen.add(id);
          if (severity) {
            const entry = healthImmediate(id, severity);
            const thr = severity === 'critical' ? bSet.criticalDays : bSet.warningDays;
            push(healthAlert(id, severity, 'backup', 'health.backupAge', 'health.backupAge.desc',
              { guestName: g.name, days: Math.floor(days) }, sid, sname, nd.name, g.type === 'qemu' ? 'qemu' : 'lxc', g.id, g.name, entry.firstSeen,
              { source: 'backup', detail: detailFor(Math.floor(days) + ' d', thr + ' d', '', 'health.source.backupContent', 'health.hint.backupAge') }));
          }
        } else {
          const id = 'backup:' + gkey + ':never';
          seen.add(id);
          const covered = jobCovers(sid, g.id);
          const entry = healthImmediate(id, 'info');
          push(healthAlert(id, 'info', 'backup', covered ? 'health.backupPending' : 'health.backupNone',
            covered ? 'health.backupPending.desc' : 'health.backupNone.desc',
            { guestName: g.name }, sid, sname, nd.name, g.type === 'qemu' ? 'qemu' : 'lxc', g.id, g.name, entry.firstSeen,
            { source: 'backup', detail: detailFor('-', '-', '', 'health.source.backupContent', covered ? 'health.hint.backupPending' : 'health.hint.backupNone') }));
        }
      }
    }
  }

  /* ---------- Health V2.1: dischi / SMART ----------
     NOT CHECKED (nessuna lettura in cache) -> NESSUN alert e nessun
     contributo "healthy": il disco è semplicemente non ancora verificato.
     Gli alert esistono SOLO se c'è una lettura SMART in cache. */
  const smartByKey = new Map();
  for (const s of (ex.smart || [])) {
    if (s && s.serverId && s.node && s.devpath) {
      smartByKey.set(s.serverId + ':' + s.node + ':' + s.devpath, s.reading);
    }
  }
  const dSet = set.disk;
  for (const d of (ex.disks || [])) {
    const sid = d.serverId || '';
    const sname = d.serverName || sid;
    const dnode = d.node || '';
    const dev = d.devpath || '';
    if (!dev) continue;
    const key = sid + ':' + dnode + ':' + dev;
    const sc = smartByKey.get(key);
    if (!sc || !sc.checkedAt) continue; /* NOT CHECKED: nessun alert */
    const base = 'disk:' + key;
    const checkedAtMs = sc.checkedAt * 1000;
    const isHealthy = sc.health === 'PASSED' || sc.health === 'OK';
    const isFailed = sc.health === 'FAILED';
    /* SMART FAILED: CRITICAL immediato, clear dopo 1 lettura sana */
    if (isFailed) {
      const entry = healthState(base + ':failed', 'critical', true, 1);
      seen.add(base + ':failed');
      push(healthAlert(base + ':failed', 'critical', 'disk', 'health.diskFailed', 'health.diskFailed.desc',
        { disk: dev, model: d.model || '' }, sid, sname, dnode, null, null, null, entry.firstSeen,
        { storage: null, source: 'smart', detail: withChecked(detailFor(sc.health, 'PASSED', '', 'health.source.smartStatus', 'health.hint.diskFailed'), checkedAtMs) }));
    } else if (isHealthy) {
      healthState(base + ':failed', null, false, 1);
      seen.add(base + ':failed');
    }
    /* UNKNOWN / SMART_DISABLED / lettura non riuscita: INFO immediato,
       clear dopo una lettura sana successiva */
    if (sc.health === 'UNKNOWN' || sc.health === 'SMART_DISABLED' || sc.smartAvailable === false) {
      const entry = healthState(base + ':unknown', 'info', true, 1);
      seen.add(base + ':unknown');
      const isDisabled = sc.health === 'SMART_DISABLED';
      push(healthAlert(base + ':unknown', 'info', 'disk', isDisabled ? 'health.diskSmartDisabled' : 'health.diskSmartUnknown',
        isDisabled ? 'health.diskSmartDisabled.desc' : 'health.diskSmartUnknown.desc',
        { disk: dev }, sid, sname, dnode, null, null, null, entry.firstSeen,
        { source: 'smart', detail: withChecked(detailFor(sc.health, 'PASSED', '', 'health.source.smartStatus', 'health.hint.diskUnknown'), checkedAtMs) }));
    } else if (isHealthy || isFailed) {
      healthState(base + ':unknown', null, false, 1);
      seen.add(base + ':unknown');
    }
    /* settori: WARNING immediato quando > 0, clear alla prima lettura a 0 */
    const sectors = [
      ['pending', 'health.diskPending', 'health.diskPending.desc', 'health.hint.diskSectors'],
      ['reallocated', 'health.diskReallocated', 'health.diskReallocated.desc', 'health.hint.diskSectors'],
      ['offlineUncorrectable', 'health.diskUncorrectable', 'health.diskUncorrectable.desc', 'health.hint.diskSectors'],
    ];
    for (const [field, titleKey, descKey, hintKey] of sectors) {
      const v = sc[field];
      const id = base + ':' + field;
      seen.add(id);
      if (typeof v === 'number' && v > 0) {
        const entry = healthState(id, 'warning', true, 1);
        push(healthAlert(id, 'warning', 'disk', titleKey, descKey,
          { disk: dev, n: v }, sid, sname, dnode, null, null, null, entry.firstSeen,
          { source: 'smart', detail: withChecked(detailFor(v, '0', '', 'health.source.smartStatus', hintKey), checkedAtMs) }));
      } else if (typeof v === 'number') {
        healthState(id, null, false, 1);
      } else {
        healthSamples.delete(id); /* metrica non disponibile: niente alert */
      }
    }
    /* vita residua stimata: immediata (dato lento), critica FISSA a 5 */
    if (typeof sc.wearRemaining === 'number' && sc.wearRemaining >= 0 && sc.wearRemaining <= 100) {
      const id = base + ':wear';
      seen.add(id);
      const sev = sc.wearRemaining <= HEALTH_DISK_WEAR_CRITICAL ? 'critical'
        : (sc.wearRemaining <= dSet.wear.warning ? 'warning' : null);
      const entry = healthImmediate(id, sev);
      if (entry.severity) {
        push(healthAlert(id, entry.severity, 'disk', 'health.diskWear', 'health.diskWear.desc',
          { disk: dev, pct: Math.round(sc.wearRemaining) }, sid, sname, dnode, null, null, null, entry.firstSeen,
          { source: 'smart', detail: withChecked(detailFor(Math.round(sc.wearRemaining) + '%', (entry.severity === 'critical' ? HEALTH_DISK_WEAR_CRITICAL : dSet.wear.warning) + '%', '', 'health.source.smartStatus', 'health.hint.diskWear'), checkedAtMs) }));
      }
    } else {
      const id = base + ':wear';
      seen.add(id);
      healthSamples.delete(id); /* N/A: niente alert */
    }
    /* temperatura: 2 campioni con downgrade a scalino (soglie configurabili) */
    if (typeof sc.temperature === 'number' && Number.isFinite(sc.temperature)) {
      const id = base + ':temp';
      const th = { warning: dSet.temp.warning, critical: dSet.temp.critical };
      const entry = healthHysteresis(id, sc.temperature, th);
      seen.add(id);
      if (entry.severity) {
        const thr = th[entry.severity === 'critical' ? 'critical' : 'warning'];
        push(healthAlert(id, entry.severity, 'disk', 'health.diskTemp', 'health.diskTemp.desc',
          { disk: dev, temp: Math.round(sc.temperature) }, sid, sname, dnode, null, null, null, entry.firstSeen,
          { source: 'smart', detail: withChecked(detailFor(Math.round(sc.temperature) + ' °C', thr + ' °C', '', 'health.source.smartStatus', 'health.hint.diskTemp'), checkedAtMs) }));
      }
    } else {
      const id = base + ':temp';
      seen.add(id);
      healthSamples.delete(id);
    }
  }

  /* cleanup: rimuove lo stato dei check che non esistono più nel payload
     corrente o che sono diventati ignore/non applicabili (niente memory leak). */
  for (const id of Array.from(healthSamples.keys())) {
    if (!seen.has(id)) healthSamples.delete(id);
  }

  /* task alerts: eventi conclusi -> immediati, niente isteresi/anti-flapping.
     Allowlist, finestra 24h, dedup per UPID, severità dal mapping. */
  if (Array.isArray(taskAlerts)) {
    const nowS = Math.floor(Date.now() / 1000);
    const seenTasks = new Set();
    for (const t of taskAlerts) {
      if (!t || typeof t !== 'object') continue;
      const severity = HEALTH_TASK_ALLOWLIST[t.type];
      if (!severity) continue;
      if (t.status === 'OK') continue;
      const endtime = Number(t.endtime) || 0;
      if (!(endtime > 0)) continue; /* task ancora in esecuzione o senza endtime */
      const starttime = Number(t.starttime) || 0;
      const tsS = endtime || starttime;
      if (tsS < nowS - HEALTH_TASK_WINDOW_S) continue; /* fuori finestra 24h */
      if (!t.upid || seenTasks.has(t.upid)) continue; /* dedup UPID */
      seenTasks.add(t.upid);
      const serverId = t.serverId || '';
      const serverName = t.serverName || serverId;
      const node = t.node || null;
      let guestType = null, guestId = null, guestName = null;
      const vmid = Number(t.vmid);
      if (vmid > 0 && Array.isArray(status && status.servers)) {
        outer: for (const srv of status.servers) {
          for (const nd of Array.isArray(srv.nodes) ? srv.nodes : []) {
            for (const list of ['vms', 'lxc']) {
              const arr = Array.isArray(nd[list]) ? nd[list] : [];
              const g = arr.find((g) => g.id === vmid && (!node || nd.name === node));
              if (g) {
                guestType = list === 'vms' ? 'qemu' : 'lxc';
                guestId = vmid;
                guestName = g.name || null;
                break outer;
              }
            }
          }
        }
      }
      push(healthAlert('task:' + serverId + ':' + t.upid, severity, 'task',
        severity === 'critical' ? 'health.backupFailed' : 'health.taskFailed',
        severity === 'critical' ? 'health.backupFailed.desc' : 'health.taskFailed.desc',
        { taskType: t.type, upid: t.upid, guestName: guestName || null },
        serverId, serverName, node, guestType, guestId, guestName, tsS * 1000));
    }
  }

  if (summary.critical > 0) summary.state = 'critical';
  else if (summary.warning > 0) summary.state = 'warning';
  else summary.state = 'healthy';

  alerts.sort((a, b) => {
    const d = HEALTH_SEVERITY_ORDER[a.severity] - HEALTH_SEVERITY_ORDER[b.severity];
    if (d !== 0) return d;
    if (b.ts !== a.ts) return b.ts - a.ts;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { summary, alerts, servers };
}

/* ---------- Health UI (FASE 3): rendering della vista Monitoraggio ---------- */

const HEALTH_BANNER = {
  healthy: { key: 'health.banner.healthy', icon: '✓' },
  warning: { key: 'health.banner.warning', icon: '⚠' },
  critical: { key: 'health.banner.critical', icon: '✕' }
};

const HEALTH_SEV_ICON = { critical: '✕', warning: '⚠', info: 'ℹ' };

/* tempo relativo (si aggiorna al normale refresh, nessun timer dedicato) */
function healthRelTime(ts) {
  const m = Math.floor(Math.max(0, Date.now() - ts) / 60000);
  if (m < 1) return t('health.time.now');
  if (m < 60) return t('health.time.min', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('health.time.hour', { n: h });
  return t('health.time.day', { n: Math.floor(h / 24) });
}

/* plurale semplice: chiave .one / .many */
function healthCount(key, n) {
  return t(key + (n === 1 ? '.one' : '.many'), { n });
}

function healthBarRow(label, ratio) {
  const pct = ratio === null ? 0 : Math.max(0, Math.min(100, ratio * 100));
  return '<div class="health-bar-row"><span class="health-bar-label">' + label + '</span>' +
    '<div class="health-bar"><div class="health-bar-track"><div class="health-bar-fill" style="width:' + pct + '%"></div></div></div>' +
    '<span class="health-bar-value">' + (ratio === null ? '—' : Math.round(pct) + '%') + '</span></div>';
}

function healthAlertHtml(a) {
  const txt = { title: t(a.titleKey, a.params), desc: t(a.descriptionKey, a.params) };
  const ctx = [];
  if (a.serverName) ctx.push(esc(a.serverName));
  if (a.node) ctx.push(esc(a.node));
  if (a.storage) ctx.push(esc(a.storage));
  if (a.pool) ctx.push(esc(a.pool));
  if (a.guestName) ctx.push(esc(a.guestName) + (a.guestId != null ? ' · ' + (a.guestType === 'qemu' ? t('vms') : t('lxc')) + ' ' + a.guestId : ''));
  let action = '';
  if (a.category === 'guest' && a.guestId != null) {
    action = '<button type="button" class="ghost-btn health-alert-action" data-health-open-guest="' +
      esc(a.serverId) + ':' + esc(a.node) + ':' + esc(a.guestType) + ':' + esc(a.guestId) + '">' + t('health.action.openGuest') + '</button>';
  } else if (a.category === 'backup' && a.guestId != null) {
    action = '<button type="button" class="ghost-btn health-alert-action" data-health-open-backup ' +
      'data-backup-server="' + esc(a.serverId) + '" data-backup-vmid="' + esc(a.guestId) + '" data-backup-type="' + esc(a.guestType || '') + '">' + t('backup.open') + '</button>';
  } else if (a.category === 'task') {
    action = '<button type="button" class="ghost-btn health-alert-action" data-health-open-task ' +
      'data-task-server="' + esc(a.serverId) + '" data-task-node="' + esc(a.node || '') + '" data-task-upid="' + esc((a.params && a.params.upid) || '') + '">' + t('health.action.openLog') + '</button>';
    /* deep-link Backup per task vzdump falliti: se il guest e' risolvibile
       si porta direttamente alla sua riga nella vista Backup & Snapshot */
    if (a.params && a.params.taskType === 'vzdump') {
      action += '<button type="button" class="ghost-btn health-alert-action" data-health-open-backup ' +
        'data-backup-server="' + esc(a.serverId) + '" data-backup-vmid="' + (a.guestId != null ? esc(a.guestId) : '') + '" data-backup-type="' + esc(a.guestType || '') + '">' + t('backup.open') + '</button>';
    }
  }
  /* dettaglio "Perché lo vedo?": valore corrente, soglia, fonte, suggerimento
     non distruttivo. Solo se l'alert espone un dettaglio. */
  let why = '';
  if (a.detail) {
    const rows = [];
    const d = a.detail;
    if (d.current !== undefined && d.current !== null && String(d.current) !== '') {
      rows.push('<div class="health-why-row"><span class="health-why-label">' + t('health.detail.current') + '</span><span>' + esc(String(d.current) + (d.unit || '')) + '</span></div>');
    }
    if (d.threshold !== undefined && d.threshold !== null && String(d.threshold) !== '') {
      rows.push('<div class="health-why-row"><span class="health-why-label">' + t('health.detail.threshold') + '</span><span>' + esc(String(d.threshold) + (d.unit || '')) + '</span></div>');
    }
    if (d.sourceLabel) {
      rows.push('<div class="health-why-row"><span class="health-why-label">' + t('health.detail.source') + '</span><span>' + esc(t(d.sourceLabel)) + '</span></div>');
    }
    if (d.suggestionKey) {
      rows.push('<div class="health-why-row"><span class="health-why-label">' + t('health.detail.suggestion') + '</span><span>' + esc(t(d.suggestionKey)) + '</span></div>');
    }
    if (d.checkedAt) {
      rows.push('<div class="health-why-row"><span class="health-why-label">' + t('health.detail.lastChecked') + '</span><span>' + esc(healthRelTime(d.checkedAt)) + '</span></div>');
    }
    if (rows.length) {
      why = '<details class="health-alert-why"><summary>' + t('health.why') + '</summary>' +
        '<div class="health-why-grid">' + rows.join('') + '</div></details>';
    }
  }
  return '<div class="health-alert health-alert--' + a.severity + '" role="listitem" data-alert-id="' + esc(a.id) + '">' +
    '<div class="health-alert-icon">' + HEALTH_SEV_ICON[a.severity] + '</div>' +
    '<div class="health-alert-body">' +
      '<div class="health-alert-top">' +
        '<span class="health-sev health-sev--' + a.severity + '">' + t('health.severity.' + a.severity) + '</span>' +
        '<span class="health-alert-time">' + healthRelTime(a.ts) + '</span>' +
      '</div>' +
      '<div class="health-alert-title">' + esc(txt.title) + '</div>' +
      '<div class="health-alert-desc">' + esc(txt.desc) + '</div>' +
      (ctx.length ? '<div class="health-alert-ctx">' + ctx.join(' · ') + '</div>' : '') +
      why +
    '</div>' +
    (action ? '<div class="health-alert-actions">' + action + '</div>' : '') +
  '</div>';
}

function healthInfraHtml(servers) {
  return servers.map((s) => {
    const nodes = s.nodes.length
      ? s.nodes.map((n) =>
          '<div class="health-node">' +
            '<div class="health-node-head">' +
              '<span class="health-node-name">' + esc(n.name) + '</span>' +
              '<span class="health-node-status">' + esc(n.status) + '</span>' +
            '</div>' +
            healthBarRow(t('cpu'), n.cpu) +
            healthBarRow(t('ram'), n.ram) +
            healthBarRow(t('health.infra.rootfs'), n.rootfs) +
            healthBarRow(t('health.infra.swap'), n.swap) +
            '<div class="health-bar-row"><span class="health-bar-label">' + t('health.infra.load') + '</span>' +
              '<span class="health-load-value">' + (n.loadavg ? Number(n.loadavg[0]).toFixed(2) + ' / ' + (n.cpus || '—') : '—') + '</span></div>' +
            '<div class="health-bar-row"><span class="health-bar-label">' + t('health.infra.guest') + '</span>' +
              '<span class="health-bar-value">' + n.guestsRunning + ' / ' + n.guestsTotal + '</span></div>' +
          '</div>'
        ).join('')
      : '<div class="health-node-empty">' + t('health.nodeEmpty') + '</div>';
    return '<div class="health-server glass">' +
      '<div class="health-server-head">' +
        '<span class="health-status-dot ' + (s.online ? 'online' : 'offline') + '"></span>' +
        '<span class="health-server-name">' + esc(s.name) + '</span>' +
        '<span class="health-server-state ' + (s.online ? 'online' : 'offline') + '">' + (s.online ? t('health.online') : t('health.offline')) + '</span>' +
      '</div>' + nodes +
    '</div>';
  }).join('');
}

/* ---------- Health UI V2: filtri, sezioni e dettaglio ---------- */

const healthFilters = { severity: 'all', server: 'all' };
let healthSectionsInit = false;

function healthFilterOk(a) {
  if (healthFilters.severity !== 'all' && a.severity !== healthFilters.severity) return false;
  if (healthFilters.server !== 'all' && a.serverId !== healthFilters.server) return false;
  return true;
}

function healthServerOk(serverId) {
  return healthFilters.server === 'all' || serverId === healthFilters.server;
}

function populateHealthServerFilter() {
  const sel = $('healthServerFilter');
  const servers = (state.status && state.status.servers) || [];
  sel.innerHTML = '<option value="all">' + t('health.filter.serverAll') + '</option>' +
    servers.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
  if (!servers.some((s) => s.id === healthFilters.server)) healthFilters.server = 'all';
  sel.value = healthFilters.server;
}

function healthPartialNote(errors) {
  if (!errors || !errors.length) return '';
  return '<div class="health-partial-note">⚠ ' + t('health.partialErrors') + '</div>';
}

function healthStorageHtml(storages, errors) {
  return storages.map((st) => {
    const badges = [];
    if (st.shared) badges.push('<span class="health-badge">' + t('health.shared') + '</span>');
    if (st.enabled === false) badges.push('<span class="health-badge health-badge--info">' + t('health.storageDisabled.short') + '</span>');
    return '<div class="health-row">' +
      '<div class="health-row-head">' +
        '<span class="health-row-name">' + esc(st.storage) + '</span>' +
        badges.join('') +
        '<span class="health-row-state ' + (st.active === false ? 'bad' : 'ok') + '">' + (st.active === false ? t('health.offline') : t('health.online')) + '</span>' +
      '</div>' +
      '<div class="health-row-meta">' + esc(st.type || '') + (st.nodes && st.nodes.length ? ' · ' + st.nodes.map(esc).join(', ') : '') + '</div>' +
      healthBarRow(t('health.infra.usage'), st.ratio) +
    '</div>';
  }).join('') + healthPartialNote(errors);
}

function healthZfsHtml(pools, errors) {
  return pools.map((p) => {
    const state = p.detail && typeof p.detail.state === 'string' && p.detail.state !== '' ? p.detail.state : (p.health || '—');
    const bad = HEALTH_ZFS_BAD.includes(String(state).toUpperCase());
    const cap = typeof p.free === 'number' && typeof p.size === 'number' && p.size > 0 ? Math.max(0, Math.min(1, 1 - p.free / p.size)) : null;
    const scan = p.detail && p.detail.scan ? p.detail.scan : '';
    return '<div class="health-row">' +
      '<div class="health-row-head">' +
        '<span class="health-row-name">' + esc(p.name) + '</span>' +
        '<span class="health-row-state ' + (bad ? 'bad' : 'ok') + '">' + esc(state) + '</span>' +
      '</div>' +
      '<div class="health-row-meta">' + esc(p.node || '') + (p.frag != null ? ' · frag ' + p.frag + '%' : '') + '</div>' +
      healthBarRow(t('health.infra.usage'), cap) +
      (scan ? '<div class="health-row-scan">' + esc(scan) + '</div>' : '') +
    '</div>';
  }).join('') + healthPartialNote(errors);
}

/* ---------- Health V2.1: sezione Dischi / SMART ---------- */

const healthDiskOpen = new Set();

function healthDiskSmartStatus(smart, entry, disk) {
  if (entry && entry.fetching) {
    return '<span class="health-row-state dim">' + t('health.disk.checking') + '</span>';
  }
  if (!smart || !smart.checkedAt) {
    return '<span class="health-row-state dim">' + t('health.disk.notChecked') + '</span>';
  }
  if (smart.smartAvailable === false) {
    return '<span class="health-row-state dim">' + t('health.disk.unavailable') + '</span>';
  }
  const cls = smart.health === 'FAILED' ? 'bad' : (smart.health === 'PASSED' || smart.health === 'OK') ? 'ok' : 'dim';
  return '<span class="health-row-state ' + cls + '">SMART ' + esc(smart.health) + '</span>';
}

function healthDiskCheckedAgo(entry) {
  if (!entry || !entry.at) return '';
  const mins = Math.floor((Date.now() - entry.at) / 60000);
  const stale = Date.now() - entry.at >= SMART_TTL_MS;
  return '<span class="health-row-meta">' + t('health.disk.checkedAgo', { n: mins }) +
    (stale ? ' · <span class="health-disk-stale">' + t('health.disk.stale') + '</span>' : '') + '</span>';
}

function healthDiskHtml(disks, smartCache, errors) {
  const servers = new Map();
  for (const d of disks) {
    if (!servers.has(d.serverId)) servers.set(d.serverId, { name: d.serverName, nodes: new Map() });
    const srv = servers.get(d.serverId);
    if (!srv.nodes.has(d.node)) srv.nodes.set(d.node, []);
    srv.nodes.get(d.node).push(d);
  }
  let html = '';
  for (const [sid, srv] of servers) {
    for (const [node, nodeDisks] of srv.nodes) {
      html += '<div class="health-server glass"><div class="health-server-head">' +
        '<span class="health-server-name">' + esc(srv.name) + '</span>' +
        '<span class="health-row-meta">' + esc(node) + '</span></div>';
      for (const d of nodeDisks) {
        const key = sid + ':' + node + ':' + d.devpath;
        const entry = smartCache.get(key);
        const smart = entry ? entry.data : null;
        const open = healthDiskOpen.has(key);
        const badges = [];
        if (d.type) badges.push('<span class="health-badge">' + esc(String(d.type).toUpperCase()) + '</span>');
        const extras = [];
        if (smart && smart.checkedAt) {
          if (typeof smart.temperature === 'number') extras.push(esc(Math.round(smart.temperature) + ' °C'));
          if (typeof smart.wearRemaining === 'number') extras.push(t('health.disk.life') + ': ' + Math.round(smart.wearRemaining) + '%');
        }
        html += '<details class="health-disk"' + (open ? ' open' : '') + ' data-disk-key="' + esc(key) + '">' +
          '<summary class="health-disk-summary">' +
            '<span class="health-row-name">' + esc(d.devpath || '?') + '</span>' +
            '<span class="health-row-meta">' + esc(d.model || '') + '</span>' +
            badges.join('') +
            healthDiskSmartStatus(smart, entry, d) +
            (extras.length ? '<span class="health-disk-extras">' + extras.join(' · ') + '</span>' : '') +
          '</summary>' +
          '<div class="health-disk-body">' +
            healthDiskCheckedAgo(entry) +
            healthDiskDetailHtml(d, smart, entry) +
          '</div>' +
        '</details>';
      }
      html += '</div>';
    }
  }
  return html + healthPartialNote(errors);
}

function healthDiskDetailHtml(d, smart, entry) {
  const rows = [
    [t('health.disk.detail.device'), d.devpath],
    [t('health.disk.detail.model'), d.model],
    [t('health.disk.detail.serial'), d.serial],
    [t('health.disk.detail.vendor'), d.vendor],
    [t('health.disk.detail.type'), d.type ? String(d.type).toUpperCase() : null],
    [t('health.disk.detail.capacity'), typeof d.size === 'number' ? fmtBytes(d.size) : null],
  ];
  if (d.type === 'hdd' && typeof d.rpm === 'number' && d.rpm > 0) rows.push([t('health.disk.detail.rpm'), d.rpm + ' rpm']);
  if (smart && smart.checkedAt) {
    rows.push([t('health.disk.detail.smartHealth'), 'SMART ' + smart.health]);
    if (typeof smart.temperature === 'number') rows.push([t('health.disk.detail.temperature'), Math.round(smart.temperature) + ' °C']);
    if (typeof smart.powerOnHours === 'number') rows.push([t('health.disk.detail.powerOnHours'), smart.powerOnHours + ' h']);
    if (typeof smart.wearRemaining === 'number') {
      rows.push([t('health.disk.detail.life'), Math.round(smart.wearRemaining) + '%']);
      rows.push([null, '<span class="health-disk-wear-note">' + t('health.disk.wearNote') + '</span>']);
    }
    if (typeof smart.reallocated === 'number') rows.push([t('health.disk.detail.reallocated'), smart.reallocated]);
    if (typeof smart.pending === 'number') rows.push([t('health.disk.detail.pending'), smart.pending]);
    if (typeof smart.offlineUncorrectable === 'number') rows.push([t('health.disk.detail.uncorrectable'), smart.offlineUncorrectable]);
  } else if (entry && entry.fetching) {
    rows.push([null, t('health.disk.checking')]);
  } else if (entry && entry.error) {
    rows.push([null, t('health.disk.unavailable')]);
  } else {
    rows.push([null, t('health.disk.notChecked')]);
  }
  let html = rows.filter((r) => r[0] !== null || r[1] !== null)
    .map((r) => '<div class="health-why-row">' +
      (r[0] ? '<span class="health-why-label">' + esc(r[0]) + '</span>' : '<span class="health-why-label"></span>') +
      '<span>' + (r[1] === null || r[1] === undefined ? '—' : r[1]) + '</span></div>').join('');
  /* Mostra SMART completo: attributi ATA (tabella) o testo NVMe/SAS, escaped */
  if (smart && (smart.rawAttributes || smart.rawText)) {
    html += '<details class="health-disk-raw"><summary>' + t('health.disk.showAll') + '</summary>';
    if (smart.rawAttributes) {
      html += '<div class="health-disk-raw-table-wrap"><table class="health-disk-raw-table">' +
        '<thead><tr><th>ID</th><th>' + t('health.disk.attr.name') + '</th><th>' + t('health.disk.attr.value') + '</th>' +
        '<th>' + t('health.disk.attr.worst') + '</th><th>' + t('health.disk.attr.threshold') + '</th>' +
        '<th>' + t('health.disk.attr.raw') + '</th></tr></thead><tbody>' +
        smart.rawAttributes.map((a) => '<tr><td>' + esc(String(a.id || '').trim()) + '</td><td>' + esc(a.name) + '</td><td>' + esc(String(a.value)) + '</td><td>' + esc(String(a.worst)) + '</td><td>' + esc(String(a.threshold)) + '</td><td>' + esc(String(a.raw)) + '</td></tr>').join('') +
        '</tbody></table></div>';
    } else if (smart.rawText) {
      html += '<pre class="health-disk-raw-text">' + esc(smart.rawText) + '</pre>';
    }
    html += '</details>';
  }
  return html;
}

function healthBackupRows() {
  const rows = [];
  const nowS = Math.floor(Date.now() / 1000);
  const byKey = new Map();
  const jobsByServer = new Map();
  for (const bs of healthSourceCache.backups.data || []) {
    for (const b of (bs.backups || [])) {
      if (!b || b.vmid == null) continue;
      const k = (bs.serverId || '') + ':' + (b.guestType || '?') + ':' + b.vmid;
      const prev = byKey.get(k);
      if (!prev || (b.ctime || 0) > (prev.ctime || 0)) byKey.set(k, b);
    }
    for (const j of (bs.jobs || [])) {
      if (!j || !j.enabled) continue;
      const arr = jobsByServer.get(bs.serverId) || [];
      arr.push(j);
      jobsByServer.set(bs.serverId, arr);
    }
  }
  const covers = (serverId, vmid) => (jobsByServer.get(serverId) || []).some((j) => {
    if (j.all) return true;
    const raw = j.vmid == null ? '' : String(j.vmid);
    if (!raw.trim()) return false;
    return raw.split(',').map((x) => Number(String(x).trim()))
      .filter((x) => Number.isFinite(x) && x > 0).includes(Number(vmid));
  });
  for (const s of (state.status && state.status.servers) || []) {
    if (!s.online || !healthServerOk(s.id)) continue;
    for (const nd of (s.nodes || [])) {
      for (const g of [].concat(Array.isArray(nd.vms) ? nd.vms : [], Array.isArray(nd.lxc) ? nd.lxc : [])) {
        const last = byKey.get(s.id + ':' + (g.type === 'qemu' ? 'qemu' : 'lxc') + ':' + g.id);
        rows.push({
          serverId: s.id, serverName: s.name, node: nd.name,
          type: g.type === 'qemu' ? 'qemu' : 'lxc', vmid: g.id, name: g.name || ('Guest ' + g.id),
          lastCtime: last ? last.ctime : null,
          daysSince: last && last.ctime ? Math.floor((nowS - last.ctime) / 86400) : null,
          covered: last ? true : covers(s.id, g.id),
        });
      }
    }
  }
  rows.sort((a, b) => {
    if (a.daysSince === null && b.daysSince !== null) return 1;
    if (a.daysSince !== null && b.daysSince === null) return -1;
    return (b.daysSince || 0) - (a.daysSince || 0);
  });
  return rows;
}

function healthBackupHtml(rows, errors) {
  const set = healthSettings().backupAge;
  return rows.map((r) => {
    let cls = 'ok';
    let label;
    if (r.daysSince === null) {
      cls = 'dim';
      label = r.covered ? t('health.backupPending.short') : t('health.backupNone.short');
    } else if (r.daysSince >= set.criticalDays) {
      cls = 'bad';
      label = t('health.backupAge.short', { days: r.daysSince });
    } else if (r.daysSince >= set.warningDays) {
      cls = 'warn';
      label = t('health.backupAge.short', { days: r.daysSince });
    } else {
      label = t('health.backupAge.short', { days: r.daysSince });
    }
    return '<div class="health-row">' +
      '<div class="health-row-head">' +
        '<span class="health-row-name">' + esc(r.name) + '</span>' +
        '<span class="health-row-state ' + cls + '">' + esc(label) + '</span>' +
      '</div>' +
      '<div class="health-row-meta">' + esc(r.serverName) + ' · ' + esc(r.node) + ' · ' + (r.type === 'qemu' ? t('vms') : t('lxc')) + ' ' + r.vmid + '</div>' +
    '</div>';
  }).join('') + healthPartialNote(errors);
}

function healthClusterHtml(entries, errors) {
  return entries.map((c) => {
    const services = (c.ha && Array.isArray(c.ha.services) && c.ha.services.length) ? c.ha.services : (c.haResources || []);
    const rows = services.map((sv) => {
      const st = sv.state || '?';
      const cls = st === 'error' ? 'bad' : (st === 'stopped' ? 'warn' : 'ok');
      return '<div class="health-row">' +
        '<div class="health-row-head">' +
          '<span class="health-row-name">' + esc(sv.sid || '?') + '</span>' +
          '<span class="health-row-state ' + cls + '">' + esc(st) + '</span>' +
        '</div>' +
        '<div class="health-row-meta">' + esc(sv.node || '') + (sv.status ? ' · ' + esc(sv.status) : '') + '</div>' +
      '</div>';
    }).join('');
    return '<div class="health-server glass">' +
      '<div class="health-server-head">' +
        '<span class="health-server-name">' + esc(c.serverName || c.serverId) + '</span>' +
        '<span class="health-server-state ' + (c.quorate === 0 ? 'offline' : 'online') + '">' + (c.quorate === 0 ? t('health.quorumLost.short') : t('health.quorumOk.short')) + '</span>' +
      '</div>' +
      (c.ha && c.ha.managerStatus ? '<div class="health-row-meta">' + t('health.haManager') + ': ' + esc(c.ha.managerStatus) + '</div>' : '') +
      rows +
    '</div>';
  }).join('') + healthPartialNote(errors);
}

function renderHealth() {
  maybeFetchHealthTasks(); /* on-demand, TTL 60s, solo a vista aperta */
  maybeFetchHealthSources(); /* storage/cluster/zfs/backup: on-demand + TTL */
  const h = state.health;
  const updatedEl = $('healthUpdated');
  if (!h) {
    $('healthBannerTitle').textContent = t('health.loading');
    $('healthBannerSub').textContent = '—';
    updatedEl.textContent = '—';
    $('healthAttentionSection').hidden = true;
    $('healthInfoSection').hidden = true;
    $('healthInfraSection').hidden = true;
    $('healthFilters').hidden = true;
    $('healthStorageSection').hidden = true;
    $('healthZfsSection').hidden = true;
    $('healthDiskSection').hidden = true;
    $('healthBackupSection').hidden = true;
    $('healthClusterSection').hidden = true;
    $('healthEmpty').hidden = true;
    return;
  }
  const st = HEALTH_BANNER[h.summary.state] || HEALTH_BANNER.healthy;
  const banner = $('healthBanner');
  banner.className = 'health-banner glass health-banner--' + h.summary.state;
  $('healthBannerIcon').textContent = st.icon;
  $('healthBannerTitle').textContent = t(st.key);
  const parts = [];
  if (h.summary.critical) parts.push(healthCount('health.critical', h.summary.critical));
  if (h.summary.warning) parts.push(healthCount('health.warning', h.summary.warning));
  $('healthBannerSub').textContent = parts.length ? parts.join(' · ') : t('health.noProblems');
  const at = state.status && state.status.at ? state.status.at : Date.now();
  updatedEl.textContent = t('updated') + ' ' + new Date(at).toLocaleTimeString(state.config.language || 'it');

  $('healthCardCritical').textContent = String(h.summary.critical);
  $('healthCardWarning').textContent = String(h.summary.warning);
  $('healthCardServer').textContent = h.summary.serversOnline + ' / ' + h.summary.serversTotal;
  $('healthCardGuest').textContent = h.summary.guestsRunning + ' / ' + h.summary.guestsTotal;

  /* filtri: solo client-side, nessun fetch */
  populateHealthServerFilter();
  $('healthFilters').hidden = !((state.status && state.status.servers) || []).length;

  const attentionTotal = h.alerts.filter((a) => a.severity === 'critical' || a.severity === 'warning');
  const infosTotal = h.alerts.filter((a) => a.severity === 'info');
  const attention = attentionTotal.filter(healthFilterOk);
  const infos = infosTotal.filter(healthFilterOk);
  /* preserva l'apertura dei dettagli "Perché lo vedo?" attraverso i re-render */
  const openAttention = new Set();
  const openInfos = new Set();
  $('healthAttentionList').querySelectorAll('.health-alert[data-alert-id] details.health-alert-why[open]').forEach((d) => {
    const li = d.closest('.health-alert');
    if (li) openAttention.add(li.dataset.alertId);
  });
  $('healthInfoList').querySelectorAll('.health-alert[data-alert-id] details.health-alert-why[open]').forEach((d) => {
    const li = d.closest('.health-alert');
    if (li) openInfos.add(li.dataset.alertId);
  });
  $('healthAttentionList').innerHTML = attention.map(healthAlertHtml).join('');
  $('healthInfoList').innerHTML = infos.map(healthAlertHtml).join('');
  $('healthAttentionList').querySelectorAll('.health-alert[data-alert-id]').forEach((li) => {
    const d = li.querySelector('details.health-alert-why');
    if (d && openAttention.has(li.dataset.alertId)) d.open = true;
  });
  $('healthInfoList').querySelectorAll('.health-alert[data-alert-id]').forEach((li) => {
    const d = li.querySelector('details.health-alert-why');
    if (d && openInfos.has(li.dataset.alertId)) d.open = true;
  });
  $('healthAttentionCount').textContent = String(attention.length);
  $('healthInfoCount').textContent = String(infos.length);
  $('healthAttentionSection').hidden = attentionTotal.length === 0;
  $('healthInfoSection').hidden = infosTotal.length === 0;

  const infraServers = h.servers.filter((s) => healthServerOk(s.id));
  $('healthInfraList').innerHTML = healthInfraHtml(infraServers);
  $('healthInfraSection').hidden = infraServers.length === 0;

  /* storage */
  const storages = (healthSourceCache.storage.data || []).filter((st) => healthServerOk(st.serverId));
  for (const st of storages) {
    st.ratio = typeof st.usedFraction === 'number' && Number.isFinite(st.usedFraction) ? st.usedFraction
      : (st.total > 0 && typeof st.used === 'number') ? st.used / st.total : null;
  }
  $('healthStorageList').innerHTML = healthStorageHtml(storages, healthSourceCache.storage.errors);
  $('healthStorageCount').textContent = String(storages.length);
  $('healthStorageSection').hidden = storages.length === 0;

  /* zfs */
  const pools = (healthSourceCache.zfs.data || []).filter((p) => healthServerOk(p.serverId));
  $('healthZfsList').innerHTML = healthZfsHtml(pools, healthSourceCache.zfs.errors);
  $('healthZfsCount').textContent = String(pools.length);
  $('healthZfsSection').hidden = pools.length === 0;

  /* dischi / SMART (V2.1): inventory senza smartctl; letture solo on-demand */
  const disks = (healthSourceCache.disks.data || []).filter((d) => healthServerOk(d.serverId));
  for (const d of disks) {
    const dkey = d.serverId + ':' + d.node + ':' + d.devpath;
    if (healthDiskOpen.has(dkey)) requestSmart(d.serverId, d.node, d.devpath);
  }
  $('healthDiskList').innerHTML = healthDiskHtml(disks, healthSourceCache.smart, healthSourceCache.disks.errors);
  $('healthDiskCount').textContent = String(disks.length);
  $('healthDiskSection').hidden = disks.length === 0;

  /* backup */
  const bRows = healthBackupRows();
  $('healthBackupList').innerHTML = healthBackupHtml(bRows, healthSourceCache.backups.errors);
  $('healthBackupCount').textContent = String(bRows.length);
  $('healthBackupSection').hidden = bRows.length === 0;

  /* cluster: presente solo se almeno un server è realmente in cluster */
  const clusters = (healthSourceCache.cluster.data || []).filter((c) => c.cluster === true && healthServerOk(c.serverId));
  $('healthClusterList').innerHTML = healthClusterHtml(clusters, healthSourceCache.cluster.errors);
  $('healthClusterSection').hidden = clusters.length === 0;

  /* stato iniziale aperto/collassato: solo al primo render con le fonti
     on-demand arrivate; dopo, il toggle dell'utente non viene più toccato */
  if (!healthSectionsInit) {
    /* tutte e quattro le fonti devono essere arrivate (o fallite con
       data non-null), altrimenti lo stato iniziale sarebbe calcolato
       con sezioni ancora vuote */
    const sourcesReady = ['storage', 'cluster', 'zfs', 'backups']
      .every((k) => healthSourceCache[k].data !== null);
    if (sourcesReady) {
      healthSectionsInit = true;
      $('healthStorageSection').open = storages.length > 0;
      $('healthZfsSection').open = h.alerts.some((a) => a.category === 'zfs' && a.severity !== 'info');
      $('healthDiskSection').open = h.alerts.some((a) => a.category === 'disk' && a.severity !== 'info');
      $('healthBackupSection').open = h.alerts.some((a) => a.category === 'backup' && a.severity !== 'info');
      $('healthClusterSection').open = h.alerts.some((a) => a.category === 'cluster' || a.category === 'ha');
    }
  }

  $('healthEmpty').hidden = attentionTotal.length > 0 || infosTotal.length > 0;

  const taskNote = $('healthTaskNote');
  taskNote.hidden = !healthTaskCache.error;
}

function healthGuestModes() {
  return (state.config && state.config.health && state.config.health.guestModes) || {};
}

/* task Health: fetch on-demand (solo vista Monitoraggio, TTL 60s, mai in background) */
async function maybeFetchHealthTasks() {
  if (currentView !== 'health') return;
  if (document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (healthTaskCache.fetching) return;
  if (healthTaskCache.data && now - healthTaskCache.fetchedAt < HEALTH_TASK_TTL_MS) return;
  healthTaskCache.fetching = true;
  try {
    const sec = Math.floor(now / 1000);
    const res = await fetch('/api/logs/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: sec - HEALTH_TASK_WINDOW_S, until: sec, limit: 200 })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    healthTaskCache.data = data.events || [];
    healthTaskCache.fetchedAt = Date.now();
    healthTaskCache.error = false;
    refreshHealthFromTasks();
  } catch (e) {
    /* fonte secondaria: un errore NON rende inutilizzabile il Health Center */
    healthTaskCache.error = true;
  } finally {
    healthTaskCache.fetching = false;
  }
}

/* ricalcola Health con la NUOVA sorgente task (seconda valutazione ammessa:
   non è una duplicazione nello stesso status tick). */
function refreshHealthFromTasks() {
  state.health = evaluateHealth(state.status, healthGuestModes(), healthTaskCache.data || [], healthExtrasPayload(), healthSettings());
  if (currentView === 'health') renderHealth();
}

/* ricalcola Health quando arriva una fonte on-demand V2 (storage/zfs/cluster/backup):
   seconda valutazione ammessa, mai una duplicazione nello stesso status tick. */
function refreshHealthFromExtras() {
  state.health = evaluateHealth(state.status, healthGuestModes(), healthTaskCache.data || [], healthExtrasPayload(), healthSettings());
  if (currentView === 'health') renderHealth();
}

/* ---------- fonti on-demand Health V2: fetch solo a vista aperta, TTL ----------
   NESSUN timer globale: il re-check avviene nel normale ciclo di renderHealth
   (richiamato a ogni refresh dello status quando la vista è aperta). */

const HEALTH_SOURCE_TTL = { storage: 60000, cluster: 60000, zfs: 120000, backups: 60000, disks: 300000 };

const healthSourceCache = {
  storage: { at: 0, data: null, errors: [], fetching: false },
  cluster: { at: 0, data: null, errors: [], fetching: false },
  zfs: { at: 0, data: null, errors: [], fetching: false },
  backups: { at: 0, data: null, errors: [], fetching: false },
  disks: { at: 0, data: null, errors: [], fetching: false },
  /* letture SMART per disco: chiave "serverId:node:devpath".
     MAI auto-refetch allo scadere del TTL: solo nuova interazione utente. */
  smart: new Map(),
};

function healthExtrasPayload() {
  return {
    storages: healthSourceCache.storage.data || [],
    pools: healthSourceCache.zfs.data || [],
    clusters: healthSourceCache.cluster.data || [],
    backups: healthSourceCache.backups.data || [],
    disks: healthSourceCache.disks.data || [],
    smart: Array.from(healthSourceCache.smart.entries()).map(([key, entry]) => {
      const parts = key.split(':');
      return {
        serverId: parts[0],
        node: parts[1],
        devpath: parts.slice(2).join(':'),
        reading: entry.data,
      };
    }),
  };
}

async function maybeFetchHealthSources() {
  if (currentView !== 'health') return;
  if (document.visibilityState === 'hidden') return;
  const now = Date.now();
  const tasks = [];
  for (const key of Object.keys(HEALTH_SOURCE_TTL)) {
    const c = healthSourceCache[key];
    if (!c.fetching && now - c.at >= HEALTH_SOURCE_TTL[key]) {
      if (key === 'storage') tasks.push(fetchHealthStorage());
      else if (key === 'cluster') tasks.push(fetchHealthCluster());
      else if (key === 'zfs') tasks.push(fetchHealthZfs());
      else if (key === 'backups') tasks.push(fetchHealthBackups());
      else tasks.push(fetchHealthDisks());
    }
  }
  if (tasks.length) await Promise.all(tasks);
}

async function fetchHealthDisks() {
  const c = healthSourceCache.disks;
  if (c.fetching) return;
  c.fetching = true;
  try {
    const d = await backupFetch('/api/health/disks');
    c.data = d.disks || [];
    c.errors = d.errors || [];
    c.at = Date.now();
  } catch (e) {
    c.errors = [{ error: e.message }];
    c.data = c.data || [];
    c.at = Date.now();
  } finally {
    c.fetching = false;
    refreshHealthFromExtras();
  }
}

/* ---------- SMART on-demand: coda FIFO, concorrenza massima 1 ---------- */

const smartQueue = [];
let smartBusy = false;

function smartEntry(key) {
  let entry = healthSourceCache.smart.get(key);
  if (!entry) {
    entry = { at: 0, data: null, error: null, fetching: false };
    healthSourceCache.smart.set(key, entry);
  }
  return entry;
}

function pumpSmartQueue() {
  if (smartBusy || smartQueue.length === 0) return;
  const job = smartQueue.shift();
  smartBusy = true;
  const entry = smartEntry(job.key);
  entry.fetching = true;
  (async () => {
    try {
      const d = await backupFetch('/api/health/smart?serverId=' + encodeURIComponent(job.serverId) +
        '&node=' + encodeURIComponent(job.node) + '&disk=' + encodeURIComponent(job.devpath));
      entry.data = d.smart || null;
      entry.error = entry.data && entry.data.smartAvailable === false ? 'SMART non disponibile' : null;
      entry.at = Date.now();
    } catch (e) {
      entry.error = e.message;
      entry.at = Date.now();
    } finally {
      entry.fetching = false;
      smartBusy = false;
      refreshHealthFromExtras();
      pumpSmartQueue();
    }
  })();
}

/* richiesta SMART per un disco: cache fresca -> nessuna chiamata; dato stale
   -> nuova lettura SOLO su interazione utente (mai automatica). */
function requestSmart(serverId, node, devpath) {
  const key = serverId + ':' + node + ':' + devpath;
  const entry = smartEntry(key);
  const now = Date.now();
  if (entry.data && now - entry.at < SMART_TTL_MS) return; /* fresca */
  if (entry.fetching) return; /* già in coda/in volo */
  smartQueue.push({ key, serverId, node, devpath });
  pumpSmartQueue();
}

async function fetchHealthStorage() {
  const c = healthSourceCache.storage;
  if (c.fetching) return;
  c.fetching = true;
  try {
    const d = await backupFetch('/api/health/storage');
    c.data = d.storages || [];
    c.errors = d.errors || [];
    c.at = Date.now();
  } catch (e) {
    c.errors = [{ error: e.message }];
    c.data = c.data || [];
    c.at = Date.now();
  } finally {
    c.fetching = false;
    refreshHealthFromExtras();
  }
}

async function fetchHealthCluster() {
  const c = healthSourceCache.cluster;
  if (c.fetching) return;
  c.fetching = true;
  try {
    const d = await backupFetch('/api/health/cluster');
    c.data = d.servers || [];
    c.errors = d.errors || [];
    c.at = Date.now();
  } catch (e) {
    c.errors = [{ error: e.message }];
    c.data = c.data || [];
    c.at = Date.now();
  } finally {
    c.fetching = false;
    refreshHealthFromExtras();
  }
}

async function fetchHealthZfs() {
  const c = healthSourceCache.zfs;
  if (c.fetching) return;
  c.fetching = true;
  try {
    const d = await backupFetch('/api/health/zfs');
    c.data = d.pools || [];
    c.errors = d.errors || [];
    c.at = Date.now();
  } catch (e) {
    c.errors = [{ error: e.message }];
    c.data = c.data || [];
    c.at = Date.now();
  } finally {
    c.fetching = false;
    refreshHealthFromExtras();
  }
}

/* backup health: riusa backupCache di Backup & Snapshot quando fresca (TTL 60s);
   altrimenti fetch on-demand di archivi + job per server. */
async function fetchHealthBackups() {
  const c = healthSourceCache.backups;
  if (c.fetching) return;
  c.fetching = true;
  const now = Date.now();
  const { targets, errors } = backupServerTargets();
  const results = [];
  const partial = [...errors];
  try {
    await Promise.all(targets.map(async (srv) => {
      const sid = encodeURIComponent(srv.id);
      const entry = { serverId: srv.id, serverName: srv.name, backups: [], jobs: [] };
      const bc = backupCache.backups.get(srv.id);
      if (bc && now - bc.at < HEALTH_SOURCE_TTL.backups) {
        entry.backups = bc.data || [];
      } else {
        try {
          const d = await backupFetch('/api/backup/list?serverId=' + sid);
          backupCache.backups.set(srv.id, { at: Date.now(), data: d.backups || [], error: null });
          entry.backups = d.backups || [];
        } catch (e) {
          partial.push({ serverId: srv.id, serverName: srv.name, error: e.message });
        }
      }
      const jc = backupCache.jobs.get(srv.id);
      if (jc && now - jc.at < HEALTH_SOURCE_TTL.backups) {
        entry.jobs = jc.data || [];
      } else {
        try {
          const d = await backupFetch('/api/backup/jobs?serverId=' + sid);
          backupCache.jobs.set(srv.id, { at: Date.now(), data: d.jobs || [], error: null });
          entry.jobs = d.jobs || [];
        } catch (e) {
          partial.push({ serverId: srv.id, serverName: srv.name, error: e.message });
        }
      }
      results.push(entry);
    }));
    c.data = results;
    c.errors = partial;
    c.at = Date.now();
  } catch (e) {
    c.errors = [...partial, { error: e.message }];
    c.data = c.data || [];
    c.at = Date.now();
  } finally {
    c.fetching = false;
    refreshHealthFromExtras();
  }
}

/* azioni alert: riusano ESATTAMENTE i meccanismi esistenti */
$('healthSection').addEventListener('click', (e) => {
  const guestBtn = e.target.closest('[data-health-open-guest]');
  if (guestBtn) {
    const parts = guestBtn.dataset.healthOpenGuest.split(':');
    openGuestDetail(parts[0], parts[1], parts[2], Number(parts[3]));
    return;
  }
  const taskBtn = e.target.closest('[data-health-open-task]');
  if (taskBtn) {
    const upid = taskBtn.dataset.taskUpid;
    const serverId = taskBtn.dataset.taskServer;
    const node = taskBtn.dataset.taskNode || null;
    switchView('logs');
    setLogTab('tasks', false);
    /* attesa one-shot del caricamento della tab (non è un polling) */
    setTimeout(() => showLogDetail(upid, serverId, node), 900);
    return;
  }
  const backupBtn = e.target.closest('[data-health-open-backup]');
  if (backupBtn) {
    backupFocusGuest = backupBtn.dataset.backupVmid
      ? { serverId: backupBtn.dataset.backupServer, vmid: Number(backupBtn.dataset.backupVmid), type: backupBtn.dataset.backupType || null }
      : null;
    switchView('backup');
    return;
  }
});

/* expected state guest: salvataggio su /api/health/prefs (già esistente) */
$('guestHealthMode').addEventListener('change', async (e) => {
  const select = e.target;
  if (!detailState.key || select.disabled) return;
  /* valore precedente = modalità salvata (la select è già sul nuovo valore) */
  const prevMode = healthGuestModes()[detailState.key];
  const prev = prevMode === 'alwayson' || prevMode === 'ignore' ? prevMode : 'manual';
  select.disabled = true;
  try {
    const res = await fetch('/api/health/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: detailState.key, mode: select.value })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    const modes = healthGuestModes();
    if (select.value === 'manual') delete modes[detailState.key];
    else modes[detailState.key] = select.value;
    /* refresh immediato senza attendere il prossimo polling */
    refreshHealthFromTasks();
  } catch (err) {
    select.value = prev;
    toast(err.message, 'err');
  } finally {
    select.disabled = false;
  }
});

/* ---------- Health V2: filtri (solo client-side) e soglie configurabili ---------- */

$('healthSeverityFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('.health-filter-btn');
  if (!btn) return;
  healthFilters.severity = btn.dataset.sev;
  document.querySelectorAll('#healthSeverityFilter .health-filter-btn').forEach((b) => {
    b.classList.toggle('active', b === btn);
    b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
  });
  if (currentView === 'health') renderHealth();
});

$('healthServerFilter').addEventListener('change', () => {
  healthFilters.server = $('healthServerFilter').value;
  if (currentView === 'health') renderHealth();
});

/* espansione disco: fetch SMART on-demand (coda, concorrenza max 1).
   Il toggle NATIVO è disabilitato con preventDefault: lo stato aperto/chiuso
   è interamente controllato dal render (evita le raffiche di eventi toggle
   generate dalla sostituzione del DOM a ogni refresh). */
$('healthDiskList').addEventListener('click', (e) => {
  const det = e.target && e.target.closest ? e.target.closest('details.health-disk') : null;
  const sum = e.target && e.target.closest ? e.target.closest('details.health-disk > summary.health-disk-summary') : null;
  if (!det || !sum) return;
  e.preventDefault();
  const key = det.dataset.diskKey;
  if (!key) return;
  if (healthDiskOpen.has(key)) {
    healthDiskOpen.delete(key);
  } else {
    healthDiskOpen.add(key);
    const parts = key.split(':');
    requestSmart(parts[0], parts[1], parts.slice(2).join(':'));
  }
  if (currentView === 'health') renderHealth();
}, true);

/* accessibilità tastiera: Enter/Spazio sul summary (l'attivazione nativa
   del summary non emette click in tutti i browser) */
$('healthDiskList').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const sum = e.target && e.target.closest ? e.target.closest('details.health-disk > summary.health-disk-summary') : null;
  if (!sum) return;
  const det = sum.parentElement;
  if (!det) return;
  e.preventDefault();
  const key = det.dataset.diskKey;
  if (!key) return;
  if (healthDiskOpen.has(key)) {
    healthDiskOpen.delete(key);
  } else {
    healthDiskOpen.add(key);
    const parts = key.split(':');
    requestSmart(parts[0], parts[1], parts.slice(2).join(':'));
  }
  if (currentView === 'health') renderHealth();
}, true);

function healthSettingsInputs() {
  return {
    storageWarning: $('hsStorageWarning'),
    storageCritical: $('hsStorageCritical'),
    backupWarning: $('hsBackupWarning'),
    backupCritical: $('hsBackupCritical'),
    swapWarning: $('hsSwapWarning'),
    swapCritical: $('hsSwapCritical'),
    diskTempWarning: $('hsDiskTempWarning'),
    diskTempCritical: $('hsDiskTempCritical'),
    diskWearWarning: $('hsDiskWearWarning'),
  };
}

function updateHealthSettingsUI() {
  const s = state.config && state.config.health && state.config.health.settings;
  const inp = healthSettingsInputs();
  const d = HEALTH_SETTING_DEFAULTS;
  inp.storageWarning.value = (s && s.storage && Number.isFinite(Number(s.storage.warning))) ? s.storage.warning : d.storage.warning;
  inp.storageCritical.value = (s && s.storage && Number.isFinite(Number(s.storage.critical))) ? s.storage.critical : d.storage.critical;
  inp.backupWarning.value = (s && s.backupAge && Number.isFinite(Number(s.backupAge.warningDays))) ? s.backupAge.warningDays : d.backupAge.warningDays;
  inp.backupCritical.value = (s && s.backupAge && Number.isFinite(Number(s.backupAge.criticalDays))) ? s.backupAge.criticalDays : d.backupAge.criticalDays;
  inp.swapWarning.value = (s && s.swap && Number.isFinite(Number(s.swap.warning))) ? s.swap.warning : d.swap.warning;
  inp.swapCritical.value = (s && s.swap && Number.isFinite(Number(s.swap.critical))) ? s.swap.critical : d.swap.critical;
  inp.diskTempWarning.value = (s && s.disk && s.disk.temp && Number.isFinite(Number(s.disk.temp.warning))) ? s.disk.temp.warning : d.disk.temp.warning;
  inp.diskTempCritical.value = (s && s.disk && s.disk.temp && Number.isFinite(Number(s.disk.temp.critical))) ? s.disk.temp.critical : d.disk.temp.critical;
  inp.diskWearWarning.value = (s && s.disk && s.disk.wear && Number.isFinite(Number(s.disk.wear.warning))) ? s.disk.wear.warning : d.disk.wear.warning;
}

$('btnHealthSave').onclick = async () => {
  const inp = healthSettingsInputs();
  const body = {
    storage: { warning: Number(inp.storageWarning.value), critical: Number(inp.storageCritical.value) },
    backupAge: { warningDays: Number(inp.backupWarning.value), criticalDays: Number(inp.backupCritical.value) },
    swap: { warning: Number(inp.swapWarning.value), critical: Number(inp.swapCritical.value) },
    disk: {
      temp: { warning: Number(inp.diskTempWarning.value), critical: Number(inp.diskTempCritical.value) },
      wear: { warning: Number(inp.diskWearWarning.value) },
    },
  };
  const hsError = $('hsError');
  hsError.hidden = true;
  try {
    const res = await fetch('/api/health/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    if (!state.config.health || typeof state.config.health !== 'object') state.config.health = {};
    state.config.health.settings = data.settings;
    updateHealthSettingsUI();
    refreshHealthFromExtras();
    toast(t('health.settings.saved'), 'ok');
  } catch (err) {
    hsError.textContent = err.message;
    hsError.hidden = false;
    toast(err.message, 'err');
  }
};

$('btnHealthReset').onclick = async () => {
  const hsError = $('hsError');
  hsError.hidden = true;
  try {
    const res = await fetch('/api/health/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Errore');
    if (!state.config.health || typeof state.config.health !== 'object') state.config.health = {};
    state.config.health.settings = data.settings;
    updateHealthSettingsUI();
    refreshHealthFromExtras();
    toast(t('health.settings.resetDone'), 'ok');
  } catch (err) {
    hsError.textContent = err.message;
    hsError.hidden = false;
    toast(err.message, 'err');
  }
};

/* registrazione service worker (solo in secure context) */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            /* toast con azione: l'utente decide quando ricaricare.
               MAI reload automatico (la Shell LXC o un'operazione in corso
               non devono essere interrotte). */
            const el = document.createElement('div');
            el.className = 'toast info';
            el.innerHTML = '<span class="t-icon">💡</span><span>' + esc(t('pwa.update')) + '</span>' +
              '<button class="ghost-btn" style="margin-left:6px;padding:6px 12px;font-size:12px">' + esc(t('refresh')) + '</button>';
            el.querySelector('button').onclick = () => location.reload();
            $('toasts').appendChild(el);
            setTimeout(() => {
              el.classList.add('out');
              setTimeout(() => el.remove(), 400);
            }, 8000);
          }
        });
      });
    }).catch(() => { /* ignora */ });
  });
}

/* stato offline: mostra un banner chiaro invece di dati vecchi */
window.addEventListener('offline', () => {
  $('connChip').className = 'status-chip offline';
  $('connText').textContent = t('conn.offline');
  toast(t('pwa.offline'), 'err');
});

window.addEventListener('online', () => {
  toast(t('pwa.online'), 'ok');
  refresh();
});
