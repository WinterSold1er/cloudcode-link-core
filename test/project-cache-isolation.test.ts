/**
 * B1 (reviewer2 finding D1/D3): `ensureProject` cached its result under the access token alone,
 * so a project resolved for one seed was handed to a different seed that shared the token.
 *
 * The counterexample these tests pin down, run against a fake upstream:
 *   ensureProject('shared-token', 'alias-A') -> the sha1-derived fallback for alias-A
 *   ensureProject('shared-token', 'alias-B') -> the SAME id, with zero upstream calls, and quota
 *                                              then sent it as `{"project": "<alias-A's id>"}`.
 *
 * Two independent defenses are asserted, because each one alone can be defeated by a different
 * change (a new seed spelling, or a cache entry that expired):
 *   1. the cache identity is token AND seed, so a fallback cannot cross seeds;
 *   2. every cache entry records whether an upstream response named the id, and quota refuses to
 *      credit an id it has to invent (no query RPC is sent at all).
 *
 * Expectations come from the fake upstream's own answers and from the observable wire bodies, not
 * from a restatement of src/client.ts.
 */

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { clearProjectCache, ensureProject, getProjectResolution, loadCodeAssist } from '../src/client.ts'
import { AccountPoolManager } from '../src/pool.ts'
import { QuotaService } from '../src/quota.ts'

const LOAD_PATH = '/v1internal:loadCodeAssist'
const LIST_PATH = '/v1internal:listCloudAICompanionProjects'
const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary'
const MODELS_PATH = '/v1internal:fetchAvailableModels'

interface Captured {
  path: string
  body: string
}

interface MockHost {
  url: string
  requests: Captured[]
  /** Requests to one path, so "did this lookup talk upstream?" is an assertion, not an impression. */
  countOf: (path: string) => number
  close: () => Promise<void>
}

/**
 * One codeassist host. `project` decides whether loadCodeAssist names a project; leaving it out
 * reproduces the upstream that answers but names nothing, which is the only path that ends in a
 * synthesized fallback.
 */
async function startMockHost(options: { project?: string } = {}): Promise<MockHost> {
  const requests: Captured[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk
    })
    req.on('end', () => {
      const path = req.url ?? ''
      requests.push({ path, body: raw })
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (path === LOAD_PATH) {
        if (options.project) send(200, { cloudaicompanionProject: options.project })
        else send(500, { error: { code: 500, message: 'loadCodeAssist named no project' } })
        return
      }
      if (path === LIST_PATH) {
        send(200, { projects: [] })
        return
      }
      if (path === QUOTA_PATH) {
        send(200, { groups: [] })
        return
      }
      if (path === MODELS_PATH) {
        send(200, { models: {} })
        return
      }
      send(404, { error: { code: 404, message: 'not part of the contract under test' } })
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    countOf: (path: string) => requests.filter((entry) => entry.path === path).length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function makeService(): { quota: QuotaService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-project-cache-'))
  return { quota: new QuotaService(new AccountPoolManager(dir)), dir }
}

beforeEach(() => {
  clearProjectCache()
})

test('1. one token, two seeds: different projects, and the second lookup does its own upstream work', async () => {
  const host = await startMockHost()
  try {
    // The token is deliberately shared - that is the whole point of the finding.
    const token = 'shared-token-for-seed-isolation'

    const projectA = await ensureProject(token, 'alias-A', undefined, [host.url])
    const callsAfterA = host.countOf(LOAD_PATH)
    const projectB = await ensureProject(token, 'alias-B', undefined, [host.url])
    const callsAfterB = host.countOf(LOAD_PATH)

    assert.ok(projectA, 'alias-A must still resolve to something usable')
    assert.ok(projectB, 'alias-B must still resolve to something usable')
    assert.notEqual(projectB, projectA, "alias-B was served alias-A's project")
    assert.ok(
      callsAfterB > callsAfterA,
      `alias-B was answered from alias-A's cache: loadCodeAssist calls went ${callsAfterA} -> ${callsAfterB}`,
    )

    // The seed that was asked for is the seed whose id comes back, and both are marked as
    // synthesized because this upstream named nothing.
    const resolutionB = getProjectResolution(token, 'alias-B')
    assert.ok(resolutionB, 'the (token, alias-B) lookup must be recorded')
    assert.equal(resolutionB.projectId, projectB)
    assert.equal(resolutionB.synthesized, true, 'an id no upstream named must be recorded as synthesized')
    assert.equal(getProjectResolution(token, 'alias-A')?.projectId, projectA)

    // A seed with no entry of its own sees no one else's entry.
    assert.equal(getProjectResolution(token, 'alias-C'), undefined)
  } finally {
    await host.close()
  }
})

test('2. a project the upstream really named is still shared across seeds of the same token', async () => {
  const host = await startMockHost({ project: 'proj-named-777' })
  try {
    const token = randomUUID()
    const a = await ensureProject(token, 'alias-A', undefined, [host.url])
    const b = await ensureProject(token, 'alias-B', undefined, [host.url])

    // Fixing the leak must not turn a backend-named project into a per-seed invention: the
    // account's own project is the same for both aliases, and it is not synthesized.
    assert.equal(a, 'proj-named-777')
    assert.equal(b, 'proj-named-777')
    assert.equal(getProjectResolution(token, 'alias-A')?.synthesized, false)
    assert.equal(getProjectResolution(token, 'alias-B')?.synthesized, false)
  } finally {
    await host.close()
  }
})

test('3. quota never credits a synthesized id: no query RPC is sent for an unresolved lookup', async () => {
  const host = await startMockHost()
  const { quota } = makeService()
  try {
    const token = randomUUID()
    const context = { accountKey: 'acct-unresolved', projectSeed: 'alias-unresolved', endpoints: [host.url] }

    const summary = await quota.fetchQuotaSummary(token, undefined, context)
    assert.equal(summary, null, 'an unresolved lookup must not produce a quota summary')
    assert.equal(quota.lastQuotaProjectResolution?.projectUnresolved, true)
    assert.equal(quota.lastQuotaProjectResolution?.source, 'unresolved')
    assert.equal(quota.lastQuotaProjectResolution?.project, undefined)
    assert.ok(
      (quota.lastQuotaEndpointErrors ?? []).some((entry) => entry.includes('project unresolved')),
      'the fault must be reported, not swallowed',
    )
    assert.equal(host.countOf(QUOTA_PATH), 0, 'a synthesized id must never be put in a query body')

    const models = await quota.fetchAvailableModels(token, undefined, context)
    assert.equal(models, null, 'an unresolved lookup must not produce a model payload either')
    assert.equal(quota.lastModelsProjectResolution?.projectUnresolved, true)
    assert.equal(host.countOf(MODELS_PATH), 0, 'a synthesized id must never be put in a query body')
  } finally {
    await host.close()
  }
})

test('4. the project on the wire is the one the upstream named, for every seed of the token', async () => {
  const host = await startMockHost({ project: 'proj-named-888' })
  const { quota } = makeService()
  try {
    const token = randomUUID()
    const summaryA = await quota.fetchQuotaSummary(token, undefined, {
      accountKey: 'acct-wire-a',
      projectSeed: 'alias-A',
      endpoints: [host.url],
    })
    assert.ok(summaryA, 'the 200 host must be answered')
    const bodies = host.requests.filter((entry) => entry.path === QUOTA_PATH)
    assert.equal(bodies.length, 1)
    assert.match(bodies[0]!.body, /"project":"proj-named-888"/, 'quota sent a project the upstream did not name')

    const summaryB = await quota.fetchQuotaSummary(token, undefined, {
      accountKey: 'acct-wire-b',
      projectSeed: 'alias-B',
      endpoints: [host.url],
    })
    assert.ok(summaryB)
    const wireBodies = host.requests.filter((entry) => entry.path === QUOTA_PATH)
    assert.equal(wireBodies.length, 2)
    assert.match(wireBodies[1]!.body, /"project":"proj-named-888"/, 'the second seed got a different project')
  } finally {
    await host.close()
  }
})

test('5. loadCodeAssist cannot hand back a fallback synthesized for another seed', async () => {
  const silent = await startMockHost()
  const named = await startMockHost({ project: 'proj-named-999' })
  try {
    const token = randomUUID()
    const fallback = await ensureProject(token, 'alias-leak', undefined, [silent.url])
    assert.ok(fallback)
    assert.equal(getProjectResolution(token, 'alias-leak')?.synthesized, true)

    // The seedless loadCodeAssist path reads a cache that only ever holds ids an upstream named,
    // so the fallback recorded above is unreachable from it.
    const discovered = await loadCodeAssist(token, undefined, [named.url])
    assert.equal(discovered, 'proj-named-999')
    assert.notEqual(discovered, fallback, 'a synthesized fallback leaked into the discovered-project path')
  } finally {
    await silent.close()
    await named.close()
  }
})

test('6. clearProjectCache drops both the seed-scoped and the token-scoped cache', async () => {
  const host = await startMockHost({ project: 'proj-named-1010' })
  try {
    const token = randomUUID()
    assert.equal(await ensureProject(token, 'alias-clear', undefined, [host.url]), 'proj-named-1010')
    assert.ok(getProjectResolution(token, 'alias-clear'))
    const cached = await ensureProject(token, 'alias-clear', undefined, [host.url])
    assert.equal(cached, 'proj-named-1010')
    assert.equal(host.countOf(LOAD_PATH), 1, 'a live cache entry must be reused, not re-queried')

    clearProjectCache()
    assert.equal(getProjectResolution(token, 'alias-clear'), undefined, 'the seed entry survived the clear')
    assert.ok(await ensureProject(token, 'alias-clear', undefined, [host.url]))
    assert.equal(host.countOf(LOAD_PATH), 2, 'after a clear the lookup must talk upstream again')
  } finally {
    await host.close()
  }
})
