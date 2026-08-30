#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_WRAPPER="$ROOT_DIR/phis"
TARGET_PATH="${1:-/usr/local/bin/phis}"
INSTALL_MODE="${PHIS_INSTALL_MODE:-symlink}"

if [[ ! -f "$SOURCE_WRAPPER" ]]; then
  echo "Missing wrapper: $SOURCE_WRAPPER" >&2
  exit 1
fi

if [[ "$INSTALL_MODE" == "copy" ]]; then
  install -m 0755 "$SOURCE_WRAPPER" "$TARGET_PATH"
  echo "Installed phis wrapper by copy to $TARGET_PATH"
  exit 0
fi

ln -sfn "$SOURCE_WRAPPER" "$TARGET_PATH"
echo "Installed phis wrapper by symlink to $TARGET_PATH"
