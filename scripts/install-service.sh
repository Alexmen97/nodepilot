#!/usr/bin/env bash
#
# NodePilot service installer — Linux (systemd) / macOS (LaunchAgent).
# Comandi: install (default) | uninstall | status
#
# Linux: unit di sistema con utente dedicato 'nodepilot' (mai root).
# L'ownership viene modificata SOLO su config.json/state.json/auth.json
# (nodepilot:nodepilot, mode 600); codice, .git e node_modules restano del
# proprietario originale. Richiede sudo e conferma esplicita.
# macOS: LaunchAgent per l'utente corrente, nessun sudo, log in
# ~/Library/Logs/NodePilot/.

if [ -z "${BASH_VERSION:-}" ]; then
  printf 'ERROR: eseguire con bash (bash scripts/install-service.sh)\n' >&2
  exit 1
fi

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
LABEL="io.github.alexmen97.nodepilot"
SERVICE_NAME="nodepilot"
SERVICE_USER="nodepilot"
PORT="${PORT:-3100}"
CMD="${1:-install}"

info() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Installatore servizio NodePilot (Linux systemd / macOS LaunchAgent)

Uso:
  ./scripts/install-service.sh install    # installa e avvia (default)
  ./scripts/install-service.sh uninstall  # ferma e rimuove il servizio
  ./scripts/install-service.sh status     # mostra lo stato

Linux: eseguire con sudo (unit di sistema, utente dedicato 'nodepilot').
macOS: eseguire come utente normale (LaunchAgent per l'utente corrente).
PORT: porta configurata nel servizio (default 3100), es. PORT=3110 ./scripts/install-service.sh install
USAGE
  exit 0
}

detect_os() {
  case "$(uname -s)" in
    Darwin) OS=macos ;;
    Linux)  OS=linux ;;
    *)      fail "Sistema operativo non supportato: $(uname -s)" ;;
  esac
}

resolve_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "node non trovato nel PATH. Installare Node.js >= 18 (vedi README)."
  fi
  NODE_BIN="$(command -v node)"
  NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
  if [ ! -x "$NODE_BIN" ]; then
    fail "node non eseguibile: $NODE_BIN"
  fi
  NODE_MAJOR="$("$NODE_BIN" -v | sed -E 's/^v?([0-9]+).*/\1/')"
  case "$NODE_MAJOR" in
    ''|*[!0-9]*) fail "Impossibile determinare la versione di node ($NODE_BIN)." ;;
  esac
  if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js >= 18 richiesto (trovato: $("$NODE_BIN" -v))."
  fi
}

esc_sed() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }
xml_esc()  { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }

confirm() {
  printf '%s [y/N] ' "$1"
  read -r ANS
  case "$ANS" in
    y|Y|yes|s|S) : ;;
    *) fail "Operazione annullata." ;;
  esac
}

ensure_runtime_files() {
  if [ ! -d "$APP_DIR/node_modules/ws" ]; then
    fail "Dipendenze mancanti (node_modules/ws): eseguire prima npm ci --omit=dev (oppure ./install.sh)."
  fi
  local missing=""
  local f=""
  for f in config.json state.json; do
    if [ ! -f "$APP_DIR/$f" ]; then
      missing="$missing $f"
    fi
  done
  if [ -n "$missing" ]; then
    fail "File runtime mancanti:$missing — eseguire prima ./install.sh nella directory di installazione."
  fi
  if [ ! -f "$APP_DIR/auth.json" ]; then
    warn "auth.json assente: la dashboard resterà senza password finché non esegui 'npm run auth:set-password'."
  fi
}

# ---------------- Linux / systemd ----------------

linux_require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "Su Linux eseguire con sudo: sudo ./scripts/install-service.sh $CMD"
  fi
}

linux_ensure_user() {
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    info "Utente di sistema creato: $SERVICE_USER (nologin, nessuna home)."
  else
    info "Utente di sistema già presente: $SERVICE_USER"
  fi
}

linux_check_access() {
  case "$APP_DIR" in
    *" "*) fail "Percorso con spazi non supportato da systemd: $APP_DIR — usare una directory senza spazi (es. /opt/nodepilot)." ;;
  esac
  local d="$APP_DIR"
  local blocked=""
  while [ "$d" != "/" ]; do
    if ! runuser -u "$SERVICE_USER" -- test -x "$d"; then
      blocked="$d"
      break
    fi
    d="$(dirname "$d")"
  done
  if ! runuser -u "$SERVICE_USER" -- test -r "$APP_DIR/server.js"; then
    blocked="${blocked:-$APP_DIR/server.js}"
  fi
  if ! runuser -u "$SERVICE_USER" -- test -r "$APP_DIR/public/index.html"; then
    blocked="${blocked:-$APP_DIR/public}"
  fi
  if ! runuser -u "$SERVICE_USER" -- test -r "$APP_DIR/node_modules"; then
    blocked="${blocked:-$APP_DIR/node_modules}"
  fi
  if ! runuser -u "$SERVICE_USER" -- "$NODE_BIN" -v >/dev/null 2>&1; then
    blocked="${blocked:-$NODE_BIN}"
  fi
  if [ -n "$blocked" ]; then
    cat >&2 <<EOF
ERROR: l'utente di servizio '$SERVICE_USER' non può accedere a: $blocked
(una directory padre non è attraversabile, oppure il codice non è leggibile).
L'ownership del repository NON viene modificata automaticamente.
Soluzioni consigliate:
  1) installazione in una directory accessibile, ad esempio /opt/nodepilot:
       sudo mv "$APP_DIR" /opt/nodepilot   (poi rilanciare lo script da lì)
  2) oppure consentire solo l'attraversamento delle directory intermedie:
       sudo chmod o+x <directory-che-blocca>
EOF
    exit 1
  fi
  info "Accesso verificato: $SERVICE_USER può leggere il codice ed eseguire node."
}

linux_chown_runtime() {
  local f=""
  for f in config.json state.json auth.json; do
    if [ -f "$APP_DIR/$f" ]; then
      chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/$f"
      chmod 600 "$APP_DIR/$f"
    fi
  done
  info "Ownership aggiornata SOLO su config.json/state.json/auth.json (600). Codice e .git invariati."
}

linux_install() {
  linux_require_root
  resolve_node
  ensure_runtime_files
  info ""
  info "Riepilogo operazioni (Linux/systemd):"
  info "  - utente di sistema: $SERVICE_USER (creato solo se assente)"
  info "  - ownership SOLO su: config.json, state.json, auth.json → $SERVICE_USER 600"
  info "  - unit: /etc/systemd/system/$SERVICE_NAME.service"
  info "  - systemctl daemon-reload + enable --now"
  info ""
  confirm "Procedere?"
  linux_ensure_user
  linux_check_access
  linux_chown_runtime
  local unit="/etc/systemd/system/$SERVICE_NAME.service"
  local template="$APP_DIR/deploy/systemd/nodepilot.service.template"
  if [ ! -f "$template" ]; then
    fail "template mancante: $template"
  fi
  if [ -e "$unit" ]; then
    cp -p "$unit" "$unit.bak.$(date +%s)"
    info "Backup dell'unit esistente creato accanto al file."
  fi
  local a n p
  a="$(esc_sed "$APP_DIR")"
  n="$(esc_sed "$NODE_BIN")"
  p="$(esc_sed "$PORT")"
  sed -e "s|@@APP_DIR@@|$a|g" -e "s|@@NODE_BIN@@|$n|g" -e "s|@@PORT@@|$p|g" -e "s|@@SERVICE_USER@@|$SERVICE_USER|g" "$template" > "$unit"
  chmod 644 "$unit"
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME.service"
  info "Servizio installato e avviato."
  info "Stato: systemctl status $SERVICE_NAME"
  info "Log:   journalctl -u $SERVICE_NAME -f"
}

linux_uninstall() {
  linux_require_root
  local unit="/etc/systemd/system/$SERVICE_NAME.service"
  if [ -e "$unit" ]; then
    confirm "Verranno fermati e rimossi il servizio e la unit '$SERVICE_NAME'. I file runtime NON verranno toccati. Procedere?"
    systemctl disable --now "$SERVICE_NAME.service" 2>/dev/null || true
    rm -f "$unit"
    systemctl daemon-reload
    info "Servizio rimosso. L'utente $SERVICE_USER non viene rimosso."
    info "Rimozione utente (scelta esplicita separata): sudo userdel $SERVICE_USER"
  else
    info "Nessuna unit installata in /etc/systemd/system/."
  fi
}

linux_status() {
  systemctl status "$SERVICE_NAME.service" --no-pager || true
}

# ---------------- macOS / LaunchAgent ----------------

macos_require_user() {
  if [ "$(id -u)" -eq 0 ]; then
    fail "Su macOS eseguire come utente normale: il LaunchAgent gira per l'utente corrente."
  fi
}

macos_install() {
  macos_require_user
  resolve_node
  ensure_runtime_files
  local log_dir="$HOME/Library/Logs/NodePilot"
  local dest="$HOME/Library/LaunchAgents/$LABEL.plist"
  local template="$APP_DIR/deploy/launchd/$LABEL.plist.template"
  if [ ! -f "$template" ]; then
    fail "template mancante: $template"
  fi
  if [ -e "$dest" ]; then
    confirm "Il file $dest esiste già: verrà creato un backup e poi sovrascritto. Procedere?"
    cp -p "$dest" "$dest.bak.$(date +%s)"
  fi
  mkdir -p "$log_dir"
  local a n p l uid
  a="$(xml_esc "$APP_DIR")"
  n="$(xml_esc "$NODE_BIN")"
  p="$(xml_esc "$PORT")"
  l="$(xml_esc "$log_dir")"
  uid="$(id -u)"
  sed -e "s|@@APP_DIR@@|$a|g" -e "s|@@NODE_BIN@@|$n|g" -e "s|@@PORT@@|$p|g" -e "s|@@LOG_DIR@@|$l|g" "$template" > "$dest"
  chmod 644 "$dest"
  launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$dest"
  info "LaunchAgent installato e avviato."
  info "Stato: launchctl print gui/$uid/$LABEL"
  info "Log:   $log_dir/stdout.log e $log_dir/stderr.log"
}

macos_uninstall() {
  macos_require_user
  local dest="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [ -e "$dest" ]; then
    confirm "Verrà fermato e rimosso il LaunchAgent '$LABEL'. File runtime e log NON verranno toccati. Procedere?"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$dest"
    info "LaunchAgent rimosso."
  else
    info "Nessun plist installato in ~/Library/LaunchAgents/."
  fi
}

macos_status() {
  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null || true
}

# ---------------- main ----------------

main() {
  if [ "$#" -gt 0 ]; then
    case "$1" in
      -h|--help) usage ;;
    esac
  fi
  detect_os
  case "$CMD" in
    install)
      if [ "$OS" = linux ]; then linux_install; else macos_install; fi
      ;;
    uninstall)
      if [ "$OS" = linux ]; then linux_uninstall; else macos_uninstall; fi
      ;;
    status)
      if [ "$OS" = linux ]; then linux_status; else macos_status; fi
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
