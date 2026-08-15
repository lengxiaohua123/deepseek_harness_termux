---
name: dsh-android-upstream-adapt
description: Use when merging upstream deepseek-harness master into the Android/Termux adaptation branch, re-applying or re-verifying Android-specific patches and native builds after an upstream update, or diagnosing build, test, or web-boot failures on this machine after a sync.
---

# DSH Android Upstream Adaptation

This repo is a fork (`my` remote: `lengxiaohua123/deepseek_harness_termux`) whose `adapt/android-termux` branch carries Android/Termux adaptations on top of upstream `deepseek-ai/deepseek-harness` master. CI (`.github/workflows/sync-upstream.yml`, daily 03:17 UTC, runs only from the default branch) force-mirrors upstream master into this repo's `master` and re-pushes every branch. The workflow below re-applies and re-verifies the adaptation layer fast and deterministically after each upstream update. The canonical run documentation lives in `USE.md`; read it before changing launch behavior.

## Termux is arm64 Linux — adapt via the arm64-Linux path

Termux runs the Linux kernel on aarch64 with the bionic libc. Treat it as an arm64 Linux environment for detection and code paths, never as a separate platform deserving its own branch.

- `process.platform` on Termux is build-dependent: the Termux-repo node build reports `'android'`/`'arm64'` (verified on this machine, node v26), while official `linux-arm64` node builds report `'linux'` but link glibc and do not run on stock Termux. Never branch on a single value: match `process.platform === 'android'` OR `(process.platform === 'linux' && process.arch === 'arm64')`.
- Prebuilt binaries are the one place "arm64 Linux" is a trap: bionic ≠ glibc, so linux-arm64 glibc prebuilds usually fail to load. Compile locally (koffi, node-pty — step 2) or use a libc-agnostic fallback (sharp → `@img/sharp-wasm32`).
- The repo currently has no `process.platform === 'android'` branches in `packages/*/*/src` (verified); platform selection happens through package `os`/`cpu` optionalDependencies and patch-layer composition. Keep it that way; add explicit platform detection only where a real binary or behavior gate exists.
- This machine: 8 aarch64 cores, but ~9 GB of 11 GB RAM is used with ~6 GB of 12 GB swap active. Treat "slow" reports as environmental until proven otherwise.

## 0. Sync the branches

`master` mirrors upstream only and must never carry local changes; all local work lives on `adapt/android-termux`.

```sh
git fetch origin
git checkout master && git reset --hard origin/master
git checkout adapt/android-termux
git merge origin/master          # resolve conflicts, then commit
git status --short               # confirm no conflict residue
```

Conflicts concentrate in the adaptation surfaces listed in step 1; expect them there, not elsewhere.

## 1. Scope what upstream changed

```sh
git log --oneline origin/master..HEAD                # this branch's own commits
git diff origin/master...HEAD --stat                 # what the merge pulled in
git log origin/master.. -- packages/ vendor/ apps/   # which areas moved
```

High-risk adaptation surfaces. Upstream rewrites here force re-application — the complete file-by-file ledger with reasons is the "Adaptation ledger" section below:

- `vendor/` — vendored Cordis; owns the loader's internal-module resolution that drives the `--expose-internals` requirement.
- `packages/boot/app-boot`, `apps/cli` — launcher and Loader boot path.
- `packages/attachment/attachment-local/src/image.ts` — keep the lazy sharp import (step 7).
- `packages/subprocess/subprocess-local/src/index.ts` — keep the lazy node-pty import (step 7).
- `packages/sandbox/*` — Landlock/bwrap fail-closed semantics.
- `packages/session/*`, `packages/host/directory-picker*` — Android filesystem quirks (hard-link-free session publish, browse picker fallback).
- `package.json`, `pnpm-workspace.yaml`, `patches/` — dependency versions and patched deps.

## 2. Re-install and rebuild native addons when dependencies changed

```sh
pnpm install --ignore-scripts        # mandatory: plain pnpm install fails on koffi compile and on lefthook's postinstall
bash scripts/android-native-build.sh # koffi + node-pty have no android-arm64 prebuilds; compile locally
```

Version bumps of `koffi` or `node-pty` break the pinned patches; update them together:

- `patches/koffi@3.1.1.patch` — swaps the `statx()` call for a raw syscall (bionic headers do not declare it).
- `patches/node-pty@1.1.0.patch`.
- `pnpm-workspace.yaml` `patchedDependencies` keys must match the patch filenames.
- If upstream bumps `sharp`, keep `@img/sharp-wasm32` in root devDependencies (the Android fallback; there is no libvips).

Toolchain prereqs for `scripts/android-native-build.sh`: `cc`, `make`, `python3`; node-pty builds with `--nodedir=$PREFIX` because the official downloaded headers gate statx behind the Android NDK and fail on Termux.

## 3. Build with npm, not pnpm

```sh
npm run build:lib:host    # tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host
```

Why npm: `pnpm run` first runs `verify-deps-before-run`, which triggers `pnpm install`, whose lefthook postinstall always fails on Android and aborts the whole command. `npm run` skips that check. After a client-package change also run `npm run build:lib:client`; after a frontend change run the web build separately (`apps/web`).

## 4. Typecheck the changed packages

```sh
node_modules/.bin/tsc -b packages/<group>/<pkg>/tsconfig.json
```

## 5. Run tests by invoking vitest directly

```sh
node --import tsx/esm node_modules/vitest/vitest.mjs run packages/<group>/<pkg>/tests
```

This bypasses the same pnpm pre-run trap as step 3.

All three packages' suites are green on this machine (attachment, subprocess, terminal-bash — 207 tests). Earlier "environment failures" were resolved by the adaptations below, not worked around:

- `attachment-local/tests/store.spec.ts` — failed on root-owned Android ancestors (`/data`, `/data/data`) during the durability walk and on forbidden hard links; both now degrade gracefully (see step 7).
- `subprocess-local/tests/process-exit.spec.ts` — failed on the android platform throw in `createProcessInspector`, not on sandbox cleanup.
- `terminal-bash/tests/local.spec.ts` — failed on the same inspector throw plus a test that hardcoded `/bin/bash`; both fixed.

Reliable suites for the adaptation surface: `attachment-local/tests/image.spec.ts`, `subprocess-local/tests/terminal.spec.ts`, `subprocess-local/tests/spawn.spec.ts`, `subprocess-local/tests/process-inspector.spec.ts`, `terminal-bash/tests/local.spec.ts`.

## 6. Boot the web server

```sh
node --expose-internals apps/cli/lib/bin.js web --port 0
# wait for "dsh web: http://..." (~1-5s in built mode), then curl must return 200
```

`--expose-internals` is mandatory: the Loader's `ModuleLoader.fromInternal()` needs Node's internal ESM loader to resolve workspace plugins, because the `node-addon-require-builtin` native chain has no Android prebuild. Without the flag the boot dies with `Cannot find package '@deepseek-ai/cordis-plugin-timer'`.

Do not run the daily service in tsx source mode: the per-import resolution probing costs 15-22s startup versus 1-5s built. Source mode is only for debugging `apps/cli/src`.

## 7. Android-specific regression checklist

Re-apply or re-verify each item when upstream rewrote the owning file:

- koffi patch still applies (raw `syscall(SYS_statx, ...)` on bionic).
- node-pty still builds via prebuild fallback with `--nodedir=$PREFIX`.
- sharp still falls back to `@img/sharp-wasm32`.
- Lazy native imports survive upstream rewrites: `attachment-local/src/image.ts` (`await import('sharp')` on first use) and `subprocess-local/src/index.ts` (`await import('node-pty')` on first PTY spawn). They are behavior-neutral; re-apply the pattern if upstream inlines the static imports again.
- Terminal shell path stays Termux-safe: `terminal-bash/src/config.ts` resolves the default with `existsSync('/bin/bash') ? '/bin/bash' : 'bash'` — Termux has no `/bin/bash`.
- `native-path-opener.ts` keeps the android branch (`termux-open(1)` via the intent launcher) and `canOpenNativePath('android')` answers true; without them the platform throws and the open button hides.
- `process-inspector.ts` `createProcessInspector` routes `'android'` to the Linux `/proc` inspector (arm64 syscall table); `spawn.ts` group-liveness includes `'android'`. These make terminal inspection and tree teardown equal to Linux on Termux.
- `attachment-local/src/store.ts` keeps two Android degradations: `syncDirectory` skips root-owned ancestors it cannot open (`/data`, `/data/data` — EACCES/EPERM) instead of failing the publication, and the object publish falls back from `link()` to `rename()` when SELinux forbids hard links (same pattern as session-persistence-jsonl).
- Directory picker still falls back to the `browse` backend (`tsconfig.base.json` carries the client-package mapping).
- Sandbox stays fail-closed (Landlock `ENOSYS`, no bwrap) with an explicit error, never silent degradation.
- Session persistence still publishes via rename when hard links are forbidden.
- `USE.md` run instructions match the merged tree (built mode + `--expose-internals`).

## Adaptation ledger — every divergence from upstream, and why

Re-apply only what upstream rewrote; everything else survives merges. Verify each item against the live diff during step 1.

### Code adaptations (upstream rewrites the file → re-apply)

| File | Change | Why |
|---|---|---|
| `packages/attachment/attachment-local/src/image.ts` | static `import sharp` → lazy `loadSharp()` on first use | sharp resolves to `@img/sharp-wasm32` on Android; a WASM backend at boot is waste |
| `packages/attachment/attachment-local/src/store.ts` | `syncDirectory` skips unopenable ancestors; publish falls back `link()` → `rename()` | root-owned `/data`/`/data/data` are unreadable; SELinux forbids hard links |
| `packages/host/apiproxy/src/native-path-opener.ts` | android branch runs `termux-open`; `canOpenNativePath('android')` true | termux-open ships with termux-tools; without the branch the platform throws |
| `packages/session/session-persistence-jsonl/src/index.ts` | publish via `rename()` when `link()` returns EACCES/EPERM | SELinux forbids hard links; rename stays atomic |
| `packages/subprocess/subprocess-local/src/index.ts` | static `import * as nodePty` → `await import('node-pty')` at first PTY spawn | native addon load at boot is waste |
| `packages/subprocess/subprocess-local/src/process-inspector.ts` | `createProcessInspector` routes `'android'` to `LinuxProcessInspector` | Termux reports platform `'android'`; the old code threw, breaking every terminal |
| `packages/subprocess/subprocess-local/src/spawn.ts` | group-liveness check includes `'android'` | keeps tree teardown equal to Linux |
| `packages/terminal/terminal-bash/src/config.ts` | default shell `existsSync('/bin/bash') ? '/bin/bash' : 'bash'` | Termux has no `/bin/bash` |

Test companions travel with the code: `apiproxy/tests/native-path-opener.spec.ts`, `subprocess-local/tests/process-inspector.spec.ts`, `terminal-bash/tests/local.spec.ts`.

### Dependency and patch layer (upstream bumps the dependency → re-apply)

| Item | Change | Why |
|---|---|---|
| `patches/koffi@3.1.1.patch` + matching `pnpm-workspace.yaml` `patchedDependencies` entry | koffi statx call → raw `syscall(SYS_statx, ...)` | bionic headers do not declare statx; pinned to koffi@3.1.1 |
| `package.json` devDependency `@img/sharp-wasm32` | wasm fallback for sharp | Android has no libvips; arch-independent |
| `scripts/android-native-build.sh` | compiles koffi + node-pty locally | no android-arm64 prebuilds; node-pty needs `--nodedir=$PREFIX` |
| `pnpm-lock.yaml` | lockfile | regenerate via `pnpm install --ignore-scripts` |

Upstream-owned, do not touch: `patches/node-pty@1.1.0.patch` (upstream supplies it).

### Configuration mapping

| Item | Change | Why |
|---|---|---|
| `tsconfig.base.json` | client path alias for `dsh-client-ui-directory-picker-browse` | the browse picker fallback resolves from source |

### Docs and CI (upstream rewrites conflict; keep the local version)

`USE.md`, `apps/cli/README*.md` (`--expose-internals`), `.github/workflows/sync-upstream.yml` (daily mirror; must stay on the default branch), `.agents/skills/`.

### Branch topology

- `master` — upstream mirror only (`git reset --hard origin/master`), never edited.
- `adapt/android-termux` — ALL adaptations (code + deps + docs), the daily working branch.
- `feat/android-native-deps` — deps+patches-only snapshot (7 files), merged into adapt; useful to reinstall dependencies from, re-pushed but never re-based on upstream. Code adaptations cannot live there — they must merge against upstream on `adapt/android-termux` anyway, and the ledger above, not branch topology, is what prevents forgetting a re-apply.

## Troubleshooting

Problems observed on this machine, with the verified fix. Symptoms below the first group are environmental, not code regressions.

| Symptom | Root cause and fix |
|---|---|
| `pnpm run ...` aborts on lefthook postinstall failure | pnpm's `verify-deps-before-run` triggers `pnpm install`; lefthook's postinstall (`get-exe.js` MODULE_NOT_FOUND) always fails on Android. Use `npm run ...` or invoke the binary directly (steps 3, 5) |
| Boot fails `Cannot find package '@deepseek-ai/cordis-plugin-timer'` | Loader's `ModuleLoader.fromInternal()` needs Node's internal ESM loader; the `node-addon-require-builtin` native chain has no Android prebuild, so the fallback dies. Launch with `--expose-internals` |
| Startup takes 15s+ | You launched in tsx source mode; per-import resolution probing (stat/ENOENT storms) costs 15-22s versus 1-5s built. Use `apps/cli/lib/bin.js`; tsx's own disk transform cache does not help because the bottleneck is resolution, not transpilation |
| `pnpm install` reports koffi `invalid conversion` | koffi's native compile conflicts with bionic headers (statx signature). Use `pnpm install --ignore-scripts`, then `scripts/android-native-build.sh` |
| Writing a file fails with EACCES on `link` | This filesystem forbids hard links, so temp-file+link atomic writes fail. Write via bash/`cat` or a rename-based tool; this is the same restriction the attachment-store and session-persistence rename fallbacks work around |
| `dshstatus` port check reports "无法检测" | `ss`/`netstat` are not installed; `pkg install net-tools` |
| `/proc/uptime` or `/proc/loadavg` permission denied | The sandbox masks them; measure with wall-clock and `/proc/<pid>/stat` tick deltas instead |
| Whole machine feels slow | Memory pressure: ~9/11 GB used, swap active; close background apps before concluding a code regression |
