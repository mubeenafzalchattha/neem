#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_ICON="$ROOT_DIR/src/logo.png"
OUT_DIR="$ROOT_DIR/build/icons"
OUT_ICON="$OUT_DIR/logo-build.png"

if [[ ! -f "$SRC_ICON" ]]; then
  echo "Missing source icon: $SRC_ICON" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "sips is required to generate build icon." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
sips -z 1024 1024 "$SRC_ICON" --out "$OUT_ICON" >/dev/null

echo "Generated build icon: $OUT_ICON"
