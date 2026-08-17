'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const notificationsMod = require('./notifications.js');
const alertEngineMod = require('./alert-engine.js');
const telegramMod = require('./telegram.js');

const PORT = Number(process.env.PORT || 3100);
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

let config = { servers: [], refreshMs: 10000, autoRefreshEnabled: true, theme: 'system', language: 'it', health: { guestModes: {} }, notifications: { center: { enabled: true }, telegram: { enabled: false, botToken: '', chatId: '', language: 'it', events: { critical: true, warning: true, success: true, info: false, recovery: true } } } };
let state = { tourCompleted: false, tourCompletedVersion: 0 };
let statusCache = null;
let statusCacheAt = 0;

/* ---------------- VNC console (noVNC, VM QEMU) ---------------- */

const VNC_PREP_TTL_MS = 60 * 1000;
/* prepId opaco (crypto.randomBytes) -> dati vncproxy PVE. Solo in memoria,
   mai persistito; single-use con TTL. ticket/port non lasciano il backend. */
const vncPreps = new Map();
/* tracking sessioni WebSocket attive (VNC e Shell) per graceful shutdown */
const activeWsRelays = new Set();

/* ---------------- config ---------------- */

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = { ...config, ...c };
      if (!Array.isArray(config.servers)) config.servers = [];
    }
  } catch (e) {
    console.error('Errore lettura config.json:', e.message);
  }
}

function saveConfig() {
  const clean = {
    ...config,
    servers: config.servers.map((s) => {
      const { _session, ...rest } = s;
      return rest;
    }),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2));
}

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('Errore lettura state.json:', e.message);
  }
}

function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/* Metadati applicazione (badge versione): letti UNA volta da package.json.
   Fallback sicuro: se il file non è leggibile/parsabile il server continua
   ad avviarsi e il frontend nasconde il badge. MAI altri metadata. */
const APP_META = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return {
      name: 'NodePilot',
      version: typeof pkg.version === 'string' ? pkg.version : '',
    };
  } catch (_) {
    return { name: 'NodePilot', version: '' };
  }
})();

/* ---------------- authentication core (Fase 1: senza enforcement, arriva in F3) ---------------- */

const AUTH_PATH = path.join(__dirname, 'auth.json');
const SESSION_COOKIE = 'hl_session';
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;        /* idle sliding */
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; /* lifetime assoluto */
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILS = 5;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; /* N=32768, r=8 richiede ~32MiB + overhead */

let authConfig = { username: 'admin', passwordHash: null };
const sessions = new Map();      /* sessionId -> { username, createdAt, lastSeen } */
const loginFailures = new Map(); /* ip -> { count, resetAt } */
const passwordChangeFailures = new Map(); /* ip -> { count, resetAt } (dedicato al cambio password) */

function loadAuth() {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      const a = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
      authConfig = { ...authConfig, ...a };
    }
  } catch (e) {
    console.error('Errore lettura auth.json:', e.message);
  }
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
    return crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

/* sessione valida o null; scadenza sliding + assoluta; cleanup pigro (zero timer) */
function getSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  const now = Date.now();
  if (now - s.createdAt > SESSION_ABSOLUTE_MS || now - s.lastSeen > SESSION_IDLE_MS) {
    sessions.delete(sid);
    return null;
  }
  s.lastSeen = now;
  return s;
}

/* guard centralizzata per l'enforcement (F3): oggi usata dai soli endpoint auth */
function requireAuth(req) {
  return getSession(req);
}

/* IP solo dal socket (nessun trust di x-forwarded-for: nessun reverse proxy configurato) */
function clientIp(req) {
  const raw = req.socket.remoteAddress || '';
  return raw.replace(/^::ffff:/, '');
}

/* ---------------- security headers (Fase 2: hardening V1.1) ---------------- */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'sha256-t4Ytnyfe7eBYYZtUNH2sbDx72gFeXygp9krTP+beGRE='; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
};

function securityHeaders() {
  return Object.assign({}, SECURITY_HEADERS);
}

/* versione raw per le risposte scritte direttamente sul socket (handshake WebSocket) */
function rawSecurityHeaders() {
  return 'X-Content-Type-Options: nosniff\r\n' +
    'X-Frame-Options: SAMEORIGIN\r\n' +
    'Referrer-Policy: strict-origin-when-cross-origin\r\n' +
    'Content-Security-Policy: ' + SECURITY_HEADERS['Content-Security-Policy'] + '\r\n';
}

/* Origin validation: il chiamante passa Origin o (fallback) Referer.
   Confronto host:port con l'header Host; client senza entrambi gli header restano ammessi. */
function isSameOriginHeader(value, req) {
  try {
    const u = new URL(value);
    const host = String(req.headers.host || '').toLowerCase();
    return u.host.toLowerCase() === host;
  } catch (e) {
    return false;
  }
}

function cookieFlags(req) {
  let flags = 'HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_ABSOLUTE_MS / 1000);
  if (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') flags += '; Secure';
  return flags;
}

function setSessionCookie(res, req, sessionId) {
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + sessionId + '; ' + cookieFlags(req));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

/* log minimale: MAI password, hash, cookie o session id */
function authLog(msg) {
  console.log('[auth]', new Date().toISOString(), msg);
}

function rateLimitInfo(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (entry) loginFailures.delete(ip);
    return { allowed: true, remaining: RATE_MAX_FAILS, retryAfter: 0 };
  }
  if (entry.count >= RATE_MAX_FAILS) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: RATE_MAX_FAILS - entry.count, retryAfter: 0 };
}

function rateLimitHit(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    entry.count += 1;
    entry.resetAt = now + RATE_WINDOW_MS;
  }
}

/* rate limit dedicato al cambio password: separato da quello del login
   (stessa finestra e stesso massimo); conta SOLO la password attuale errata */
function changeRateLimitInfo(ip) {
  const now = Date.now();
  const entry = passwordChangeFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (entry) passwordChangeFailures.delete(ip);
    return { allowed: true, remaining: RATE_MAX_FAILS, retryAfter: 0 };
  }
  if (entry.count >= RATE_MAX_FAILS) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: RATE_MAX_FAILS - entry.count, retryAfter: 0 };
}

function changeRateLimitHit(ip) {
  const now = Date.now();
  const entry = passwordChangeFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    passwordChangeFailures.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    entry.count += 1;
    entry.resetAt = now + RATE_WINDOW_MS;
  }
}

/* ---------------- client Proxmox (login user/password, niente token API) ---------------- */

function apiRequest(server, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(server.url.replace(/\/+$/, '') + apiPath);
    } catch (e) {
      return reject(new Error('URL del server non valido'));
    }
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    let encodedBody = null;
    if (body) {
      encodedBody = new URLSearchParams(body).toString();
      headers['Content-Length'] = Buffer.byteLength(encodedBody);
    }
    if (server._session) {
      headers.Cookie = 'PVEAuthCookie=' + server._session.ticket;
      if (method !== 'GET') headers.CSRFPreventionToken = server._session.csrf;
    }
    const options = {
      method,
      headers,
      rejectUnauthorized: server.verifyTls !== false,
    };
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = { data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', (e) => {
      const code = e.code || '';
      let msg = e.message;
      if (code === 'ECONNREFUSED') msg = 'Connessione rifiutata: controlla IP e porta (es. https://IP:8006)';
      else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') msg = 'Host non trovato: controlla l\'indirizzo IP';
      else if (code === 'ETIMEDOUT') msg = 'Timeout: il server non risponde, controlla IP e porta';
      else if (code === 'EHOSTUNREACH') msg = 'Host non raggiungibile: controlla la rete';
      else if (!msg) msg = 'Errore di rete (' + (code || 'sconosciuto') + ')';
      const err = new Error(msg);
      err.code = code;
      reject(err);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Timeout di rete')));
    if (encodedBody) req.write(encodedBody);
    req.end();
  });
}

async function login(server) {
  const res = await apiRequest(server, 'POST', '/api2/json/access/ticket', {
    username: server.user,
    password: server.password,
  });
  if (res.status >= 400 || !res.body || !res.body.data || !res.body.data.ticket) {
    const raw = typeof res.body === 'object' && res.body.data !== undefined
      ? JSON.stringify(res.body).slice(0, 200)
      : String(res.body || '').slice(0, 200);
    const pveMsg = res.body && res.body.message;
    let detail;
    if (pveMsg) {
      detail = pveMsg;
    } else if (res.status === 200 && res.body && res.body.data === null) {
      detail = 'credenziali errate: utente o password non validi. Controlla il formato utente (es. root@pam o nome@pve) e che la 2FA non sia attiva';
    } else if (res.status === 401 || res.status === 403) {
      detail = 'autenticazione rifiutata (HTTP ' + res.status + ')';
    } else if (res.status >= 500) {
      detail = 'errore del server Proxmox (HTTP ' + res.status + ')';
    } else if (res.status === 404) {
      detail = 'API non trovata (HTTP 404): controlla che l\'URL includa la porta corretta (es. https://IP:8006)';
    } else if (res.status === 0 || !res.status) {
      detail = 'nessuna risposta dal server';
    } else {
      detail = 'risposta inattesa (HTTP ' + res.status + '): ' + raw;
    }
    throw new Error('Login fallito: ' + detail);
  }
  server._session = {
    ticket: res.body.data.ticket,
    csrf: res.body.data.CSRFPreventionToken,
    expiresAt: Date.now() + 2 * 60 * 60 * 1000,
  };
  return server._session;
}

async function api(server, method, apiPath, body) {
  if (!server._session || Date.now() > server._session.expiresAt) await login(server);
  let res = await apiRequest(server, method, apiPath, body);
  if (res.status === 401) {
    await login(server);
    res = await apiRequest(server, method, apiPath, body);
  }
  if (res.status >= 400) {
    const err = new Error((res.body && res.body.message) || ('Errore ' + res.status));
    err.pveStatus = res.status;
    throw err;
  }
  return res.body ? res.body.data : null;
}

/* ---------------- raccolta stato ---------------- */

/* ultimo campione di rete per ogni guest: { serverId:node:type:vmid -> { netin, netout, at } } */
const netSamples = new Map();

function pickGuest(st) {
  /* Health V2: PVE 9.2 rinomina free_mem in freemem; leggiamo entrambi per
     compatibilità con le versioni precedenti. Zero nuove chiamate PVE. */
  const freememRaw = st.freemem !== undefined && st.freemem !== null ? st.freemem : st.free_mem;
  return {
    status: st.status || 'unknown',
    cpu: st.cpu || 0,
    cpus: st.cpus || 1,
    mem: st.mem || 0,
    maxmem: st.maxmem || 0,
    /* metrica guest affidabile solo con QEMU Guest Agent; null se assente.
       Pass-through additivo: nessuna nuova chiamata PVE. */
    freemem: Number.isFinite(Number(freememRaw)) ? Number(freememRaw) : null,
    balloon: Number.isFinite(Number(st.balloon)) ? Number(st.balloon) : null,
    maxballoon: Number.isFinite(Number(st.maxballoon)) ? Number(st.maxballoon) : null,
    disk: st.disk || 0,
    maxdisk: st.maxdisk || 0,
    netin: st.netin || 0,
    netout: st.netout || 0,
    uptime: st.uptime || 0,
    /* Health V2: pass-through additivo dei soli campi già presenti nella
       risposta status/current (ha/qmpstatus/lock/agent). */
    ha: st.ha && typeof st.ha === 'object' ? { managed: pveFlag(st.ha.managed) } : null,
    qmpstatus: typeof st.qmpstatus === 'string' ? st.qmpstatus : null,
    lock: typeof st.lock === 'string' ? st.lock : null,
    agent: Number.isFinite(Number(st.agent)) ? Number(st.agent) : null,
  };
}

/* calcola la velocità di rete (byte/s) come differenza tra due campioni
   divisa per il tempo trascorso: i campi netin/netout di Proxmox sono
   contatori cumulativi di byte, NON velocità istantanee. */
function netRate(key, netin, netout, now) {
  const prev = netSamples.get(key);
  netSamples.set(key, { netin, netout, at: now });
  if (!prev || prev.at >= now) return { in: 0, out: 0 };
  const dt = (now - prev.at) / 1000;
  if (dt <= 0) return { in: 0, out: 0 };
  return {
    in: Math.max(0, (netin - prev.netin) / dt),
    out: Math.max(0, (netout - prev.netout) / dt),
  };
}

/* Health V2: loadavg PVE può essere array [1,5,15] o, su PVE 9.2, oggetto
   {"0","1","2"}. Normalizza in [n1,n5,n15] oppure null se non interpretabile. */
function normalizeLoadavg(v) {
  const nums = [];
  if (Array.isArray(v)) {
    for (const x of v) nums.push(Number(x));
  } else if (v && typeof v === 'object') {
    for (const k of ['0', '1', '2']) nums.push(Number(v[k]));
  }
  if (nums.length !== 3 || nums.some((x) => !Number.isFinite(x))) return null;
  return nums;
}

async function collectServer(server) {
  const nodes = await api(server, 'GET', '/api2/json/nodes');
  const out = { id: server.id, name: server.name, url: server.url, online: true, nodes: [] };
  for (const n of nodes) {
    const nodeName = encodeURIComponent(n.node);
    const [qemu, lxc, nodeStatus] = await Promise.all([
      api(server, 'GET', '/api2/json/nodes/' + nodeName + '/qemu'),
      api(server, 'GET', '/api2/json/nodes/' + nodeName + '/lxc'),
      api(server, 'GET', '/api2/json/nodes/' + nodeName + '/status'),
    ]);
    const vms = [];
    for (const vm of qemu || []) {
      try {
        const st = await api(server, 'GET', '/api2/json/nodes/' + nodeName + '/qemu/' + vm.vmid + '/status/current');
        if (process.env.DEBUG_PVE) {
          console.log('[pve-debug]', new Date().toISOString(), server.id, n.node, 'qemu', vm.vmid, 'ricevuto:', st.status, 'normalizzato:', pickGuest(st).status);
        }
        const g = pickGuest(st);
        const key = server.id + ':' + n.node + ':qemu:' + vm.vmid;
        const rate = netRate(key, g.netin, g.netout, Date.now());
        g.netin = rate.in;
        g.netout = rate.out;
        vms.push({ id: vm.vmid, name: vm.name || ('VM ' + vm.vmid), type: 'qemu', ...g });
      } catch (e) {
        if (process.env.DEBUG_PVE) {
          console.log('[pve-debug]', new Date().toISOString(), server.id, n.node, 'qemu', vm.vmid, 'ERRORE:', e.message);
        }
        vms.push({ id: vm.vmid, name: vm.name || ('VM ' + vm.vmid), type: 'qemu', status: 'error', error: e.message });
      }
    }
    const cts = [];
    for (const c of lxc || []) {
      try {
        const st = await api(server, 'GET', '/api2/json/nodes/' + nodeName + '/lxc/' + c.vmid + '/status/current');
        if (process.env.DEBUG_PVE) {
          console.log('[pve-debug]', new Date().toISOString(), server.id, n.node, 'lxc', c.vmid, 'ricevuto:', st.status, 'normalizzato:', pickGuest(st).status);
        }
        const g = pickGuest(st);
        const key = server.id + ':' + n.node + ':lxc:' + c.vmid;
        const rate = netRate(key, g.netin, g.netout, Date.now());
        g.netin = rate.in;
        g.netout = rate.out;
        cts.push({ id: c.vmid, name: c.name || ('CT ' + c.vmid), type: 'lxc', ...g });
      } catch (e) {
        if (process.env.DEBUG_PVE) {
          console.log('[pve-debug]', new Date().toISOString(), server.id, n.node, 'lxc', c.vmid, 'ERRORE:', e.message);
        }
        cts.push({ id: c.vmid, name: c.name || ('CT ' + c.vmid), type: 'lxc', status: 'error', error: e.message });
      }
    }
    out.nodes.push({
      name: n.node,
      /* online/offline reale dal campo status della lista GET /nodes (già eseguita);
         /nodes/{node}/status non espone lo stato del nodo. */
      status: n.status === 'online' || n.status === 'offline' ? n.status : 'unknown',
      uptime: nodeStatus.uptime || 0,
      cpu: nodeStatus.cpu || 0,
      /* dati CPU reali dal nodo: /nodes/{node}/status non espone maxcpu,
         ma cpuinfo contiene model, sockets, cores e cpus (logical/threads) */
      cpuinfo: {
        model: (nodeStatus.cpuinfo && nodeStatus.cpuinfo.model) || null,
        sockets: (nodeStatus.cpuinfo && nodeStatus.cpuinfo.sockets) || null,
        cores: (nodeStatus.cpuinfo && nodeStatus.cpuinfo.cores) || null,
        cpus: (nodeStatus.cpuinfo && nodeStatus.cpuinfo.cpus) || null,
      },
      maxcpu: nodeStatus.maxcpu || (nodeStatus.cpuinfo && nodeStatus.cpuinfo.cpus) || 1,
      mem: nodeStatus.mem || (nodeStatus.memory && nodeStatus.memory.used) || 0,
      maxmem: nodeStatus.maxmem || (nodeStatus.memory && nodeStatus.memory.total) || 0,
      /* rootfs del nodo dalla stessa chiamata /nodes/{node}/status; null se assente. */
      rootfs: (nodeStatus.rootfs && Number.isFinite(Number(nodeStatus.rootfs.total)) && Number.isFinite(Number(nodeStatus.rootfs.used)) && Number.isFinite(Number(nodeStatus.rootfs.avail)))
        ? { total: Number(nodeStatus.rootfs.total), used: Number(nodeStatus.rootfs.used), avail: Number(nodeStatus.rootfs.avail) }
        : null,
      /* Health V2: swap/loadavg/memoria disponibile dalla stessa chiamata
         /nodes/{node}/status già eseguita. ZERO nuove chiamate PVE. */
      swap: (nodeStatus.swap && Number.isFinite(Number(nodeStatus.swap.total)) && Number.isFinite(Number(nodeStatus.swap.used)))
        ? { total: Number(nodeStatus.swap.total), used: Number(nodeStatus.swap.used), free: Number(nodeStatus.swap.free) }
        : null,
      loadavg: normalizeLoadavg(nodeStatus.loadavg),
      memoryAvail: Number.isFinite(Number(nodeStatus.memory && nodeStatus.memory.available)) ? Number(nodeStatus.memory.available) : null,
      vms,
      lxc: cts,
    });
  }
  return out;
}

let statusFetching = null;

async function getStatus() {
  if (statusCache && Date.now() - statusCacheAt < 2000) return statusCache;
  /* mutex: se una raccolta è già in corso, riusa la stessa promessa
     invece di lanciare richieste concorrenti che possono finire fuori ordine */
  if (statusFetching) return statusFetching;
  statusFetching = (async () => {
    const results = await Promise.all(config.servers.map(async (s) => {
      try {
        return await collectServer(s);
      } catch (e) {
        return { id: s.id, name: s.name, url: s.url, online: false, error: e.message, nodes: [] };
      }
    }));
    statusCache = { servers: results, at: Date.now() };
    statusCacheAt = Date.now();
    return statusCache;
  })().finally(() => {
    statusFetching = null;
  });
  return statusFetching;
}


/* ---------------- HTTP ---------------- */

function json(res, data, code) {
  const body = JSON.stringify(data);
  res.writeHead(code || 200, { ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(new Error('Body troppo grande'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('JSON non valido')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, p) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, securityHeaders());
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, securityHeaders());
      return res.end('Not found');
    }
    res.writeHead(200, { ...securityHeaders(),
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function sanitizeServer(s) {
  return { id: s.id, name: s.name, url: s.url, user: s.user, verifyTls: s.verifyTls !== false };
}

/* Health prefs: guestModes è una mappa opzionale "<serverId>:<node>:<type>:<vmid>" -> mode.
   Config legacy senza health/guestModes -> oggetto vuoto. Nessuna scrittura automatica. */
function safeGuestModes() {
  const h = config.health && typeof config.health === 'object' ? config.health : {};
  const m = h.guestModes && typeof h.guestModes === 'object' && !Array.isArray(h.guestModes) ? h.guestModes : {};
  return m;
}

/* Health: soglie configurabili (storage, età backup, swap, dischi V2.1).
   Default centralizzati; validazione warning < critical con range sensati. */
const HEALTH_SETTING_DEFAULTS = {
  storage: { warning: 85, critical: 90 },
  backupAge: { warningDays: 7, criticalDays: 14 },
  swap: { warning: 80, critical: 90 },
  disk: { temp: { warning: 55, critical: 65 }, wear: { warning: 10 } },
};

const HEALTH_SETTING_VALIDATORS = {
  storage: (v) => v.warning >= 1 && v.warning <= 99 && v.critical >= 2 && v.critical <= 100 && v.warning < v.critical,
  backupAge: (v) => v.warningDays >= 1 && v.warningDays <= 365 && v.criticalDays >= 2 && v.criticalDays <= 365 && v.warningDays < v.criticalDays,
  swap: (v) => v.warning >= 1 && v.warning <= 99 && v.critical >= 2 && v.critical <= 100 && v.warning < v.critical,
  /* wear critical resta FISSO a 5: solo il warning è configurabile (> 5) */
  disk: (v) => v.temp.warning >= 20 && v.temp.warning <= 90 &&
    v.temp.critical >= 21 && v.temp.critical <= 95 && v.temp.warning < v.temp.critical &&
    v.wear.warning > 5 && v.wear.warning <= 100,
};

/* merge ricorsivo default + valori utente (gruppi annidati come disk.temp) */
function mergeSetting(def, user) {
  if (def && typeof def === 'object' && !Array.isArray(def)) {
    const out = {};
    for (const key of Object.keys(def)) {
      const u = user && typeof user === 'object' && !Array.isArray(user) ? user[key] : undefined;
      out[key] = (def[key] && typeof def[key] === 'object' && !Array.isArray(def[key]))
        ? mergeSetting(def[key], u)
        : (Number.isFinite(Number(u)) ? Number(u) : def[key]);
    }
    return out;
  }
  return def;
}

/* merge default + config.json; un gruppo invalido (es. config editata a mano)
   ricade sui default. Non tocca mai health.guestModes. */
function safeHealthSettings() {
  const h = config.health && typeof config.health === 'object' ? config.health : {};
  const s = h.settings && typeof h.settings === 'object' && !Array.isArray(h.settings) ? h.settings : {};
  const out = {};
  for (const [group, def] of Object.entries(HEALTH_SETTING_DEFAULTS)) {
    const user = s[group] && typeof s[group] === 'object' && !Array.isArray(s[group]) ? s[group] : {};
    const merged = mergeSetting(def, user);
    out[group] = HEALTH_SETTING_VALIDATORS[group](merged) ? merged : JSON.parse(JSON.stringify(def));
  }
  return out;
}

/* ---------- Backup & Snapshot Manager (Fase 1: SOLO lettura) ---------- */

/* content PVE puo' essere stringa CSV ("backup,vztmpl,iso") o lista:
   normalizzazione robusta, sempre array di stringhe. */
function storageContentList(content) {
  if (Array.isArray(content)) return content.map((x) => String(x).trim()).filter(Boolean);
  if (typeof content === 'string') return content.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

/* flag PVE booleani espressi come 0/1, "0"/"1" o true/false */
function pveFlag(v) {
  return v === true || v === 1 || v === '1';
}

/* stringa opzionale: assente o vuota -> null, altrimenti stringa invariata */
function pveString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s;
}

/* numero reale PVE (byte/epoch): mantiene il valore numerico, null se assente */
function pveNumber(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/* niente caratteri di controllo (U+0000-U+001F, U+007F) ne' backslash */
function hasControlOrBackslash(v) {
  for (const ch of v) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127 || ch === '\\') return true;
  }
  return false;
}

/* scoperta destinazioni backup di un server: GET /nodes/{node}/storage per ogni
   nodo, filtrando enabled + active + content include "backup".
   Dedup multi-node: uno storage SHARED con lo stesso nome su piu' nodi genera
   UNA entry (il nodo primario resta in "node" per le operazioni, l'elenco
   completo dei nodi in "nodes"); uno storage node-local mantiene la propria
   entry per nodo. Nessuna ambiguita: nessun nodo viene scartato. */
async function backupStorageTargets(server) {
  const nodes = await api(server, 'GET', '/api2/json/nodes');
  const results = await Promise.allSettled((nodes || []).map(async (n) => {
    const list = await api(server, 'GET', '/api2/json/nodes/' + encodeURIComponent(n.node) + '/storage');
    return { node: n.node, list: list || [] };
  }));
  const errors = [];
  const entries = new Map();
  const nodeSets = new Map();
  for (const r of results) {
    if (r.status === 'rejected') {
      errors.push({ serverId: server.id, serverName: server.name, error: r.reason.message });
      continue;
    }
    for (const raw of r.value.list || []) {
      const content = storageContentList(raw.content);
      const shared = pveFlag(raw.shared);
      if (!pveFlag(raw.enabled) || !pveFlag(raw.active) || !content.includes('backup')) continue;
      /* shared: chiave per nome (dedup tra nodi); node-local: chiave nome@nodo */
      const key = shared ? raw.storage : raw.storage + '@' + r.value.node;
      if (!entries.has(key)) {
        entries.set(key, {
          serverId: server.id,
          serverName: server.name,
          node: r.value.node,
          storage: raw.storage,
          type: pveString(raw.type),
          shared,
          enabled: true,
          active: true,
          avail: pveNumber(raw.avail) || 0,
          used: pveNumber(raw.used) || 0,
          total: pveNumber(raw.total) || 0,
          content,
        });
        nodeSets.set(key, [r.value.node]);
      } else if (!nodeSets.get(key).includes(r.value.node)) {
        nodeSets.get(key).push(r.value.node);
      }
    }
  }
  const storages = [];
  for (const [key, entry] of entries) {
    const list = nodeSets.get(key) || [];
    if (list.length > 1) entry.nodes = list.slice().sort();
    storages.push(entry);
  }
  return { storages, errors };
}

/* stesso criterio di validazione nodo usato da /api/health/prefs (Fase 1) */
function isValidNodeName(v) {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v);
}

/* mapping compress NodePilot -> PVE verificato sul sorgente ufficiale
   (PVE/VZDump.pm, compressor_info): 0 = nessuna compressione, 1 = alias lzo. */
const PVE_COMPRESS = { zstd: 'zstd', gzip: 'gzip', lzo: 'lzo', none: '0' };

/* verifica READ-ONLY che un guest esista sul nodo indicato. VMID e' univoco per
   nodo tra qemu e lxc (nessuna collisione possibile): il controllo non e'
   ambiguo. 403 PVE e altri errori reali vengono propagati; il solo caso
   "does not exist" (HTTP 500 con messaggio specifico, verificato su PVE 9.2)
   viene trattato come guest assente. */
async function guestExists(server, node, vmid) {
  const nodeName = encodeURIComponent(node);
  for (const type of ['qemu', 'lxc']) {
    try {
      await api(server, 'GET', '/api2/json/nodes/' + nodeName + '/' + type + '/' + vmid + '/status/current');
      return true;
    } catch (e) {
      if (e.pveStatus === 403) throw e;
      if (!/does not exist/i.test(e.message)) throw e;
    }
  }
  return false;
}

/* ---------- Health V2.1: parsing SMART (puro, testabile) ---------- */

/* primo numero di un raw ATA ("40" -> 40; "33 (Min/Max 33/33)" -> 33).
   Parsing fallito -> null, MAI 0. */
function parseSmartFirstNumber(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^[ \t]*(-?[0-9]+(?:[.][0-9]+)?)/.exec(raw);
  return m ? Number(m[1]) : null;
}

/* lookup attributo ATA: ID numerico prima, nome (regex) come fallback.
   I vendor usano nomi diversi: nessun nome è assunto come unico. */
function smartFindAttr(attrs, ids, namePattern) {
  if (!Array.isArray(attrs)) return null;
  const normId = (s) => String(s == null ? '' : s).trim();
  for (const a of attrs) {
    if (ids.includes(normId(a.id))) return a;
  }
  for (const a of attrs) {
    if (namePattern.test(String(a.name || ''))) return a;
  }
  return null;
}

/* normalizzazione health SMART: PASSED/OK sani, FAILED critico,
   UNKNOWN e SMART Disabled informativi. Mai inventare severità. */
function normalizeSmartHealth(h) {
  if (h === null || h === undefined) return 'UNKNOWN';
  const v = String(h).trim();
  if (/^PASSED$/i.test(v)) return 'PASSED';
  if (/^OK$/i.test(v)) return 'OK';
  if (/^FAILED|^FAILING_NOW/i.test(v)) return 'FAILED';
  if (/^SMART[ ]+Disabled/i.test(v)) return 'SMART_DISABLED';
  return 'UNKNOWN';
}

/* registri wear ATA (stessa lista del sorgente PVE Diskmanage.pm, per coerenza
   col campo wearout di disks/list); value normalizzato = vita residua stimata.
   Nessun registro -> null (es. HDD o SSD vendor senza wear). */
const SMART_WEAR_REGISTERS = [
  /Media_Wearout_Indicator/i, /SSD_Life_Left/i, /Wear_Leveling_Count/i,
  /Perc_Write.Erase_Ct_BC/i, /Perc_Rated_Life_Remain/i, /Remaining_Lifetime_Perc/i,
  /Percent_Lifetime_Remain/i, /Lifetime_Left/i, /PCT_Life_Remaining/i,
  /Lifetime_Remaining/i, /Percent_Life_Remaining/i, /Percent_Lifetime_Used/i,
  /Perc_Rated_Life_Used/i,
];

/* parsing conservativo NVMe/SAS dal testo smartctl (solo righe note
   dell'audit). Riga non riconosciuta -> nessun alert derivato. */
function parseSmartTextFields(text) {
  const out = { temperature: null, wearRemaining: null, powerOnHours: null };
  if (typeof text !== 'string' || !text.trim()) return out;
  let m;
  /* NVMe Log 0x02 */
  if ((m = /^Temperature:[ \t]*([0-9]+)[ \t]*Celsius/im.exec(text))) out.temperature = Number(m[1]);
  if ((m = /^Percentage Used(?:[ \t]+endurance indicator)?:[ \t]*([0-9]+(?:[.][0-9]+)?)[ \t]*%/im.exec(text))) {
    out.wearRemaining = Math.max(0, Math.min(100, 100 - Number(m[1])));
  }
  if ((m = /^Power On Hours:[ \t]*([0-9]+)/im.exec(text))) out.powerOnHours = Number(m[1]);
  /* SAS */
  if (out.temperature === null && (m = /Current Drive Temperature:[ \t]*([0-9]+)[ \t]*C/im.exec(text))) {
    out.temperature = Number(m[1]);
  }
  return out;
}

/* lettura SMART normalizzata per il frontend: mai la risposta PVE grezza
   come struttura primaria. checkedAt in secondi epoch. */
function normalizeSmartReading(raw) {
  const out = {
    checkedAt: Math.floor(Date.now() / 1000),
    health: normalizeSmartHealth(raw && raw.health),
    smartAvailable: !!(raw && (raw.health !== undefined || raw.attributes || raw.text)),
    type: raw && typeof raw.type === 'string' ? raw.type : null,
    temperature: null,
    powerOnHours: null,
    wearRemaining: null,
    reallocated: null,
    pending: null,
    offlineUncorrectable: null,
    rawAttributes: null,
    rawText: null,
  };
  if (!raw || typeof raw !== 'object') return out;
  const attrs = Array.isArray(raw.attributes) ? raw.attributes : [];
  if (raw.type === 'ata' && attrs.length) {
    const re = smartFindAttr(attrs, ['5'], /^Reallocated_Sector/i);
    out.reallocated = re ? parseSmartFirstNumber(re.raw) : null;
    const pe = smartFindAttr(attrs, ['197'], /^Current_Pending_Sector/i);
    out.pending = pe ? parseSmartFirstNumber(pe.raw) : null;
    const oe = smartFindAttr(attrs, ['198'], /^Offline_Uncorrectable|^Offline_Scan_UNC/i);
    out.offlineUncorrectable = oe ? parseSmartFirstNumber(oe.raw) : null;
    const po = smartFindAttr(attrs, ['9'], /^Power_On_Hours|^Power-On_Hours/i);
    out.powerOnHours = po ? parseSmartFirstNumber(po.raw) : null;
    const te = smartFindAttr(attrs, ['194'], /^Temperature_Celsius|^Airflow_Temperature|^Temperature_Case|^Temperature_Internal|^Temperature$/i);
    out.temperature = te ? parseSmartFirstNumber(te.raw) : null;
    for (const re of SMART_WEAR_REGISTERS) {
      const wa = attrs.find((a) => re.test(String(a.name || '')));
      if (wa && Number.isFinite(Number(wa.value))) {
        out.wearRemaining = Math.max(0, Math.min(100, Number(wa.value)));
        break;
      }
    }
    out.rawAttributes = attrs;
  } else if (raw.type === 'text' && typeof raw.text === 'string') {
    const parsed = parseSmartTextFields(raw.text);
    out.temperature = parsed.temperature;
    out.wearRemaining = parsed.wearRemaining;
    out.powerOnHours = parsed.powerOnHours;
    out.rawText = raw.text;
  }
  return out;
}

/* ---------- fine parsing SMART ---------- */

/* ---------- Health V2.0 Core: helper di sola lettura ---------- */

/* Storage: GET /nodes/{node}/storage per ogni nodo; entry per TUTTI gli storage
   (non solo backup). Dedup shared per nome (elenco nodi in "nodes"), storage
   node-local per nodo. Errori parziali per nodo, mai stack trace. */
async function healthStorageTargets(server) {
  const nodes = await api(server, 'GET', '/api2/json/nodes');
  const results = await Promise.allSettled((nodes || []).map(async (n) => {
    const list = await api(server, 'GET', '/api2/json/nodes/' + encodeURIComponent(n.node) + '/storage');
    return { node: n.node, list: list || [] };
  }));
  const errors = [];
  const entries = new Map();
  const nodeSets = new Map();
  for (const r of results) {
    if (r.status === 'rejected') {
      errors.push({ serverId: server.id, serverName: server.name, error: r.reason.message });
      continue;
    }
    for (const raw of r.value.list || []) {
      const shared = pveFlag(raw.shared);
      const key = shared ? raw.storage : raw.storage + '@' + r.value.node;
      if (!entries.has(key)) {
        entries.set(key, {
          serverId: server.id,
          serverName: server.name,
          node: r.value.node,
          storage: pveString(raw.storage),
          type: pveString(raw.type),
          content: storageContentList(raw.content),
          total: pveNumber(raw.total),
          used: pveNumber(raw.used),
          avail: pveNumber(raw.avail),
          usedFraction: Number.isFinite(Number(raw.used_fraction)) ? Number(raw.used_fraction) : null,
          active: pveFlag(raw.active),
          enabled: pveFlag(raw.enabled),
          shared,
        });
        nodeSets.set(key, [r.value.node]);
      } else if (!nodeSets.get(key).includes(r.value.node)) {
        nodeSets.get(key).push(r.value.node);
      }
    }
  }
  const storages = [];
  for (const [key, entry] of entries) {
    const list = nodeSets.get(key) || [];
    if (list.length > 1) entry.nodes = list.slice().sort();
    storages.push(entry);
  }
  return { storages, errors };
}

/* ZFS: GET /nodes/{node}/disks/zfs + dettaglio per pool. Un nodo senza ZFS
   (lista vuota o errore) NON è un errore Health: viene semplicemente saltato. */
async function healthZfsPools(server) {
  const nodes = await api(server, 'GET', '/api2/json/nodes');
  const pools = [];
  for (const n of (nodes || [])) {
    let list = null;
    try {
      list = await api(server, 'GET', '/api2/json/nodes/' + encodeURIComponent(n.node) + '/disks/zfs');
    } catch (_) {
      continue; /* nodo senza ZFS o permessi: nessun errore Health per il nodo */
    }
    for (const raw of (list || [])) {
      const pool = {
        serverId: server.id,
        serverName: server.name,
        node: n.node,
        name: pveString(raw.name),
        size: pveNumber(raw.size),
        alloc: pveNumber(raw.alloc),
        free: pveNumber(raw.free),
        frag: pveNumber(raw.frag),
        health: pveString(raw.health),
        dedup: pveNumber(raw.dedup),
        detail: null,
        detailError: null,
      };
      try {
        const d = await api(server, 'GET', '/api2/json/nodes/' + encodeURIComponent(n.node) + '/disks/zfs/' + encodeURIComponent(raw.name));
        pool.detail = {
          state: pveString(d.state),
          errors: pveString(d.errors),
          scan: pveString(d.scan),
          status: pveString(d.status),
          action: pveString(d.action),
        };
      } catch (e) {
        pool.detailError = e.message; /* mai stack trace */
      }
      pools.push(pool);
    }
  }
  return pools;
}

/* Cluster/HA: GET /cluster/status; solo se cluster, HA status corrente e
   risorse. Standalone -> { cluster:false, ha:null } senza warning. */
async function healthClusterEntry(server) {
  const status = await api(server, 'GET', '/api2/json/cluster/status');
  const entries = Array.isArray(status) ? status : [];
  const clusterEntry = entries.find((e) => e && e.type === 'cluster');
  const nodeEntries = entries.filter((e) => e && e.type === 'node');
  const entry = {
    serverId: server.id,
    serverName: server.name,
    cluster: !!clusterEntry,
    quorate: clusterEntry ? (pveFlag(clusterEntry.quorate) ? 1 : 0) : null,
    nodes: nodeEntries.map((n) => ({ name: pveString(n.name) || pveString(n.id), online: !(n.online === 0 || n.online === '0' || n.online === false) })),
    ha: null,
    haResources: [],
  };
  if (entry.cluster) {
    try {
      const ha = await api(server, 'GET', '/api2/json/cluster/ha/status/current');
      /* su installazioni senza HA attivo la risposta non contiene manager_status:
         ha resta null e nessun alert viene generato */
      if (ha && typeof ha === 'object' && (ha.manager_status || Array.isArray(ha.services))) {
        entry.ha = {
          managerStatus: pveString(ha.manager_status),
          master: pveString(ha.master),
          services: Array.isArray(ha.services) ? ha.services.map((sv) => ({
            sid: pveString(sv.sid),
            type: pveString(sv.type),
            node: pveString(sv.node),
            state: pveString(sv.state),
            status: pveString(sv.status),
          })) : [],
        };
      }
    } catch (_) {
      entry.ha = null;
    }
    try {
      const res = await api(server, 'GET', '/api2/json/cluster/ha/resources?type=vm');
      entry.haResources = Array.isArray(res) ? res.map((r) => ({
        sid: pveString(r.sid),
        type: pveString(r.type),
        state: pveString(r.state),
      })) : [];
    } catch (_) {
      entry.haResources = [];
    }
  }
  return entry;
}

/* ---------------- Notification Center & Alert Engine (v1.3.0 FASE 1) ---------------- */

/* helper condivisi con le route Log: normalizzati a livello modulo per il riuso
   nel watchdog (alert-engine) senza duplicazione. */
function normalizeTask(s, n, t) {
  return {
    serverId: s.id,
    serverName: s.name,
    node: t.node || n.node,
    upid: t.upid,
    type: t.type || 'unknown',
    status: t.status || 'unknown',
    vmid: t.id || null,
    user: t.user || '',
    starttime: t.starttime || 0,
    endtime: t.endtime || 0,
    pid: t.pid || null,
  };
}

function parseSyslogLine(t) {
  const m = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\S+)\s+([^:]+):\s?(.*)$/.exec(t || '');
  if (!m) return { ts: 0, service: '', message: t || '' };
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const mon = months[m[1]];
  if (mon === undefined) return { ts: 0, service: '', message: t || '' };
  const nowDate = new Date();
  let d = new Date(nowDate.getFullYear(), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  if (d.getTime() > Date.now() + 86400000) {
    d = new Date(nowDate.getFullYear() - 1, mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  }
  return { ts: Math.floor(d.getTime() / 1000), service: m[7], message: m[8] };
}

async function fetchAllServers(serverId, fn) {
  const targets = serverId
    ? config.servers.filter((s) => s.id === serverId)
    : config.servers;
  const results = await Promise.all(targets.map(async (s) => {
    try {
      return { serverId: s.id, serverName: s.name, ok: true, data: await fn(s) };
    } catch (e) {
      return { serverId: s.id, serverName: s.name, ok: false, error: e.message, data: null };
    }
  }));
  const all = [];
  const errors = [];
  for (const r of results) {
    if (r.ok) all.push(...(r.data || []));
    else errors.push({ serverName: r.serverName, error: r.error });
  }
  return { all, errors };
}

/* raccolta task recenti per il watchdog (stessa logica della route /api/logs/tasks) */
async function collectTaskEvents() {
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const { all } = await fetchAllServers(null, async (s) => {
    const nodes = await api(s, 'GET', '/api2/json/nodes');
    const tasks = [];
    for (const n of nodes) {
      const nodeName = encodeURIComponent(n.node);
      const list = await api(s, 'GET', '/api2/json/nodes/' + nodeName + '/tasks?limit=200&since=' + since);
      for (const t of list || []) tasks.push(normalizeTask(s, n, t));
    }
    return tasks;
  });
  return all;
}

/* età dell'ultimo backup per guest: riusa backupStorageTargets (helper esistente).
   Niente jobs in FASE 1: il "mai backup" resta esclusivo del Health Center UI. */
async function collectBackupAge() {
  const out = [];
  for (const s of config.servers) {
    const entry = { serverId: s.id, serverName: s.name, backups: [] };
    try {
      const { storages } = await backupStorageTargets(s);
      for (const st of storages) {
        try {
          const content = await api(s, 'GET',
            '/api2/json/nodes/' + encodeURIComponent(st.node) + '/storage/' + encodeURIComponent(st.storage) + '/content?content=backup');
          for (const raw of content || []) {
            entry.backups.push({
              vmid: pveNumber(raw.vmid),
              guestType: raw.subtype === 'lxc' || raw.subtype === 'qemu' ? raw.subtype : null,
              ctime: pveNumber(raw.ctime),
            });
          }
        } catch (_) { /* storage parziale: salta, il tick non si blocca */ }
      }
    } catch (_) { /* server non raggiungibile: salta */ }
    out.push(entry);
  }
  return out;
}

async function collectStorage() {
  const out = [];
  for (const s of config.servers) {
    try {
      const { storages } = await healthStorageTargets(s);
      out.push(...storages);
    } catch (_) { /* salta */ }
  }
  return out;
}

async function collectZfs() {
  const out = [];
  for (const s of config.servers) {
    try {
      out.push(...await healthZfsPools(s));
    } catch (_) { /* salta */ }
  }
  return out;
}

async function collectCluster() {
  const out = [];
  for (const s of config.servers) {
    try {
      out.push(await healthClusterEntry(s));
    } catch (_) { /* salta */ }
  }
  return out;
}

async function fetchTaskStatus(server, node, upid) {
  return api(server, 'GET',
    '/api2/json/nodes/' + encodeURIComponent(node) + '/tasks/' + encodeURIComponent(upid) + '/status');
}

/* ---------- settings Notification Center & Telegram (FASE 2A) ---------- */

const TELEGRAM_EVENT_KEYS = ['critical', 'warning', 'success', 'info', 'recovery'];
const TELEGRAM_EVENT_DEFAULTS = { critical: true, warning: true, success: true, info: false, recovery: true };

/* settings Telegram interni (con token) per il delivery: default sicuri,
   backward compatible con config v1.2.3 (assenza chiave -> defaults). */
function safeTelegramSettings() {
  const n = config.notifications && typeof config.notifications === 'object' ? config.notifications : {};
  const t = n.telegram && typeof n.telegram === 'object' ? n.telegram : {};
  const events = {};
  for (const k of TELEGRAM_EVENT_KEYS) {
    events[k] = typeof t.events === 'object' && t.events !== null && typeof t.events[k] === 'boolean'
      ? t.events[k]
      : TELEGRAM_EVENT_DEFAULTS[k];
  }
  return {
    enabled: t.enabled === true,
    botToken: typeof t.botToken === 'string' ? t.botToken : '',
    chatId: typeof t.chatId === 'string' ? t.chatId : '',
    language: t.language === 'en' ? 'en' : 'it',
    events,
  };
}

/* versione pubblica (API): MAI il botToken */
function publicTelegramSettings() {
  const t = safeTelegramSettings();
  return {
    enabled: t.enabled,
    configured: !!(t.botToken && t.chatId),
    chatId: t.chatId,
    language: t.language,
    events: Object.assign({}, t.events),
  };
}

/* settings Notification Center: default sicuri, backward compatible */
function safeNotificationsSettings() {
  const n = config.notifications && typeof config.notifications === 'object' ? config.notifications : {};
  const c = n.center && typeof n.center === 'object' ? n.center : {};
  return { center: { enabled: c.enabled !== false } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const q = url.searchParams;
  /* Fase 3: enforcement autenticazione — tutti gli endpoint /api richiedono una
     sessione valida, tranne login/session/logout. Gli statici restano pubblici
     (la shell di login non contiene dati). */
  if (p.startsWith('/api/') && p !== '/api/auth/login' && p !== '/api/auth/session' && p !== '/api/auth/logout' && p !== '/api/version') {
    if (!requireAuth(req)) {
      return json(res, { ok: false, authenticated: false, error: 'Non autenticato' }, 401);
    }
  }
  /* Fase 2: Origin validation sulle richieste mutative autenticate.
     Esclusi GET e gli endpoint pubblici di autenticazione (login/session/logout),
     che hanno già rate limit e protezioni dedicate. Client senza Origin né Referer
     (es. curl) restano ammessi. */
  if ((req.method === 'POST' || req.method === 'DELETE') &&
      p.startsWith('/api/') &&
      p !== '/api/auth/login' && p !== '/api/auth/session' && p !== '/api/auth/logout') {
    const originCandidate = req.headers.origin || req.headers.referer;
    if (originCandidate && !isSameOriginHeader(originCandidate, req)) {
      return json(res, { ok: false, error: 'Origine non valida' }, 403);
    }
  }
  try {
    /* ---------- authentication (Fase 1: core; enforcement sugli altri endpoint in F3) ---------- */

    if (p === '/api/auth/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const limit = rateLimitInfo(ip);
      if (!limit.allowed) {
        authLog('rate limit: ip=' + ip);
        res.setHeader('Retry-After', String(limit.retryAfter));
        return json(res, { ok: false, error: 'Troppi tentativi. Riprova più tardi.' }, 429);
      }
      const b = await readBody(req);
      const username = typeof b.username === 'string' ? b.username.trim() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      if (!authConfig.username || !authConfig.passwordHash) {
        return json(res, { ok: false, error: 'Autenticazione non configurata: eseguire npm run auth:set-password' }, 503);
      }
      let ok = false;
      if (username === authConfig.username && password) {
        ok = verifyPassword(password, authConfig.passwordHash);
      } else {
        /* confronto dummy per uniformare i tempi (no user enumeration) */
        crypto.scryptSync(password || '', crypto.randomBytes(16), SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
      }
      if (!ok) {
        rateLimitHit(ip);
        authLog('login fallito: ip=' + ip);
        return json(res, { ok: false, error: 'Credenziali non valide' }, 401);
      }
      loginFailures.delete(ip);
      /* rotazione session id a ogni login: niente session fixation */
      const sessionId = crypto.randomBytes(32).toString('base64url');
      sessions.set(sessionId, { username, createdAt: Date.now(), lastSeen: Date.now() });
      setSessionCookie(res, req, sessionId);
      authLog('login riuscito: user=' + username);
      return json(res, { ok: true, user: { username } });
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const sid = parseCookies(req)[SESSION_COOKIE];
      const s = sid ? sessions.get(sid) : null;
      if (s) {
        sessions.delete(sid);
        authLog('logout: user=' + s.username);
      }
      clearSessionCookie(res);
      return json(res, { ok: true });
    }

    if (p === '/api/auth/session' && req.method === 'GET') {
      const s = getSession(req);
      if (!s) return json(res, { ok: true, authenticated: false });
      return json(res, { ok: true, authenticated: true, user: { username: s.username } });
    }

    /* GET /api/version — metadata pubblici minimi (badge versione).
       SOLO name e version; nessun altro dato di runtime. */
    if (p === '/api/version' && req.method === 'GET') {
      return json(res, APP_META);
    }

    /* cambio password: NON nella allowlist pubblica, quindi eredita
       autenticazione globale, Origin validation, security headers e no-store */
    if (p === '/api/auth/change-password' && req.method === 'POST') {
      const ip = clientIp(req);
      const limit = changeRateLimitInfo(ip);
      if (!limit.allowed) {
        authLog('rate limit cambio password: ip=' + ip);
        res.setHeader('Retry-After', String(limit.retryAfter));
        return json(res, { ok: false, code: 'RATE_LIMITED', error: 'Troppi tentativi. Riprova più tardi.' }, 429);
      }
      const b = await readBody(req);
      const currentPassword = typeof b.currentPassword === 'string' ? b.currentPassword : '';
      const newPassword = typeof b.newPassword === 'string' ? b.newPassword : '';
      if (!authConfig.username || !authConfig.passwordHash) {
        return json(res, { ok: false, code: 'NOT_CONFIGURED', error: 'Autenticazione non configurata: eseguire npm run auth:set-password' }, 503);
      }
      /* la password attuale viene SEMPRE verificata a costo pieno (scrypt,
         nessuna scorciatoia temporale); solo dopo si valida la nuova */
      if (!currentPassword || !verifyPassword(currentPassword, authConfig.passwordHash)) {
        changeRateLimitHit(ip);
        authLog('cambio password fallito (password attuale errata): ip=' + ip);
        return json(res, { ok: false, code: 'WRONG_CURRENT', error: 'Password attuale non corretta' }, 401);
      }
      if (!newPassword || newPassword.length < 8) {
        return json(res, { ok: false, code: 'TOO_SHORT', error: 'Nuova password troppo corta: minimo 8 caratteri' }, 400);
      }
      if (newPassword.length > 256) {
        return json(res, { ok: false, code: 'TOO_LONG', error: 'Nuova password troppo lunga: massimo 256 caratteri' }, 400);
      }
      if (newPassword === currentPassword) {
        return json(res, { ok: false, code: 'SAME_PASSWORD', error: 'La nuova password deve essere diversa da quella attuale' }, 400);
      }
      /* stesso sistema scrypt del login: N=32768, r=8, p=1, keylen 32, salt 16B */
      const salt = crypto.randomBytes(16);
      const hash = crypto.scryptSync(newPassword, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
      const passwordHash = 'scrypt$' + SCRYPT_N + '$' + SCRYPT_R + '$' + SCRYPT_P + '$' + salt.toString('base64url') + '$' + hash.toString('base64url');
      /* scrittura atomica: temp nella stessa directory (mode 600) + rename.
         auth.json continua a contenere SOLO username + passwordHash */
      const tmpPath = AUTH_PATH + '.tmp';
      try {
        fs.writeFileSync(tmpPath, JSON.stringify({ username: authConfig.username, passwordHash }, null, 2), { mode: 0o600 });
        fs.renameSync(tmpPath, AUTH_PATH);
      } catch (e) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* ignora */ }
        console.error('Errore salvataggio auth.json:', e.message);
        return json(res, { ok: false, error: 'Impossibile salvare la nuova password' }, 500);
      }
      /* commit solo dopo la scrittura riuscita: memoria, sessioni e cookie */
      authConfig.passwordHash = passwordHash;
      sessions.clear();
      passwordChangeFailures.delete(ip);
      clearSessionCookie(res);
      authLog('password cambiata: user=' + authConfig.username);
      return json(res, { ok: true });
    }

    if (p === '/api/status') return json(res, await getStatus());

    /* ---------- log Proxmox: task / system / cluster ---------- */

    /* Task: GET /nodes/{node}/tasks (since/until verificati su PVE 9.2) */
    if (p === '/api/logs/tasks' && req.method === 'POST') {
      const b = await readBody(req);
      const limit = Math.min(Number(b.limit) || 200, 200);
      const since = Number(b.since) || 0;
      const until = Number(b.until) || 0;
      const { all, errors } = await fetchAllServers(b.serverId || null, async (s) => {
        const nodes = await api(s, 'GET', '/api2/json/nodes');
        const tasks = [];
        for (const n of nodes) {
          const nodeName = encodeURIComponent(n.node);
          let path = '/api2/json/nodes/' + nodeName + '/tasks?limit=' + limit;
          if (since) path += '&since=' + since;
          if (until) path += '&until=' + until;
          const list = await api(s, 'GET', path);
          for (const t of list || []) tasks.push(normalizeTask(s, n, t));
        }
        return tasks;
      });
      all.sort((a, b) => (b.starttime || 0) - (a.starttime || 0));
      return json(res, { ok: true, events: all, errors });
    }

    /* Log di sistema: GET /nodes/{node}/syslog (testo non strutturato {n,t};
       since/until accettano formato data 'YYYY-MM-DD HH:MM:SS' (non epoch);
       il filtro client-side sul timestamp parsato resta come doppia sicurezza) */
    if (p === '/api/logs/system' && req.method === 'POST') {
      const b = await readBody(req);
      const limit = Math.min(Number(b.limit) || 500, 1000);
      const since = typeof b.since === 'string' && b.since ? b.since : '';
      const { all, errors } = await fetchAllServers(b.serverId || null, async (s) => {
        const nodes = await api(s, 'GET', '/api2/json/nodes');
        const lines = [];
        for (const n of nodes) {
          const nodeName = encodeURIComponent(n.node);
          let path = '/api2/json/nodes/' + nodeName + '/syslog?limit=' + limit;
          if (since) path += '&since=' + encodeURIComponent(since);
          const list = await api(s, 'GET', path);
          for (const l of list || []) {
            const parsed = parseSyslogLine(l.t || '');
            lines.push({
              serverId: s.id,
              serverName: s.name,
              node: n.node,
              n: l.n || 0,
              t: l.t || '',
              ts: parsed.ts,
              service: parsed.service,
              message: parsed.message,
            });
          }
        }
        return lines;
      });
      /* l'API syslog restituisce in ordine cronologico (più vecchie prima):
         invertiamo per mostrare prima le righe più recenti (ts=0 in fondo) */
      all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return json(res, { ok: true, events: all, errors });
    }

    /* Log cluster: GET /cluster/log (strutturato: time,node,pri,tag,msg,user) */
    if (p === '/api/logs/cluster' && req.method === 'POST') {
      const b = await readBody(req);
      const { all, errors } = await fetchAllServers(b.serverId || null, async (s) => {
        const [log, status] = await Promise.all([
          api(s, 'GET', '/api2/json/cluster/log'),
          api(s, 'GET', '/api2/json/cluster/status'),
        ]);
        const standalone = Array.isArray(status) && status.length === 1;
        return (log || []).map((e) => ({
          serverId: s.id,
          serverName: s.name,
          node: e.node || '',
          pri: e.pri,
          tag: e.tag || '',
          msg: e.msg || '',
          user: e.user || '',
          time: e.time || 0,
          standalone,
        }));
      });
      all.sort((a, b) => (b.time || 0) - (a.time || 0));
      return json(res, { ok: true, events: all, errors });
    }

    /* alias compatibile: /api/logs continua a restituire i Task (stesso formato di prima) */
    if (p === '/api/logs' && req.method === 'POST') {
      const b = await readBody(req);
      const limit = Math.min(Number(b.limit) || 50, 200);
      const { all, errors } = await fetchAllServers(b.serverId || null, async (s) => {
        const nodes = await api(s, 'GET', '/api2/json/nodes');
        const tasks = [];
        for (const n of nodes) {
          const nodeName = encodeURIComponent(n.node);
          const list = await api(s, 'GET', '/api2/json/nodes/' + nodeName + '/tasks?limit=' + limit);
          for (const t of list || []) tasks.push(normalizeTask(s, n, t));
        }
        return tasks;
      });
      all.sort((a, b) => (b.starttime || 0) - (a.starttime || 0));
      return json(res, { ok: true, events: all, errors });
    }

    if (p === '/api/logs/detail' && req.method === 'POST') {
      const b = await readBody(req);
      const s = config.servers.find((x) => x.id === b.serverId);
      if (!s) throw new Error('Server non trovato');
      const nodeName = encodeURIComponent(b.node);
      const upid = encodeURIComponent(b.upid);
      const log = await api(s, 'GET', '/api2/json/nodes/' + nodeName + '/tasks/' + upid + '/log?limit=200');
      return json(res, { ok: true, log: log || [] });
    }



    if (p === '/api/guest/detail' && req.method === 'GET') {
      const serverId = q.get('serverId');
      const nodeName = encodeURIComponent(q.get('node') || '');
      const type = q.get('type') === 'lxc' ? 'lxc' : 'qemu';
      const vmid = q.get('vmid');

      const s = config.servers.find((x) => x.id === serverId);
      if (!s || !nodeName || !vmid) throw new Error('Parametri mancanti');

      const [stRes, cfgRes, tasksRes] = await Promise.allSettled([
        api(s, 'GET', '/api2/json/nodes/' + nodeName + '/' + type + '/' + vmid + '/status/current'),
        api(s, 'GET', '/api2/json/nodes/' + nodeName + '/' + type + '/' + vmid + '/config'),
        api(s, 'GET', '/api2/json/nodes/' + nodeName + '/tasks?vmid=' + vmid + '&limit=25')
      ]);

      return json(res, {
        ok: true,
        status: stRes.status === 'fulfilled' ? stRes.value : null,
        config: cfgRes.status === 'fulfilled' ? cfgRes.value : null,
        tasks: tasksRes.status === 'fulfilled' ? tasksRes.value : null,
        errors: {
          status: stRes.status === 'rejected' ? stRes.reason.message : null,
          config: cfgRes.status === 'rejected' ? cfgRes.reason.message : null,
          tasks: tasksRes.status === 'rejected' ? tasksRes.reason.message : null,
        }
      });
    }

    if (p === '/api/guest/rrd' && req.method === 'GET') {
      const serverId = q.get('serverId');
      const nodeName = encodeURIComponent(q.get('node') || '');
      const type = q.get('type') === 'lxc' ? 'lxc' : 'qemu';
      const vmid = q.get('vmid');
      const timeframe = q.get('timeframe') || 'hour'; // hour, day, week, month

      const s = config.servers.find((x) => x.id === serverId);
      if (!s || !nodeName || !vmid) throw new Error('Parametri mancanti');

      const rrd = await api(s, 'GET', '/api2/json/nodes/' + nodeName + '/' + type + '/' + vmid + '/rrddata?timeframe=' + encodeURIComponent(timeframe));
      return json(res, { ok: true, data: rrd || [] });
    }

    /* ---------- Backup & Snapshot Manager (Fase 1: SOLO lettura) ---------- */

    /* GET /api/backup/storages?serverId=<id>
       Solo storage enabled + active con content che include "backup".
       Errori parziali per nodo in "errors" (pattern multi-source dei Log). */
    if (p === '/api/backup/storages' && req.method === 'GET') {
      const serverId = (q.get('serverId') || '').trim();
      if (!serverId) return json(res, { error: 'Parametri mancanti: serverId' }, 400);
      const server = config.servers.find((s) => s.id === serverId);
      if (!server) return json(res, { error: 'Server non trovato' }, 404);
      const { storages, errors } = await backupStorageTargets(server);
      return json(res, { ok: true, storages, errors });
    }

    /* GET /api/backup/list?serverId=<id>[&node=<node>][&vmid=<n>]
       Fonte autorevole: storage content (MAI task vzdump). Gli archivi di guest
       eliminati restano nella risposta. Ordinamento ctime DESC, assenti in fondo. */
    if (p === '/api/backup/list' && req.method === 'GET') {
      const serverId = (q.get('serverId') || '').trim();
      if (!serverId) return json(res, { error: 'Parametri mancanti: serverId' }, 400);
      const server = config.servers.find((s) => s.id === serverId);
      if (!server) return json(res, { error: 'Server non trovato' }, 404);
      const nodeFilter = (q.get('node') || '').trim() || null;
      const vmidRaw = (q.get('vmid') || '').trim();
      let vmid = null;
      if (vmidRaw) {
        vmid = Number(vmidRaw);
        if (!Number.isInteger(vmid) || vmid <= 0) {
          return json(res, { error: 'VMID non valido: intero positivo' }, 400);
        }
      }
      if (nodeFilter && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(nodeFilter)) {
        return json(res, { error: 'Nodo non valido' }, 400);
      }
      const targets = await backupStorageTargets(server);
      const errors = [...targets.errors];
      const selected = nodeFilter
        ? targets.storages.filter((st) => st.node === nodeFilter || (st.nodes || []).includes(nodeFilter))
        : targets.storages;
      const backups = [];
      for (const st of selected) {
        try {
          const content = await api(server, 'GET',
            '/api2/json/nodes/' + encodeURIComponent(st.node) + '/storage/' + encodeURIComponent(st.storage) +
            '/content?content=backup' + (vmid ? '&vmid=' + vmid : ''));
          for (const raw of content || []) {
            backups.push({
              serverId: server.id,
              serverName: server.name,
              node: st.node,
              storage: st.storage,
              volid: pveString(raw.volid),
              vmid: pveNumber(raw.vmid),
              guestType: raw.subtype === 'lxc' || raw.subtype === 'qemu' ? raw.subtype : null,
              ctime: pveNumber(raw.ctime),
              size: pveNumber(raw.size),
              format: pveString(raw.format),
              notes: pveString(raw.notes),
              protected: pveFlag(raw.protected),
            });
          }
        } catch (e) {
          errors.push({ serverId: server.id, serverName: server.name, node: st.node, storage: st.storage, error: e.message });
        }
      }
      backups.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
      return json(res, { ok: true, backups, errors });
    }

    /* GET /api/backup/jobs?serverId=<id>
       403 PVE distinto da "nessun job": risposta 403 esplicita con forbidden:true. */
    if (p === '/api/backup/jobs' && req.method === 'GET') {
      const serverId = (q.get('serverId') || '').trim();
      if (!serverId) return json(res, { error: 'Parametri mancanti: serverId' }, 400);
      const server = config.servers.find((s) => s.id === serverId);
      if (!server) return json(res, { error: 'Server non trovato' }, 404);
      try {
        const jobs = await api(server, 'GET', '/api2/json/cluster/backup');
        return json(res, {
          ok: true,
          jobs: (jobs || []).map((j) => ({
            serverId: server.id,
            serverName: server.name,
            id: pveString(j.id),
            enabled: pveFlag(j.enabled),
            storage: pveString(j.storage),
            schedule: pveString(j.schedule),
            mode: pveString(j.mode),
            compress: j.compress !== null && j.compress !== undefined ? String(j.compress) : null,
            /* vmid preserva la semantica PVE (stringa CSV/lista), MAI forzato a Number */
            vmid: pveString(j.vmid),
            all: pveFlag(j.all),
            node: pveString(j.node),
            notesTemplate: pveString(j['notes-template']),
            pruneBackups: j['prune-backups'] && typeof j['prune-backups'] === 'object' ? j['prune-backups'] : null,
          })),
        });
      } catch (e) {
        if (e.pveStatus === 403) {
          return json(res, { ok: false, serverId: server.id, serverName: server.name, forbidden: true, error: 'Permessi insufficienti per leggere i job di backup: ' + e.message }, 403);
        }
        throw e;
      }
    }

    /* GET /api/snapshot/list?serverId=&node=&type=lxc|qemu=&vmid=
       La pseudo-entry "current" NON e' uno snapshot: filtrata nel backend. */
    if (p === '/api/snapshot/list' && req.method === 'GET') {
      const serverId = (q.get('serverId') || '').trim();
      const node = (q.get('node') || '').trim();
      const type = (q.get('type') || '').trim();
      const vmidRaw = (q.get('vmid') || '').trim();
      if (!serverId) return json(res, { error: 'Parametri mancanti: serverId' }, 400);
      const server = config.servers.find((s) => s.id === serverId);
      if (!server) return json(res, { error: 'Server non trovato' }, 404);
      if (!node) return json(res, { error: 'Parametri mancanti: node' }, 400);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(node)) return json(res, { error: 'Nodo non valido' }, 400);
      if (type !== 'lxc' && type !== 'qemu') return json(res, { error: 'Tipo non valido: solo lxc o qemu' }, 400);
      const vmid = Number(vmidRaw);
      if (!Number.isInteger(vmid) || vmid <= 0) return json(res, { error: 'VMID non valido: intero positivo' }, 400);
      const list = await api(server, 'GET',
        '/api2/json/nodes/' + encodeURIComponent(node) + '/' + type + '/' + vmid + '/snapshot');
      const snapshots = (list || [])
        .filter((s) => s && s.name !== 'current')
        .map((s) => ({
          serverId: server.id,
          serverName: server.name,
          node,
          type,
          vmid,
          name: pveString(s.name),
          description: pveString(s.description),
          parent: pveString(s.parent),
          snaptime: pveNumber(s.snaptime),
          snapstate: pveString(s.snapstate),
          /* vmstate: assente -> null (LXC non lo espone: non viene inventato) */
          vmstate: s.vmstate === null || s.vmstate === undefined ? null : pveFlag(s.vmstate),
        }))
        .sort((a, b) => (b.snaptime || 0) - (a.snaptime || 0));
      return json(res, { ok: true, snapshots });
    }

    /* POST /api/tasks/status { serverId, node, upid }
       READ-ONLY verso PVE: UNA richiesta -> UNA risposta, nessun loop/polling.
       UPID validato (formato PVE) e encoded come segmento di path. */
    if (p === '/api/tasks/status' && req.method === 'POST') {
      const b = await readBody(req);
      const serverId = typeof b.serverId === 'string' ? b.serverId.trim() : '';
      const node = typeof b.node === 'string' ? b.node.trim() : '';
      const upid = typeof b.upid === 'string' ? b.upid.trim() : '';
      if (!serverId) return json(res, { error: 'Parametri mancanti: serverId' }, 400);
      const server = config.servers.find((s) => s.id === serverId);
      if (!server) return json(res, { error: 'Server non trovato' }, 404);
      if (!node || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(node)) return json(res, { error: 'Nodo non valido' }, 400);
      if (!upid || upid.length > 600 ||
          !/^UPID:[A-Za-z0-9._-]+:[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}:[0-9A-Fa-f]{8}:[A-Za-z0-9_-]*:[0-9]*:[A-Za-z0-9@!._-]+:$/.test(upid)) {
        return json(res, { error: 'UPID non valido' }, 400);
      }
      const st = await api(server, 'GET',
        '/api2/json/nodes/' + encodeURIComponent(node) + '/tasks/' + encodeURIComponent(upid) + '/status');
      return json(res, {
        ok: true,
        serverId: server.id,
        node,
        upid,
        status: st ? st.status : null,
        exitstatus: st && st.exitstatus !== undefined && st.exitstatus !== null ? st.exitstatus : null,
        starttime: pveNumber(st && st.starttime),
        endtime: pveNumber(st && st.endtime),
        type: pveString(st && st.type),
        id: st && st.id ? st.id : null,
        user: pveString(st && st.user),
      });
    }

    /* POST /api/backup/create { serverId, node, vmid, storage, mode, compress, notes, protected }
       FASE 2: validazione completa PRIMA del POST vzdump; risponde subito con
       l'UPID (nessun polling backend). Payload PVE minimale e conservativo:
       niente remove/prune-backups/bwlimit/performance/ionice/script/tmpdir/job-id. */
    if (p === '/api/backup/create' && req.method === 'POST') {
      const b = await readBody(req);
      const serverId = typeof b.serverId === 'string' ? b.serverId.trim() : '';
      const node = typeof b.node === 'string' ? b.node.trim() : '';
      const storage = typeof b.storage === 'string' ? b.storage.trim() : '';
      const mode = typeof b.mode === 'string' ? b.mode.trim() : 'snapshot';
      const compress = typeof b.compress === 'string' ? b.compress.trim() : 'zstd';
      const notes = typeof b.notes === 'string' ? b.notes.trim() : '';
      const isProtected = b.protected;
      if (!serverId) return json(res, { error: 'Parametri mancanti: serverId' }, 400);
      const server = config.servers.find((s) => s.id === serverId);
      if (!server) return json(res, { error: 'Server non trovato' }, 404);
      if (!isValidNodeName(node)) return json(res, { error: 'Nodo non valido' }, 400);
      const vmid = Number(b.vmid);
      if (!Number.isInteger(vmid) || vmid <= 0) return json(res, { error: 'VMID non valido: intero positivo' }, 400);
      if (!storage) return json(res, { error: 'Parametri mancanti: storage' }, 400);
      if (!['snapshot', 'suspend', 'stop'].includes(mode)) return json(res, { error: 'Modalità non valida: snapshot, suspend o stop' }, 400);
      if (!Object.prototype.hasOwnProperty.call(PVE_COMPRESS, compress)) return json(res, { error: 'Compressione non valida: zstd, gzip, lzo o none' }, 400);
      if (notes && (notes.length > 256 || hasControlOrBackslash(notes) || notes.includes('{{'))) {
        return json(res, { error: 'Note non valide: massimo 256 caratteri, singola riga, nessun template' }, 400);
      }
      if (isProtected !== undefined && typeof isProtected !== 'boolean') {
        return json(res, { error: 'protected deve essere un booleano' }, 400);
      }
      /* storage reale compatibile per quel server/nodo: riusa l'helper di Fase 1
         (nessuna duplicazione, nessuna fiducia nel nome inviato dal client) */
      const targets = await backupStorageTargets(server);
      const target = targets.storages.find((st) => st.storage === storage && (st.node === node || (st.nodes || []).includes(node)));
      if (!target) {
        return json(res, { error: 'Storage non valido o non compatibile con i backup su questo nodo' }, 400);
      }
      /* guest esistente sul nodo: verifica read-only (azione on-demand, non polling) */
      if (!(await guestExists(server, node, vmid))) {
        return json(res, { error: 'Guest non trovato sul nodo indicato' }, 404);
      }
      const pveBody = { vmid: String(vmid), storage, mode, compress: PVE_COMPRESS[compress] };
      if (notes) pveBody['notes-template'] = notes;
      if (isProtected === true) pveBody.protected = 1;
      try {
        const upid = await api(server, 'POST', '/api2/json/nodes/' + encodeURIComponent(node) + '/vzdump', pveBody);
        if (upid) {
          alertEngine.trackTask(upid, server.id, node, 'backup',
            server.id + ':' + node + ':' + vmid, 'Guest ' + vmid);
        }
        return json(res, { ok: true, serverId: server.id, node, vmid, storage, upid: upid || null });
      } catch (e) {
        if (e.pveStatus === 403) {
          return json(res, { ok: false, forbidden: true, error: 'Permessi insufficienti per creare il backup: ' + e.message }, 403);
        }
        throw e;
      }
    }

    /* POST /api/snapshot/create { serverId, node, type, vmid, name, description, vmstate }
       FASE 2: validazione completa, verifica guest read-only e pre-check duplicati
       (409) PRIMA del POST PVE. vmstate solo QEMU; su LXC e' un errore 400. */
    if (p === '/api/snapshot/create' && req.method === 'POST') {
      const b = await readBody(req);
      const serverId = typeof b.serverId === 'string' ? b.serverId.trim() : '';
      const node = typeof b.node === 'string' ? b.node.trim() : '';
      const type = typeof b.type === 'string' ? b.type.trim() : '';
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      const description = typeof b.description === 'string' ? b.description.trim() : '';
      const vmstate = b.vmstate;
      if (!serverId) return json(res, { error: 'Parametri mancanti: serverId' }, 400);
      const server = config.servers.find((s) => s.id === serverId);
      if (!server) return json(res, { error: 'Server non trovato' }, 404);
      if (!isValidNodeName(node)) return json(res, { error: 'Nodo non valido' }, 400);
      if (type !== 'lxc' && type !== 'qemu') return json(res, { error: 'Tipo non valido: solo lxc o qemu' }, 400);
      const vmid = Number(b.vmid);
      if (!Number.isInteger(vmid) || vmid <= 0) return json(res, { error: 'VMID non valido: intero positivo' }, 400);
      if (!name) return json(res, { error: 'Parametri mancanti: name' }, 400);
      if (name === 'current' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)) {
        return json(res, { error: 'Nome snapshot non valido: max 63 caratteri, inizio alfanumerico, solo lettere, numeri, "_" e "-"' }, 400);
      }
      if (description && (description.length > 256 || hasControlOrBackslash(description))) {
        return json(res, { error: 'Descrizione non valida: massimo 256 caratteri' }, 400);
      }
      if (type === 'lxc' && vmstate !== undefined && vmstate !== null) {
        return json(res, { error: 'vmstate non supportato per LXC' }, 400);
      }
      if (vmstate !== undefined && vmstate !== null && typeof vmstate !== 'boolean') {
        return json(res, { error: 'vmstate deve essere un booleano' }, 400);
      }
      /* guest esistente sul nodo/type: verifica read-only (azione on-demand) */
      try {
        await api(server, 'GET', '/api2/json/nodes/' + encodeURIComponent(node) + '/' + type + '/' + vmid + '/status/current');
      } catch (e) {
        if (e.pveStatus === 403) {
          return json(res, { ok: false, forbidden: true, error: 'Permessi insufficienti: ' + e.message }, 403);
        }
        if (/does not exist/i.test(e.message)) {
          return json(res, { error: 'Guest non trovato sul nodo indicato' }, 404);
        }
        throw e;
      }
      /* pre-check duplicati read-only (la pseudo-entry current non e' considerata);
         un errore di lettura non blocca: PVE resta la validazione finale */
      try {
        const list = await api(server, 'GET', '/api2/json/nodes/' + encodeURIComponent(node) + '/' + type + '/' + vmid + '/snapshot');
        if ((list || []).some((s) => s && s.name === name)) {
          return json(res, { error: 'Esiste già uno snapshot con questo nome' }, 409);
        }
      } catch (e) {
        if (e.pveStatus === 403) {
          return json(res, { ok: false, forbidden: true, error: 'Permessi insufficienti: ' + e.message }, 403);
        }
      }
      const pveBody = { snapname: name };
      if (description) pveBody.description = description;
      if (type === 'qemu' && vmstate === true) pveBody.vmstate = 1;
      try {
        const upid = await api(server, 'POST', '/api2/json/nodes/' + encodeURIComponent(node) + '/' + type + '/' + vmid + '/snapshot', pveBody);
        if (upid) {
          alertEngine.trackTask(upid, server.id, node, 'snapshot',
            server.id + ':' + node + ':' + type + ':' + vmid, 'Guest ' + vmid);
        }
        return json(res, { ok: true, serverId: server.id, node, type, vmid, name, upid: upid || null });
      } catch (e) {
        if (e.pveStatus === 403) {
          return json(res, { ok: false, forbidden: true, error: 'Permessi insufficienti per creare lo snapshot: ' + e.message }, 403);
        }
        /* es. guest locked o storage senza supporto snapshot: messaggio PVE conservato */
        throw e;
      }
    }

    if (p === '/api/config') {
      return json(res, {
        servers: config.servers.map(sanitizeServer),
        refreshMs: config.refreshMs,
        autoRefreshEnabled: config.autoRefreshEnabled !== false,
        theme: config.theme || 'system',
        language: config.language || 'it',
        health: { guestModes: safeGuestModes(), settings: safeHealthSettings() },
        tourCompleted: state.tourCompleted,
        tourCompletedVersion: state.tourCompletedVersion || 0,
      });
    }

    if (p === '/api/prefs' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.theme !== undefined) {
        if (!['light', 'dark', 'system'].includes(b.theme)) throw new Error('Tema non valido');
        config.theme = b.theme;
      }
      if (b.language !== undefined) {
        if (!['it', 'en'].includes(b.language)) throw new Error('Lingua non valida');
        config.language = b.language;
      }
      saveConfig();
      return json(res, { ok: true, theme: config.theme, language: config.language });
    }

    if (p === '/api/health/prefs' && req.method === 'POST') {
      const b = await readBody(req);
      const key = typeof b.key === 'string' ? b.key.trim() : '';
      const mode = typeof b.mode === 'string' ? b.mode.trim() : '';
      const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];
      const parts = key.split(':');
      const serverId = parts[0];
      const node = parts[1];
      const type = parts[2];
      const vmidStr = parts[3];
      if (parts.length !== 4 || !serverId || !node || !type || !vmidStr) {
        return json(res, { error: 'Chiave non valida: atteso <serverId>:<node>:<type>:<vmid>' }, 400);
      }
      if (parts.some((part) => FORBIDDEN.includes(part))) {
        return json(res, { error: 'Chiave non valida' }, 400);
      }
      if (type !== 'lxc' && type !== 'qemu') {
        return json(res, { error: 'Tipo non valido: solo lxc o qemu' }, 400);
      }
      const vmid = Number(vmidStr);
      if (!Number.isInteger(vmid) || vmid <= 0) {
        return json(res, { error: 'VMID non valido: intero positivo' }, 400);
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(node)) {
        return json(res, { error: 'Nodo non valido' }, 400);
      }
      if (!['alwayson', 'manual', 'ignore'].includes(mode)) {
        return json(res, { error: 'Modalità non valida: alwayson, manual o ignore' }, 400);
      }
      if (!config.servers.some((s) => s.id === serverId)) {
        return json(res, { error: 'Server non configurato' }, 400);
      }
      const modes = safeGuestModes();
      if (mode === 'manual') {
        /* l'assenza della chiave equivale a manual: config.json resta pulito */
        delete modes[key];
      } else {
        modes[key] = mode;
      }
      saveConfig();
      return json(res, { ok: true, key, mode });
    }

    /* ---------- Health V2.0 Core: endpoint di sola lettura + settings ---------- */

    /* GET /api/health/storage[?serverId=<id>]
       Usage/attività di TUTTI gli storage per server. Errori parziali in
       "errors" (pattern multi-source dei Log), mai stack trace. */
    if (p === '/api/health/storage' && req.method === 'GET') {
      const serverId = (q.get('serverId') || '').trim() || null;
      if (serverId && !config.servers.some((s) => s.id === serverId)) {
        return json(res, { error: 'Server non trovato' }, 404);
      }
      const targets = serverId ? config.servers.filter((s) => s.id === serverId) : config.servers;
      const storages = [];
      const errors = [];
      await Promise.all(targets.map(async (s) => {
        try {
          const r = await healthStorageTargets(s);
          storages.push(...r.storages);
          errors.push(...r.errors);
        } catch (e) {
          errors.push({ serverId: s.id, serverName: s.name, error: e.message });
        }
      }));
      return json(res, { ok: true, storages, errors });
    }

    /* GET /api/health/zfs[?serverId=<id>]
       Pool ZFS + dettaglio (state/errors/scan). Nodo senza ZFS = nessun errore
       Health, semplicemente nessun pool per quel nodo. */
    if (p === '/api/health/zfs' && req.method === 'GET') {
      const serverId = (q.get('serverId') || '').trim() || null;
      if (serverId && !config.servers.some((s) => s.id === serverId)) {
        return json(res, { error: 'Server non trovato' }, 404);
      }
      const targets = serverId ? config.servers.filter((s) => s.id === serverId) : config.servers;
      const pools = [];
      const errors = [];
      await Promise.all(targets.map(async (s) => {
        try {
          pools.push(...await healthZfsPools(s));
        } catch (e) {
          errors.push({ serverId: s.id, serverName: s.name, error: e.message });
        }
      }));
      return json(res, { ok: true, pools, errors });
    }

    /* GET /api/health/cluster[?serverId=<id>]
       Quorum (solo cluster) e stato HA. Standalone: cluster=false, nessun
       warning "cluster non disponibile". */
    if (p === '/api/health/cluster' && req.method === 'GET') {
      const serverId = (q.get('serverId') || '').trim() || null;
      if (serverId && !config.servers.some((s) => s.id === serverId)) {
        return json(res, { error: 'Server non trovato' }, 404);
      }
      const targets = serverId ? config.servers.filter((s) => s.id === serverId) : config.servers;
      const serversOut = [];
      const errors = [];
      await Promise.all(targets.map(async (s) => {
        try {
          serversOut.push(await healthClusterEntry(s));
        } catch (e) {
          errors.push({ serverId: s.id, serverName: s.name, error: e.message });
        }
      }));
      return json(res, { ok: true, servers: serversOut, errors });
    }

    /* GET /api/health/disks[?serverId=<id>]
       Inventory SOLO (disks/list?skipsmart=1): NESSUNO smartctl, nessun
       risveglio di dischi. smartAvailable=null significa "SMART non ancora
       letto" (mai PASSED/UNKNOWN/FAILED inventati). Errori parziali. */
    if (p === '/api/health/disks' && req.method === 'GET') {
      const serverId = (q.get('serverId') || '').trim() || null;
      if (serverId && !config.servers.some((s) => s.id === serverId)) {
        return json(res, { error: 'Server non trovato' }, 404);
      }
      const targets = serverId ? config.servers.filter((s) => s.id === serverId) : config.servers;
      const disks = [];
      const errors = [];
      await Promise.all(targets.map(async (s) => {
        try {
          const nodes = await api(s, 'GET', '/api2/json/nodes');
          await Promise.all((nodes || []).map(async (n) => {
            try {
              const list = await api(s, 'GET', '/api2/json/nodes/' + encodeURIComponent(n.node) + '/disks/list?skipsmart=1');
              for (const raw of (list || [])) {
                disks.push({
                  serverId: s.id,
                  serverName: s.name,
                  node: n.node,
                  devpath: pveString(raw.devpath),
                  type: pveString(raw.type),
                  model: pveString(raw.model),
                  serial: pveString(raw.serial),
                  size: pveNumber(raw.size),
                  vendor: pveString(raw.vendor),
                  rpm: pveNumber(raw.rpm),
                  used: pveString(raw.used),
                  gpt: pveFlag(raw.gpt),
                  /* SMART NON ancora interrogato per questa sessione/cache */
                  smartAvailable: null,
                });
              }
            } catch (e) {
              errors.push({ serverId: s.id, serverName: s.name, node: n.node, error: e.message });
            }
          }));
        } catch (e) {
          errors.push({ serverId: s.id, serverName: s.name, error: e.message });
        }
      }));
      return json(res, { ok: true, disks, errors });
    }

    /* GET /api/health/smart?serverId=&node=&disk=
       SMART on-demand per UN disco (chiamato SOLO su espansione utente).
       1) sintassi devpath; 2) il disco deve appartenere all'inventory del nodo
       (verifica skipsmart, zero spin-up); 3) poi smart PVE healthonly=0.
       Risposta normalizzata, mai la risposta PVE grezza come struttura primaria. */
    if (p === '/api/health/smart' && req.method === 'GET') {
      const serverId = (q.get('serverId') || '').trim();
      const node = (q.get('node') || '').trim();
      const disk = (q.get('disk') || '').trim();
      if (!serverId || !node || !disk) {
        return json(res, { error: 'Parametri mancanti: serverId, node, disk' }, 400);
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(node)) {
        return json(res, { error: 'Nodo non valido' }, 400);
      }
      if (!disk.startsWith('/dev/') || disk.length <= 5 || !/^[A-Za-z0-9/_-]+$/.test(disk.slice(5))) {
        return json(res, { error: 'Percorso disco non valido' }, 400);
      }
      const server = config.servers.find((s) => s.id === serverId);
      if (!server) return json(res, { error: 'Server non trovato' }, 404);
      let listed = false;
      try {
        const list = await api(server, 'GET', '/api2/json/nodes/' + encodeURIComponent(node) + '/disks/list?skipsmart=1');
        listed = Array.isArray(list) && list.some((d) => (d.devpath || ('/dev/' + d.name)) === disk);
      } catch (e) {
        return json(res, { ok: false, error: 'Inventario dischi non disponibile: ' + e.message }, 502);
      }
      if (!listed) {
        return json(res, { ok: false, error: 'Disco non presente sul nodo indicato' }, 404);
      }
      let raw;
      try {
        raw = await api(server, 'GET', '/api2/json/nodes/' + encodeURIComponent(node) + '/disks/smart?disk=' + encodeURIComponent(disk) + '&healthonly=0');
      } catch (e) {
        /* errore PVE (disco sparito, permessi, smartctl fallito): risposta
           controllata con smartAvailable=false, MAI stack trace */
        return json(res, {
          ok: true,
          smart: {
            checkedAt: Math.floor(Date.now() / 1000),
            health: 'UNKNOWN',
            smartAvailable: false,
            type: null,
            temperature: null,
            powerOnHours: null,
            wearRemaining: null,
            reallocated: null,
            pending: null,
            offlineUncorrectable: null,
            rawAttributes: null,
            rawText: null,
          },
        });
      }
      const smart = normalizeSmartReading(raw);
      /* Alert Engine: SMART on-demand, MAI automatico. La lettura esplicita
         dell'utente genera eventi (failed/settori/temp/wear). */
      try {
        alertEngine.observeSmart(smart, {
          serverId: server.id,
          serverName: server.name,
          node,
          disk,
        });
      } catch (e) {
        console.error('[alert-engine] observeSmart fallito: ' + e.message);
      }
      return json(res, { ok: true, smart });
    }

    /* POST /api/health/settings
       Soglie configurabili: storage %, età backup giorni, swap %, dischi
       (temperatura + vita residua). Body parziale ammesso (anche su gruppi
       annidati); {reset:true} ripristina i default. Mai health.guestModes. */
    if (p === '/api/health/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.reset === true) {
        const h = config.health && typeof config.health === 'object' ? config.health : {};
        config.health = { ...h, settings: JSON.parse(JSON.stringify(HEALTH_SETTING_DEFAULTS)) };
        saveConfig();
        return json(res, { ok: true, settings: safeHealthSettings() });
      }
      const current = safeHealthSettings();
      const candidate = JSON.parse(JSON.stringify(current));
      const provided = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
      const patches = [];
      const collectLeaves = (group, def, user, path) => {
        for (const key of Object.keys(def)) {
          const p = path ? path + '.' + key : key;
          const u = user && typeof user === 'object' && !Array.isArray(user) ? user[key] : undefined;
          if (u === undefined) continue;
          if (def[key] && typeof def[key] === 'object' && !Array.isArray(def[key])) {
            if (typeof u !== 'object' || Array.isArray(u)) {
              return 'Impostazioni non valide: ' + p;
            }
            const err = collectLeaves(group, def[key], u, p);
            if (err) return err;
          } else {
            const v = Number(u);
            if (!Number.isFinite(v)) return 'Valore non valido per ' + p;
            patches.push({ group, keys: path ? path.split('.') : [], key, value: v });
          }
        }
        return null;
      };
      for (const group of Object.keys(HEALTH_SETTING_DEFAULTS)) {
        const pg = provided[group];
        if (pg === undefined || pg === null) continue;
        if (typeof pg !== 'object' || Array.isArray(pg)) {
          return json(res, { error: 'Impostazioni non valide: ' + group }, 400);
        }
        const err = collectLeaves(group, HEALTH_SETTING_DEFAULTS[group], pg, '');
        if (err) return json(res, { error: err }, 400);
      }
      for (const patchEntry of patches) {
        let target = candidate[patchEntry.group];
        for (const k of patchEntry.keys) target = target[k];
        target[patchEntry.key] = patchEntry.value;
      }
      for (const [group, valid] of Object.entries(HEALTH_SETTING_VALIDATORS)) {
        if (!valid(candidate[group])) {
          return json(res, { error: 'Impostazioni non valide per ' + group + ': warning < critical e range consentiti' }, 400);
        }
      }
      const h = config.health && typeof config.health === 'object' ? config.health : {};
      config.health = { ...h, settings: candidate };
      saveConfig();
      return json(res, { ok: true, settings: safeHealthSettings() });
    }

    /* ---------- Notification Center (v1.3.0 FASE 1: backend core) ----------
       Il frontend NON genera eventi: legge e interagisce. L'Alert Engine
       scrive via notificationsStore.add() solo su transizioni di stato. */
    if (p === '/api/notifications' && req.method === 'GET') {
      const list = notificationsStore.list();
      return json(res, { ok: true, notifications: list.notifications, unreadCount: list.unreadCount });
    }

    if (p === '/api/notifications/read-all' && req.method === 'POST') {
      notificationsStore.markAllRead();
      return json(res, { ok: true });
    }

    if (p === '/api/notifications/clear' && req.method === 'POST') {
      notificationsStore.clear();
      return json(res, { ok: true });
    }

    if (p.startsWith('/api/notifications/') && p.endsWith('/read') && req.method === 'POST') {
      const id = decodeURIComponent(p.split('/')[3]);
      const found = notificationsStore.markRead(id);
      if (!found) return json(res, { ok: false, error: 'Notifica non trovata' }, 404);
      return json(res, { ok: true });
    }

    if (p.startsWith('/api/notifications/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.split('/')[3]);
      const found = notificationsStore.remove(id);
      if (!found) return json(res, { ok: false, error: 'Notifica non trovata' }, 404);
      return json(res, { ok: true });
    }

    /* ---------- Notification settings (FASE 2A: Telegram backend-only) ---------- */

    if (p === '/api/notifications/settings' && req.method === 'GET') {
      return json(res, {
        ok: true,
        center: safeNotificationsSettings().center,
        telegram: publicTelegramSettings(),
      });
    }

    if (p === '/api/notifications/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return json(res, { error: 'Body non valido' }, 400);
      }
      const current = safeTelegramSettings();
      const next = {
        enabled: current.enabled,
        botToken: current.botToken,
        chatId: current.chatId,
        language: current.language,
        events: Object.assign({}, current.events),
      };

      /* center.enabled (UI, FASE 2B): accettato per compatibilità futura */
      if (b.center !== undefined) {
        if (!b.center || typeof b.center !== 'object' || Array.isArray(b.center)) {
          return json(res, { error: 'center non valido' }, 400);
        }
        if (b.center.enabled !== undefined && typeof b.center.enabled !== 'boolean') {
          return json(res, { error: 'center.enabled deve essere booleano' }, 400);
        }
      }

      const t = b.telegram !== undefined ? b.telegram : null;
      if (t !== null) {
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
          return json(res, { error: 'telegram non valido' }, 400);
        }
        if (t.enabled !== undefined && typeof t.enabled !== 'boolean') {
          return json(res, { error: 'telegram.enabled deve essere booleano' }, 400);
        }
        if (t.chatId !== undefined) {
          const cid = typeof t.chatId === 'string' ? t.chatId.trim() : '';
          /* formato Telegram ragionevole: id numerico o @username */
          const chatOk = /^-?d{4,15}$/.test(cid) || /^@[A-Za-z0-9_]{4,32}$/.test(cid);
          if (!chatOk) {
            return json(res, { error: 'chatId non valido' }, 400);
          }
          next.chatId = cid;
        }
        if (t.language !== undefined && t.language !== 'it' && t.language !== 'en') {
          return json(res, { error: 'language non valido: solo it o en' }, 400);
        }
        if (t.language === 'it' || t.language === 'en') next.language = t.language;
        if (t.events !== undefined) {
          if (!t.events || typeof t.events !== 'object' || Array.isArray(t.events)) {
            return json(res, { error: 'events non valido' }, 400);
          }
          for (const k of Object.keys(t.events)) {
            if (!TELEGRAM_EVENT_KEYS.includes(k)) {
              return json(res, { error: 'chiave evento sconosciuta: ' + k }, 400);
            }
            if (typeof t.events[k] !== 'boolean') {
              return json(res, { error: 'events.' + k + ' deve essere booleano' }, 400);
            }
            next.events[k] = t.events[k];
          }
        }
        /* token: presente valido -> sostituisce; assente o "" -> conserva;
           clearToken:true -> rimuove. MAI restituito. */
        if (t.clearToken === true) {
          next.botToken = '';
        } else if (t.botToken !== undefined && t.botToken !== '') {
          if (typeof t.botToken !== 'string' || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(t.botToken)) {
            return json(res, { error: 'botToken non valido' }, 400);
          }
          next.botToken = t.botToken;
        }
        if (t.enabled === true) {
          next.enabled = true;
        } else if (t.enabled === false) {
          next.enabled = false;
        }
      }

      /* salva SOLO config.notifications.telegram: nessun altro settore toccato */
      const n = config.notifications && typeof config.notifications === 'object' ? config.notifications : {};
      config.notifications = Object.assign({}, n, {
        telegram: next,
      });
      if (b.center !== undefined && b.center.enabled !== undefined) {
        const c = n.center && typeof n.center === 'object' ? n.center : {};
        config.notifications.center = Object.assign({}, c, { enabled: b.center.enabled });
      }
      saveConfig();
      return json(res, {
        ok: true,
        center: safeNotificationsSettings().center,
        telegram: publicTelegramSettings(),
      });
    }

    /* ---------- POST /api/notifications/test (FASE 2A) ---------- */
    if (p === '/api/notifications/test' && req.method === 'POST') {
        const ip = clientIp(req);
        const last = telegramTestRate.get(ip) || 0;
        const elapsed = Date.now() - last;
        if (elapsed < 60 * 1000) {
          return json(res, {
            ok: false,
            provider: 'telegram',
            code: 'rate_limited',
            retryAfter: Math.ceil((60 * 1000 - elapsed) / 1000),
          }, 429);
        }
        const set = safeTelegramSettings();
        if (!set.enabled) {
          return json(res, { ok: false, provider: 'telegram', code: 'disabled' }, 400);
        }
        if (!set.botToken || !set.chatId) {
          return json(res, { ok: false, provider: 'telegram', code: 'not_configured' }, 400);
        }
        telegramTestRate.set(ip, Date.now());
        const text = '🧪 TEST — NodePilot\n' +
          (set.language === 'en' ? 'Test notification at ' : 'Notifica di test alle ') +
          new Date().toLocaleString(set.language === 'en' ? 'en-GB' : 'it-IT');
        const sender = telegramMod.createTelegramSender();
        const res2 = await sender.sendMessage(set.botToken, set.chatId, text);
        if (res2.ok) {
          return json(res, { ok: true, provider: 'telegram' });
        }
        /* errori sanitizzati: MAI body/URL/token Telegram */
        const codeMap = {
          unauthorized: 'unauthorized',
          forbidden: 'forbidden',
          chat_not_found: 'chat_not_found',
          rate_limited: 'rate_limited',
          invalid_request: 'invalid_settings',
          telegram_unavailable: 'telegram_unavailable',
        };
        const code = codeMap[res2.code] || (res2.code && res2.code.startsWith('telegram_error') ? 'telegram_unavailable' : 'network_error');
        const status = res2.code === 'unauthorized' ? 401 : 400;
        return json(res, { ok: false, provider: 'telegram', code }, status);
      }

    if (p === '/api/autorefresh' && req.method === 'POST') {
      const b = await readBody(req);
      config.autoRefreshEnabled = !!b.enabled;
      saveConfig();
      return json(res, { ok: true, autoRefreshEnabled: config.autoRefreshEnabled });
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      const b = await readBody(req);
      const allowed = [5000, 10000, 15000, 20000, 30000, 60000];
      const ms = Number(b.refreshMs);
      if (!allowed.includes(ms)) throw new Error('Intervallo non valido');
      config.refreshMs = ms;
      saveConfig();
      return json(res, { ok: true, refreshMs: config.refreshMs });
    }

    if (p === '/api/state') {
      return json(res, { tourCompleted: state.tourCompleted, tourCompletedVersion: state.tourCompletedVersion || 0 });
    }

    if (p === '/api/tour/complete' && req.method === 'POST') {
      const b = await readBody(req);
      const version = Number.isInteger(Number(b.version)) ? Number(b.version) : 1;
      state.tourCompleted = true;
      state.tourCompletedVersion = Math.max(state.tourCompletedVersion || 0, version);
      saveState();
      statusCache = null;
      return json(res, { ok: true, tourCompleted: true, tourCompletedVersion: state.tourCompletedVersion });
    }

    /* Deprecato (release Technical Cleanup): non riattiva più alcuna modalità demo.
       Il Tour V2 si riavvia client-side (startTour) e gira solo sui dati reali. */
    if (p === '/api/tour/restart' && req.method === 'POST') {
      return json(res, { ok: true, demo: false, deprecated: true });
    }

    if (p === '/api/servers' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.name || !b.url || !b.user) throw new Error('Nome, URL e utente sono obbligatori');
      let s = config.servers.find((x) => x.id === b.id);
      if (!s) {
        s = { id: b.id || crypto.randomUUID() };
        config.servers.push(s);
      }
      s.name = b.name.trim();
      s.url = b.url.trim().replace(/\/+$/, '');
      s.user = b.user.trim();
      s.verifyTls = b.verifyTls !== false;
      if (b.password) s.password = b.password;
      saveConfig();
      statusCache = null;
      return json(res, { ok: true, server: sanitizeServer(s) });
    }

    if (p.startsWith('/api/servers/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.split('/')[3]);
      config.servers = config.servers.filter((s) => s.id !== id);
      saveConfig();
      statusCache = null;
      return json(res, { ok: true });
    }

    if (p === '/api/test' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.url || !b.user || !b.password) throw new Error('URL, utente e password sono obbligatori');
      const tmp = { url: b.url.trim().replace(/\/+$/, ''), user: b.user.trim(), password: b.password, verifyTls: b.verifyTls !== false };
      await login(tmp);
      const version = await api(tmp, 'GET', '/api2/json/version');
      return json(res, { ok: true, version: version.version, release: version.release });
    }

    if (p === '/api/action' && req.method === 'POST') {
      const b = await readBody(req);
      const s = config.servers.find((x) => x.id === b.serverId);
      if (!s) throw new Error('Server non trovato');
      const allowed = ['start', 'stop', 'reboot', 'shutdown', 'suspend', 'resume'];
      if (!allowed.includes(b.action)) throw new Error('Azione non valida');
      const type = b.type === 'lxc' ? 'lxc' : 'qemu';
      const upid = await api(s, 'POST', '/api2/json/nodes/' + encodeURIComponent(b.node) + '/' + type + '/' + b.vmid + '/status/' + b.action);
      let taskDone = false;
      if (upid) {
        for (let i = 0; i < 40; i++) {
          await new Promise((r2) => setTimeout(r2, 750));
          try {
            const st = await api(s, 'GET', '/api2/json/nodes/' + encodeURIComponent(b.node) + '/tasks/' + encodeURIComponent(upid) + '/status');
            if (st && (st.status === 'stopped' || st.exitstatus !== undefined)) {
              if (st.exitstatus && st.exitstatus !== 'OK') {
                throw new Error('Proxmox task fallito: exitstatus=' + st.exitstatus);
              }
              taskDone = true;
              break;
            }
          } catch (e) {
            if (/task/i.test(e.message)) break;
          }
        }
      }
      statusCache = null;
      return json(res, { ok: true, upid: upid || null, taskDone });
    }

    /* Console VNC per VM QEMU: due fasi.
       Fase 1 (questo endpoint): valida, crea il vncproxy PVE, genera un prepId
       opaco casuale e restituisce SOLO prepId + credenziali RFB temporanee.
       Eredita guard di sessione, Origin validation, security headers e no-store. */
    if (p === '/api/vnc/prep' && req.method === 'POST') {
      const b = await readBody(req);
      const serverId = typeof b.serverId === 'string' ? b.serverId : '';
      const node = typeof b.node === 'string' ? b.node.trim() : '';
      const vmid = Number(b.vmid);
      const s = config.servers.find((x) => x.id === serverId);
      if (!s || !isValidNodeName(node) || !Number.isInteger(vmid) || vmid < 1) {
        return json(res, { ok: false, code: 'INVALID_REQUEST', error: 'Richiesta non valida' }, 400);
      }
      /* cleanup lazy delle voci scadute (nessun timer globale) */
      const vncNow = Date.now();
      for (const [k, v] of vncPreps) {
        if (vncNow - v.createdAt > VNC_PREP_TTL_MS) vncPreps.delete(k);
      }
      try {
        const vp = await api(s, 'POST', '/api2/json/nodes/' + encodeURIComponent(node) + '/qemu/' + vmid + '/vncproxy', { websocket: 1 });
        if (!vp || !vp.ticket || !vp.port) {
          return json(res, { ok: false, code: 'CONSOLE_UNAVAILABLE', error: 'Console non disponibile' }, 409);
        }
        const prepId = crypto.randomBytes(32).toString('base64url');
        vncPreps.set(prepId, {
          serverId: s.id,
          node,
          vmid,
          ticket: vp.ticket,
          port: vp.port,
          user: typeof vp.user === 'string' ? vp.user : '',
          password: typeof vp.password === 'string' ? vp.password : null,
          createdAt: Date.now(),
        });
        /* su PVE >= 9.1.8 esiste il password dedicato (il ticket resta backend-only);
           su PVE precedenti fallback al ticket, necessario all'handshake RFB. */
        return json(res, {
          ok: true,
          prepId,
          credentials: {
            username: typeof vp.user === 'string' ? vp.user : '',
            password: typeof vp.password === 'string' ? vp.password : vp.ticket,
          },
          ttlMs: VNC_PREP_TTL_MS,
        });
      } catch (e) {
        if (e.pveStatus === 403) {
          return json(res, { ok: false, code: 'VNC_FORBIDDEN', error: 'Permessi insufficienti' }, 403);
        }
        if (e.pveStatus === 404 || /does not exist/i.test(e.message)) {
          return json(res, { ok: false, code: 'GUEST_NOT_FOUND', error: 'Guest non trovato' }, 404);
        }
        if (e.code && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET'].includes(e.code)) {
          return json(res, { ok: false, code: 'PROXMOX_UNAVAILABLE', error: 'Connessione a Proxmox non disponibile' }, 502);
        }
        /* qualsiasi altro errore PVE su vncproxy (es. VM ferma o display seriale):
           console non disponibile, messaggio PVE reale solo nei log del server */
        if (e.pveStatus) {
          console.error('[vnc] prep fallito server=' + s.id + ' node=' + node + ' vmid=' + vmid + ' pveStatus=' + e.pveStatus + ' motivo=' + String(e.message).slice(0, 120));
          return json(res, { ok: false, code: 'CONSOLE_UNAVAILABLE', error: 'Console non disponibile' }, 409);
        }
        console.error('[vnc] prep fallito server=' + s.id + ' node=' + node + ' vmid=' + vmid + ' motivo=' + String(e.message).slice(0, 120));
        return json(res, { ok: false, code: 'VNC_INTERNAL_ERROR', error: 'Errore interno' }, 500);
      }
    }

    if (p.startsWith('/api/')) return json(res, { error: 'Non trovato' }, 404);
    return serveStatic(req, res, p);
  } catch (e) {
    return json(res, { error: e.message }, 500);
  }
});

/* ---------- proxy WebSocket per la console LXC (termproxy VNC) ---------- */

const { WebSocket: PveWebSocket, WebSocketServer } = require('ws');

/* risposta di rifiuto sul socket prima dell'upgrade (stesso formato della Shell) */
function wsUpgradeError(socket, statusLine) {
  socket.write('HTTP/1.1 ' + statusLine + '\r\n' + rawSecurityHeaders() + '\r\n');
  socket.destroy();
}

/* ---------- proxy WebSocket per la console VNC (QEMU, noVNC) ---------- */

/* Fase 2: tunnel binario trasparente. Il client presenta il prepId della fase 1;
   sessione e Origin sono verificate PRIMA dell'upgrade; la voce prep e'
   single-use con TTL. Nessun auth frame (il frame user:ticket e' solo Shell),
   l'handshake RFB/VeNCrypt e' gestito da noVNC end-to-end. */
async function handleVncUpgrade(req, socket, head, url) {
  if (!getSession(req)) {
    wsUpgradeError(socket, '401 Unauthorized');
    return;
  }
  const wsOrigin = req.headers.origin || req.headers.referer;
  if (wsOrigin && !isSameOriginHeader(wsOrigin, req)) {
    wsUpgradeError(socket, '403 Forbidden');
    return;
  }
  const prepId = url.searchParams.get('prepId');
  if (!prepId) {
    wsUpgradeError(socket, '400 Bad Request');
    return;
  }
  const prep = vncPreps.get(prepId);
  if (!prep) {
    wsUpgradeError(socket, '404 Not Found');
    return;
  }
  if (Date.now() - prep.createdAt > VNC_PREP_TTL_MS) {
    vncPreps.delete(prepId);
    wsUpgradeError(socket, '410 Gone');
    return;
  }
  /* single-use: la voce viene eliminata PRIMA di usare il ticket */
  vncPreps.delete(prepId);
  const s = config.servers.find((x) => x.id === prep.serverId);
  if (!s || !s._session) {
    wsUpgradeError(socket, '502 Bad Gateway');
    return;
  }
  try {
    /* il vncticket esiste SOLO in questo URL backend->Proxmox: non raggiunge mai il browser */
    const pveUrl = s.url.replace(/\/+$/, '') + '/api2/json/nodes/' + encodeURIComponent(prep.node) + '/qemu/' + prep.vmid + '/vncwebsocket?port=' + encodeURIComponent(prep.port) + '&vncticket=' + encodeURIComponent(prep.ticket);
    const pveWs = new PveWebSocket(pveUrl, {
      headers: {
        Cookie: 'PVEAuthCookie=' + s._session.ticket,
        Origin: s.url.replace(/\/+$/, ''),
      },
      rejectUnauthorized: s.verifyTls !== false,
      perMessageDeflate: false,
      handshakeTimeout: 15000,
    });
    await new Promise((resolve, reject) => {
      pveWs.once('open', resolve);
      pveWs.once('error', reject);
    });
    console.log('[vnc] upstream connesso');
    const clientWs = new WebSocketServer({ noServer: true });
    clientWs.handleUpgrade(req, socket, head, (ws) => {
      ws.binaryType = 'arraybuffer';
      console.log('[vnc] client connesso');
      const relay = { type: 'vnc', ws, pveWs };
      activeWsRelays.add(relay);
      const cleanup = () => activeWsRelays.delete(relay);
      ws.on('message', (data) => {
        if (pveWs.readyState === PveWebSocket.OPEN) pveWs.send(data);
      });
      ws.on('close', (code) => { console.log('[vnc] client chiuso', code); cleanup(); pveWs.close(); });
      ws.on('error', (e) => { console.log('[vnc] client error', e.message); cleanup(); pveWs.close(); });
      pveWs.on('message', (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });
      pveWs.on('close', (code) => { console.log('[vnc] pve chiuso', code); cleanup(); ws.close(); });
      pveWs.on('error', (e) => { console.log('[vnc] pve error', e.message); cleanup(); ws.close(); });
    });
  } catch (e) {
    console.error('[vnc] errore upgrade:', e.message);
    wsUpgradeError(socket, '502 Bad Gateway');
  }
}

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  /* dispatcher: Shell LXC (handler invariato) e Console VNC QEMU */
  if (url.pathname === '/api/vnc/ws') {
    return handleVncUpgrade(req, socket, head, url);
  }
  if (url.pathname !== '/api/shell/ws') {
    socket.destroy();
    return;
  }
  /* Fase 3: la Shell richiede una sessione NodePilot valida PRIMA dell'upgrade.
     Protocollo termproxy/vncwebsocket, auth frame PVE, resize e keepalive restano
     esattamente invariati. */
  if (!getSession(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n' + rawSecurityHeaders() + '\r\n');
    socket.destroy();
    return;
  }
  /* Fase 2: Origin validation prima dell'upgrade (i browser inviano sempre Origin
     sul WebSocket; client senza Origin/Referer restano ammessi per compatibilità). */
  const wsOrigin = req.headers.origin || req.headers.referer;
  if (wsOrigin && !isSameOriginHeader(wsOrigin, req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n' + rawSecurityHeaders() + '\r\n');
    socket.destroy();
    return;
  }
  const q = url.searchParams;
  const serverId = q.get('serverId');
  const node = q.get('node');
  const vmid = q.get('vmid');
  const type = q.get('type') === 'lxc' ? 'lxc' : 'qemu';
  const s = config.servers.find((x) => x.id === serverId);
  if (!s || !node || !vmid) {
    socket.write('HTTP/1.1 400 Bad Request\r\n' + rawSecurityHeaders() + '\r\n');
    socket.destroy();
    return;
  }
  try {
    /* crea il termproxy SOLO ora, con il client già in handshake:
       evita il timeout di Proxmox ("failed waiting for client") */
    const tp = await api(s, 'POST', '/api2/json/nodes/' + encodeURIComponent(node) + '/' + type + '/' + vmid + '/termproxy');
    if (!tp || !tp.ticket || !tp.port) throw new Error('Impossibile creare la sessione console');
    const port = tp.port;
    const vncticket = tp.ticket;
    /* piccola attesa: il termproxy deve aprire la porta prima della connessione */

    const pveUrl = s.url.replace(/\/+$/, '') + '/api2/json/nodes/' + encodeURIComponent(node) + '/' + type + '/' + vmid + '/vncwebsocket?port=' + encodeURIComponent(port) + '&vncticket=' + encodeURIComponent(vncticket);
    const pveWs = new PveWebSocket(pveUrl, {
      headers: {
        Cookie: 'PVEAuthCookie=' + s._session.ticket,
        Origin: s.url.replace(/\/+$/, ''),
      },
      rejectUnauthorized: s.verifyTls !== false,
      perMessageDeflate: false,
      handshakeTimeout: 15000,
    });
    await new Promise((resolve, reject) => {
      pveWs.once('open', resolve);
      pveWs.once('error', reject);
    });
    /* con --vncticket-endpoint, Proxmox richiede il ticket VNC come PRIMO
       messaggio WebSocket (non solo nell'URL), altrimenti chiude con
       "failed reading ticket: authentication data is invalid" */
    pveWs.send(Buffer.from(tp.user + ':' + tp.ticket + '\n'), { binary: true });
    console.log('[shell] upstream connesso, porta', port, '| ticket inviato');
    const clientWs = new WebSocketServer({ noServer: true });
    clientWs.handleUpgrade(req, socket, head, (ws) => {
      ws.binaryType = 'arraybuffer';
      console.log('[shell] client connesso');
      const relay = { type: 'shell', ws, pveWs };
      activeWsRelays.add(relay);
      const cleanup = () => activeWsRelays.delete(relay);
      ws.on('message', (data) => {
        if (pveWs.readyState === PveWebSocket.OPEN) pveWs.send(data);
      });
      ws.on('close', (code) => { console.log('[shell] client chiuso', code); cleanup(); pveWs.close(); });
      ws.on('error', (e) => { console.log('[shell] client error', e.message); cleanup(); pveWs.close(); });
      pveWs.on('message', (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      });
      pveWs.on('close', (code) => { console.log('[shell] pve chiuso', code); cleanup(); ws.close(); });
      pveWs.on('error', (e) => { console.log('[shell] pve error', e.message); cleanup(); ws.close(); });
    });
  } catch (e) {
    console.error('[shell] errore upgrade:', e.message);
    socket.write('HTTP/1.1 502 Bad Gateway\r\n' + rawSecurityHeaders() + '\r\n');
    socket.destroy();
  }
});

loadConfig();
loadState();
loadAuth();

/* ---------------- Notification Center & Alert Engine (v1.3.0 FASE 1) ---------------- */

const notificationsStore = notificationsMod.createNotifications({});
notificationsStore.load();

/* Delivery Telegram: reconciliation startup — i record rimasti 'pending'
   da un processo precedente diventano failed/interrupted (nessun reinvio:
   un retry dopo restart potrebbe duplicare messaggi già consegnati). */
{
  const n = notificationsStore.reconcilePendingDeliveries('telegram');
  if (n > 0) console.log('[telegram] ' + n + ' delivery pending riconciliati come interrupted');
}

/* rate limit in-memory POST /api/notifications/test: 1 ogni 60s per IP */
const telegramTestRate = new Map();

/* Telegram delivery (FASE 2A): consumer dello store, indipendente da
   center.enabled e dal browser. Coda concorrenza 1, isolata dal tick. */
const telegramDelivery = telegramMod.createTelegramDelivery({
  getSettings: () => safeTelegramSettings(),
  updateDelivery: (id, status) => notificationsStore.updateDelivery(id, status.provider, status.status, status),
  log: (...args) => console.log(...args),
});

const alertEngine = alertEngineMod.createAlertEngine({
  notify: (rec) => {
    const item = notificationsStore.add(rec);
    if (item) telegramDelivery.enqueue(item);
  },
  getSettings: () => safeHealthSettings(),
  collectors: {
    getStatus: () => getStatus(),
    getStorage: () => collectStorage(),
    getZfs: () => collectZfs(),
    getCluster: () => collectCluster(),
    getTasks: () => collectTaskEvents(),
    getBackupAge: () => collectBackupAge(),
    getTaskStatus: async ({ serverId, node, upid }) => {
      const server = config.servers.find((s) => s.id === serverId);
      if (!server) return { status: 'notfound' }; /* server rimosso: task non più monitorabile */
      try {
        return await fetchTaskStatus(server, node, upid);
      } catch (e) {
        /* PVE 404 = task non più reperibile (es. task purgato o VM rimossa):
           stato normalizzato per la classificazione terminale dell'engine */
        if (e && e.pveStatus === 404) return { status: 'notfound' };
        throw e; /* errori di rete/5xx: riprova al tick successivo */
      }
    },
  },
  log: (...args) => console.log(...args),
});

server.listen(PORT, () => {
  console.log('');
  console.log('  NodePilot avviata');
  console.log('  http://localhost:' + PORT);
  console.log('  Tour completato: ' + state.tourCompleted);
  console.log('');
  alertEngine.start();
});

const activeSockets = new Set();
server.on('connection', (socket) => {
  activeSockets.add(socket);
  socket.on('close', () => activeSockets.delete(socket));
});

let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n[server] Ricevuto segnale ' + signal + ': avvio chiusura ordinata...');

  /* 0. Stop watchdog: nessun timer, nessuna chiamata PVE dopo shutdown */
  alertEngine.stop();
  /* 0b. Flush bounded della coda Telegram (max 2s), poi nessun invio */
  telegramDelivery.stop();

  /* 1. Hard timeout di sicurezza massimo 5 secondi per garantire l\x27uscita */
  const hardTimeout = setTimeout(() => {
    console.error('[server] Timeout di arresto (5s) superato: terminazione forzata.');
    process.exit(1);
  }, 5000);
  if (typeof hardTimeout.unref === 'function') hardTimeout.unref();

  /* 2. Chiusura ordinata delle sessioni WebSocket attive (VNC e Shell) con codice 1001 */
  for (const relay of activeWsRelays) {
    try {
      if (relay.ws && relay.ws.readyState === PveWebSocket.OPEN) {
        relay.ws.close(1001, 'Server shutting down');
      }
    } catch (_) {}
    try {
      if (relay.pveWs && relay.pveWs.readyState === PveWebSocket.OPEN) {
        relay.pveWs.close();
      }
    } catch (_) {}
  }
  activeWsRelays.clear();

  /* 3. Stop ricezione nuove connessioni HTTP */
  server.close((err) => {
    clearTimeout(hardTimeout);
    if (err) {
      console.error('[server] Errore durante la chiusura del server HTTP:', err.message);
      process.exit(1);
    }
    console.log('[server] Chiusura completata con successo.');
    process.exit(0);
  });

  /* 4. Grace period per le richieste HTTP residue prima del fallback finale sui socket */
  const graceTimer = setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    } else {
      for (const socket of activeSockets) {
        socket.destroy();
      }
    }
  }, 1500);
  if (typeof graceTimer.unref === 'function') graceTimer.unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
