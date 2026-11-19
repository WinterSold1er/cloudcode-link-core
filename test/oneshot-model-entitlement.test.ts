/**
 * oneshot-model-entitlement.test.ts — `runAgyOnce` must ask the pool for an account that is
 * entitled to the wire model it is about to request.
 *
 * Before the fix, oneshot called `selectAccount(family)` with no model, so the pool could hand the
 * request to a signed-in account that does not serve that model, and the turn died on a 403 that
 * was really a routing mistake. `src/host/adapter.ts` already passed the wire model; this pins the
 * same rule for the oneshot path.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgyOnce } from '../src/oneshot.ts'
import { defaultConfig } from '../src/types/config-types.ts'
import { modelFamilyOf } from '../src/types/pool-types.ts'
import { getAntigravityRequestModelId } from '../src/models.ts'
import { AccountPoolManager, modelEntitlementOf } from '../src/pool.ts'

const REQUESTED_MODEL = 'gemini-4-hydrogen-high'
/** A model the un-entitled account IS allowed to serve, so it stays a healthy account. */
const FOREIGN_MODEL = 'claude-4.5-sonnet-thinking'

interface GenerateCall {
  authorization: string
  model: string | null
}

interface Upstream {
  endpoint: string
  calls: GenerateCall[]
  close(): Promise<void>
}

async function startUpstream(): Promise<Upstream> {
  const calls: GenerateCall[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (piece: Buffer) => chunks.push(piece))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const url = req.url ?? ''
      if (url.includes('loadCodeAssist') || url.includes('onboardUser')) return
      let model: string | null = null
      try {
        const parsed = JSON.parse(raw) as { model?: unknown }
        model = typeof parsed.model === 'string' ? parsed.model : null
      } catch {
        model = null
      }
      calls.push({ authorization: req.headers.authorization ?? '', model })
    })

    if ((req.url ?? '').includes('loadCodeAssist')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ cloudaicompanionProject: 'test-project-123' }))
      return
    }
    if ((req.url ?? '').includes('onboardUser')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ done: true, cloudaicompanionProject: 'test-project-123' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"served by the entitled account"}]}}]}}\n\n' +
        'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n',
    )
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    endpoint: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe('Oneshot account selection is model-aware (packages/core/src/oneshot.ts)', () => {
  it('never dispatches a request to an account that is not entitled to the requested model', async () => {
    const wireModel = getAntigravityRequestModelId(REQUESTED_MODEL, undefined)
    const family = modelFamilyOf(wireModel)
    const dir = mkdtempSync(join(tmpdir(), 'oneshot-entitlement-'))
    delete process.env.ANTIGRAVITY_TOKEN
    const pool = new AccountPoolManager(dir)
    const unentitled = pool.getAccounts()[0]!
    const entitled = pool.createAccountSlot('acc-entitled')

    pool.updateAccountQuotas(unentitled.id, {
      [family]: { remainingFraction: 0.9, models: [{ modelId: FOREIGN_MODEL }] },
    })
    pool.updateAccountQuotas(entitled.id, {
      [family]: { remainingFraction: 0.9, models: [{ modelId: wireModel }] },
    })
    // Both accounts hold a usable token: the only thing that may rule one out is the model list.
    pool.setMemoryToken(unentitled.id, 'token-unentitled', Date.now() + 60_000)
    pool.setMemoryToken(entitled.id, 'token-entitled', Date.now() + 60_000)

    const upstream = await startUpstream()
    try {
      assert.equal(
        modelEntitlementOf(pool.getAccount(unentitled.id)!, family, wireModel).supported,
        false,
        'the first account must genuinely lack the requested model, or the case proves nothing',
      )
      assert.equal(pool.selectAccount(family, wireModel)!.id, entitled.id)

      const result = await runAgyOnce(
        { cfg: () => defaultConfig(), pool, endpointCandidates: [upstream.endpoint] },
        { prompt: 'Say hi', model: REQUESTED_MODEL },
      )

      assert.equal(result.ok, true, `oneshot must succeed on the entitled account: ${result.error ?? ''}`)
      assert.equal(result.text, 'served by the entitled account')
      assert.equal(upstream.calls.length, 1, 'exactly one generation request must be dispatched')
      assert.equal(upstream.calls[0]!.model, wireModel)
      assert.equal(upstream.calls[0]!.authorization, 'Bearer token-entitled')
      assert.equal(
        upstream.calls.filter((call) => call.authorization === 'Bearer token-unentitled').length,
        0,
        'an account whose model list lacks the target model must never be asked to serve it',
      )
      assert.equal(
        pool.getAccount(unentitled.id)!.authRequired,
        undefined,
        'routing around an account is not a credential verdict on it',
      )
    } finally {
      await upstream.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sends no request at all when no account serves the model', async () => {
    const wireModel = getAntigravityRequestModelId(REQUESTED_MODEL, undefined)
    const family = modelFamilyOf(wireModel)
    const dir = mkdtempSync(join(tmpdir(), 'oneshot-no-model-'))
    delete process.env.ANTIGRAVITY_TOKEN
    const pool = new AccountPoolManager(dir)
    const only = pool.getAccounts()[0]!
    pool.updateAccountQuotas(only.id, {
      [family]: { remainingFraction: 0.9, models: [{ modelId: FOREIGN_MODEL }] },
    })
    pool.setMemoryToken(only.id, 'token-unentitled', Date.now() + 60_000)

    const upstream = await startUpstream()
    try {
      const result = await runAgyOnce(
        { cfg: () => defaultConfig(), pool, endpointCandidates: [upstream.endpoint] },
        { prompt: 'Say hi', model: REQUESTED_MODEL },
      )
      assert.equal(result.ok, false)
      assert.equal(upstream.calls.length, 0, 'no request may be sent to an un-entitled account')
      assert.ok(result.error, 'the failure must be reported, not swallowed')
    } finally {
      await upstream.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the model as the fault when every signed-in account is entitled to something else', async () => {
    const wireModel = getAntigravityRequestModelId(REQUESTED_MODEL, undefined)
    const family = modelFamilyOf(wireModel)
    const dir = mkdtempSync(join(tmpdir(), 'oneshot-no-model-wording-'))
    delete process.env.ANTIGRAVITY_TOKEN
    const pool = new AccountPoolManager(dir)
    const only = pool.getAccounts()[0]!
    pool.updateAccountQuotas(only.id, {
      [family]: { remainingFraction: 0.9, models: [{ modelId: FOREIGN_MODEL }] },
    })
    // The account is fully signed in: a credential verdict on it would be false.
    pool.setMemoryToken(only.id, 'token-unentitled', Date.now() + 60_000)

    const status = pool.getFamilyStatus(family, wireModel)
    assert.equal(status.hasAccount, true, 'the account exists and is enabled')
    assert.equal(status.suppressed, true, 'the model must be refused')
    assert.equal(
      status.reason,
      'model_not_available',
      'the pool must call this an entitlement fault, not an auth fault',
    )

    const upstream = await startUpstream()
    try {
      const result = await runAgyOnce(
        { cfg: () => defaultConfig(), pool, endpointCandidates: [upstream.endpoint] },
        { prompt: 'Say hi', model: REQUESTED_MODEL },
      )
      assert.equal(result.ok, false)
      assert.equal(upstream.calls.length, 0, 'nothing may be dispatched when no account serves the model')
      const error = result.error ?? ''
      assert.ok(error.length > 0, 'the failure must be reported, not swallowed')
      assert.ok(error.includes(wireModel), `the message must name the model that cannot be served, got: ${error}`)
      assert.match(error, /model list/, 'the message must point at the model lists, the actual cause')
      assert.ok(
        !error.includes('No authenticated CloudCode Link account available'),
        `a signed-in pool must not be reported as an auth failure, got: ${error}`,
      )
      assert.ok(!error.includes('/ccl auth'), `re-auth cannot fix this, so the message must not ask for it, got: ${error}`)
    } finally {
      await upstream.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
