'use strict';

/* Launcher minimale della Console VNC QEMU.
   La console vive in una finestra dedicata same-origin (vnc-window.html):
   qui si costruisce SOLO l'URL con identificatori non sensibili e si apre
   la finestra in modo SINCRONO nel gesto utente (niente await/fetch prima
   di window.open, per non innescare il popup blocker).
   prep, credenziali e RFB sono gestiti esclusivamente da vnc-window.js. */
(function () {
  function sanitizeWindowName(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  }

  function open(key) {
    const parts = String(key || '').split(':');
    const [serverId, node, type, vmid] = parts;
    if (type !== 'qemu' || !serverId || !node || !vmid) return;
    const guest = findGuest(serverId, node, type, vmid);
    if (!guest || guest.status !== 'running') {
      toast(t('vnc.needStart'), 'err');
      return;
    }
    const url = '/vnc-window.html?serverId=' + encodeURIComponent(serverId) +
      '&node=' + encodeURIComponent(node) + '&vmid=' + encodeURIComponent(vmid);
    const winName = 'nodepilot-vnc-' + sanitizeWindowName(serverId) + '-' +
      sanitizeWindowName(node) + '-' + vmid;
    const win = window.open(url, winName, 'width=1280,height=800,resizable=yes,scrollbars=no');
    if (!win) {
      toast(t('vnc.popupBlocked'), 'err');
    }
  }

  /* API compatibile con app.js: close() e' un no-op sicuro (la finestra
     dedicata ha il proprio ciclo di vita; non esiste piu' una modale da chiudere) */
  window.VNCConsole = {
    open: open,
    close: function () {},
    isOpen: function () { return false; },
  };
})();
