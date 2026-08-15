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

A plain `pnpm install` fails on android/arm64: `koffi@3.1.1` native compilation errors on the `statx` signature vs bionic headers. `koffi` is used by `fs-local`, `session-persistence-jsonl`, `sandbox-windows-acl`, and `directory-picker-native`. Install with `pnpm install --ignore-scripts` instead; the esbuild and rolldown platform packages are prebuilt and unaffected, so tests, gates, and the build still run.

```sh
pnpm install --ignore-scripts
```

Smoke-check the toolchain before trusting gate output:

```sh
pnpm exec vitest run packages/util/timeout   # unit runner
pnpm run build:lib:host                      # tsc + tsdown/rolldown
pnpm dsh --version                           # CLI entry
```

## Update flow

1. Fix stale facts first: renamed directories, missing packages, obsolete commands.
2. Fill orientation gaps; for the full package map, link `packages/README.md` instead of duplicating it.
3. Keep it tight — every line loads into every future session.
4. Re-run `pnpm run verify-doc-budgets` and `pnpm run verify-md-wrap`, review `git diff --check` and the final diff, then hand the result to the user for review.
