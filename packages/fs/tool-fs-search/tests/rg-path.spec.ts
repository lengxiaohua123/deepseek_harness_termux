/**
 * Resolution-path tests for the lazy ripgrep lookup. The module is mocked to
 * throw at evaluation — the shape a missing or corrupt platform package
 * produces — and the product then falls back to a PATH `rg` (Android/Termux
 * has no `@vscode/ripgrep` platform build), memoizing the resolved value.
 * The success path with a real binary is exercised throughout tools.spec.ts.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { resolveRgPath, runRipgrep } from '@deepseek-ai/dsh-tool-fs-search'

// Any access to the mocked module's surface throws — the shape a missing
// platform package produces at module evaluation.
vi.mock('@vscode/ripgrep', () => new Proxy({}, {
  get() {
    throw new Error('platform package @vscode/ripgrep-win32-x64 is not installed')
  },
}))

describe('lazy packaged-ripgrep resolution', () => {
  it('fails the first search call with SEARCH_FAILED instead of failing module load', async () => {
    // The resolution rejects before any spawn, so no subprocess service is needed.
    const controller = new AbortController()
    const exec = { signal: controller.signal, name: 'glob', callId: CallId('missing-platform-package') } as unknown as ToolExecution

    await expect(runRipgrep(new Context(), exec, 'glob', ['--files'], 1_000_000, 3_000, 64 * 1024))
      .rejects.toMatchObject({ name: 'SearchError', code: 'SEARCH_FAILED' })
  })

  it('falls back to a PATH rg and memoizes the resolution', async () => {
    // The packaged build is missing, so the product falls back to a
    // PATH-resolved `rg` (Termux ships no @vscode/ripgrep platform package);
    // the memoized value is the same on every call.
    await expect(resolveRgPath()).resolves.toBe('rg')
    await expect(resolveRgPath()).resolves.toBe('rg')
  })
})
