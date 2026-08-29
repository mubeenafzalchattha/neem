# Neem Screen Recorder

Neem is a lightweight macOS recorder for your screen, a single window or a
custom region — with a cursor-following zoom, an optional camera bubble and
a microphone track.

## Features

- **Home screen library.** Every recording is saved automatically to
  `~/Movies/Neem` and listed on the home screen with a thumbnail, date,
  duration and file size. Click to play, or use the icons to reveal it in
  Finder / move it to the Trash.
- **Choose what to record.** Whole display, a single app window, or drag out
  a custom region.
- **Cursor zoom.** Neem eases into a close-up around your pointer when you
  settle somewhere, holds it, then eases back out. Manual control too.
- **Camera bubble** composited into the video, and a **microphone** track.
- **Neem's own UI never appears in the recording** — the overlay is excluded
  from screen capture while recording.

## Shortcuts while recording

| Shortcut | Action |
| --- | --- |
| `⌘⇧Z` | Zoom in |
| `⌘⇧X` | Zoom out (back to auto at 1×) |
| `⌘⇧P` | Pause / resume |
| `⌘⇧S` | Stop and save |

## Where recordings go

`~/Movies/Neem/neem-YYYYMMDD-HHMMSS.mp4`

Metadata (duration, capture mode) lives in `~/Movies/Neem/.neem/index.json`
and thumbnails in `~/Movies/Neem/.neem/thumbs/`. Deleting a video from the
home screen prunes both.

## Build

```bash
npm run dev          # run from source
npm run pack:mac     # build Neem.app into dist/
npm run build:mac    # build the .dmg + .zip
npm run install:mac  # copy to /Applications, clear quarantine, ad-hoc sign
```

## Permissions on macOS

Neem needs Screen Recording, and optionally Camera and Microphone:
**System Settings → Privacy & Security**. The in-app **i** button links
straight to each pane.

Permissions are tied to app identity *and* install location, so always run
from `/Applications/Neem.app` rather than a build folder.

## "Neem is damaged and can't be opened" / corrupted package

**The app is not corrupted.** That message is macOS Gatekeeper's generic
wording for *"this app is not signed by a Developer ID I recognise, and it
carries a quarantine flag."*

Anything that arrives via a DMG or download gets a `com.apple.quarantine`
extended attribute. Gatekeeper caches its verdict, so an app can launch once
and then be blocked days later — after a macOS update, an XProtect
definition update, or simply when the cached assessment expires. Nothing
about the file changed; the verdict did.

### Fix it now

```bash
npm run fix:quarantine
# or directly:
xattr -cr /Applications/Neem.app
codesign --force --deep --sign - /Applications/Neem.app
```

Then open Neem from Applications.

### Fix it permanently

Join the Apple Developer Program, then sign and notarize the build with a
*Developer ID Application* certificate:

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID"
npm run build:mac
```

A notarized + stapled build opens with no warning on any Mac, and Gatekeeper
never re-blocks it.

## "Malware Blocked and Moved to Trash" (Electron.app) / SIGKILL on `npm run dev`

Both symptoms are one event. macOS XProtect matched something in the dev
Electron runtime at `node_modules/electron/dist/Electron.app`, sent it
SIGKILL mid-launch, then moved the bundle to the Trash — which is why the
next `npm run dev` reports the binary is gone.

**This is not your code.** `Electron.app` is the stock runtime that
`electron`'s postinstall downloads from Electron's GitHub releases; nothing
in `src/` ends up inside it.

Audit performed 2026-08-29 on this project:

- All 276 installed packages resolve to `registry.npmjs.org` and every one
  carries an integrity hash. None resolve to a foreign registry or a git URL.
- No unexpected install hooks. Only `electron` (postinstall) and
  `ffmpeg-static` (install) actually run, and both are the genuine
  first-party downloaders.
- The lockfile's electron integrity
  (`sha512-HZtZg8EHsDGnswFt0QeV8If8B+et63uD6RJ7I4/xhcXqmTIbI08GoubX/wm+HdY0DwcuPe1/xsgqpmYvjdjRoA==`)
  matches the live npm registry byte for byte.
- Nothing else in `node_modules` was touched — the `ffmpeg-static` binary,
  also unsigned, is intact.

The project was pinned to **Electron 31.7.7, end-of-life since January 2025**
— about 19 months of unshipped Chromium security fixes. That is the most
likely thing XProtect was reacting to, and a real risk on its own. The fix is
to move to a supported major.

### Recover and upgrade

```bash
cd ~/Desktop/neem
rm -rf node_modules package-lock.json
npm install          # pulls Electron 44 + electron-builder 26
npm run dev
```

`npm install` is itself the integrity check: `@electron/get` verifies the
downloaded zip's SHA-256 against Electron's published `SHASUMS256.txt` and
fails loudly on a mismatch. If it completes, the binary is authentic.

### If you still get SIGKILL

On Apple Silicon a Mach-O binary with a missing or broken signature is killed
by the kernel at launch. A partially removed or re-extracted `Electron.app`
lands in exactly that state:

```bash
npm run resign:dev   # codesign --force --deep --sign - node_modules/electron/dist/Electron.app
```

### Confirm what was actually detected

```bash
log show --last 24h --predicate 'process CONTAINS "XProtect"' --info --style compact \
  | grep -iE "malware|detect|remediat|electron" | head -40

ls -la ~/.Trash | grep -i electron
```

A named adware/stealer family in that output means treat the machine as
suspect. A generic heuristic with no family name is the signature of a false
positive, which XProtect produced repeatedly through 2026 against unsigned
Electron-based helpers.

### What was hardening this

Earlier versions ran `chmod` on the bundled `ffmpeg` binary *inside the .app
bundle* on every launch. Writing into a signed bundle at runtime risks
invalidating its signature. Neem now uses the bundled binary read-only and,
only if it is not executable, copies it to Application Support first. The
build also declares hardened-runtime entitlements so the bundled ffmpeg can
still be spawned.
