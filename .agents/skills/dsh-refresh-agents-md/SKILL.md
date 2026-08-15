---
name: dsh-refresh-agents-md
description: Use when asked to bootstrap, refresh, or audit the deepseek-harness repository memory (root AGENTS.md and its CLAUDE.md symlinks), or when the repo layout, commands, budgets, or conventions may have drifted from the tree and manifests.
---

# DSH Refresh AGENTS.md

The root `AGENTS.md` is the repository memory: every session loads it, so it must be accurate and tight. Refresh it in place — never rewrite wholesale and never create a second memory file. `CLAUDE.md` is a symlink to `AGENTS.md` at root, `packages/`, and `examples/`; edit the real file only.

## Facts that drift, and how to verify them

1. **Package layout.** The root `## Repository layout` block is an index; the authoritative group map is the `packages/README.md` table. Diff the block against the real tree and that table — directories get renamed (`self-modification/` → `extensions/`, `support/` → `test-support/`), and new packages appear without the index being updated.

```sh
ls packages
cat packages/README.md
```

2. **Commands.** The `## Commands` block must list scripts that exist verbatim.

```sh
grep -oE '"(test|test:coverage|typecheck|lint|build|hygiene|doc-sync|website:build|dsh|demo:acp|demo:cordis)":' package.json
```

3. **Symlinks and referenced docs.** Every `CLAUDE.md` must be a symlink; every `docs/*.md` link in `AGENTS.md` must resolve.

```sh
ls -la CLAUDE.md packages/CLAUDE.md examples/CLAUDE.md
for f in docs/architecture.md docs/testing.md docs/development.md docs/cordis-primer.md docs/rescope.md docs/defensive-patterns.md docs/glossary.md; do test -f "$f" && echo "OK $f" || echo "MISS $f"; done
```

4. Read the current file fully before editing — preserve its structure and voice.

## Budget and gate compliance

The root `AGENTS.md` is budgeted in `scripts/doc-budgets.manifest.json`, enforced by `pnpm run verify-doc-budgets`. `docs/AGENTS.md` sets the target at 1,600 words; the ceiling is 2,000 (raised from 1,900 in 2026-08 to fit the complete package index — justify any further raise in the PR, per the docs/AGENTS.md exception for content that would otherwise be deleted).

```sh
wc -w AGENTS.md
```

`pnpm run verify-md-wrap` rejects hard-wrapped prose paragraphs; fenced code blocks are exempt, so layout blocks and command listings may flow. When over ceiling, condense glosses before touching the manifest.

Both gates run through `tsx` from `node_modules`; they are part of `pnpm run doc-sync`.

## Environment bootstrap (Android/Termux notes)

`pnpm` is not preinstalled on this host: `npm install -g pnpm@<version>`, where `<version>` is the `packageManager` field of `package.json` (e.g. `pnpm@11.7.0`).

A plain `pnpm install` fails on android/arm64 (koffi's `statx` call does not compile against bionic). Install in two steps; the native addons are then genuinely usable, not disabled:

```sh
pnpm install --ignore-scripts
bash scripts/android-native-build.sh   # compiles koffi + node-pty; needs cc/make/python
```

Repository-fixed adaptation facts:

- **koffi**: `patches/koffi@3.1.1.patch` (registered in `pnpm-workspace.yaml` `patchedDependencies`) uses `syscall(SYS_statx, ...)` because bionic declares no `statx()` function; `scripts/android-native-build.sh` compiles the patched store copy. After a `pnpm install` that re-materializes the `koffi@3.1.1_patch_hash=*` store dir, rerun the script.
- **node-pty**: compiled via the local node headers (`--nodedir=$PREFIX`) — node-gyp's downloaded official headers gate `statx` behind the Android NDK branch and fail.
- **sharp**: runs through the `@img/sharp-wasm32` fallback (root devDependency); no libvips needed.
- **Platform boundary**: sandbox process isolation needs Landlock (Android kernels return `ENOSYS`) or `bwrap` (absent) — the sandbox is fail-closed by design (explicit `SandboxUnavailableError`, never a silent downgrade).
- **directory-picker** resolves to the `browse` backend off darwin/win32/linux; the client surface package needs a `tsconfig.base.json` `paths` entry for source runs (a missing entry shows up as `ERR_MODULE_NOT_FOUND` when the auto entry dynamically imports it — check `dsh-client-ui-*` paths when adding client packages).
- **session persistence**: Android SELinux (`untrusted_app`) forbids `link()` everywhere; `session-persistence-jsonl`'s `materializePosix` falls back to `rename()` on `EACCES`/`EPERM`. If a `link ... EACCES` error resurfaces in a session write, the running branch is missing that fix (commit `16a6a7f347`) — `feat/android-native-deps` predates it; run on `adapt/android-termux`.
- **lazy native loading**: `sharp` and `node-pty` are dynamic-imported on first use, so booting web/headless never touches a native module until a terminal or attachment operation actually needs it.

`esbuild`/`rolldown` platform packages are prebuilt and unaffected. Smoke-check the toolchain before trusting gate output:

```sh
pnpm exec vitest run packages/util/timeout   # unit runner
pnpm run build:lib:host                      # tsc + tsdown/rolldown
pnpm dsh --version                           # CLI entry
```

## Run and troubleshoot (Android)

```sh
# built-lib run (no tsx; resolves workspace packages via node_modules links)
node --expose-internals apps/cli/lib/bin.js web --port 3080
# source run (tsx + tsconfig paths; picks up src changes without rebuilding)
node --expose-internals --import tsx/esm apps/cli/src/bin.ts web --port 3080
# headless task (same shape)
node --expose-internals --import tsx/esm apps/cli/src/bin.ts --profile headless "task"
```

- `--expose-internals` is mandatory (cordis-plugin-hmr refuses to start without it); `NODE_OPTIONS` rejects it, so `pnpm dsh web` cannot carry the flag — always invoke `node` directly.
- API key: `~/.dsh/.credentials.yaml` (environment wins, file falls back); not the repo `.env`.
- Branch discipline: run on `adapt/android-termux` (owns every fix and the dependency set). `master` is a pure upstream mirror with none of the deps — never run pnpm or the web there. `feat/android-native-deps` has the dependency set but not the session fix.
- Remotes: `origin` = upstream `deepseek-ai/deepseek-harness` (https, fetch only); `my` = `git@github.com:lengxiaohua123/deepseek_harness_termux.git` (SSH, push). Upstream mirror CI: `.github/workflows/sync-upstream.yml` (schedule needs the GitHub default branch to be `adapt/android-termux`).

## Update flow

1. Fix stale facts first: renamed directories, missing packages, obsolete commands.
2. Fill orientation gaps; for the full package map, link `packages/README.md` instead of duplicating it.
3. Keep it tight — every line loads into every future session.
4. Re-run `pnpm run verify-doc-budgets` and `pnpm run verify-md-wrap`, review `git diff --check` and the final diff, then hand the result to the user for review.
