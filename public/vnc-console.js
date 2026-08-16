'use strict';

/* Console VNC per VM QEMU (noVNC 1.7.0 vendorizzato in public/vendor/novnc).
   Script classico: il modulo RFB viene caricato on-demand con import() dinamico,
   quindi niente bundler, niente dipendenze npm, CSP invariata.
   prepId e credenziali RFB vivono SOLO in memoria JS e vengono azzerati al close;
   mai localStorage/sessionStorage/cookie/DOM/dataset/log/URL. */
(function () {
  let RFBClass = null;
  let rfbLoad = null;
  let rfb = null;
  let vncOpen = false;
  let vncConnected = false; /* evita disconnect() su RFB gia' disconnesso */
  let vncKey = null;         /* serverId:node:qemu:vmid (per il Reconnect) */
  let vncGuest = null;       /* { key, serverId, node, vmid, name } */
  let vncPrepId = null;      /* token opaco single-use */
  let vncCredentials = null; /* { username, password } temporanee */

  function setStatus(msg, cls, showReconnect) {
    const box = $('vncStatus');
    if (!box) return;
    $('vncStatusText').textContent = msg;
    box.className = 'vnc-status' + (cls ? ' ' + cls : '');
    $('btnVncReconnect').hidden = !showReconnect;
  }

  /* mappa i codici backend verso messaggi i18n controllati (mai stringhe PVE grezze) */
  function prepError(code, status) {
    if (code === 'VNC_FORBIDDEN' || status === 401) return t('vnc.noPerms');
    if (code === 'GUEST_NOT_FOUND' || code === 'CONSOLE_UNAVAILABLE') return t('vnc.unavailable');
    if (code === 'PROXMOX_UNAVAILABLE') return t('vnc.proxmoxDown');
    if (code === 'VNC_PREP_EXPIRED') return t('vnc.expired');
    return t('vnc.failed');
  }

  async function open(key) {
    if (vncOpen) close();
    const [serverId, node, type, vmid] = key.split(':');
    if (type !== 'qemu') return;
    const guest = findGuest(serverId, node, type, vmid);
    if (!guest || guest.status !== 'running') {
      toast(t('vnc.needStart'), 'err');
      return;
    }
    vncKey = key;
    vncGuest = { key, serverId, node, vmid, name: guest.name };
    vncOpen = true;
    vncConnected = false;
    $('vncTitle').textContent = 'Monitor ' + guest.name + ' · QEMU ' + vmid;
    $('btnVncFullscreen').title = t('vnc.fullscreen');
    $('vncModal').querySelector('[data-close]').title = t('vnc.close');
    setStatus(t('vnc.connecting'), '', false);
    $('vncModal').hidden = false;
    try {
      /* Fase 1: nuovo vncproxy PVE + prepId opaco (mai riciclati al Reconnect) */
      const res = await fetch('/api/vnc/prep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: serverId, node: node, vmid: Number(vmid) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || !data.prepId || !data.credentials) {
        setStatus(prepError(data && data.code, res.status), 'err', true);
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
      const screen = $('vncScreen');
      screen.innerHTML = '';
      rfb = new RFBClass(screen, wsUrl, {
        credentials: { username: vncCredentials.username, password: vncCredentials.password },
      });
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.addEventListener('connect', () => {
        vncConnected = true;
        setStatus(t('vnc.connected'), 'ok', false);
      });
      rfb.addEventListener('disconnect', (e) => {
        vncConnected = false;
        if (!vncOpen) return; /* chiusura volontaria: non sovrascrivere lo stato */
        setStatus(t('vnc.disconnected'), 'err', true);
      });
      rfb.addEventListener('credentialsrequired', () => {
        /* non atteso con credenziali preconfigurate; se PVE le richiede le reinvia */
        if (rfb && vncCredentials) {
          try { rfb.sendCredentials({ username: vncCredentials.username, password: vncCredentials.password }); } catch (_) { /* ignora */ }
        }
      });
      rfb.addEventListener('securityfailure', () => {
        if (!vncOpen) return;
        setStatus(t('vnc.failed'), 'err', true);
      });
    } catch (e) {
      console.error('[vnc] apertura fallita:', e.message);
      setStatus(t('vnc.failed'), 'err', true);
    }
  }

  /* UNICO punto di cleanup centralizzato: idempotente, azzera anche i segreti */
  function close() {
    if (rfb) {
      if (vncConnected) {
        try { rfb.disconnect(); } catch (_) { /* ignora */ }
      }
      rfb = null;
    }
    vncConnected = false;
    vncCredentials = null;
    vncPrepId = null;
    vncGuest = null;
    vncKey = null;
    vncOpen = false;
    const modal = $('vncModal');
    if (modal) {
      const win = modal.querySelector('.vnc-modal');
      if (win) win.classList.remove('vnc-fullscreen');
      modal.hidden = true;
    }
    const screen = $('vncScreen');
    if (screen) screen.innerHTML = '';
    const box = $('vncStatus');
    if (box) box.className = 'vnc-status';
    const rec = $('btnVncReconnect');
    if (rec) rec.hidden = true;
  }

  function toggleFullscreen() {
    const modal = $('vncModal');
    if (!modal) return;
    const win = modal.querySelector('.vnc-modal');
    if (!win) return;
    win.classList.toggle('vnc-fullscreen');
    /* il ResizeObserver interno di noVNC rifitta il viewport sul nuovo box */
  }

  function isOpen() {
    return vncOpen;
  }

  /* wiring dei controlli della modale (ciclo di vita self-contained) */
  (function initControls() {
    const modal = $('vncModal');
    if (!modal) return;
    const closeBtn = modal.querySelector('[data-close]');
    if (closeBtn) closeBtn.onclick = close;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    const fs = $('btnVncFullscreen');
    if (fs) fs.onclick = toggleFullscreen;
    const rec = $('btnVncReconnect');
    if (rec) rec.onclick = () => {
      /* Reconnect = SEMPRE nuovo prep/new credentials/new WS */
      const k = vncKey;
      if (k) open(k);
    };
  })();

  window.VNCConsole = { open: open, close: close, toggleFullscreen: toggleFullscreen, isOpen: isOpen };
})();
