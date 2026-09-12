# refactor(subprocess): name the /proc process-tree platform set

## What

`dsh-subprocess-local` compared the target platform against the `'linux'`
literal in two readers:

- the platform dispatch in `createProcessInspector`;
- the process-group liveness rule that `spawn.ts` runs once the direct child has settled.

Both readers consume a Linux-style `/proc` process tree, so the platform set they
accept is a property of the reader, not of one operating system's name. The
change exports `hasProcProcessTree(platform)` from `process-inspector.ts` — next
to the `/proc` readers that depend on it — and calls it from both sites.

## Why

Android is Linux-family: bionic serves `/proc/<pid>/stat` and `/proc/<pid>/task`
in the layout both readers parse, and `os.platform()` reports `android` there.
The literal therefore excluded a platform whose readers work unchanged, and
terminal inspection failed at plugin load with
`terminal inspection is unsupported on platform android` instead of reading the
process table.

## Behavior

- `hasProcProcessTree('android')` returns `true`; `createProcessInspector('android', 'arm64', …)` returns the `/proc` inspector instead of throwing.
- `linux`, `darwin`, and `win32` take exactly the branches they took before.
- Every other platform still fails loud at plugin load (`createProcessInspector` keeps its `throw`).

## Checks run

- `tsc -b packages/subprocess/subprocess-local/tsconfig.json`
- `vitest run packages/subprocess/subprocess-local/tests/process-inspector.spec.ts packages/subprocess/subprocess-local/tests/spawn.spec.ts` — 97 passed. Run on an Android/arm64 host (bionic), which is where the new `android` dispatch assertions execute against the real `/proc` layout.
- `scripts/verify-agent-note-format.ts` — 344 Agent Notes conform.
- `scripts/verify-translation-pairing.ts --write <pair>` — bilingual record updated.

Not run on this host: the full `pnpm run test`, `test:coverage`, and `doc-sync`
aggregates. The preparing host is a Termux/arm64 environment without the CI
toolchain, so those gates are left to CI.

## Agent Note

`.agents/notes/implemented/simplification/2026-09-12-name-the-proc-process-tree-platform-set.md`
