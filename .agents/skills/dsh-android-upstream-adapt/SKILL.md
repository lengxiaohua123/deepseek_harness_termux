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
node scripts/android-platform-audit.mjs              # platform routing: new linux branches AND surviving adaptations
```

`android-platform-audit.mjs` is the authority for both platform questions; do not hand-run a grep instead.

- Check 1 fails on a `'linux'` comparison in runtime source that has no recorded verdict, and on a file whose comparison count grew — an upstream branch Android would silently skip. It matches any expression carrying the platform (`platform`, `facts.platform`, `os.platform()`, a local alias), in either operand order, so a renamed parameter cannot hide a site.
- Check 2 fails when a recorded adaptation lost its markers. This is the check that matters most after a merge: upstream overwriting `platform === 'linux' || platform === 'android'` back to its own form leaves the site count identical, so check 1 alone reports clean.
- Check 3 fails when a native artifact the Android toolchain or runtime resolves is gone — the android binding of esbuild/rolldown/rollup/lightningcss/oxlint/oxc-resolver, the locally compiled koffi and node-pty binaries, the sharp wasm fallback, or a PATH `rg`. A dependency bump or an install under a linux-reporting node breaks exactly one of those.
- It also refuses a narrowed corpus, so a broken walk cannot look like a clean tree.

Run it repo-wide, never only over the merge diff: a renamed or newly split file carries branches the diff view hides behind a rename.

Companion modes: `--markdown` prints the current verdict table (the single home for those verdicts is the script); `--literals` lists `'linux'` literals no comparison pattern claimed, which is how a map key or array membership check would surface; `--self-test` proves both checks reject, and runs in a temp fixture tree.

Every new hit needs a verdict recorded in the script: either android falls through to the correct default, or the branch needs the dual-value match (`android` OR `linux && arm64`). `=== 'darwin'`/`=== 'win32'` branches are safe — android takes the POSIX path. Verdicts decided from source reading, kept in the script so the next sync only has to look for new sites:

- `subprocess-local/src/index.ts` containment mode — correct as-is. The `linux-scope` probe requires `systemctl --user`/`systemd-run --user`, absent on Termux, so android would land in `fallback` anyway; excluding android also skips two `spawnSync` probes.
- `util/native-command/src/path-opener.ts` — correct as-is; the remaining sites are `$BROWSER`/WSL semantics, and android has its own `termux-open` branches. Note Termux does ship `xdg-open` (a wrapper forwarding to `termux-open`) and an Android `zenity` binary, so "the tool is missing" is not a safe assumption for a new Linux branch — check `canOpenNativePath`'s `DISPLAY` requirement instead.
- `host/directory-picker-auto` / `directory-picker-native` — correct as-is. Android has no attended Linux chooser, so auto picks `browse`; forcing `native` throws a loud unsupported-platform error.
- `host/open-in-app` `specFor()`/`icons.ts` — correct as-is. The catalog is desktop-app-specific; generic opening goes through the path opener's android branch.
- `experimental/code-runtime-python/src/index.ts` — already accepts android alongside linux.
- `experimental/webworker-runtime` — comments only; that sandbox projects its own realm as linux regardless of host.

High-risk adaptation surfaces. Upstream rewrites here force re-application — the complete file-by-file ledger with reasons is the "Adaptation ledger" section below:

- `vendor/` — vendored Cordis; owns the loader's internal-module resolution that drives the `--expose-internals` requirement.
- `packages/boot/app-boot`, `apps/cli` — launcher and Loader boot path.
- `packages/attachment/attachment-local/src/image.ts` — keep the lazy sharp import (step 7).
- `packages/subprocess/subprocess-local/src/index.ts` — keep the lazy node-pty import (step 7).
- `packages/sandbox/*` — Landlock/bwrap fail-closed semantics.
- `packages/session/*`, `packages/host/directory-picker*` — Android filesystem quirks (hard-link-free session publish, browse picker fallback).
- `package.json`, `pnpm-workspace.yaml`, `patches/` — dependency versions and patched deps.

### The platform-lie question

Do not replace these dual matches by shimming `process.platform` to report `linux`. Measured on this machine: the shim works (`process.platform` is `configurable`, `os.platform()` follows it, and `NODE_OPTIONS` propagates it to children), but it makes JS believe `linux` while the installed native binaries stay android-built. `koffi` then fails with `Cannot find the native Koffi module` because its loader reads `build/koffi/<platform>_<arch>/koffi.node` and the local build lands in `android_arm64/`. Worse, no `linux-arm64` variant of the esbuild, rolldown, rollup, lightningcss, oxlint, or oxc-resolver bindings is installed, so the build toolchain itself stops resolving. `sharp` and `node-pty` survive the lie, and `canOpenNativePath()` flips to `false` because it requires `DISPLAY`/`WAYLAND_DISPLAY`, which disables native path opening. The lie also removes the signal that Android is not Linux: a future `'linux'` branch gets taken silently instead of falling through where this audit can see it. It saves the two one-line dual matches in `process-inspector.ts` and `spawn.ts` — and the upstream helper below retires those properly.

### Upstream draft: retire the two dual matches

`upstream-proc-process-tree.patch` (branch `upstream/proc-process-tree-helper`, based on `origin/master`) adds `hasProcProcessTree(platform)` to `process-inspector.ts` and calls it from both the inspector dispatch and the `spawn.ts` liveness rule, with an Agent Note triplet. `upstream-proc-process-tree-pr.md` is its PR body. If upstream lands an equivalent helper, delete adaptations 6 and 7 from the script's `ADAPTATIONS` and reclassify those two `VERDICTS` entries as `upstream` — otherwise check 2 will fail on a tree that is correct.

## 2. Re-install and rebuild native addons when dependencies changed

```sh
pnpm install --ignore-scripts        # mandatory: plain pnpm install fails on koffi compile and on lefthook's postinstall
bash scripts/android-native-build.sh # koffi + node-pty have no android-arm64 prebuilds; compile locally
```

Version bumps of `koffi` or `node-pty` break the pinned patches; update them together:

- `patches/koffi@3.1.1.patch` — swaps the `statx()` call for a raw syscall (bionic headers do not declare it).
- `patches/node-pty@1.2.0-beta.15.patch` (upstream owns this one; the local `patchedDependencies` key must match the installed version, not a fixed major).
- `pnpm-workspace.yaml` `patchedDependencies` keys must match the patch filenames.
- If upstream bumps `sharp`, keep `@img/sharp-wasm32` in root devDependencies (the Android fallback; there is no libvips).

Toolchain prereqs for `scripts/android-native-build.sh`: `cc`, `make`, `python3`; node-pty builds with `--nodedir=$PREFIX` because the official downloaded headers gate statx behind the Android NDK and fail on Termux.

Then confirm the whole native layer resolved — dependencies branch on the platform string too, and they do not all behave the same:

```sh
node scripts/android-platform-audit.mjs    # "native artifacts: 9/9 resolved, host commands: 1/1 present"
```

| Class | Packages | What Android needs |
| --- | --- | --- |
| npm publishes an `android-arm64` variant | `@esbuild/android-arm64` (3 pinned versions), `@rolldown/binding-android-arm64`, `@rollup/rollup-android-arm64`, `@oxlint/binding-android-arm64`, `@oxc-resolver/binding-android-arm64`, `lightningcss-android-arm64`, `@napi-rs/canvas-android-arm64` | Nothing beyond `pnpm install`: pnpm's `os`/`cpu` filtering picks the android variant when the platform string is `android`. This is why the build, the bundler, CSS, and lint run natively on Termux |
| No android prebuild, compiled locally | `koffi`, `node-pty` | `scripts/android-native-build.sh`. Both loaders look for a directory named from the platform string — koffi at `build/koffi/<platform>_<arch>/koffi.node`, node-pty preferring `build/Release` — so the build must land where the loader of an `android`-reporting node looks |
| No android variant, supported fallback | `sharp` → `@img/sharp-wasm32`; `@vscode/ripgrep` → PATH `rg` | `sharp`'s own loader ends its fallback chain at `require('@img/sharp-wasm32/sharp.node')` and its error text names that install. `@vscode/ripgrep` has no android package at all, so `resolveRgPath()` falls back to a PATH `rg` (`pkg install ripgrep`) |

Two consequences worth keeping in mind. A `pnpm install` run under a node build that reports `linux` (some Termux builds do) installs the `linux-arm64` variants of the first class instead — glibc binaries that will not load on bionic; the audit's artifact check fails in exactly that case, naming the missing package. And the `@esbuild`/`@rolldown`/`lightningcss` bindings are the reason the platform string cannot simply be faked as `linux`: no `linux-arm64` binding is installed, so bundling, CSS, and lint would fail to resolve, on top of `koffi` losing its native module.

## 3. Build — full build on big merges

For a routine patch, build just what changed:

```sh
npm run build:lib:host    # tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host
```

For a LARGE merge (hundreds of commits) that touches client packages, run the FULL build — a host-only build leaves client packages (ui-renderer, ui-attachment, …) stale or missing and the server fails to boot:

```sh
npm_config_verify_deps_before_run=false pnpm run build   # full: host + client + web, skipping pnpm's auto-install
```

Why the env flag instead of `npm run build:lib:host`: `pnpm run build` normally runs `verify-deps-before-run`, which triggers `pnpm install`, whose lefthook postinstall always fails on Android and aborts the whole command. `npm_config_verify_deps_before_run=false` disables that pre-run install check so the full build proceeds. A full build also works around stale `tsbuildinfo` incremental caches: on big refactor merges the incremental tsc can keep pre-refactor content in `lib/types` and mis-bundle a server entry as React (node then hits `.css`) — a clean full build reclassifies it.

## 4. Typecheck the changed packages

```sh
node_modules/.bin/tsc -b packages/<group>/<pkg>/tsconfig.json
```

## 5. Run tests by invoking vitest directly

```sh
node --import tsx/esm node_modules/vitest/vitest.mjs run packages/<group>/<pkg>/tests
```

This bypasses the same pnpm pre-run trap as step 3.

The adapted-package suites are green on this machine except one known environmental failure: 1144 passed / 1 failed / 18 skipped (45 files, 1163 tests) across `attachment-local`, `subprocess-local`, `settings-file`, `directory-picker-auto`, `native-command`, `tool-bash`, `session-persistence-jsonl`, and `fs-local`; the single failure is the sharp-wasm32 SVG `<text>` case below. Earlier "environment failures" were resolved by the adaptations below, not worked around:

- `attachment-local/tests/store.spec.ts` — failed on root-owned Android ancestors (`/data`, `/data/data`) during the durability walk and on forbidden hard links; both now degrade gracefully (see step 7).
- `subprocess-local/tests/process-exit.spec.ts` — failed on the android platform throw in `createProcessInspector`, not on sandbox cleanup.
- `terminal-bash/tests/local.spec.ts` — failed on the same inspector throw plus a test that hardcoded `/bin/bash`; both fixed.

Full-suite baseline after the 0.1.5-rc.2 sync (14.5 min, `--maxWorkers=4`): 14563 passed / 31 failed / 116 skipped (14710 tests, 872 files). All 31 are environmental — none touch the adapted packages:

- oxlint-contract and install-lefthook — tooling version / hard-link install; lefthook is unused on Termux.
- subagent-claude-code / subagent-codex real-product — need the external CLIs and their API keys.
- session-query-sqlite — inspect-API behavior on a slow machine.
- credentials ×1 — Android filesystem does not reflect chmod(600).
- gen-third-party-notices ×1 — optional Claude SDK payload not installed.
- attachment `normalization.spec.ts` ×1 — sharp-wasm32 does not render SVG `<text>`; genuine wasm32 limitation.
- process-exit, acp-snapshot, session-persistence-sqlite, lsp-stdio, tool-bash are green this run (timing flakes / fixed).

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
- `util/native-command/src/path-opener.ts` keeps the android branch (`termux-open(1)` via the intent launcher) and `canOpenNativePath('android')` answers true; without them the platform throws and the open button hides.
- `process-inspector.ts` `createProcessInspector` routes `'android'` to the Linux `/proc` inspector (arm64 syscall table); `spawn.ts` group-liveness includes `'android'`. These make terminal inspection and tree teardown equal to Linux on Termux.
- `attachment-local/src/store.ts` keeps two Android degradations: `syncDirectory` skips root-owned ancestors it cannot open (`/data`, `/data/data` — EACCES/EPERM) instead of failing the publication, and the object publish falls back from `link()` to `rename()` when SELinux forbids hard links (same pattern as session-persistence-jsonl).
- Directory picker still falls back to the `browse` backend (`tsconfig.base.json` carries the client-package mapping).
- Sandbox stays fail-closed (Landlock `ENOSYS`, no bwrap) with an explicit error, never silent degradation.
- Session persistence still publishes via rename when hard links are forbidden.
- `USE.md` run instructions match the merged tree (built mode + `--expose-internals`).

## Adaptation ledger — every divergence from upstream, and why

Re-apply only what upstream rewrote; everything else survives merges. Verify each item against the live diff during step 1. The platform-routing rows (inspector, spawn, settings watcher, opener) are also machine-checked: `node scripts/android-platform-audit.mjs` fails when one loses its markers, which is the failure a diff review misses because the site count stays the same.

### Code adaptations (upstream rewrites the file → re-apply)

| File | Change | Why |
|---|---|---|
| `packages/attachment/attachment-local/src/image.ts` | static `import sharp` → lazy `loadSharp()` on first use | sharp resolves to `@img/sharp-wasm32` on Android; a WASM backend at boot is waste |
| `packages/attachment/attachment-local/src/store.ts` | `syncDirectory` skips unopenable ancestors; publish falls back `link()` → `rename()` | root-owned `/data`/`/data/data` are unreadable; SELinux forbids hard links |
| `packages/util/native-command/src/path-opener.ts` | android branch runs `termux-open`; `canOpenNativePath('android')` true | termux-open ships with termux-tools; without the branch the platform throws |
| `packages/session/session-persistence-jsonl/src/index.ts` | publish via `rename()` when `link()` returns EACCES/EPERM | SELinux forbids hard links; rename stays atomic |
| `packages/subprocess/subprocess-local/src/index.ts` | static `import * as nodePty` → `await import('node-pty')` at first PTY spawn | native addon load at boot is waste |
| `packages/subprocess/subprocess-local/src/process-inspector.ts` | `createProcessInspector` routes `'android'` to `LinuxProcessInspector` | Termux reports platform `'android'`; the old code threw, breaking every terminal |
| `packages/subprocess/subprocess-local/src/spawn.ts` | group-liveness check includes `'android'` | keeps tree teardown equal to Linux |
| `packages/terminal/terminal-bash/src/config.ts` | default shell `existsSync('/bin/bash') ? '/bin/bash' : 'bash'` | Termux has no `/bin/bash` |
| `packages/settings/settings-file/src/index.ts` | watcher runs `usePolling` on android or linux+arm64 | this filesystem delivers inotify events late/lossy for rapid atomic renames; polling reads the one small document reliably |
| `packages/fs/tool-fs-search/src/search-core.ts` | `resolveRgPath()` falls back to a PATH `rg` when `@vscode/ripgrep` fails to load | VS Code never published an android platform package; Termux supplies `rg` via `pkg install ripgrep` or a statically linked aarch64 musl binary (glibc arm64 binaries do not load on bionic) |
| `packages/fs/fs-local/src/fsio.ts` | the `createIfAbsent` publish falls back from `link()` to `rename()` on EACCES/EPERM | Android SELinux forbids hard links; this one fix keeps the fs write/edit tools working on Termux |

Test companions travel with the code: `util/native-command/tests/path-opener.spec.ts` (the opener moved out of `host/apiproxy`), `subprocess-local/tests/process-inspector.spec.ts`, `terminal-bash/tests/local.spec.ts`, `settings-file/tests/local.spec.ts` (waitFor raised to 15s), `tool-fs-search/tests/tools.spec.ts` + `rg-path.spec.ts` (resolve via the product resolver instead of a static `@vscode/ripgrep` import), `directory-picker-auto/tests/loader-composition.spec.ts` + `directory-picker-native/tests/native-picker.spec.ts` (assert the android fallback to browse instead of assuming a native tier — this one has several assertions, so re-apply it as a whole file: the attended cases must use the `attendedBackend`/`attendedSurface` constants in the `find(...)` and `not.toContain(...)` calls too, not only in the mount assertions, or the later cases dereference an entry that does not exist on android), `attachment-local/tests/file-store.spec.ts` (guard the hard-link inode assertion with a `link(2)` capability probe, since the store's rename fallback publishes a copy).

Two traps when re-applying a companion by hand, both hit during the 0.1.5-rc.2 sync: pasting the new `it(...)` inside an existing test body instead of after it (vitest then fails collection with `Calling the test function inside another test function is not allowed`), and adapting only the first assertion of a repeated pattern. Run the companion file itself right after re-applying it — it is the only signal for both.

### Dependency and patch layer (upstream bumps the dependency → re-apply)

| Item | Change | Why |
|---|---|---|
| `patches/koffi@3.1.1.patch` + matching `pnpm-workspace.yaml` `patchedDependencies` entry | koffi statx call → raw `syscall(SYS_statx, ...)` | bionic headers do not declare statx; pinned to koffi@3.1.1 |
| `package.json` devDependency `@img/sharp-wasm32` | wasm fallback for sharp | Android has no libvips; arch-independent |
| `scripts/android-native-build.sh` | compiles koffi + node-pty locally; the node-pty `.pnpm` glob tracks the major (currently `node-pty@1.2*` — update it on major bumps) | no android-arm64 prebuilds; node-pty needs `--nodedir=$PREFIX`. Each compiled artifact is asserted by `android-platform-audit.mjs`, which is what catches a version bump that moves the `.pnpm` path |
| `pnpm-lock.yaml` | lockfile | regenerate via `pnpm install --ignore-scripts` |

Upstream-owned, do not touch: `patches/node-pty@1.2.0-beta.15.patch` (upstream supplies it; rename it and the `pnpm-workspace.yaml` key together when upstream bumps node-pty).

### Configuration mapping

| Item | Change | Why |
|---|---|---|
| `tsconfig.base.json` | client path alias for `dsh-client-ui-directory-picker-browse` | the browse picker fallback resolves from source |

### Docs and CI (upstream rewrites conflict; keep the local version)

- `USE.md` — Android run and adaptation conventions.
- `apps/cli/README.md`, `README.zh.md`, `README.i18n.yaml` — `--expose-internals` notes, plus the i18n checksum manifest that tracks them.
- `AGENTS.md` + `scripts/doc-budgets.manifest.json` — refreshed package index and its raised budget ceiling (1900→2000); no Android content, but keep the local copy when upstream rewrites them.
- `.github/workflows/sync-upstream.yml` — daily upstream mirror; must stay on the default branch.
- `.agents/skills/` — the skills themselves.
- `scripts/android-platform-audit.mjs` — the platform gate: three checks (unrecorded `'linux'` branches, adaptation markers, native dependency artifacts) plus a corpus floor. Its `VERDICTS`, `ADAPTATIONS`, and `NATIVE_ARTIFACTS` tables are the machine-readable half of the ledger; `--self-test` proves every rejection.
- `.agents/skills/dsh-android-upstream-adapt/upstream-proc-process-tree.patch` + `upstream-proc-process-tree-pr.md` — the upstream draft that retires adaptations 6 and 7. Fork tooling, never merged into `master`.

Machine-local, NOT in the repo (do not hunt for them in the diff): `~/.zshrc` `dshstart`/`dshstop`/`dshstatus`/`dshattach` tmux helpers, `~/.dsh/settings.yaml` (danger-full-access default).

### Branch topology

- `master` — upstream mirror only (`git reset --hard origin/master`), never edited.
- `adapt/android-termux` — ALL adaptations (code + deps + docs), the daily working branch.
- `upstream/proc-process-tree-helper` — the `hasProcProcessTree` draft based on `origin/master`, for sending upstream. Rebase it on `origin/master` before pushing; the patch file is the stale-proof copy.
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
| A large sync (100s of commits) leaves the merge interrupted / half-applied | Run `git merge` as a background job with output to a log (foreground 180s tool timeouts can kill it mid-merge, leaving partial working-tree changes and no MERGE_HEAD); `git reset --hard HEAD` to recover a clean pre-merge tree, then rerun in the background |
| Suites fail to LOAD with `Cannot find package '<pkg>'` right after a sync | Upstream added a new dependency (even when versions of existing ones look unchanged). Run `CI=true pnpm install --ignore-scripts` to sync node_modules, then re-run tests |
| Build reports spurious TS errors right after a sync | Do not run `npm run build:lib:host` concurrently with `pnpm install` — both mutate node_modules and race. Run install first, then build |
| New upstream tests hardcode a default we overrode (e.g. `/bin/bash` in the new dialect tests) | When a default-resolution fix (existsSync fallback) collides with an upstream test that asserts the literal old default, update that test to expect the resolved value (`existsSync('/bin/bash') ? '/bin/bash' : 'bash'`) — same pattern as terminal-bash config |
| A spec fails `Calling the test function inside another test function is not allowed` | A re-applied test companion was pasted into the middle of an existing test body instead of after it. Re-insert the added `it(...)` block at the end of the enclosing `describe`, next to the sibling test it belongs with |
| A platform scan reports clean, but a bare `=== 'linux'` branch is later found by hand | The scan used a `git grep` pathspec glob (`'packages/*/*/src/**/*.ts'`), which misses files directly under `src/`; run `node scripts/android-platform-audit.mjs`, which walks the tree itself |
| `android-platform-audit.mjs` says `FAIL adaptation lost` after a merge | Upstream rewrote the file and dropped our `|| platform === 'android'`. Re-apply that row from the Adaptation ledger, then re-run the audit |
| `android-platform-audit.mjs` says `FAIL unrecorded` | A new upstream `'linux'` branch. Read it, decide whether android must join it, and record the verdict in the script's `VERDICTS` (with `count: 1` or the real count) either way |
