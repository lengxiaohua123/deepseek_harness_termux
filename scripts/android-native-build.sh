#!/usr/bin/env bash
# Compile the native addons that have no android/arm64 prebuilds.
#
# Required before running `dsh web` (or any profile that loads sandbox,
# subprocess, or attachment entries) on Android/Termux. Prerequsites:
#   - `pnpm install --ignore-scripts` completed
#   - Termux toolchain: cc, make, python3
# The script is idempotent: recompiling an already-built addon is a no-op
# from the loader's point of view.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"

# koffi: patches/koffi@3.1.1.patch makes the statx() call use the raw syscall
# on bionic (the function is not declared in Termux headers). Compile the
# patched store copy.
KOFFI_MOD="$(ls -d "$ROOT"/node_modules/.pnpm/koffi@3.1.1_patch_hash=*/node_modules/koffi 2>/dev/null | head -1 || true)"
if [ -n "$KOFFI_MOD" ]; then
  echo "building koffi: $KOFFI_MOD"
  (cd "$KOFFI_MOD" && node ./cnoke.cjs -P . -D src/koffi --prebuild --release)
else
  echo "koffi store copy not found; run 'pnpm install --ignore-scripts' first" >&2
  exit 1
fi

# node-pty: no android prebuild artifact, so prebuild.js falls through to
# node-gyp. Use the local node headers via --nodedir; the downloaded official
# headers gate statx behind the Android NDK and fail on Termux.
NPTY_MOD="$(ls -d "$ROOT"/node_modules/.pnpm/node-pty@1.1.0*/node_modules/node-pty | head -1)"
echo "building node-pty: $NPTY_MOD"
NG="$(npm root -g)/npm/node_modules/node-gyp/bin/node-gyp.js"
(cd "$NPTY_MOD" && node scripts/prebuild.js || node "$NG" rebuild --nodedir="$PREFIX")

echo "native addons built."
