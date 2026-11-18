import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  AGY_IDE_TYPE,
  AGY_LOAD_MODE,
  AGY_REQUEST_TYPE,
  AGY_TIER_PREFERENCE,
  AGY_WIRE_USER_AGENT,
  agyClientMetadata,
  antigravityHeaders,
  antigravityRequestEnvelope,
  clearProjectCache,
  defaultProjectId,
  ensureProject,
  isFreeTierId,
  loadCodeAssist,
  loadCodeAssistBody,
  onboardUser,
  parseLoadCodeAssistResponse,
  selectTierId,
} from '../src/client.ts'
import { lookupModelEnum } from '../src/models.ts'

/**
 * Evidence base: ops/relink/t2-traffic-findings.md plus the raw MITM dumps under
 * /tmp/agy-fix/mitm/capture/daily-cloudcode-pa.googleapis.com (only requests whose User-Agent is
 * `antigravity/cli/...` are agy's own; the curl probes in the same directory are not).
 */

/** LoadCodeAssistResponse as recorded for a consumer account whose region blocks the free tier
 *  (20261116T081540Z-2.resp.txt). Values are truncated where the capture elided them. */
const RECORDED_LCA = {
  cloudaicompanionProject: 'aicode-consumers',
  currentTier: {
    id: 'standard-tier',
    name: 'Antigravity',
    description: 'Unlimited coding assistant with the most powerful Gemini models',
    userDefinedCloudaicompanionProject: true,
    privacyNotice: {},
    isDefault: true,
    usesGcpTos: true,
  },
  allowedTiers: [
    {
      id: 'standard-tier',
      name: 'Antigravity',
      userDefinedCloudaicompanionProject: true,
      isDefault: true,
      usesGcpTos: true,
    },
  ],
  gcpManaged: false,
  ineligibleTiers: [
    {
      reasonCode: 'UNSUPPORTED_LOCATION',
      reasonMessage: 'Your current account is not eligible for Antigravity, because it is not currently available in your location.',
      tierId: 'free-tier',
      tierName: 'Antigravity',
    },
  ],
  paidTier: {
    id: 'g1-pro-tier',
    name: 'Google AI Pro',
    upgradeSubscriptionUri: 'https://antigravity.google/g1-upgrade',
  },
  manageSubscriptionUri: 'https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fone.google.com%2Fsettings',
}

/** Top-level ids of the captured agent flow 20261116T081812Z-35.req.txt. */
const CAPTURED_AGENT_LABELS = [
  'cascade_id',
  'last_step_index',
  'model_enum',
  'request_id',
  'root_cascade_id',
  'trajectory_id',
  'used_claude',
  'used_claude_conservative',
  'used_non_gemini_model',
]

interface CapturedRequest {
  method: string | undefined
  url: string | undefined
  headers: NodeJS.Dict<string | string[]>
  body: string
}

function startMockServer(handler: (req: CapturedRequest, res: import('node:http').ServerResponse) => void) {
  const seen: CapturedRequest[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      }
      seen.push(captured)
      handler(captured, res)
    })
  })
  return { server, seen }
}

async function listen(server: import('node:http').Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return `http://127.0.0.1:${port}`
}

function headerValues(captured: CapturedRequest): string[] {
  return Object.keys(captured.headers).map((name) => name.toLowerCase())
}

describe('antigravityHeaders mirrors the captured header set', () => {
  it('sends only Authorization, Content-Type and User-Agent', () => {
    const headers = antigravityHeaders('tok-1')
    assert.equal(headers.Authorization, 'Bearer tok-1')
    assert.equal(headers['Content-Type'], 'application/json')
    assert.match(String(headers['User-Agent']), /^antigravity\/cli\/[0-9.]+ \(aidev_client; os_type=\w+; arch=\w+; cl=\d+; auth_method=consumer\)$/)
  })

  it('drops Client-Metadata, the x-goog-* family and Accept', () => {
    const headers = antigravityHeaders('tok-2')
    assert.deepEqual(Object.keys(headers).sort(), ['Authorization', 'Content-Type', 'User-Agent'])
    for (const name of Object.keys(headers)) {
      assert.equal(/client-metadata|goog|^accept$/i.test(name), false, `unexpected header ${name}`)
    }
  })
})

describe('ClientMetadata and the loadCodeAssist body', () => {
  it('agyClientMetadata only ever sets ideType', () => {
    assert.deepEqual(agyClientMetadata(), { ideType: AGY_IDE_TYPE })
  })

  it('the default body is byte-for-byte the captured 38-byte payload', () => {
    const serialized = JSON.stringify(loadCodeAssistBody())
    assert.equal(serialized, '{"metadata":{"ideType":"ANTIGRAVITY"}}')
    assert.equal(Buffer.byteLength(serialized, 'utf8'), 38)
  })

  it('never emits platform, pluginType, ideVersion, pluginVersion, duetProject or a mode', () => {
    const serialized = JSON.stringify(loadCodeAssistBody({ projectId: 'proj-77' }))
    for (const token of ['PLATFORM', 'pluginType', 'ideVersion', 'pluginVersion', 'duetProject', 'updateChannel', 'mode']) {
      assert.equal(serialized.includes(token), false, `body carries ${token}: ${serialized}`)
    }
    assert.deepEqual(JSON.parse(serialized), {
      cloudaicompanionProject: 'proj-77',
      metadata: { ideType: 'ANTIGRAVITY' },
    })
  })

  it('mode is added only when a check is asked for', () => {
    assert.deepEqual(loadCodeAssistBody({ mode: AGY_LOAD_MODE.unspecified }), { metadata: { ideType: 'ANTIGRAVITY' } })
    assert.deepEqual(loadCodeAssistBody({ mode: AGY_LOAD_MODE.eligibilityCheck }).mode, 'FULL_ELIGIBILITY_CHECK')
    assert.deepEqual(loadCodeAssistBody({ mode: AGY_LOAD_MODE.healthCheck }).mode, 'HEALTH_CHECK')
  })
})

describe('tier ids come from the loadCodeAssist payload', () => {
  it('parses the recorded response into tiers, blockers and paid tier', () => {
    const info = parseLoadCodeAssistResponse(RECORDED_LCA)
    assert.equal(info.projectId, 'aicode-consumers')
    assert.equal(info.currentTier?.id, 'standard-tier')
    assert.deepEqual(info.allowedTiers.map((tier) => tier.id), ['standard-tier'])
    assert.equal(info.ineligibleTiers[0]?.tierId, 'free-tier')
    assert.equal(info.ineligibleReason, 'UNSUPPORTED_LOCATION')
    assert.equal(info.paidTierId, 'g1-pro-tier')
    assert.equal(info.gcpManaged, false)
    assert.equal(info.subscriptionUri, RECORDED_LCA.manageSubscriptionUri)
  })

  it('selects a real tier id and never the invented TIER_FREE', () => {
    const chosen = selectTierId(parseLoadCodeAssistResponse(RECORDED_LCA))
    assert.equal(chosen, 'standard-tier')
    assert.equal(String(chosen).includes('TIER_FREE'), false)
  })

  it('prefers a paid/non-free tier over a default free tier', () => {
    const info = parseLoadCodeAssistResponse({
      allowedTiers: [
        { id: 'free-tier', isDefault: true },
        { id: 'standard-tier' },
      ],
    })
    assert.equal(selectTierId(info), 'standard-tier')
    assert.equal(isFreeTierId('free-tier'), true)
    assert.equal(isFreeTierId('standard-tier'), false)
  })

  it('skips a tier the server declared ineligible', () => {
    const info = parseLoadCodeAssistResponse({
      allowedTiers: [{ id: 'free-tier', isDefault: true }, { id: 'standard-tier' }],
      ineligibleTiers: [{ tierId: 'standard-tier', reasonCode: 'UNSUPPORTED_CLIENT' }],
    })
    assert.equal(selectTierId(info), 'free-tier')
  })

  it('ranks the observed paid tier first when the server offers it', () => {
    const info = parseLoadCodeAssistResponse({ allowedTiers: [{ id: 'standard-tier' }, { id: 'g1-pro-tier' }] })
    assert.equal(AGY_TIER_PREFERENCE[0], 'g1-pro-tier')
    assert.equal(selectTierId(info), 'g1-pro-tier')
  })

  it('free-only accounts still onboard with the server id, and no tiers means no tier', () => {
    assert.equal(selectTierId(parseLoadCodeAssistResponse({ allowedTiers: [{ id: 'free-tier', isDefault: true }] })), 'free-tier')
    assert.equal(selectTierId(parseLoadCodeAssistResponse({ allowedTiers: [] })), undefined)
    assert.equal(selectTierId(parseLoadCodeAssistResponse({})), undefined)
  })
})

describe('generation envelope matches the captured agent flow', () => {
  const trajectoryId = '2e579052-6e35-4b56-a71a-0dc25d814d44'
  const cascadeId = 'f3e5ee7e-7a31-493e-a2b3-234414b16cf9'

  it('carries the nine captured labels for a Gemini model', () => {
    const envelope = antigravityRequestEnvelope('gemini-4-hydrogen-medium', false, {
      trajectoryId,
      cascadeId,
      step: 3,
    })
    assert.deepEqual(Object.keys(envelope.labels).sort(), CAPTURED_AGENT_LABELS)
    assert.equal(envelope.labels.cascade_id, cascadeId)
    assert.equal(envelope.labels.root_cascade_id, cascadeId)
    assert.equal(envelope.labels.trajectory_id, trajectoryId)
    assert.equal(envelope.labels.request_id, `${trajectoryId}-3`)
    assert.equal(envelope.labels.last_step_index, '3')
    assert.equal(envelope.labels.used_claude, 'false')
    assert.equal(envelope.labels.used_claude_conservative, 'false')
    assert.equal(envelope.labels.used_non_gemini_model, 'false')
    assert.equal(envelope.labels.model_enum, lookupModelEnum('gemini-4-hydrogen-medium'))
    assert.match(String(envelope.labels.model_enum), /^MODEL_[A-Z0-9_]+$/)
  })

  it('separates root cascade from cascade when a sub-run is reported', () => {
    const envelope = antigravityRequestEnvelope('gemini-3.5-flash', false, {
      trajectoryId,
      cascadeId,
      rootCascadeId: 'root-cascade-0',
    })
    assert.equal(envelope.labels.cascade_id, cascadeId)
    assert.equal(envelope.labels.root_cascade_id, 'root-cascade-0')
  })

  it('flags Claude and non-Gemini models and omits an unknown model_enum', () => {
    const envelope = antigravityRequestEnvelope('claude-sonnet-4-5', true, { trajectoryId })
    assert.equal(envelope.labels.used_claude, 'true')
    assert.equal(envelope.labels.used_claude_conservative, 'true')
    assert.equal(envelope.labels.used_non_gemini_model, 'true')
    assert.equal('model_enum' in envelope.labels, false)
    assert.equal(lookupModelEnum('claude-sonnet-4-5'), undefined)
  })

  it('requestId is agent/<cascade>/<epoch_ms>/<trajectory>/<step> with the wire userAgent', () => {
    const envelope = antigravityRequestEnvelope('gemini-4-hydrogen', false, {
      trajectoryId,
      cascadeId,
      step: 7,
      now: () => 1_794_817_091_999,
    })
    assert.equal(envelope.requestType, AGY_REQUEST_TYPE.agent)
    assert.equal(envelope.userAgent, AGY_WIRE_USER_AGENT)
    assert.equal(envelope.requestId, `agent/${cascadeId}/1794817091999/${trajectoryId}/7`)
    assert.match(envelope.sessionId, /^-?\d{1,20}$/)
  })

  it('an injected clock makes the requestId byte-identical across calls', () => {
    const clock = () => 1_794_817_091_999
    const first = antigravityRequestEnvelope('gemini-4-hydrogen', false, { trajectoryId, step: 1, now: clock })
    const second = antigravityRequestEnvelope('gemini-4-hydrogen', false, { trajectoryId, step: 1, now: clock })
    assert.equal(first.requestId, `agent/${trajectoryId}/1794817091999/${trajectoryId}/1`)
    assert.equal(first.requestId, second.requestId)
    assert.equal(first.requestId.includes(String(Date.now())), false)
  })

  it('checkpoint requests use the checkpoint/<uuid> form', () => {
    const envelope = antigravityRequestEnvelope('gemini-3.5-flash-lite', false, {
      requestType: AGY_REQUEST_TYPE.checkpoint,
    })
    assert.equal(envelope.requestType, 'checkpoint')
    assert.match(envelope.requestId, /^checkpoint\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.equal(envelope.requestId.includes('/17'), false)
  })
})

describe('onboarding traffic over a real socket', () => {
  const pollEnv = ['ANTIGRAVITY_ONBOARD_POLL_INTERVAL_MS', 'ANTIGRAVITY_ONBOARD_POLL_MAX_ATTEMPTS', 'ANTIGRAVITY_ONBOARD_POLL_DEADLINE_MS']

  beforeEach(() => {
    clearProjectCache()
    process.env.ANTIGRAVITY_ONBOARD_POLL_INTERVAL_MS = '10'
    process.env.ANTIGRAVITY_ONBOARD_POLL_MAX_ATTEMPTS = '2'
    process.env.ANTIGRAVITY_ONBOARD_POLL_DEADLINE_MS = '300'
  })

  afterEach(() => {
    for (const name of pollEnv) delete process.env[name]
  })

  it('loadCodeAssist travels as the captured POST with the captured headers and body', async () => {
    const { server, seen } = startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(RECORDED_LCA))
    })
    const endpoint = await listen(server)
    try {
      const projectId = await loadCodeAssist('tok-wire', undefined, [endpoint], true)
      assert.equal(projectId, 'aicode-consumers')
      const request = seen[0]
      assert.ok(request, 'no request reached the server')
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1internal:loadCodeAssist')
      assert.equal(request.body, '{"metadata":{"ideType":"ANTIGRAVITY"}}')
      assert.equal(String(request.headers['user-agent']).startsWith('antigravity/cli/'), true)
      assert.equal(request.headers['client-metadata'], undefined)
      assert.equal(request.headers['x-goog-api-client'], undefined)
      for (const name of headerValues(request)) {
        assert.equal(/goog|client-metadata/.test(name), false, `wire header ${name} is not one agy sends`)
      }
      // fetch adds its own spec defaults (accept: */*, accept-encoding, …); what must not reach the
      // wire is the SSE Accept value this client used to force onto every request.
      assert.notEqual(request.headers.accept, 'text/event-stream')
    } finally {
      server.close()
    }
  })

  it('onboardUser gets its tierId from allowedTiers, not from a literal', async () => {
    const { server, seen } = startMockServer((req, res) => {
      if (req.url?.includes('loadCodeAssist')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ allowedTiers: [{ id: 'free-tier', isDefault: true }, { id: 'standard-tier' }] }))
      } else if (req.url?.includes('onboardUserBackgroundTasks')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ done: true, name: 'operations/1', response: { project: 'tier-derived-project' } }))
      } else if (req.url?.includes('onboardUser')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ done: false, name: 'operations/1' }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    const endpoint = await listen(server)
    try {
      assert.equal(await ensureProject('tok-tier', 'seed@example.com', undefined, [endpoint]), 'tier-derived-project')
      const onboard = seen.find((req) => req.url?.includes('onboardUser') && !req.url?.includes('BackgroundTasks'))
      const poll = seen.find((req) => req.url?.includes('onboardUserBackgroundTasks'))
      assert.ok(onboard, 'onboardUser was never called')
      assert.ok(poll, 'the operation was never polled through onboardUserBackgroundTasks')
      const onboardBody = JSON.parse(onboard.body) as { tierId?: string; metadata?: unknown }
      assert.equal(onboardBody.tierId, 'standard-tier')
      assert.deepEqual(onboardBody.metadata, { ideType: 'ANTIGRAVITY' })
      assert.deepEqual(JSON.parse(poll.body), { operation: { name: 'operations/1' } })
      for (const req of seen) {
        assert.equal(req.body.includes('TIER_FREE'), false, `body invented a tier: ${req.body}`)
        assert.equal(req.body.includes('PLATFORM'), false, `body invented a platform: ${req.body}`)
      }
    } finally {
      server.close()
    }
  })

  it('a free-only account onboards with the server-provided free tier id', async () => {
    const { server, seen } = startMockServer((req, res) => {
      if (req.url?.includes('loadCodeAssist')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }))
      } else if (req.url?.includes('onboardUser')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ done: true, name: 'operations/2', response: { cloudaicompanionProject: { id: 'free-project' } } }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    const endpoint = await listen(server)
    try {
      assert.equal(await ensureProject('tok-free', 'seed@example.com', undefined, [endpoint]), 'free-project')
      const onboard = seen.find((req) => req.url?.includes('onboardUser'))
      assert.equal(onboard ? JSON.parse(onboard.body).tierId : undefined, 'free-tier')
    } finally {
      server.close()
    }
  })

  it('skips onboarding when every offered tier is blocked, and falls back deterministically', async () => {
    const { server, seen } = startMockServer((req, res) => {
      if (req.url?.includes('loadCodeAssist')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          allowedTiers: [{ id: 'free-tier', isDefault: true }],
          ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'UNSUPPORTED_LOCATION' }],
        }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    const endpoint = await listen(server)
    try {
      const seed = 'blocked@example.com'
      const projectId = await ensureProject('tok-blocked', seed, undefined, [endpoint])
      assert.equal(projectId, defaultProjectId(seed))
      assert.equal(seen.some((req) => req.url?.includes('onboardUser')), false, 'onboardUser ran on a blocked account')
    } finally {
      server.close()
    }
  })

  it('a stalled operation is polled a bounded number of times and never hangs the request', async () => {
    let polls = 0
    const { server } = startMockServer((req, res) => {
      if (req.url?.includes('loadCodeAssist')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ allowedTiers: [{ id: 'standard-tier' }] }))
      } else if (req.url?.includes('onboardUserBackgroundTasks')) {
        polls += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ done: false, name: 'operations/stuck' }))
      } else if (req.url?.includes('onboardUser')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ done: false, name: 'operations/stuck' }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    const endpoint = await listen(server)
    try {
      const seed = 'stalled@example.com'
      const started = Date.now()
      const projectId = await ensureProject('tok-stalled', seed, undefined, [endpoint])
      const elapsed = Date.now() - started
      assert.equal(projectId, defaultProjectId(seed))
      assert.equal(polls, 2, `expected the configured poll cap, got ${polls}`)
      assert.ok(elapsed < 5_000, `onboarding blocked the request for ${elapsed}ms`)
    } finally {
      server.close()
    }
  })

  it('an HTTP failure on every call still yields the deterministic project id', async () => {
    const { server } = startMockServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 500, message: 'internal error' } }))
    })
    const endpoint = await listen(server)
    try {
      const seed = 'broken@example.com'
      assert.equal(await ensureProject('tok-500', seed, undefined, [endpoint]), defaultProjectId(seed))
    } finally {
      server.close()
    }
  })

  it('onboardUser refuses an empty tier instead of guessing one', async () => {
    await assert.rejects(() => onboardUser('tok-none', '   '), /tierId/)
  })
})
