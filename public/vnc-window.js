'use strict';

/* Console VNC dedicata per VM QEMU (noVNC 1.7.0 vendorizzato in public/vendor/novnc).
   Pagina standalone same-origin: sessione dashboard verificata, poi prepId
   single-use creato QUI (mai passato dalla dashboard), poi WS relay.
   prepId e credenziali RFB vivono SOLO in memoria JS e vengono azzerati
   al cleanup; mai localStorage/sessionStorage/cookie/DOM/dataset/log/URL. */
(function () {
  const $ = (id) => document.getElementById(id);

  /* i18n minimale: riusa il dizionario I18N di i18n.js e la preferenza
     lingua salvata dalla dashboard (hl_prefs). t() di app.js non e'
     disponibile qui: la pagina dedicata non carica la dashboard. */
  function t(key, vars) {
    let lang = 'it';
    try {
      lang = (JSON.parse(localStorage.getItem('hl_prefs') || '{}').language) || 'it';
    } catch (_) { /* preferenza assente o corrotta: italiano */ }
    let str = (I18N[lang] && I18N[lang][key]) || I18N.it[key] || key;
    if (vars) {
      for (const k of Object.keys(vars)) {
        str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k]));
      }
    }
    return str;
  }

  let RFBClass = null;
  let rfbLoad = null;
  let rfb = null;
  let vncConnected = false;
  let vncPrepId = null;
  let vncCredentials = null;
  let vncParams = null; /* { serverId, node, vmid } validati dall'URL */
  let vncGuestName = null;

  function setStatus(msg, cls) {
    const box = $('vncStatus');
    if (!box) return;
    box.textContent = msg;
    box.className = 'status' + (cls ? ' ' + cls : '');
  }

  function setTitle() {
    const title = $('vncTitle');
    if (!title) return;
    title.textContent = vncGuestName ? vncGuestName + ' · QEMU ' + vncParams.vmid : 'QEMU ' + vncParams.vmid;
    document.title = title.textContent + ' · NodePilot';
  }

  /* mappa i codici backend verso messaggi i18n controllati (mai stringhe PVE grezze) */
  function prepError(code, status) {
    if (code === 'VNC_FORBIDDEN' || status === 401) return t('vnc.noPerms');
    if (code === 'GUEST_NOT_FOUND' || code === 'CONSOLE_UNAVAILABLE') return t('vnc.unavailable');
    if (code === 'PROXMOX_UNAVAILABLE') return t('vnc.proxmoxDown');
    if (code === 'VNC_PREP_EXPIRED') return t('vnc.expired');
    return t('vnc.failed');
  }

  function parseParams() {
    const q = new URLSearchParams(location.search);
    const serverId = (q.get('serverId') || '').trim();
    const node = (q.get('node') || '').trim();
    const vmid = Number(q.get('vmid'));
    if (!serverId || !node || !Number.isInteger(vmid) || vmid < 1) return null;
    return { serverId, node, vmid };
  }

  async function fetchGuestName() {
    /* leggero: riusa /api/guest/detail gia' esistente per il nome nel titolo */
    try {
      const res = await fetch('/api/guest/detail?serverId=' + encodeURIComponent(vncParams.serverId) +
        '&node=' + encodeURIComponent(vncParams.node) + '&type=qemu&vmid=' + vncParams.vmid);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.ok && data.status && data.status.name) {
        vncGuestName = String(data.status.name);
        setTitle();
      }
    } catch (_) { /* titolo resta QEMU <vmid> */ }
  }

  async function open() {
    if (rfb) closeRfb();
    vncConnected = false;
    setStatus(t('vnc.connecting'), 'connecting');
    try {
      /* Fase 1: nuovo vncproxy PVE + prepId opaco, creato DA QUESTA pagina */
      const res = await fetch('/api/vnc/prep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: vncParams.serverId, node: vncParams.node, vmid: vncParams.vmid }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.prepId || !data.credentials) {
        setStatus(prepError(data && data.code, res.status), 'err');
        return;
      }
      vncPrepId = data.prepId;
      vncCredentials = {
        username: String(data.credentials.username || ''),
        password: String(data.credentials.password || ''),
      };
      if (!rfbLoad) rfbLoad = import('/vendor/novnc/core/rfb.js');
      const mod = await rfbLoad;
      RFBClass = mod.default;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + location.host + '/api/vnc/ws?prepId=' + encodeURIComponent(vncPrepId);
      const container = $('vncContainer');
      container.innerHTML = '';
      rfb = new RFBClass(container, wsUrl, {
        credentials: { username: vncCredentials.username, password: vncCredentials.password },
      });
      rfb.scaleViewport = true;
      /* resize remoto disabilitato: le VM QEMU testate (virtio-gpu e std-vga)
         rifiutano SetDesktopSize; scaleViewport copre il ridimensionamento locale
         ed evita i warning "Server did not accept the resize request". */
      rfb.resizeSession = false;
      /* qualita' e compressione ottimizzate per LAN: meno banda e meno lavoro encoder
         sui rect Tight/JPEG, senza degrado visibile su testo e icone (misurato). */
      rfb.qualityLevel = 4;
      rfb.compressionLevel = 1;
      rfb.addEventListener('connect', () => {
        vncConnected = true;
        setStatus(t('vnc.connected'), 'ok');
      });
      rfb.addEventListener('disconnect', () => {
        vncConnected = false;
        setStatus(t('vnc.disconnected'), 'err');
      });
      rfb.addEventListener('credentialsrequired', () => {
        /* non atteso con credenziali preconfigurate; se PVE le richiede le reinvia */
        if (rfb && vncCredentials) {
          try { rfb.sendCredentials({ username: vncCredentials.username, password: vncCredentials.password }); } catch (_) { /* ignora */ }
        }
      });
      rfb.addEventListener('securityfailure', () => {
        setStatus(t('vnc.failed'), 'err');
      });
    } catch (e) {
      console.error('[vnc] apertura fallita:', e.message);
      setStatus(t('vnc.failed'), 'err');
    }
  }

  function closeRfb() {
    if (rfb) {
      if (vncConnected) {
        try { rfb.disconnect(); } catch (_) { /* ignora */ }
      }
      rfb = null;
    }
    vncConnected = false;
    vncCredentials = null;
    vncPrepId = null;
    const container = $('vncContainer');
    if (container) container.innerHTML = '';
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  function init() {
    vncParams = parseParams();
    if (!vncParams) {
      setStatus(t('vnc.invalidParams'), 'err');
      return;
    }
    $('vncVmid').textContent = String(vncParams.vmid);
    setTitle();
    setStatus(t('vnc.checking'), 'connecting');

    /* sessione dashboard: senza sessione valida nessun prep/WS */
    fetch('/api/auth/session')
      .then((res) => res.json())
      .then((data) => {
        if (!data || data.authenticated !== true) {
          setStatus(t('vnc.sessionExpired'), 'err');
          return;
        }
        fetchGuestName();
        /* layout stabile prima di creare RFB: nessuna animazione/transform
           sul container, un solo rAF per geometria definitiva */
        requestAnimationFrame(() => requestAnimationFrame(() => open()));
      })
      .catch(() => {
        setStatus(t('vnc.sessionExpired'), 'err');
      });
  }

  (function initControls() {
    const rec = $('btnReconnect');
    if (rec) rec.onclick = () => { if (vncParams) open(); };
    const fs = $('btnFullscreen');
    if (fs) fs.onclick = toggleFullscreen;
    const close = $('btnClose');
    if (close) close.onclick = () => window.close();
  })();

  /* chiusura finestra/tab: disconnect RFB, il WS browser si chiude e il
     backend chiude l'upstream PVE; nessuna chiamata mutativa sincrona */
  window.addEventListener('pagehide', () => {
    if (rfb) {
      try { rfb.disconnect(); } catch (_) { /* ignora */ }
      rfb = null;
    }
    vncConnected = false;
    vncCredentials = null;
    vncPrepId = null;
  });

  init();
})();
