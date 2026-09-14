import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  StatsCollector,
  MemoryStatsStorage,
  type StatsConfig,
  type RequestMetric,
  type IStatsStorage,
  type SessionMetric,
} from '../src/stats/index.ts'

const validConfig: StatsConfig = {
  retentionDays: 7,
  dbPath: 'memory://stats.db',
  flushIntervalMs: 50,
  maxQueueSize: 5,
  cleanupIntervalMs: 200,
}

test('StatsCollector: config validation throws on invalid values', () => {
  assert.throws(() => {
    new StatsCollector({ ...validConfig, retentionDays: 0 })
  }, /Invalid retentionDays/)

  assert.throws(() => {
    new StatsCollector({ ...validConfig, dbPath: '' })
  }, /Invalid dbPath/)

  assert.throws(() => {
    new StatsCollector({ ...validConfig, flushIntervalMs: -1 })
  }, /Invalid flushIntervalMs/)

  assert.throws(() => {
    new StatsCollector({ ...validConfig, maxQueueSize: 0 })
  }, /Invalid maxQueueSize/)

  assert.throws(() => {
    new StatsCollector({ ...validConfig, cleanupIntervalMs: 0 })
  }, /Invalid cleanupIntervalMs/)
})

test('StatsCollector: recordRequest calculates cacheHit and aggregates session metrics correctly', async () => {
  const storage = new MemoryStatsStorage()
  const collector = new StatsCollector(validConfig, storage)

  // Request 1: with cache tokens
  collector.recordRequest({
    requestId: 'req-1',
    sessionId: 'sess-1',
    accountId: 'acc-1',
    model: 'gemini-1.5-pro',
    timestamp: 1000,
    status: 'success',
    latencyMs: 120,
    promptTokens: 100,
    cachedTokens: 40,
    outputTokens: 50,
  })

  // Request 2: no cache tokens, error status
  collector.recordRequest({
    requestId: 'req-2',
    sessionId: 'sess-1',
    accountId: 'acc-1',
    model: 'gemini-1.5-pro',
    timestamp: 2000,
    status: 'error',
    latencyMs: 80,
    promptTokens: 100,
    cachedTokens: 0,
    outputTokens: 0,
  })

  // Session check in memory before flush
  const sessionImmediate = await collector.getSessionMetric('sess-1')
  assert.ok(sessionImmediate)
  assert.equal(sessionImmediate.sessionId, 'sess-1')
  assert.equal(sessionImmediate.accountId, 'acc-1')
  assert.equal(sessionImmediate.totalRequests, 2)
  assert.equal(sessionImmediate.totalSuccess, 1)
  assert.equal(sessionImmediate.totalFailed, 1)
  assert.equal(sessionImmediate.totalPromptTokens, 200)
  assert.equal(sessionImmediate.totalCachedTokens, 40)
  // formula: 40 / 200 = 0.2
  assert.equal(sessionImmediate.cacheHitRate, 0.2)
  assert.equal(sessionImmediate.createdAt, 1000)
  assert.equal(sessionImmediate.updatedAt, 2000)

  // Flush to storage
  await collector.flush()

  const requests = await storage.queryRequests()
  assert.equal(requests.length, 2)

  const req1 = requests.find((r) => r.requestId === 'req-1')
  assert.ok(req1)
  assert.equal(req1.cacheHit, true)
  assert.equal(req1.cachedTokens, 40)

  const req2 = requests.find((r) => r.requestId === 'req-2')
  assert.ok(req2)
  assert.equal(req2.cacheHit, false)
  assert.equal(req2.cachedTokens, 0)

  await collector.close()
})

test('StatsCollector: buffer drops oldest item on overflow and triggers onDrop callback', async () => {
  const droppedRecords: RequestMetric[] = []
  const storage = new MemoryStatsStorage()
  const collector = new StatsCollector(
    { ...validConfig, maxQueueSize: 2 },
    storage,
    {
      onDrop: (dropped) => {
        droppedRecords.push(...dropped)
      },
    },
  )

  collector.recordRequest({
    requestId: 'req-1',
    accountId: 'acc-1',
    model: 'model-a',
    status: 'success',
    latencyMs: 10,
    promptTokens: 10,
    cachedTokens: 0,
    outputTokens: 10,
  })

  collector.recordRequest({
    requestId: 'req-2',
    accountId: 'acc-1',
    model: 'model-a',
    status: 'success',
    latencyMs: 10,
    promptTokens: 10,
    cachedTokens: 0,
    outputTokens: 10,
  })

  // 3rd push should drop req-1 because maxQueueSize is 2
  collector.recordRequest({
    requestId: 'req-3',
    accountId: 'acc-1',
    model: 'model-a',
    status: 'success',
    latencyMs: 10,
    promptTokens: 10,
    cachedTokens: 0,
    outputTokens: 10,
  })

  assert.equal(droppedRecords.length, 1)
  assert.equal(droppedRecords[0]?.requestId, 'req-1')

  await collector.flush()
  const stored = await storage.queryRequests()
  assert.equal(stored.length, 2)
  assert.equal(stored[0]?.requestId, 'req-2')
  assert.equal(stored[1]?.requestId, 'req-3')

  await collector.close()
})

test('StatsCollector: storage exceptions are isolated and reported without throwing', async () => {
  let reportedError: unknown = null
  let errorContext = ''

  const faultyStorage: IStatsStorage = {
    async init() {},
    async close() {},
    async saveRequestMetrics() {
      throw new Error('Disk IO failure')
    },
    async upsertSessionMetrics() {
      throw new Error('Disk IO failure')
    },
    async getSessionMetric() {
      return null
    },
    async deleteRequestsBefore() {
      return 0
    },
    async deleteSessionsBefore() {
      return 0
    },
  }

  const collector = new StatsCollector(validConfig, faultyStorage, {
    onError: (err, ctx) => {
      reportedError = err
      errorContext = ctx
    },
  })

  // recordRequest should never throw
  assert.doesNotThrow(() => {
    collector.recordRequest({
      requestId: 'req-err',
      accountId: 'acc-1',
      model: 'model-x',
      status: 'success',
      latencyMs: 50,
      promptTokens: 10,
      cachedTokens: 0,
      outputTokens: 10,
    })
  })

  // flush handles error gracefully
  await collector.flush()

  assert.ok(reportedError instanceof Error)
  assert.equal((reportedError as Error).message, 'Disk IO failure')
  assert.equal(errorContext, 'storage-flush')

  await collector.close()
})

test('StatsCollector: retention cleanup purges expired request and session records', async () => {
  const storage = new MemoryStatsStorage()
  const retentionDays = 3
  const collector = new StatsCollector(
    { ...validConfig, retentionDays },
    storage,
  )

  const now = 10_000_000_000
  const oneDayMs = 86_400_000
  const expiredTime = now - (retentionDays + 1) * oneDayMs
  const activeTime = now - (retentionDays - 1) * oneDayMs

  // Expired request and session
  collector.recordRequest({
    requestId: 'req-expired',
    sessionId: 'sess-expired',
    accountId: 'acc-1',
    model: 'model-a',
    timestamp: expiredTime,
    status: 'success',
    latencyMs: 100,
    promptTokens: 50,
    cachedTokens: 0,
    outputTokens: 20,
  })

  // Active request and session
  collector.recordRequest({
    requestId: 'req-active',
    sessionId: 'sess-active',
    accountId: 'acc-1',
    model: 'model-a',
    timestamp: activeTime,
    status: 'success',
    latencyMs: 100,
    promptTokens: 50,
    cachedTokens: 0,
    outputTokens: 20,
  })

  await collector.flush()

  const beforeCleanupReqs = await storage.queryRequests()
  assert.equal(beforeCleanupReqs.length, 2)

  // Run cleanup explicitly with current timestamp
  const cleanupResult = await collector.cleanup(now)
  assert.equal(cleanupResult.deletedRequests, 1)
  assert.equal(cleanupResult.deletedSessions, 1)

  const afterCleanupReqs = await storage.queryRequests()
  assert.equal(afterCleanupReqs.length, 1)
  assert.equal(afterCleanupReqs[0]?.requestId, 'req-active')

  const expiredSession = await collector.getSessionMetric('sess-expired')
  assert.equal(expiredSession, null)

  const activeSession = await collector.getSessionMetric('sess-active')
  assert.ok(activeSession)
  assert.equal(activeSession.sessionId, 'sess-active')

  await collector.close()
})

test('Issue 1: createStatsStorage throws on unsupported protocol and succeeds on memory protocol', () => {
  assert.throws(() => {
    new StatsCollector({ ...validConfig, dbPath: 'postgres://localhost:5432/db' })
  }, /Unsupported dbPath protocol/)

  const collector1 = new StatsCollector({ ...validConfig, dbPath: ':memory:' })
  assert.ok(collector1.getStorage() instanceof MemoryStatsStorage)

  const collector2 = new StatsCollector({ ...validConfig, dbPath: 'memory://test.db' })
  assert.ok(collector2.getStorage() instanceof MemoryStatsStorage)
})

test('Issue 2: sessionQueue bounded capacity evicts oldest and triggers onDrop to prevent OOM', async () => {
  let droppedSessionCount = 0
  const storage = new MemoryStatsStorage()
  const collector = new StatsCollector(
    {
      ...validConfig,
      maxQueueSize: 100,
      maxSessionQueueSize: 2,
    },
    storage,
    {
      onDrop: (_droppedReqs, _qSize, droppedSessions) => {
        if (droppedSessions && droppedSessions.length > 0) {
          droppedSessionCount += droppedSessions.length
        }
      },
    },
  )

  collector.recordRequest({
    requestId: 'r-1',
    sessionId: 'sess-alpha',
    accountId: 'acc-1',
    model: 'model-a',
    status: 'success',
    latencyMs: 10,
    promptTokens: 10,
    cachedTokens: 0,
    outputTokens: 10,
  })

  collector.recordRequest({
    requestId: 'r-2',
    sessionId: 'sess-beta',
    accountId: 'acc-1',
    model: 'model-a',
    status: 'success',
    latencyMs: 10,
    promptTokens: 10,
    cachedTokens: 0,
    outputTokens: 10,
  })

  // 3rd session triggers eviction on oldest session delta
  collector.recordRequest({
    requestId: 'r-3',
    sessionId: 'sess-gamma',
    accountId: 'acc-1',
    model: 'model-a',
    status: 'success',
    latencyMs: 10,
    promptTokens: 10,
    cachedTokens: 0,
    outputTokens: 10,
  })

  assert.equal(droppedSessionCount, 1)
  await collector.close()
})

test('Issue 3: partial write failure retries only unpersisted slices, preventing duplicate requests', async () => {
  let saveRequestsCallCount = 0
  let upsertSessionsCallCount = 0
  const savedRequests: RequestMetric[] = []

  const partiallyFailingStorage: IStatsStorage = {
    async init() {},
    async close() {},
    async saveRequestMetrics(metrics) {
      saveRequestsCallCount++
      savedRequests.push(...metrics)
    },
    async upsertSessionDeltas() {
      upsertSessionsCallCount++
      if (upsertSessionsCallCount === 1) {
        throw new Error('Transient session storage failure')
      }
    },
    async getSessionMetric() {
      return null
    },
    async deleteRequestsBefore() {
      return 0
    },
    async deleteSessionsBefore() {
      return 0
    },
    async queryRequests() {
      return savedRequests
    },
  }

  const collector = new StatsCollector(
    { ...validConfig, maxQueueSize: 10 },
    partiallyFailingStorage,
  )

  collector.recordRequest({
    requestId: 'req-once',
    sessionId: 'sess-test',
    accountId: 'acc-1',
    model: 'model-a',
    status: 'success',
    latencyMs: 10,
    promptTokens: 10,
    cachedTokens: 0,
    outputTokens: 10,
  })

  // 1st flush: saveRequestMetrics succeeds, upsertSessionDeltas fails
  await collector.flush()
  assert.equal(saveRequestsCallCount, 1)
  assert.equal(savedRequests.length, 1)

  // 2nd flush: request should NOT be re-saved because it was already persisted!
  await collector.flush()
  assert.equal(saveRequestsCallCount, 1)
  assert.equal(savedRequests.length, 1)
  assert.equal(upsertSessionsCallCount, 2)

  await collector.close()
})

test('Issue 4: batchSize chunks queue execution to avoid unbounded payload bursts', async () => {
  const batchSizesObserved: number[] = []
  const storage: IStatsStorage = {
    async init() {},
    async close() {},
    async saveRequestMetrics(metrics) {
      batchSizesObserved.push(metrics.length)
    },
    async upsertSessionDeltas() {},
    async getSessionMetric() {
      return null
    },
    async deleteRequestsBefore() {
      return 0
    },
    async deleteSessionsBefore() {
      return 0
    },
  }

  const collector = new StatsCollector(
    { ...validConfig, maxQueueSize: 20, batchSize: 2 },
    storage,
  )

  for (let i = 1; i <= 5; i++) {
    collector.recordRequest({
      requestId: `req-${i}`,
      accountId: 'acc-1',
      model: 'model-a',
      status: 'success',
      latencyMs: 10,
      promptTokens: 10,
      cachedTokens: 0,
      outputTokens: 10,
    })
  }

  await collector.flush()
  // 5 items with batchSize 2 -> chunks of 2, 2, 1
  assert.deepEqual(batchSizesObserved, [2, 2, 1])

  await collector.close()
})

test('Issue 5: cross-restart session history is atomically accumulated via deltas without overwrite', async () => {
  // Simulates persistent DB surviving process restart
  const persistentDb = {
    requests: [] as RequestMetric[],
    sessions: new Map<string, SessionMetric>(),
  }

  const createMockDbStorage = (): IStatsStorage => ({
    async init() {},
    async close() {},
    async saveRequestMetrics(metrics) {
      persistentDb.requests.push(...metrics)
    },
    async upsertSessionDeltas(deltas) {
      for (const d of deltas) {
        const existing = persistentDb.sessions.get(d.sessionId)
        if (!existing) {
          persistentDb.sessions.set(d.sessionId, {
            sessionId: d.sessionId,
            accountId: d.accountId,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
            totalRequests: d.requestCount,
            totalSuccess: d.successCount,
            totalFailed: d.failedCount,
            totalPromptTokens: d.promptTokens,
            totalCachedTokens: d.cachedTokens,
            cacheHitRate: d.promptTokens > 0 ? d.cachedTokens / d.promptTokens : 0,
          })
        } else {
          existing.totalRequests += d.requestCount
          existing.totalSuccess += d.successCount
          existing.totalFailed += d.failedCount
          existing.totalPromptTokens += d.promptTokens
          existing.totalCachedTokens += d.cachedTokens
          existing.cacheHitRate = existing.totalPromptTokens > 0 ? existing.totalCachedTokens / existing.totalPromptTokens : 0
          existing.createdAt = Math.min(existing.createdAt, d.createdAt)
          existing.updatedAt = Math.max(existing.updatedAt, d.updatedAt)
        }
      }
    },
    async getSessionMetric(id) {
      const found = persistentDb.sessions.get(id)
      return found ? { ...found } : null
    },
    async deleteRequestsBefore() {
      return 0
    },
    async deleteSessionsBefore() {
      return 0
    },
  })

  // Instance 1: Initial requests before process shutdown
  const collector1 = new StatsCollector(validConfig, createMockDbStorage())
  collector1.recordRequest({
    requestId: 'r-1',
    sessionId: 'sess-persistent',
    accountId: 'acc-1',
    model: 'model-a',
    timestamp: 1000,
    status: 'success',
    latencyMs: 10,
    promptTokens: 100,
    cachedTokens: 20,
    outputTokens: 10,
  })
  await collector1.close() // flushed and closed

  const sessionAfterC1 = persistentDb.sessions.get('sess-persistent')
  assert.ok(sessionAfterC1)
  assert.equal(sessionAfterC1.totalRequests, 1)
  assert.equal(sessionAfterC1.totalPromptTokens, 100)

  // Instance 2: Represents process restart, new collector with clean in-memory state
  const collector2 = new StatsCollector(validConfig, createMockDbStorage())
  collector2.recordRequest({
    requestId: 'r-2',
    sessionId: 'sess-persistent',
    accountId: 'acc-1',
    model: 'model-a',
    timestamp: 2000,
    status: 'success',
    latencyMs: 10,
    promptTokens: 150,
    cachedTokens: 30,
    outputTokens: 10,
  })

  // getSessionMetric before flush synthesizes stored baseline + pending delta
  const sessionImmediate = await collector2.getSessionMetric('sess-persistent')
  assert.ok(sessionImmediate)
  assert.equal(sessionImmediate.totalRequests, 2)
  assert.equal(sessionImmediate.totalPromptTokens, 250)
  assert.equal(sessionImmediate.totalCachedTokens, 50)
  assert.equal(sessionImmediate.createdAt, 1000)
  assert.equal(sessionImmediate.updatedAt, 2000)

  // Flush to storage
  await collector2.flush()

  const sessionFinal = persistentDb.sessions.get('sess-persistent')
  assert.ok(sessionFinal)
  assert.equal(sessionFinal.totalRequests, 2)
  assert.equal(sessionFinal.totalPromptTokens, 250)
  assert.equal(sessionFinal.totalCachedTokens, 50)
  assert.equal(sessionFinal.createdAt, 1000)
  assert.equal(sessionFinal.updatedAt, 2000)

  await collector2.close()
})

test('Issue 6: dropped requests do not corrupt session counts; total requests strictly match details', async () => {
  const storage = new MemoryStatsStorage()
  const collector = new StatsCollector(
    { ...validConfig, maxQueueSize: 2 },
    storage,
  )

  // 1st request for sess-x
  collector.recordRequest({
    requestId: 'req-x1',
    sessionId: 'sess-x',
    accountId: 'acc-1',
    model: 'model-a',
    timestamp: 1000,
    status: 'success',
    latencyMs: 10,
    promptTokens: 100,
    cachedTokens: 0,
    outputTokens: 10,
  })

  // 2nd request for sess-x
  collector.recordRequest({
    requestId: 'req-x2',
    sessionId: 'sess-x',
    accountId: 'acc-1',
    model: 'model-a',
    timestamp: 2000,
    status: 'success',
    latencyMs: 10,
    promptTokens: 100,
    cachedTokens: 0,
    outputTokens: 10,
  })

  // 3rd request pushes req-x1 out of buffer (maxQueueSize = 2)
  collector.recordRequest({
    requestId: 'req-x3',
    sessionId: 'sess-x',
    accountId: 'acc-1',
    model: 'model-a',
    timestamp: 3000,
    status: 'success',
    latencyMs: 10,
    promptTokens: 100,
    cachedTokens: 0,
    outputTokens: 10,
  })

  await collector.flush()

  const storedRequests = await storage.queryRequests({ sessionId: 'sess-x' })
  assert.equal(storedRequests.length, 2) // req-x2 and req-x3 only

  const session = await storage.getSessionMetric('sess-x')
  assert.ok(session)
  // Session totalRequests must strictly match stored requests count (2, NOT 3!)
  assert.equal(session.totalRequests, storedRequests.length)
  assert.equal(session.totalPromptTokens, 200)

  await collector.close()
})

test('Issue 7: concurrent cleanup calls reuse in-flight promise and return real cleanup results', async () => {
  const storage = new MemoryStatsStorage()
  const retentionDays = 1
  const collector = new StatsCollector(
    { ...validConfig, retentionDays },
    storage,
  )

  const now = 100_000_000_000
  const expiredTime = now - 2 * 86_400_000

  collector.recordRequest({
    requestId: 'expired-1',
    accountId: 'acc-1',
    model: 'm',
    timestamp: expiredTime,
    status: 'success',
    latencyMs: 10,
    promptTokens: 10,
    cachedTokens: 0,
    outputTokens: 10,
  })

  await collector.flush()

  // Concurrently trigger cleanup
  const [res1, res2] = await Promise.all([
    collector.cleanup(now),
    collector.cleanup(now),
  ])

  assert.equal(res1.deletedRequests, 1)
  assert.equal(res2.deletedRequests, 1) // Must NOT return fake 0!

  await collector.close()
})

test('Issue 8: graceful close awaits in-flight flush without killing storage early', async () => {
  let storageClosed = false
  let flushCompleted = false

  const slowStorage: IStatsStorage = {
    async init() {},
    async close() {
      if (!flushCompleted) {
        throw new Error('Fatal: Storage closed while flush was still writing!')
      }
      storageClosed = true
    },
    async saveRequestMetrics() {
      // Simulate asynchronous IO delay
      await new Promise((resolve) => setTimeout(resolve, 50))
      flushCompleted = true
    },
    async upsertSessionDeltas() {},
    async getSessionMetric() {
      return null
    },
    async deleteRequestsBefore() {
      return 0
    },
    async deleteSessionsBefore() {
      return 0
    },
  }

  const collector = new StatsCollector(validConfig, slowStorage)
  collector.recordRequest({
    requestId: 'req-slow',
    accountId: 'acc-1',
    model: 'model-a',
    status: 'success',
    latencyMs: 10,
    promptTokens: 10,
    cachedTokens: 0,
    outputTokens: 10,
  })

  // Trigger flush and immediately close() concurrently
  const flushPromise = collector.flush()
  const closePromise = collector.close()

  await Promise.all([flushPromise, closePromise])

  assert.equal(flushCompleted, true)
  assert.equal(storageClosed, true)
})

test('Issue 9: queryRequests and querySessions return records sorted in descending order', async () => {
  const storage = new MemoryStatsStorage()

  await storage.saveRequestMetrics([
    {
      requestId: 'req-old',
      sessionId: 'sess-1',
      accountId: 'acc-1',
      model: 'm',
      timestamp: 1000,
      status: 'success',
      latencyMs: 10,
      cacheHit: false,
      promptTokens: 10,
      cachedTokens: 0,
      outputTokens: 10,
    },
    {
      requestId: 'req-new',
      sessionId: 'sess-1',
      accountId: 'acc-1',
      model: 'm',
      timestamp: 3000,
      status: 'success',
      latencyMs: 10,
      cacheHit: false,
      promptTokens: 10,
      cachedTokens: 0,
      outputTokens: 10,
    },
    {
      requestId: 'req-mid',
      sessionId: 'sess-1',
      accountId: 'acc-1',
      model: 'm',
      timestamp: 2000,
      status: 'success',
      latencyMs: 10,
      cacheHit: false,
      promptTokens: 10,
      cachedTokens: 0,
      outputTokens: 10,
    },
  ])

  const sortedRequests = await storage.queryRequests({ limit: 2 })
  assert.equal(sortedRequests.length, 2)
  assert.equal(sortedRequests[0]?.requestId, 'req-new') // 3000
  assert.equal(sortedRequests[1]?.requestId, 'req-mid') // 2000

  await storage.upsertSessionDeltas([
    {
      sessionId: 'sess-old',
      accountId: 'acc-1',
      createdAt: 1000,
      updatedAt: 1000,
      requestCount: 1,
      successCount: 1,
      failedCount: 0,
      promptTokens: 10,
      cachedTokens: 0,
      outputTokens: 10,
    },
    {
      sessionId: 'sess-new',
      accountId: 'acc-1',
      createdAt: 3000,
      updatedAt: 3000,
      requestCount: 1,
      successCount: 1,
      failedCount: 0,
      promptTokens: 10,
      cachedTokens: 0,
      outputTokens: 10,
    },
    {
      sessionId: 'sess-mid',
      accountId: 'acc-1',
      createdAt: 2000,
      updatedAt: 2000,
      requestCount: 1,
      successCount: 1,
      failedCount: 0,
      promptTokens: 10,
      cachedTokens: 0,
      outputTokens: 10,
    },
  ])

  const sortedSessions = await storage.querySessions({ limit: 2 })
  assert.equal(sortedSessions.length, 2)
  assert.equal(sortedSessions[0]?.sessionId, 'sess-new') // 3000
  assert.equal(sortedSessions[1]?.sessionId, 'sess-mid') // 2000

  await storage.close()
})
