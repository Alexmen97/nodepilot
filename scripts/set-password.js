'use strict';

/* Setup password amministratore NodePilot.
   Interattivo, senza echo della password, salva SOLO l'hash scrypt in auth.json.
   Riusabile anche per il recovery della password. Nessun secret nei log. */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const AUTH_PATH = path.join(__dirname, '..', 'auth.json');
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function askHidden(rl, question) {
  return new Promise((resolve) => {
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => {
      /* lascia passare solo il prompt e le righe vuote/control: la digitazione resta invisibile */
      if (s === question || !s.trim()) write(s);
    };
    rl.question(question, (ans) => resolve(ans));
  });
}

function validate(username, p1, p2) {
  if (username.length > 64 || /[^A-Za-z0-9._-]/.test(username)) {
    console.error('Username non valido: max 64 caratteri, solo lettere, numeri, punto, underscore, trattino.');
    process.exit(1);
  }
  if (!p1 || p1.length < 8) {
    console.error('Password troppo corta: minimo 8 caratteri.');
    process.exit(1);
  }
  if (p1 !== p2) {
    console.error('Le password non coincidono.');
    process.exit(1);
  }
}

/* stdin non-TTY (es. pipe per test/automazione): legge username, password e conferma
   una per riga. Su terminale interattivo usa i prompt con password nascosta. */
async function readCredentials() {
  if (!process.stdin.isTTY) {
    const lines = fs.readFileSync(0, 'utf8').split(/[\r\n]+/).filter((l) => l !== '');
    const username = (lines[0] || '').trim() || 'admin';
    const p1 = lines[1] || '';
    const p2 = lines[2] || '';
    return { username, p1, p2 };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const username = (await ask('Username (default admin): ')).trim() || 'admin';
  const p1 = await askHidden(rl, 'Password: ');
  const p2 = await askHidden(rl, 'Conferma password: ');
  rl.close();
  return { username, p1, p2 };
}

async function main() {
  const { username, p1, p2 } = await readCredentials();
  validate(username, p1, p2);

  let auth = { username: 'admin', passwordHash: null };
  try {
    if (fs.existsSync(AUTH_PATH)) {
      auth = { ...auth, ...JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('Errore lettura auth.json:', e.message);
    process.exit(1);
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(p1, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  auth.username = username;
  auth.passwordHash = 'scrypt$' + SCRYPT_N + '$' + SCRYPT_R + '$' + SCRYPT_P + '$' + salt.toString('base64url') + '$' + hash.toString('base64url');
  fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), { mode: 0o600 });
  console.log('Password aggiornata per utente ' + username + ' (salvato solo hash in auth.json).');
  console.log('Riavvia il backend per applicare la nuova credenziale.');
}

main().catch((e) => {
  console.error('Errore:', e.message);
  process.exit(1);
});
