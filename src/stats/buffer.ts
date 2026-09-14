import type {
  IStatsStorage,
  OnDropCallback,
  OnErrorCallback,
  RequestMetric,
  SessionMetric,
  SessionMetricDelta,
} from './types.ts'

export interface StatsBufferQueueOptions {
  maxQueueSize: number
  maxSessionQueueSize?: number
  batchSize?: number
  flushIntervalMs: number
  storage: IStatsStorage
  onDrop?: OnDropCallback
  onError?: OnErrorCallback
}

export class StatsBufferQueue {
  public static readonly DEFAULT_BATCH_SIZE = 500
  public static readonly DEFAULT_MAX_SESSION_QUEUE_SIZE = 5000

  private readonly maxQueueSize: number
  private readonly maxSessionQueueSize: number
  private readonly batchSize: number
  private readonly flushIntervalMs: number
  private readonly storage: IStatsStorage
  private readonly onDrop?: OnDropCallback
  private readonly onError?: OnErrorCallback

  private requestQueue: RequestMetric[] = []
  private readonly sessionQueue: Map<string, SessionMetricDelta> = new Map()

  private timer: NodeJS.Timeout | null = null
  private activeFlushPromise: Promise<void> | null = null
  private hasPendingFlush = false
  private isClosed = false

  constructor(options: StatsBufferQueueOptions) {
    if (options.maxQueueSize <= 0 || !Number.isFinite(options.maxQueueSize)) {
      throw new Error(`Invalid maxQueueSize: ${options.maxQueueSize}. Must be a positive finite integer.`)
    }
    if (options.flushIntervalMs <= 0 || !Number.isFinite(options.flushIntervalMs)) {
      throw new Error(`Invalid flushIntervalMs: ${options.flushIntervalMs}. Must be a positive finite integer.`)
    }
    if (options.batchSize !== undefined && (options.batchSize <= 0 || !Number.isFinite(options.batchSize))) {
      throw new Error(`Invalid batchSize: ${options.batchSize}. Must be a positive finite integer.`)
    }
    if (options.maxSessionQueueSize !== undefined && (options.maxSessionQueueSize <= 0 || !Number.isFinite(options.maxSessionQueueSize))) {
      throw new Error(`Invalid maxSessionQueueSize: ${options.maxSessionQueueSize}. Must be a positive finite integer.`)
    }

    this.maxQueueSize = Math.floor(options.maxQueueSize)
    this.flushIntervalMs = Math.floor(options.flushIntervalMs)
    this.batchSize = Math.floor(options.batchSize ?? StatsBufferQueue.DEFAULT_BATCH_SIZE)
    this.maxSessionQueueSize = Math.floor(options.maxSessionQueueSize ?? Math.max(this.maxQueueSize, StatsBufferQueue.DEFAULT_MAX_SESSION_QUEUE_SIZE))
    this.storage = options.storage
    this.onDrop = options.onDrop
    this.onError = options.onError
  }

  start(): void {
    if (this.timer !== null || this.isClosed) {
      return
    }
    this.timer = setInterval(() => {
      void this.flush().catch((error) => {
        this.safeReportError(error, 'interval-flush')
      })
    }, this.flushIntervalMs)

    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  push(metric: RequestMetric, _legacySession?: SessionMetric): void {
    if (this.isClosed) {
      return
    }

    if (this.requestQueue.length >= this.maxQueueSize) {
      const dropped = this.requestQueue.shift()
      if (dropped) {
        if (dropped.sessionId) {
          this.decrementSessionDelta(dropped)
        }
        if (this.onDrop) {
          try {
            this.onDrop([dropped], this.requestQueue.length)
          } catch (error) {
            this.safeReportError(error, 'onDrop-handler')
          }
        }
      }
    }

    this.requestQueue.push(metric)

    if (metric.sessionId) {
      const isSuccess = metric.status === 'success'
      const isFailed = metric.status === 'error' || metric.status === 'abort'

      const delta: SessionMetricDelta = {
        sessionId: metric.sessionId,
        accountId: metric.accountId,
        createdAt: metric.timestamp,
        updatedAt: metric.timestamp,
        requestCount: 1,
        successCount: isSuccess ? 1 : 0,
        failedCount: isFailed ? 1 : 0,
        promptTokens: metric.promptTokens,
        cachedTokens: metric.cachedTokens,
        outputTokens: metric.outputTokens,
      }
      this.applySessionDelta(delta)
    }
  }

  async flush(): Promise<void> {
    while (this.activeFlushPromise !== null) {
      this.hasPendingFlush = true
      await this.activeFlushPromise
    }

    if (this.requestQueue.length === 0 && this.sessionQueue.size === 0) {
      return
    }

    const flushExecution = (async () => {
      try {
        await this.executeFlushLoop()
      } finally {
        this.activeFlushPromise = null
      }
    })()

    this.activeFlushPromise = flushExecution
    await flushExecution

    if (this.hasPendingFlush) {
      this.hasPendingFlush = false
      await this.flush()
    }
  }

  async close(): Promise<void> {
    this.isClosed = true
    this.stop()
    await this.flush()
  }

  getQueueSize(): number {
    return this.requestQueue.length
  }

  getSessionQueueSize(): number {
    return this.sessionQueue.size
  }

  getPendingSessionDelta(sessionId: string): SessionMetricDelta | null {
    const found = this.sessionQueue.get(sessionId)
    if (!found) {
      return null
    }
    return { ...found }
  }

  private async executeFlushLoop(): Promise<void> {
    while (this.requestQueue.length > 0 || this.sessionQueue.size > 0) {
      const requestsSlice = this.requestQueue.splice(0, this.batchSize)

      const sessionDeltasSlice: SessionMetricDelta[] = []
      const sessionKeys = Array.from(this.sessionQueue.keys()).slice(0, this.batchSize)
      for (const key of sessionKeys) {
        const item = this.sessionQueue.get(key)
        if (item) {
          sessionDeltasSlice.push(item)
        }
        this.sessionQueue.delete(key)
      }

      let requestsPersisted = false
      let sessionsPersisted = false

      try {
        if (requestsSlice.length > 0) {
          await this.storage.saveRequestMetrics(requestsSlice)
          requestsPersisted = true
        }

        if (sessionDeltasSlice.length > 0) {
          if (typeof this.storage.upsertSessionDeltas === 'function') {
            await this.storage.upsertSessionDeltas(sessionDeltasSlice)
          } else if (typeof this.storage.upsertSessionMetrics === 'function') {
            await this.storage.upsertSessionMetrics(this.deltasToSessionMetrics(sessionDeltasSlice))
          }
          sessionsPersisted = true
        }
      } catch (storageError) {
        this.safeReportError(storageError, 'storage-flush')
        const unpersistedRequests = requestsPersisted ? [] : requestsSlice
        const unpersistedSessions = sessionsPersisted ? [] : sessionDeltasSlice
        this.requeueOnError(unpersistedRequests, unpersistedSessions)
        break
      }
    }
  }

  private applySessionDelta(delta: SessionMetricDelta): void {
    const existing = this.sessionQueue.get(delta.sessionId)
    if (!existing) {
      if (this.sessionQueue.size >= this.maxSessionQueueSize) {
        const oldestKey = this.sessionQueue.keys().next().value
        if (oldestKey) {
          const droppedSession = this.sessionQueue.get(oldestKey)
          this.sessionQueue.delete(oldestKey)
          if (this.onDrop && droppedSession) {
            try {
              this.onDrop([], this.requestQueue.length, [droppedSession])
            } catch (error) {
              this.safeReportError(error, 'onDrop-handler')
            }
          }
        }
      }
      this.sessionQueue.set(delta.sessionId, { ...delta })
    } else {
      existing.accountId = delta.accountId
      existing.createdAt = Math.min(existing.createdAt, delta.createdAt)
      existing.updatedAt = Math.max(existing.updatedAt, delta.updatedAt)
      existing.requestCount += delta.requestCount
      existing.successCount += delta.successCount
      existing.failedCount += delta.failedCount
      existing.promptTokens += delta.promptTokens
      existing.cachedTokens += delta.cachedTokens
      existing.outputTokens += delta.outputTokens
    }
  }

  private decrementSessionDelta(metric: RequestMetric): void {
    if (!metric.sessionId) {
      return
    }
    const existing = this.sessionQueue.get(metric.sessionId)
    if (!existing) {
      return
    }

    const isSuccess = metric.status === 'success'
    const isFailed = metric.status === 'error' || metric.status === 'abort'

    existing.requestCount -= 1
    existing.successCount -= isSuccess ? 1 : 0
    existing.failedCount -= isFailed ? 1 : 0
    existing.promptTokens -= metric.promptTokens
    existing.cachedTokens -= metric.cachedTokens
    existing.outputTokens -= metric.outputTokens

    if (existing.requestCount <= 0) {
      this.sessionQueue.delete(metric.sessionId)
    }
  }

  private requeueOnError(requests: RequestMetric[], sessions: SessionMetricDelta[]): void {
    for (const session of sessions) {
      this.applySessionDelta(session)
    }

    const availableSlots = this.maxQueueSize - this.requestQueue.length
    if (availableSlots <= 0) {
      if (requests.length > 0) {
        for (const req of requests) {
          this.decrementSessionDelta(req)
        }
        if (this.onDrop) {
          try {
            this.onDrop(requests, this.requestQueue.length)
          } catch (error) {
            this.safeReportError(error, 'onDrop-handler')
          }
        }
      }
      return
    }

    const allowed = requests.slice(0, availableSlots)
    const excess = requests.slice(availableSlots)

    this.requestQueue.unshift(...allowed)

    if (excess.length > 0) {
      for (const req of excess) {
        this.decrementSessionDelta(req)
      }
      if (this.onDrop) {
        try {
          this.onDrop(excess, this.requestQueue.length)
        } catch (error) {
          this.safeReportError(error, 'onDrop-handler')
        }
      }
    }
  }

  private deltasToSessionMetrics(deltas: readonly SessionMetricDelta[]): SessionMetric[] {
    return deltas.map((d) => {
      const totalPromptTokens = Math.max(0, d.promptTokens)
      const totalCachedTokens = Math.max(0, d.cachedTokens)
      const cacheHitRate = totalPromptTokens > 0 ? totalCachedTokens / totalPromptTokens : 0
      return {
        sessionId: d.sessionId,
        accountId: d.accountId,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        totalRequests: d.requestCount,
        totalSuccess: d.successCount,
        totalFailed: d.failedCount,
        totalPromptTokens,
        totalCachedTokens,
        cacheHitRate,
      }
    })
  }

  private safeReportError(error: unknown, context: string): void {
    if (!this.onError) {
      return
    }
    try {
      this.onError(error, context)
    } catch {
      // Isolate error reporter exceptions
    }
  }
}
