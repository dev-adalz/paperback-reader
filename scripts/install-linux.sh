#!/usr/bin/env bash
# Install Paperback as a desktop app for the current user (no root needed).
# Runs straight from this checkout, so code changes apply on the next launch.
#   ./scripts/install-linux.sh            install / update
#   ./scripts/install-linux.sh --remove   uninstall (your books and library are not touched)
set -euo pipefail

APP_ID=paperback
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON="$ROOT/node_modules/electron/dist/electron"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
ICONS="$DATA/icons/hicolor"
DESKTOP="$DATA/applications/$APP_ID.desktop"

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$DESKTOP"
  for s in 16 24 32 48 64 128 256 512; do rm -f "$ICONS/${s}x${s}/apps/$APP_ID.png"; done
  rm -f "$ICONS/scalable/apps/$APP_ID.svg"
  update-desktop-database "$DATA/applications" 2>/dev/null || true
  gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
  echo "Paperback removed from the app menu."
  exit 0
fi

[[ -x "$ELECTRON" ]] || { echo "Electron not found. Run 'npm install' in $ROOT first." >&2; exit 1; }
[[ "$ROOT" != *" "* ]] || { echo "The project path contains spaces; move it somewhere without spaces." >&2; exit 1; }

# Chromium's sandbox helper must be root-owned + setuid, or Electron aborts on many distros.
SANDBOX="$ROOT/node_modules/electron/dist/chrome-sandbox"
EXTRA=""
if [[ -f "$SANDBOX" && ( "$(stat -c %U "$SANDBOX")" != root || ! -u "$SANDBOX" ) ]]; then
  echo "Note: $SANDBOX is not root-owned/setuid. Either run:"
  echo "  sudo chown root:root '$SANDBOX' && sudo chmod 4755 '$SANDBOX'   (then re-run this script)"
  echo "or the launcher will start Electron with --no-sandbox."
  EXTRA=" --no-sandbox"
fi

for s in 16 24 32 48 64 128 256 512; do
  install -Dm644 "$ROOT/build/icons/${s}x${s}.png" "$ICONS/${s}x${s}/apps/$APP_ID.png"
done
install -Dm644 "$ROOT/build/icon.svg" "$ICONS/scalable/apps/$APP_ID.svg"

mkdir -p "$(dirname "$DESKTOP")"
cat > "$DESKTOP" <<DESK
[Desktop Entry]
Type=Application
Name=Paperback
GenericName=EPUB Reader
Comment=A local-first EPUB reader that feels like a printed book
Exec=$ELECTRON $ROOT$EXTRA
Path=$ROOT
Icon=$APP_ID
Terminal=false
Categories=Office;Viewer;
Keywords=ebook;epub;reader;books;library;
StartupNotify=true
StartupWMClass=Paperback
DESK
chmod 644 "$DESKTOP"

update-desktop-database "$DATA/applications" 2>/dev/null || true
gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
echo "Installed: Paperback is in your app menu ($DESKTOP)."
