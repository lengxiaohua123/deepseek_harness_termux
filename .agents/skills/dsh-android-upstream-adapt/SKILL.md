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

High-risk adaptation surfaces. Upstream rewrites here force re-application:

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

Known environment failures on this machine — do not chase them unless the change touches their paths:

- `packages/attachment/attachment-local/tests/store.spec.ts` — directory `fsync` returns EACCES on Android.
- `packages/subprocess/subprocess-local/tests/process-exit.spec.ts` — child-process exit cleanup hangs under the sandbox (fails even for the non-terminal scenario).

Reliable suites for the adaptation surface: `attachment-local/tests/image.spec.ts`, `subprocess-local/tests/terminal.spec.ts`, `subprocess-local/tests/spawn.spec.ts`.

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
- Directory picker still falls back to the `browse` backend (`tsconfig.base.json` carries the client-package mapping).
- Sandbox stays fail-closed (Landlock `ENOSYS`, no bwrap) with an explicit error, never silent degradation.
- Session persistence still publishes via rename when hard links are forbidden.
- `USE.md` run instructions match the merged tree (built mode + `--expose-internals`).

## Troubleshooting

Problems observed on this machine, with the verified fix. Symptoms below the first group are environmental, not code regressions.

| Symptom | Root cause and fix |
|---|---|
| `pnpm run ...` aborts on lefthook postinstall failure | pnpm's `verify-deps-before-run` triggers `pnpm install`; lefthook's postinstall (`get-exe.js` MODULE_NOT_FOUND) always fails on Android. Use `npm run ...` or invoke the binary directly (steps 3, 5) |
| Boot fails `Cannot find package '@deepseek-ai/cordis-plugin-timer'` | Loader's `ModuleLoader.fromInternal()` needs Node's internal ESM loader; the `node-addon-require-builtin` native chain has no Android prebuild, so the fallback dies. Launch with `--expose-internals` |
| Startup takes 15s+ | You launched in tsx source mode; per-import resolution probing (stat/ENOENT storms) costs 15-22s versus 1-5s built. Use `apps/cli/lib/bin.js`; tsx's own disk transform cache does not help because the bottleneck is resolution, not transpilation |
| `pnpm install` reports koffi `invalid conversion` | koffi's native compile conflicts with bionic headers (statx signature). Use `pnpm install --ignore-scripts`, then `scripts/android-native-build.sh` |
| Writing a file fails with EACCES on `link` | This filesystem forbids hard links, so temp-file+link atomic writes fail. Write via bash/`cat` or a rename-based tool; this is the same restriction the session-persistence rename fix works around |
| `store.spec.ts` fails with EACCES | Directory `fsync` is not permitted on Android; the store suite cannot pass here. Not a regression |
| `process-exit.spec.ts` times out | Child-process exit cleanup hangs under the sandbox; the non-terminal scenario fails too, so it is unrelated to node-pty. Not a regression |
| `dshstatus` port check reports "无法检测" | `ss`/`netstat` are not installed; `pkg install net-tools` |
| `/proc/uptime` or `/proc/loadavg` permission denied | The sandbox masks them; measure with wall-clock and `/proc/<pid>/stat` tick deltas instead |
| Whole machine feels slow | Memory pressure: ~9/11 GB used, swap active; close background apps before concluding a code regression |
