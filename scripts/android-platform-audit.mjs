/**
 * Audit Termux platform routing in two directions.
 *
 * Check 1 (new branches): every `platform === 'linux'` site in runtime source
 * has a recorded verdict, because Termux reports `'android'` and would silently
 * skip a Linux-only branch. A new or newly multiplied site fails the run.
 *
 * Check 2 (surviving adaptations): each Android adaptation still carries its
 * marker. An upstream merge can overwrite `platform === 'linux' || platform
 * === 'android'` back to the upstream form, which leaves the site count
 * unchanged and would pass check 1 alone.
 *
 * Usage:
 *   node scripts/android-platform-audit.mjs               # audit this checkout
 *   node scripts/android-platform-audit.mjs --literals    # also list unclaimed linux literals
 *   node scripts/android-platform-audit.mjs --markdown    # emit the verdict table
 *   node scripts/android-platform-audit.mjs --self-test   # prove the checks reject
 */

import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Matches a comparison against a Linux platform string in either operand
 * order. Any expression may carry the platform — `platform`, `facts.platform`,
 * `os.platform()`, or a local alias such as `p` — so a renamed parameter
 * cannot hide a site from the audit.
 */
const LINUX_COMPARISON = /[\w.$)\]]+\s*(?:===|!==)\s*'linux'|'linux'\s*(?:===|!==)\s*[\w.$([]+/g

/** Any Linux literal in runtime source that the comparison pattern did not claim. */
const LINUX_LITERAL = /'linux'/g

/** Floor for a credible runtime scan; this tree holds 1600+ runtime sources. */
const MIN_RUNTIME_SOURCES = 400

/**
 * Recorded verdict for one runtime source file that compares against `'linux'`.
 *
 * `count` is the number of comparisons the audit expects there. Termux is
 * correct when the branch either carries an `android` alternative (`adapted`)
 * or is Linux-desktop-specific so that Android taking the other path is right
 * (`upstream`).
 */
const VERDICTS = [
  {
    file: 'packages/experimental/code-runtime-python/src/index.ts',
    count: 1,
    kind: 'adapted',
    verdict: 'Accepts android alongside linux already.',
  },
  {
    file: 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/path.ts',
    count: 1,
    kind: 'upstream',
    verdict: 'Comment only; projects the worker realm as linux regardless of host.',
  },
  {
    file: 'packages/experimental/webworker-runtime/src/node/external_packages/koffi.ts',
    count: 1,
    kind: 'upstream',
    verdict: 'Comment only; the sandbox has no koffi call path.',
  },
  {
    file: 'packages/host/directory-picker-auto/src/resolve.ts',
    count: 1,
    kind: 'upstream',
    verdict: 'Android has no attended Linux chooser, so the browse backend is the correct pick.',
  },
  {
    file: 'packages/host/directory-picker-native/src/native-picker.ts',
    count: 1,
    kind: 'upstream',
    verdict: 'zenity/kdialog tier is desktop-only; android throws a loud unsupported-platform error.',
  },
  {
    file: 'packages/host/open-in-app/src/icons.ts',
    count: 1,
    kind: 'upstream',
    verdict: 'Desktop icon catalog; android falls through to the generic path opener.',
  },
  {
    file: 'packages/host/open-in-app/src/resolver.ts',
    count: 1,
    kind: 'upstream',
    verdict: 'Desktop app catalog; android resolves no catalog entry, which is correct.',
  },
  {
    file: 'packages/settings/settings-file/src/index.ts',
    count: 1,
    kind: 'adapted',
    verdict: 'Polling watcher for android and for linux+arm64 Termux node builds.',
  },
  {
    file: 'packages/subprocess/subprocess-local/src/index.ts',
    count: 1,
    kind: 'upstream',
    verdict: 'linux-scope containment needs systemd; android falls back, which is correct and cheaper.',
  },
  {
    file: 'packages/subprocess/subprocess-local/src/process-inspector.ts',
    count: 1,
    kind: 'adapted',
    verdict: 'Android uses the Linux /proc inspector.',
  },
  {
    file: 'packages/subprocess/subprocess-local/src/spawn.ts',
    count: 1,
    kind: 'adapted',
    verdict: 'Android process-group liveness follows the Linux /proc rule.',
  },
  {
    file: 'packages/util/native-command/src/path-opener.ts',
    count: 7,
    kind: 'adapted',
    verdict: 'Android opens through termux-open; the remaining sites are $BROWSER and WSL semantics.',
  },
]

/**
 * One Android adaptation and the markers proving it survived a merge. Every
 * pattern must match the file; the patterns span the surrounding logic so that
 * a partial revert of the file fails the check.
 */
const ADAPTATIONS = [
  {
    reason: 'android opens paths through termux-open',
    file: 'packages/util/native-command/src/path-opener.ts',
    markers: [
      /platform === 'android'/,
      /run\('termux-open', \[path\], signal\)/,
      /if \(platform === 'android'\) return true/,
    ],
  },
  {
    reason: 'lazy sharp import keeps the Android startup path free of libvips',
    file: 'packages/attachment/attachment-local/src/image.ts',
    markers: [/async function loadSharp/, /await import\('sharp'\)/],
  },
  {
    reason: 'hard-link-free attachment publish falls back to rename()',
    file: 'packages/attachment/attachment-local/src/store.ts',
    markers: [
      /code === 'EACCES' \|\| code === 'EPERM'[\s\S]{0,240}?await rename\(/,
      /code === 'EACCES' \|\| code === 'EPERM'[\s\S]{0,400}?await rename\(staged\.path, target\)/,
    ],
  },
  {
    reason: 'session publish falls back to rename() when link() is forbidden',
    file: 'packages/session/session-persistence-jsonl/src/index.ts',
    markers: [/code !== 'EACCES' && code !== 'EPERM'[\s\S]{0,120}?await rename\(tmp, finalPath\)/],
  },
  {
    reason: 'lazy node-pty import avoids loading the PTY addon at startup',
    file: 'packages/subprocess/subprocess-local/src/index.ts',
    markers: [/await import\('node-pty'\)/],
  },
  {
    reason: 'android process inspector routes to the Linux /proc implementation',
    file: 'packages/subprocess/subprocess-local/src/process-inspector.ts',
    markers: [/platform === 'linux' \|\| platform === 'android'\) return new LinuxProcessInspector/],
  },
  {
    reason: 'android process-group liveness follows the Linux /proc rule',
    file: 'packages/subprocess/subprocess-local/src/spawn.ts',
    markers: [/\(platform === 'linux' \|\| platform === 'android'\)/],
  },
  {
    reason: 'Termux has no /bin/bash',
    file: 'packages/terminal/terminal-bash/src/config.ts',
    markers: [/DEFAULT_BASH_SHELL = existsSync\('\/bin\/bash'\) \? '\/bin\/bash' : 'bash'/],
  },
  {
    reason: 'settings watcher polls where inotify drops rapid atomic renames',
    file: 'packages/settings/settings-file/src/index.ts',
    markers: [/usePolling: process\.platform === 'android' \|\| \(process\.platform === 'linux' && process\.arch === 'arm64'\)/],
  },
  {
    reason: 'ripgrep resolution falls back to PATH because no android package exists',
    file: 'packages/fs/tool-fs-search/src/search-core.ts',
    markers: [/await import\('@vscode\/ripgrep'\)[\s\S]{0,40}?\}\)\.catch\(\(\) => 'rg'\)/],
  },
  {
    reason: 'fs write publishes through rename() when link() is forbidden',
    file: 'packages/fs/fs-local/src/fsio.ts',
    markers: [/code === 'EACCES' \|\| code === 'EPERM'[\s\S]{0,240}?await rename\(tempPath, absolutePath\)/],
  },
]

/**
 * Read every runtime TypeScript source under `packages`. Test files are
 * excluded: they assert platform behavior rather than routing it.
 * @param root - repository root to walk.
 * @returns repo-relative posix paths of candidate sources.
 */
function runtimeSources(root) {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'lib' || entry.name === 'node_modules' || entry.name === 'tests') continue
        walk(full)
        continue
      }
      if (entry.name.endsWith('.ts')) found.push(relative(root, full).split(sep).join(posix.sep))
    }
  }
  walk(join(root, 'packages'))
  return found
}

/**
 * Compare the Linux-comparison sites in a tree against a verdict table.
 * @param root - repository root to audit.
 * @param verdicts - recorded verdicts to check the tree against.
 * @param minSources - floor for a credible scan, catching a narrowed corpus.
 * @returns per-file findings: unrecorded files, grown counts, stale entries, and corpus size.
 */
function auditBranches(root, verdicts, minSources) {
  const recorded = new Map(verdicts.map(entry => [entry.file, entry]))
  const sources = runtimeSources(root)
  const seen = new Map()
  for (const file of sources) {
    const hits = readFileSync(join(root, file), 'utf8').match(LINUX_COMPARISON)?.length ?? 0
    if (hits > 0) seen.set(file, hits)
  }
  const unrecorded = []
  const drifted = []
  for (const [file, hits] of seen) {
    const entry = recorded.get(file)
    if (entry === undefined) {
      unrecorded.push({ file, hits })
      continue
    }
    if (hits > entry.count) drifted.push({ file, expected: entry.count, hits })
  }
  const stale = verdicts.filter(entry => (seen.get(entry.file) ?? 0) < entry.count)
  return { seen, sources, unrecorded, drifted, stale, narrowed: sources.length < minSources }
}

/**
 * Check that every recorded adaptation is still present in its file.
 * @param root - repository root to audit.
 * @param adaptations - adaptations to verify.
 * @returns the adaptations whose markers no longer all match.
 */
function auditAdaptations(root, adaptations) {
  const missing = []
  for (const adaptation of adaptations) {
    let text
    try {
      text = readFileSync(join(root, adaptation.file), 'utf8')
    } catch {
      missing.push({ adaptation, failed: ['file is missing'] })
      continue
    }
    const failed = adaptation.markers.filter(marker => !marker.test(text)).map(marker => marker.source)
    if (failed.length > 0) missing.push({ adaptation, failed })
  }
  return missing
}

/**
 * List Linux literals that no comparison pattern claimed, so nothing hides.
 * @param root - repository root to scan.
 * @returns unclaimed matches with their file, line, and text.
 */
function auditLiterals(root) {
  const unclaimed = []
  for (const file of runtimeSources(root)) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    lines.forEach((line, index) => {
      const literalCount = line.match(LINUX_LITERAL)?.length ?? 0
      const comparisonCount = line.match(LINUX_COMPARISON)?.length ?? 0
      if (literalCount > comparisonCount) unclaimed.push({ file, line: index + 1, text: line.trim() })
    })
  }
  return unclaimed
}

/**
 * Run both audits and report them.
 * @param root - repository root to audit.
 * @param options - verdict table, adaptation table, scan floor, and literal switch.
 * @returns whether every check passed.
 */
function runAudit(root, options) {
  const branches = auditBranches(root, options.verdicts, options.minSources)
  const missing = auditAdaptations(root, options.adaptations)
  const literals = options.literals ? auditLiterals(root) : []
  const failed = branches.narrowed || branches.unrecorded.length > 0
    || branches.drifted.length > 0 || missing.length > 0

  if (branches.narrowed) {
    console.log(`FAIL narrowed corpus: found ${branches.sources.length} runtime sources, expected at least ${options.minSources}`)
  }
  console.log(`runtime linux-comparison sites: ${branches.seen.size} files of ${branches.sources.length} sources`)
  for (const { file, hits } of branches.unrecorded) {
    console.log(`FAIL unrecorded: ${file} (${hits} site${hits === 1 ? '' : 's'}) — decide the android route, then record a verdict`)
  }
  for (const { file, expected, hits } of branches.drifted) {
    console.log(`FAIL new site: ${file} has ${hits} comparisons, verdict records ${expected}`)
  }
  for (const entry of branches.stale) {
    const hits = branches.seen.get(entry.file) ?? 0
    console.log(`WARN verdict drift: ${entry.file} records ${entry.count} comparisons but has ${hits} — update or drop the verdict`)
  }
  for (const { adaptation, failed: markers } of missing) {
    console.log(`FAIL adaptation lost: ${adaptation.file} (${adaptation.reason})`)
    for (const marker of markers) console.log(`       missing: ${marker}`)
  }
  for (const { file, line, text } of literals) {
    console.log(`note unclaimed literal: ${file}:${line} ${text}`)
  }
  if (failed) {
    console.log('\naudit failed')
    return false
  }
  console.log(`all ${options.verdicts.length} verdicts match and all ${options.adaptations.length} adaptations are present`)
  return true
}

/**
 * Prove the checks accept an adapted tree and reject each way it can rot.
 * @returns whether the self-test passed.
 */
function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-platform-audit-'))
  const verdicts = [{ file: 'packages/a/b/src/index.ts', count: 1, kind: 'adapted', verdict: 'fixture' }]
  const adaptations = [{
    reason: 'fixture adaptation',
    file: 'packages/a/b/src/index.ts',
    markers: [/platform === 'linux' \|\| platform === 'android'/],
  }]
  const options = { verdicts, adaptations, literals: false, minSources: 1 }
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  const expect = (label, wanted, run) => {
    if (run() === wanted) return true
    console.log(`self-test FAILED: ${label}`)
    return false
  }
  try {
    write('packages/a/b/src/index.ts', "if (platform === 'linux' || platform === 'android') return 'ok'\n")
    if (!expect('an adapted tree was rejected', true, () => runAudit(root, options))) return false
    write('packages/a/b/src/other.ts', "export const tier = process.platform === 'linux' ? 'native' : 'browse'\n")
    if (!expect('an unrecorded linux branch was accepted', false, () => runAudit(root, options))) return false
    rmSync(join(root, 'packages/a/b/src/other.ts'))
    write('packages/a/b/src/index.ts', "if (platform === 'linux') return 'ok'\n")
    if (!expect('a dropped android adaptation was accepted', false, () => runAudit(root, options))) return false
    write('packages/a/b/src/index.ts', "if (platform === 'linux' || platform === 'android') return 'ok'\n")
    if (!expect('a narrowed corpus was accepted', false,
      () => runAudit(root, { ...options, minSources: 99 }))) return false
    console.log('self-test passed: adapted tree accepted; new branch, dropped adaptation, and narrowed corpus rejected')
    return true
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Print the recorded verdicts as a Markdown table.
 * @returns nothing.
 */
function printMarkdown() {
  console.log('| File | Sites | Kind | Verdict |')
  console.log('| --- | --- | --- | --- |')
  for (const entry of VERDICTS) {
    console.log(`| \`${entry.file}\` | ${entry.count} | ${entry.kind} | ${entry.verdict} |`)
  }
}

const argv = process.argv.slice(2)
const rootIndex = argv.indexOf('--root')
const root = rootIndex === -1 ? REPO_ROOT : argv[rootIndex + 1]
if (argv.includes('--markdown')) {
  printMarkdown()
  process.exit(0)
}
if (argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1)
}
const passed = runAudit(root, {
  verdicts: VERDICTS,
  adaptations: ADAPTATIONS,
  literals: argv.includes('--literals'),
  minSources: MIN_RUNTIME_SOURCES,
})
process.exit(passed ? 0 : 1)
