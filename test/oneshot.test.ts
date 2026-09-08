import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inlineFiles, runAgyOnce } from '../src/oneshot.ts'
import { defaultConfig } from '../src/types/config-types.ts'

describe('Oneshot & File Inlining', () => {
  it('inlineFiles inlines text files and skips missing', async () => {
    const prompt = 'Review this code'
    const inlined = await inlineFiles(prompt, ['package.json'], process.cwd())
    assert.ok(inlined.includes('Review this code'))
    assert.ok(inlined.includes('--- file:'))
    assert.ok(inlined.includes('"cloudcode-link-core"'))
  })

  it('runAgyOnce fails cleanly without token', async () => {
    const res = await runAgyOnce(
      {
        cfg: () => defaultConfig(),
      },
      {
        prompt: 'Say hi',
      },
    )
    assert.equal(res.ok, false)
    assert.ok(res.error?.includes('No authenticated Antigravity account available.'))
  })
})
