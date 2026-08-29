#!/usr/bin/env bash
# Recovers Neem from macOS Gatekeeper's "the application is damaged" error.
#
# Cause: the app is not signed with a paid Apple Developer ID and not
# notarized. macOS tags anything that arrives via a DMG/download with a
# com.apple.quarantine attribute; when Gatekeeper later re-evaluates that
# app and finds no valid Developer ID signature, it reports the bundle as
# damaged even though nothing about the file changed.
set -e

APP="${1:-/Applications/Neem.app}"

if [ ! -d "$APP" ]; then
  echo "Not found: $APP"
  exit 1
fi

echo "Clearing quarantine flags on $APP ..."
xattr -cr "$APP"

echo "Re-applying an ad-hoc signature ..."
codesign --force --deep --sign - "$APP"

echo "Done. Open Neem from Applications."
