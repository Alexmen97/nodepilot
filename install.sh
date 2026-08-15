#!/usr/bin/env bash
#
# NodePilot — installer idempotente per Linux e macOS.
#
# - non sovrascrive config.json, auth.json o state.json esistenti;
# - non installa pacchetti di sistema automaticamente (mostra solo istruzioni);
# - non usa sudo, non modifica /etc, nessuna telemetria;
# - nessun segreto viene stampato nei log.
#
# Uso consigliato:
#   git clone https://github.com/Alexmen97/nodepilot.git
#   cd nodepilot
#   ./install.sh
#
# Uso rapido (opzionale):
#   curl -fsSL https://raw.githubusercontent.com/Alexmen97/nodepilot/main/install.sh | bash
#   (per scegliere la directory: | bash -s -- /percorso/destinazione)

if [ -z "${BASH_VERSION:-}" ]; then
  printf 'ERROR: eseguire con bash (bash install.sh)\n' >&2
  exit 1
fi

set -euo pipefail

REPO_URL="${NODEPILOT_REPO:-https://github.com/Alexmen97/nodepilot.git}"
DISPLAY_PORT="${PORT:-3100}"
APP_DIR=""

info() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Installatore NodePilot (Linux/macOS)

Uso (dal repository clonato):
  ./install.sh

Uso (download diretto):
  curl -fsSL https://raw.githubusercontent.com/Alexmen97/nodepilot/main/install.sh | bash -s -- [DIRECTORY]

Variabili d'ambiente:
  NODEPILOT_REPO  URL del repository da clonare (solo per il download diretto)
  PORT            porta mostrata nel riepilogo finale (default 3100)

Comportamento: controlla i requisiti, installa le dipendenze con npm,
crea config.json/state.json se mancanti (permessi 600) e avvia la
configurazione della password dashboard se auth.json non è configurato.
I file runtime esistenti non vengono mai sovrascritti.
USAGE
  exit 0
}

is_nodepilot_dir() {
  [ -f package.json ] && [ -f server.js ] && [ -f public/index.html ]
}

detect_os() {
  case "$(uname -s)" in
    Darwin) OS=macos ;;
    Linux)  OS=linux ;;
    *)      fail "Sistema operativo non supportato ($(uname -s)): NodePilot richiede Linux o macOS." ;;
  esac
}

node_install_hints() {
  if [ "$OS" = macos ]; then
    info "  Su macOS puoi installare Node.js con Homebrew:"
    info "    brew install node"
  else
    if [ -r /etc/os-release ]; then
      DISTRO="$(. /etc/os-release && printf '%s %s' "${ID:-}" "${ID_LIKE:-}")"
      case "$DISTRO" in
        *debian*|*ubuntu*) info "  Su Debian/Ubuntu puoi usare apt:"
                            info "    sudo apt update && sudo apt install -y nodejs npm"
                            info "  oppure NodeSource per una versione recente: https://github.com/nodesource/distributions" ;;
        *rhel*|*fedora*|*centos*|*rocky*|*alma*) info "  Su RHEL/Fedora/CentOS/Rocky/Alma puoi usare dnf:"
                            info "    sudo dnf install -y nodejs npm" ;;
        *arch*) info "  Su Arch:"
                info "    sudo pacman -S nodejs npm" ;;
        *) info "  Installa Node.js (>= 18) con il gestore pacchetti della tua distribuzione." ;;
      esac
    else
      info "  Installa Node.js (>= 18) con il gestore pacchetti della tua distribuzione."
    fi
    info "  In alternativa: https://nodejs.org/"
  fi
}

git_install_hints() {
  if [ "$OS" = macos ]; then
    info "  Su macOS: xcode-select --install  oppure  brew install git"
  else
    if [ -r /etc/os-release ]; then
      DISTRO="$(. /etc/os-release && printf '%s %s' "${ID:-}" "${ID_LIKE:-}")"
      case "$DISTRO" in
        *debian*|*ubuntu*) info "  Su Debian/Ubuntu: sudo apt update && sudo apt install -y git" ;;
        *rhel*|*fedora*|*centos*|*rocky*|*alma*) info "  Su RHEL/Fedora: sudo dnf install -y git" ;;
        *arch*) info "  Su Arch: sudo pacman -S git" ;;
        *) info "  Installa git con il gestore pacchetti della tua distribuzione." ;;
      esac
    else
      info "  Installa git con il gestore pacchetti della tua distribuzione."
    fi
  fi
}

check_requirements() {
  if ! command -v node >/dev/null 2>&1; then
    info "Node.js non trovato. È richiesto Node.js >= 18."
    node_install_hints
    fail "requisito mancante: Node.js"
  fi
  NODE_MAJOR="$(node -v | sed -E 's/^v?([0-9]+).*/\1/')"
  case "$NODE_MAJOR" in
    ''|*[!0-9]*) fail "Impossibile determinare la versione di Node.js ('$(node -v)')." ;;
  esac
  if [ "$NODE_MAJOR" -lt 18 ]; then
    warn "Node.js $(node -v) rilevato: è richiesto Node.js >= 18."
    node_install_hints
    fail "requisito non soddisfatto: Node.js >= 18"
  fi
  if ! command -v npm >/dev/null 2>&1; then
    info "npm non trovato (normalmente viene installato insieme a Node.js)."
    node_install_hints
    fail "requisito mancante: npm"
  fi
  NPM_VER="$(npm -v 2>/dev/null || true)"
  info "Requisiti OK: Node.js $(node -v), npm ${NPM_VER:-sconosciuta}, OS ${OS}."
}

install_deps() {
  if [ -f package-lock.json ]; then
    info "Installazione dipendenze (npm ci --omit=dev)…"
    npm ci --omit=dev
  else
    info "package-lock.json assente: uso npm install --omit=dev."
    npm install --omit=dev
  fi
}

set_perms() {
  if [ -e "$1" ]; then
    if ! chmod 600 "$1" 2>/dev/null; then
      warn "impossibile impostare i permessi 600 su $1"
    fi
  fi
}

ensure_runtime_files() {
  if [ -f config.json ]; then
    info "config.json già presente: non lo sovrascrivo."
  elif [ -f config.example.json ]; then
    cp config.example.json config.json
    info "Creato config.json da config.example.json."
  else
    warn "config.example.json assente: config.json non creato."
  fi
  set_perms config.json

  if [ -f state.json ]; then
    info "state.json già presente: non lo sovrascrivo."
  else
    printf '{\n  "tourCompleted": false,\n  "tourCompletedVersion": 0\n}\n' > state.json
    info "Creato state.json con struttura minima."
  fi
  set_perms state.json

  if [ -f auth.json ]; then
    set_perms auth.json
  fi
}

auth_needs_setup() {
  if [ ! -f auth.json ]; then
    return 0
  fi
  if ! grep -q '"passwordHash"' auth.json 2>/dev/null; then
    return 0
  fi
  if grep -q '"passwordHash"[[:space:]]*:[[:space:]]*null' auth.json 2>/dev/null; then
    return 0
  fi
  return 1
}

setup_auth() {
  AUTH_CONFIGURED_THIS_RUN=0
  if auth_needs_setup; then
    if [ -t 0 ]; then
      info ""
      info "Configurazione password della dashboard (la password non verrà mostrata):"
      npm run auth:set-password
      AUTH_CONFIGURED_THIS_RUN=1
    else
      warn "Terminale non interattivo: password dashboard non configurata."
      info "Esegui manualmente: npm run auth:set-password"
    fi
  else
    info "auth.json già configurato: non lo sovrascrivo."
  fi
}

get_lan_ip() {
  local ip=""
  if [ "$OS" = macos ] && command -v ipconfig >/dev/null 2>&1; then
    ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
    if [ -z "$ip" ]; then
      ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
    fi
  elif [ "$OS" = linux ]; then
    if command -v ip >/dev/null 2>&1; then
      ip="$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -nE 's/.* src ([0-9.]+).*/\1/p' | head -n1 || true)"
    fi
    if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
      ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    fi
  fi
  case "$ip" in
    '') return 1 ;;
    127.*|169.254.*) return 1 ;;
    *[!0-9.]*) return 1 ;;
    *) printf '%s' "$ip" ;;
  esac
}

final_checks() {
  local ok=1
  if [ -f server.js ]; then
    if node --check server.js 2>/dev/null; then
      info "Verifica sintassi server.js: OK."
    else
      warn "node --check server.js ha rilevato problemi di sintassi."
      ok=0
    fi
  fi
  if [ -f config.json ]; then
    info "File runtime presente: config.json"
  else
    warn "File runtime mancante: config.json"
    ok=0
  fi
  if [ -f state.json ]; then
    info "File runtime presente: state.json"
  else
    warn "File runtime mancante: state.json"
    ok=0
  fi
  if [ -f auth.json ]; then
    info "File runtime presente: auth.json"
  else
    info "auth.json requires dashboard password setup"
  fi
  if [ "$ok" = 1 ]; then
    info "Verifiche finali completate con successo."
  fi
}


print_summary() {
  local lan=""
  info ""
  info "NodePilot installato correttamente."
  info "Per avviarlo:"
  info "  cd ${APP_DIR}"
  info "  npm start"
  info ""
  info "Dashboard: http://localhost:${DISPLAY_PORT}"
  if lan="$(get_lan_ip)"; then
    info "Rete locale: http://${lan}:${DISPLAY_PORT}"
  fi
  info ""
  info "L'avvio automatico (systemd su Linux, LaunchAgent su macOS) verrà"
  info "configurato nella prossima fase."
  if [ "${AUTH_CONFIGURED_THIS_RUN:-0}" = 0 ] && [ ! -f auth.json ]; then
    info ""
    info "Ricorda di impostare la password della dashboard con:"
    info "  npm run auth:set-password"
  fi
}

main() {
  if [ "$#" -gt 0 ]; then
    case "$1" in
      -h|--help) usage ;;
    esac
  fi

  detect_os
  info "NodePilot installer — OS rilevato: ${OS}"

  if is_nodepilot_dir; then
    APP_DIR="$(pwd -P)"
    info "Sorgente NodePilot trovato in: ${APP_DIR}"
    if ! command -v git >/dev/null 2>&1; then
      warn "git non trovato: 'git pull' non sarà disponibile per gli aggiornamenti."
    fi
  else
    if ! command -v git >/dev/null 2>&1; then
      info "git non trovato: è necessario per scaricare il repository."
      git_install_hints
      fail "requisito mancante: git"
    fi
    APP_DIR="${1:-${NODEPILOT_DIR:-$HOME/nodepilot}}"
    case "$APP_DIR" in
      -*) fail "Destinazione non valida: ${APP_DIR}" ;;
    esac
    if [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
      if [ -f "$APP_DIR/package.json" ] && [ -f "$APP_DIR/server.js" ] && [ -f "$APP_DIR/public/index.html" ]; then
        warn "${APP_DIR} contiene già NodePilot: procedo come reinstallazione (i file runtime non verranno toccati)."
        cd "$APP_DIR"
      else
        fail "La directory ${APP_DIR} esiste, non è vuota e non contiene NodePilot. Scegli un'altra destinazione."
      fi
    else
      info "Download del repository in: ${APP_DIR}"
      git clone --depth 1 "$REPO_URL" "$APP_DIR"
      cd "$APP_DIR"
    fi
  fi

  check_requirements
  install_deps
  ensure_runtime_files
  setup_auth
  final_checks
  print_summary
}

main "$@"
