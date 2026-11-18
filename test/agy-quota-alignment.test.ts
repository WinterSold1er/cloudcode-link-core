/**
 * Wire-contract tests for the two agy query RPCs.
 *
 * Everything is asserted on data that actually crossed a socket: a local `node:http`
 * server records each request's path, raw body and headers, and the assertions read that
 * record. Nothing inside QuotaService is mocked or stubbed, so the test fails if the
 * request shape, the identity headers or the endpoint order drift.
 *
 * Contract under test (ops/relink/t2-traffic-findings.md, ops/relink/t2-contract-diff.md):
 *   - body of `v1internal:retrieveUserQuotaSummary` and `v1internal:fetchAvailableModels`
 *     is exactly `{"project":"<project>"}` — no metadata, no request_id, no location,
 *     no entitlement.
 *   - headers are bearer + content type + the CLI identity string; agy sends no
 *     `x-goog-api-client`, no `x-goog-user-project`, no `client-metadata`.
 *   - the project id is one with an evidenced source: `cloudaicompanionProject` from the
 *     loadCodeAssist response, or an explicit `ANTIGRAVITY_PROJECT_ID`. When the backend names
 *     nothing, no query RPC is sent at all and the result says `projectUnresolved` — the
 *     sha1-shaped id `defaultProjectId` derives has never been seen accepted upstream, so it
 *     must not reach the socket.
 *   - endpoint preference is remembered per account, not globally.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import * as quotaModule from '../src/quota.ts'
import {
  AGY_CLI_CHANGELIST,
  QuotaService,
  agyProjectScopedRequest,
  agyUserAgent,
  buildAgyCliUserAgent,
  resolveClientPlatform,
  type QuotaRequestContext,
} from '../src/quota.ts'
import { AGY_ENDPOINTS } from '../src/oauth.ts'
import { AccountPoolManager } from '../src/pool.ts'
import { defaultProjectId, stableProjectId } from '../src/client.ts'

const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary'
const MODELS_PATH = '/v1internal:fetchAvailableModels'
const LOAD_PATH = '/v1internal:loadCodeAssist'

interface Captured {
  path: string
  body: string
  headers: NodeJS.Dict<string | string[]>
}

interface MockHost {
  url: string
  requests: Captured[]
  close: () => Promise<void>
}

/**
 * One codeassist host under test.
 * `project` decides whether loadCodeAssist hands back a project id; leaving it out makes the
 * lookup come back empty, which is how the unresolved path is exercised.
 * `queryStatus` is the answer to the two query RPCs, so a host can be the "failing" one in
 * an endpoint-order test.
 */
async function startMockHost(options: { project?: string; queryStatus?: number } = {}): Promise<MockHost> {
  const requests: Captured[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk
    })
    req.on('end', () => {
      const path = req.url ?? ''
      requests.push({ path, body: raw, headers: req.headers })
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (path === LOAD_PATH) {
        if (options.project) send(200, { cloudaicompanionProject: options.project })
        else send(500, { error: { code: 500, message: 'loadCodeAssist unavailable' } })
        return
      }
      if (path === QUOTA_PATH) {
        send(options.queryStatus ?? 200, options.queryStatus ? { error: { code: options.queryStatus } } : { groups: [] })
        return
      }
      if (path === MODELS_PATH) {
        send(options.queryStatus ?? 200, options.queryStatus ? { error: { code: options.queryStatus } } : { models: {} })
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Fresh QuotaService over its own throwaway pool directory; unique token per test so the
 *  module-level project cache in client.ts cannot leak between tests. */
function makeService(): { quota: QuotaService; dir: string; token: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-quota-align-'))
  return { quota: new QuotaService(new AccountPoolManager(dir)), dir, token: randomUUID() }
}

function capturedPath(host: MockHost, path: string): Captured[] {
  return host.requests.filter((entry) => entry.path === path)
}

function lastBody(host: MockHost, path: string): string {
  const hits = capturedPath(host, path)
  const last = hits.at(-1)
  assert.ok(last, `expected at least one request on ${path}`)
  return last.body
}

// ---------------------------------------------------------------------------

test('1. both query RPCs send exactly {"project":…} built from the loadCodeAssist payload', async () => {
  const host = await startMockHost({ project: 'aicode-consumers' })
  const { quota, dir, token } = makeService()
  try {
    const context: QuotaRequestContext = {
      accountKey: 'acct-1',
      projectSeed: 'acct-alias-1',
      endpoints: [host.url],
    }
    const summary = await quota.fetchQuotaSummary(token, undefined, context)
    const models = await quota.fetchAvailableModels(token, undefined, context)
    assert.ok(summary, 'quota summary must be returned by the 200 host')
    assert.ok(models, 'available models must be returned by the 200 host')

    // Byte-for-byte the captured shape: one key, no whitespace, no extra fields.
    assert.equal(lastBody(host, QUOTA_PATH), '{"project":"aicode-consumers"}')
    assert.equal(lastBody(host, MODELS_PATH), '{"project":"aicode-consumers"}')

    for (const path of [QUOTA_PATH, MODELS_PATH]) {
      const parsed = JSON.parse(lastBody(host, path)) as Record<string, unknown>
      assert.deepEqual(Object.keys(parsed), ['project'], `${path} body must carry the project field only`)
      for (const forbidden of ['metadata', 'requestId', 'request_id', 'location', 'entitlement', 'tier', 'tierId']) {
        assert.ok(!(forbidden in parsed), `${path} body must not send ${forbidden}; agy leaves it unset`)
      }
    }

    assert.equal(
      capturedPath(host, LOAD_PATH).length,
      1,
      'the project must come from one loadCodeAssist lookup, not be invented per RPC',
    )
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('2. headers are bearer + content type + CLI identity, and none of the headers agy never sends', async () => {
  const host = await startMockHost({ project: 'aicode-consumers' })
  const { quota, dir, token } = makeService()
  try {
    const context: QuotaRequestContext = { accountKey: 'acct-h', projectSeed: 'acct-h', endpoints: [host.url] }
    await quota.fetchQuotaSummary(token, undefined, context)
    await quota.fetchAvailableModels(token, undefined, context)

    const expectedUA = agyUserAgent()
    const { osType, arch } = resolveClientPlatform()
    assert.equal(
      expectedUA,
      `antigravity/cli/1.3.5 (aidev_client; os_type=${osType}; arch=${arch}; cl=${AGY_CLI_CHANGELIST}; auth_method=consumer)`,
      'User-Agent must be the identity captured byte-for-byte in the traffic dump',
    )
    assert.equal(expectedUA, buildAgyCliUserAgent(), 'query identity and generation identity must be the same string')
    assert.ok(!expectedUA.includes('1.1.15'), 'the unevidenced antigravity/1.1.15 quota identity must be gone')
    assert.ok(!expectedUA.includes('google-api-go-client'), 'agy sends its own CLI identity, not the Go client one')

    for (const path of [QUOTA_PATH, MODELS_PATH]) {
      const headers = capturedPath(host, path).at(-1)!.headers
      assert.equal(headers['user-agent'], expectedUA, `${path} must send the CLI identity`)
      assert.equal(headers.authorization, `Bearer ${token}`, `${path} must carry the bearer token`)
      assert.equal(headers['content-type'], 'application/json', `${path} must post JSON`)
      for (const absent of ['x-goog-api-client', 'x-goog-user-project', 'client-metadata', 'x-goog-api-key', 'x-client-version']) {
        assert.equal(headers[absent], undefined, `${path} must not send ${absent}; it is absent from the captured header union`)
      }
    }
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('3. endpoint memory is per account, not one global pin', async () => {
  const failing = await startMockHost({ project: 'aicode-consumers', queryStatus: 500 })
  const answering = await startMockHost({ project: 'aicode-consumers' })
  const { quota, dir, token } = makeService()
  try {
    const endpoints = [failing.url, answering.url]
    const accountA: QuotaRequestContext = { accountKey: 'acct-a', projectSeed: 'alias-a', endpoints }

    const first = await quota.fetchQuotaSummary(token, undefined, accountA)
    assert.ok(first, 'the call must fall through to the endpoint that answers')
    assert.deepEqual(
      capturedPath(failing, QUOTA_PATH).length,
      1,
      'first call must try the failing endpoint before the answering one',
    )
    assert.equal(capturedPath(answering, QUOTA_PATH).length, 1, 'the answering endpoint must have been reached')
    assert.ok(
      quota.lastQuotaEndpointErrors.some((entry) => entry.includes(failing.url) && entry.includes('500')),
      `the failed endpoint must be recorded, got ${JSON.stringify(quota.lastQuotaEndpointErrors)}`,
    )

    // Same account: the endpoint that answered is tried first now.
    const second = await quota.fetchAvailableModels(token, undefined, accountA)
    assert.ok(second, 'the remembered endpoint must answer on the second call too')
    assert.equal(capturedPath(failing, MODELS_PATH).length, 0, 'the remembered account must not revisit the failing endpoint')
    assert.equal(capturedPath(answering, MODELS_PATH).length, 1, 'the remembered endpoint must be the first attempt')

    // Different account on the same pool and the same endpoint list: no inherited pin.
    const accountB: QuotaRequestContext = { accountKey: 'acct-b', projectSeed: 'alias-b', endpoints }
    const third = await quota.fetchQuotaSummary(token, undefined, accountB)
    assert.ok(third, 'the second account must still be able to fall through to the answering endpoint')
    assert.equal(capturedPath(failing, QUOTA_PATH).length, 2, 'a second account must start from the default order')
  } finally {
    await failing.close()
    await answering.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('4. a call with no account identity neither reads nor writes the endpoint memory', async () => {
  const failing = await startMockHost({ project: 'aicode-consumers', queryStatus: 500 })
  const answering = await startMockHost({ project: 'aicode-consumers' })
  const { quota, dir, token } = makeService()
  try {
    const endpoints = [failing.url, answering.url]
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await quota.fetchQuotaSummary(token, undefined, { endpoints })
      assert.ok(res, `attempt ${attempt + 1} must fall through to the answering endpoint`)
      assert.equal(capturedPath(failing, QUOTA_PATH).length, attempt + 1, `attempt ${attempt + 1} must still try the first endpoint`)
    }
  } finally {
    await failing.close()
    await answering.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('5. quota defaults to the daily endpoint first, matching the traffic dump', () => {
  assert.equal(
    AGY_ENDPOINTS[0],
    'https://daily-cloudcode-pa.googleapis.com',
    'agy only ever hit daily-cloudcode-pa; the shared endpoint list must lead with it',
  )
})

test('6. with no project named by the backend, no query RPC is sent and the result says projectUnresolved', async () => {
  const dead = await startMockHost()
  const { quota, dir } = makeService()
  const token = randomUUID()
  try {
    const context: QuotaRequestContext = {
      accountKey: 'acct-f1',
      projectSeed: 'seed-alpha',
      endpoints: [dead.url],
    }

    const summary = await quota.fetchQuotaSummary(token, undefined, context)
    assert.equal(summary, null, 'there is no summary to hand back when no project was resolved')
    assert.equal(
      capturedPath(dead, QUOTA_PATH).length,
      0,
      'retrieveUserQuotaSummary must not be called at all without a project to send',
    )

    assert.ok(quota.lastQuotaProjectResolution, 'the call must record its project resolution state')
    assert.equal(quota.lastQuotaProjectResolution?.projectUnresolved, true, 'the state must name the fault: project unresolved')
    assert.equal(quota.lastQuotaProjectResolution?.source, 'unresolved')
    assert.equal(quota.lastQuotaProjectResolution?.project, undefined, 'an unresolved state carries no project id')
    assert.match(
      quota.lastQuotaProjectResolution!.reason,
      /loadCodeAssist/,
      'the reason must point at the lookup that named nothing, not a generic failure',
    )
    assert.ok(
      quota.lastQuotaEndpointErrors.some((entry) => entry.includes('project unresolved')),
      `the reason must land on the existing observability surface, got ${JSON.stringify(quota.lastQuotaEndpointErrors)}`,
    )

    const models = await quota.fetchAvailableModels(token, undefined, context)
    assert.equal(models, null, 'there is no model payload to hand back when no project was resolved')
    assert.equal(
      capturedPath(dead, MODELS_PATH).length,
      0,
      'fetchAvailableModels must not be called at all without a project to send',
    )
    assert.equal(quota.lastModelsProjectResolution?.projectUnresolved, true, 'the models call must record the same fault')
    assert.ok(
      quota.lastEndpointErrors.some((entry) => entry.includes('project unresolved')),
      `got ${JSON.stringify(quota.lastEndpointErrors)}`,
    )

    // Skipping the RPC is not skipping the diagnosis: the lookup itself is still attempted.
    assert.ok(
      capturedPath(dead, LOAD_PATH).length >= 1,
      'the project lookup must still be tried on the endpoints the caller approved',
    )

    // The id the previous fallback put on the wire must now be absent from every socket write.
    const invented = defaultProjectId('seed-alpha')
    assert.match(
      invented,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'the derived id is the sha1-shaped one the reviewer flagged',
    )
    for (const entry of dead.requests) {
      assert.ok(!entry.body.includes('"project"'), `${entry.path} must not carry a project field when none was resolved`)
      assert.ok(!entry.body.includes(invented), `${entry.path} must not carry the derived id ${invented}`)
    }
  } finally {
    await dead.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('7. ANTIGRAVITY_PROJECT_ID pins the project id used by both query RPCs', async () => {
  const previous = process.env.ANTIGRAVITY_PROJECT_ID
  process.env.ANTIGRAVITY_PROJECT_ID = 'env-pinned-project'
  const dead = await startMockHost()
  const { quota, dir } = makeService()
  try {
    const context: QuotaRequestContext = { accountKey: 'acct-env', projectSeed: 'seed-env', endpoints: [dead.url] }
    assert.ok(await quota.fetchQuotaSummary(randomUUID(), undefined, context))
    assert.ok(await quota.fetchAvailableModels(randomUUID(), undefined, context))
    assert.equal(lastBody(dead, QUOTA_PATH), '{"project":"env-pinned-project"}')
    assert.equal(lastBody(dead, MODELS_PATH), '{"project":"env-pinned-project"}')
    assert.equal(capturedPath(dead, QUOTA_PATH).length, 1, 'the explicit id must make the RPC run, and run once')
    assert.equal(quota.lastModelsProjectResolution?.projectUnresolved, false, 'an explicit override is a resolved project')
    assert.equal(quota.lastModelsProjectResolution?.source, 'explicit-override', 'the state must name where the id came from')
    const derived = stableProjectId('seed-env')
    for (const entry of dead.requests) {
      assert.ok(
        !entry.body.includes(derived),
        `${entry.path} must not carry the sha1-derived id ${derived} while an explicit project is set`,
      )
    }
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_PROJECT_ID
    else process.env.ANTIGRAVITY_PROJECT_ID = previous
    await dead.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('8. a concurrent quota+models pair resolves the project once per account', async () => {
  const host = await startMockHost({ project: 'aicode-consumers' })
  const { quota, dir, token } = makeService()
  try {
    const context: QuotaRequestContext = { accountKey: 'acct-pair', projectSeed: 'alias-pair', endpoints: [host.url] }
    const [summary, models] = await Promise.all([
      quota.fetchQuotaSummary(token, undefined, context),
      quota.fetchAvailableModels(token, undefined, context),
    ])
    assert.ok(summary && models)
    assert.equal(capturedPath(host, LOAD_PATH).length, 1, 'the pair must share one project resolution')
    assert.equal(lastBody(host, QUOTA_PATH), '{"project":"aicode-consumers"}')
    assert.equal(lastBody(host, MODELS_PATH), '{"project":"aicode-consumers"}')
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('9. ANTIGRAVITY_USER_AGENT overrides the identity on the wire', async () => {
  const previous = process.env.ANTIGRAVITY_USER_AGENT
  process.env.ANTIGRAVITY_USER_AGENT = 'antigravity/cli/9.9.9 (aidev_client; os_type=linux; arch=amd64; cl=1; auth_method=consumer)'
  const host = await startMockHost({ project: 'aicode-consumers' })
  const { quota, dir, token } = makeService()
  try {
    const context: QuotaRequestContext = { accountKey: 'acct-ua', projectSeed: 'alias-ua', endpoints: [host.url] }
    assert.ok(await quota.fetchQuotaSummary(token, undefined, context))
    assert.equal(
      capturedPath(host, QUOTA_PATH).at(-1)!.headers['user-agent'],
      process.env.ANTIGRAVITY_USER_AGENT,
      'the override must reach the wire unchanged',
    )
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_USER_AGENT
    else process.env.ANTIGRAVITY_USER_AGENT = previous
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('10. agyProjectScopedRequest refuses an empty project and trims the id', () => {
  assert.deepEqual(agyProjectScopedRequest('  aicode-consumers  '), { project: 'aicode-consumers' })
  assert.throws(() => agyProjectScopedRequest(''), /non-empty project/)
  assert.throws(() => agyProjectScopedRequest('   '), /non-empty project/)
})

test('11. the unevidenced quota/discovery identities are gone from the module surface', () => {
  const exported = Object.keys(quotaModule)
  for (const gone of ['AGY_QUOTA_USER_AGENT', 'AGY_DISCOVERY_USER_AGENT', 'agyQuotaUserAgent']) {
    assert.ok(!exported.includes(gone), `${gone} must not be exported any more: no captured request used it`)
  }
})

test('12. regression: a backend-named project keeps both bodies byte-exact and records a resolved state', async () => {
  const host = await startMockHost({ project: 'aicode-consumers' })
  const { quota, dir, token } = makeService()
  try {
    const context: QuotaRequestContext = { accountKey: 'acct-real', projectSeed: 'alias-real', endpoints: [host.url] }

    const summary = await quota.fetchQuotaSummary(token, undefined, context)
    assert.ok(summary, 'the 200 host must still answer the quota RPC')
    assert.deepEqual(Object.keys(summary ?? {}), ['groups'], 'the quota success-path shape must not change')
    assert.equal(lastBody(host, QUOTA_PATH), '{"project":"aicode-consumers"}')
    assert.equal(quota.lastQuotaProjectResolution?.projectUnresolved, false, 'a named project is not unresolved')
    assert.equal(quota.lastQuotaProjectResolution?.project, 'aicode-consumers')
    assert.equal(quota.lastQuotaProjectResolution?.source, 'loadCodeAssist', 'the state must credit the backend')
    assert.deepEqual(quota.lastQuotaEndpointErrors, [], 'a clean run must leave no endpoint errors')

    const models = await quota.fetchAvailableModels(token, undefined, context)
    assert.ok(models, 'the 200 host must still answer the models RPC')
    assert.deepEqual(Object.keys(models ?? {}), ['models'], 'the models success-path shape must not change')
    assert.equal(lastBody(host, MODELS_PATH), '{"project":"aicode-consumers"}')
    assert.equal(quota.lastModelsProjectResolution?.source, 'loadCodeAssist')

    for (const entry of host.requests) {
      if (!entry.body.includes('"project"')) continue
      assert.equal(entry.body, '{"project":"aicode-consumers"}', `${entry.path} may only carry the backend-named id`)
    }
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('13. a project the backend named is not shadowed by ANTIGRAVITY_PROJECT_ID (client.ts precedence kept)', async () => {
  const previous = process.env.ANTIGRAVITY_PROJECT_ID
  process.env.ANTIGRAVITY_PROJECT_ID = 'env-pinned-project'
  const host = await startMockHost({ project: 'aicode-consumers' })
  const { quota, dir, token } = makeService()
  try {
    const context: QuotaRequestContext = { accountKey: 'acct-prec', projectSeed: 'alias-prec', endpoints: [host.url] }
    assert.ok(await quota.fetchQuotaSummary(token, undefined, context))
    assert.equal(
      lastBody(host, QUOTA_PATH),
      '{"project":"aicode-consumers"}',
      'the id the backend named must win, exactly as ensureProject already ranks them',
    )
    assert.equal(quota.lastQuotaProjectResolution?.source, 'loadCodeAssist')
    assert.ok(
      !host.requests.some((entry) => entry.body.includes('env-pinned-project')),
      'an override that was not needed must stay off the wire',
    )
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_PROJECT_ID
    else process.env.ANTIGRAVITY_PROJECT_ID = previous
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
