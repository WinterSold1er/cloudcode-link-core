import { StatsBufferQueue } from './buffer.ts'
import { StatsRetentionCleaner } from './cleaner.ts'
import { createStatsStorage } from './storage/memory.ts'
import type {
  CleanupResult,
  IStatsStorage,
  RecordRequestInput,
  RequestMetric,
  RequestMetricStatus,
  SessionMetric,
  StatsCollectorOptions,
  StatsConfig,
} from './types.ts'

export class StatsCollector {
  private readonly config: Readonly<StatsConfig>
  private readonly storage: IStatsStorage
  private readonly buffer: StatsBufferQueue
  private readonly cleaner: StatsRetentionCleaner
  private readonly options?: StatsCollectorOptions
  private isStarted = false
  private isClosed = false

  constructor(config: StatsConfig, storage?: IStatsStorage, options?: StatsCollectorOptions) {
    this.validateConfig(config)
    this.config = Object.freeze({ ...config })
    this.storage = storage ?? createStatsStorage(this.config)
    this.options = options

    this.buffer = new StatsBufferQueue({
      maxQueueSize: this.config.maxQueueSize,
      maxSessionQueueSize: this.config.maxSessionQueueSize,
      batchSize: this.config.batchSize,
      flushIntervalMs: this.config.flushIntervalMs,
      storage: this.storage,
      onDrop: this.options?.onDrop,
      onError: this.options?.onError,
    })

    this.cleaner = new StatsRetentionCleaner({
      storage: this.storage,
      retentionDays: this.config.retentionDays,
      cleanupIntervalMs: this.config.cleanupIntervalMs,
      onCleanup: this.options?.onCleanup,
      onError: this.options?.onError,
    })
  }

  start(): void {
    if (this.isClosed || this.isStarted) {
      return
    }
    this.buffer.start()
    this.cleaner.start()
    this.isStarted = true
  }

  recordRequest(input: RecordRequestInput): void {
    if (this.isClosed) {
      return
    }

    try {
      this.validateRecordInput(input)

      const timestamp = typeof input.timestamp === 'number' && Number.isFinite(input.timestamp)
        ? input.timestamp
        : Date.now()

      const promptTokens = Math.max(0, Math.floor(input.promptTokens))
      const cachedTokens = Math.max(0, Math.floor(input.cachedTokens))
      const outputTokens = Math.max(0, Math.floor(input.outputTokens))
      const latencyMs = Math.max(0, Math.floor(input.latencyMs))
      const ttftMs = typeof input.ttftMs === 'number' && Number.isFinite(input.ttftMs)
        ? Math.max(0, Math.floor(input.ttftMs))
        : undefined

      const cacheHit = cachedTokens > 0

      const requestMetric: RequestMetric = {
        requestId: input.requestId,
        sessionId: input.sessionId ?? null,
        accountId: input.accountId,
        model: input.model,
        timestamp,
        status: input.status,
        latencyMs,
        ttftMs,
        cacheHit,
        promptTokens,
        cachedTokens,
        outputTokens,
      }

      this.buffer.push(requestMetric)
    } catch (error) {
      if (this.options?.onError) {
        try {
          this.options.onError(error, 'recordRequest')
        } catch {
          // Suppress error inside error handler
        }
      }
    }
  }

  async flush(): Promise<void> {
    await this.buffer.flush()
  }

  async cleanup(referenceNow?: number): Promise<CleanupResult> {
    return await this.cleaner.cleanup(referenceNow)
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return
    }
    this.isClosed = true
    this.isStarted = false

    this.cleaner.stop()
    await this.buffer.close()
    await this.storage.close()
  }

  async getSessionMetric(sessionId: string): Promise<SessionMetric | null> {
    const persisted = await this.storage.getSessionMetric(sessionId)
    const pendingDelta = this.buffer.getPendingSessionDelta(sessionId)

    if (!persisted && !pendingDelta) {
      return null
    }

    if (!persisted && pendingDelta) {
      const totalPromptTokens = Math.max(0, pendingDelta.promptTokens)
      const totalCachedTokens = Math.max(0, pendingDelta.cachedTokens)
      const cacheHitRate = totalPromptTokens > 0 ? totalCachedTokens / totalPromptTokens : 0
      return {
        sessionId: pendingDelta.sessionId,
        accountId: pendingDelta.accountId,
        createdAt: pendingDelta.createdAt,
        updatedAt: pendingDelta.updatedAt,
        totalRequests: pendingDelta.requestCount,
        totalSuccess: pendingDelta.successCount,
        totalFailed: pendingDelta.failedCount,
        totalPromptTokens,
        totalCachedTokens,
        cacheHitRate,
      }
    }

    if (persisted && !pendingDelta) {
      return { ...persisted }
    }

    if (persisted && pendingDelta) {
      const totalRequests = persisted.totalRequests + pendingDelta.requestCount
      const totalSuccess = persisted.totalSuccess + pendingDelta.successCount
      const totalFailed = persisted.totalFailed + pendingDelta.failedCount
      const totalPromptTokens = persisted.totalPromptTokens + pendingDelta.promptTokens
      const totalCachedTokens = persisted.totalCachedTokens + pendingDelta.cachedTokens
      const cacheHitRate = totalPromptTokens > 0 ? totalCachedTokens / totalPromptTokens : 0
      return {
        ...persisted,
        accountId: pendingDelta.accountId,
        createdAt: Math.min(persisted.createdAt, pendingDelta.createdAt),
        updatedAt: Math.max(persisted.updatedAt, pendingDelta.updatedAt),
        totalRequests,
        totalSuccess,
        totalFailed,
        totalPromptTokens,
        totalCachedTokens,
        cacheHitRate,
      }
    }

    return null
  }

  getStorage(): IStatsStorage {
    return this.storage
  }

  getConfig(): Readonly<StatsConfig> {
    return this.config
  }

  private validateConfig(config: StatsConfig): void {
    if (!config || typeof config !== 'object') {
      throw new Error('StatsConfig must be a non-null object.')
    }
    if (typeof config.retentionDays !== 'number' || !Number.isFinite(config.retentionDays) || config.retentionDays <= 0) {
      throw new Error(`Invalid retentionDays: ${config.retentionDays}. Must be a positive finite number.`)
    }
    if (typeof config.dbPath !== 'string' || config.dbPath.trim().length === 0) {
      throw new Error(`Invalid dbPath: "${config.dbPath}". Must be a non-empty string.`)
    }
    if (typeof config.flushIntervalMs !== 'number' || !Number.isFinite(config.flushIntervalMs) || config.flushIntervalMs <= 0) {
      throw new Error(`Invalid flushIntervalMs: ${config.flushIntervalMs}. Must be a positive finite integer.`)
    }
    if (typeof config.maxQueueSize !== 'number' || !Number.isFinite(config.maxQueueSize) || config.maxQueueSize <= 0) {
      throw new Error(`Invalid maxQueueSize: ${config.maxQueueSize}. Must be a positive finite integer.`)
    }
    if (config.maxSessionQueueSize !== undefined) {
      if (typeof config.maxSessionQueueSize !== 'number' || !Number.isFinite(config.maxSessionQueueSize) || config.maxSessionQueueSize <= 0) {
        throw new Error(`Invalid maxSessionQueueSize: ${config.maxSessionQueueSize}. Must be a positive finite integer.`)
      }
    }
    if (config.batchSize !== undefined) {
      if (typeof config.batchSize !== 'number' || !Number.isFinite(config.batchSize) || config.batchSize <= 0) {
        throw new Error(`Invalid batchSize: ${config.batchSize}. Must be a positive finite integer.`)
      }
    }
    if (typeof config.cleanupIntervalMs !== 'number' || !Number.isFinite(config.cleanupIntervalMs) || config.cleanupIntervalMs <= 0) {
      throw new Error(`Invalid cleanupIntervalMs: ${config.cleanupIntervalMs}. Must be a positive finite integer.`)
    }
  }

  private validateRecordInput(input: RecordRequestInput): void {
    if (!input || typeof input !== 'object') {
      throw new Error('RecordRequestInput must be a valid non-null object.')
    }
    if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
      throw new Error('Invalid requestId: must be a non-empty string.')
    }
    if (typeof input.accountId !== 'string' || input.accountId.trim().length === 0) {
      throw new Error('Invalid accountId: must be a non-empty string.')
    }
    if (typeof input.model !== 'string' || input.model.trim().length === 0) {
      throw new Error('Invalid model: must be a non-empty string.')
    }
    const validStatuses: readonly RequestMetricStatus[] = ['success', 'error', 'abort']
    if (!validStatuses.includes(input.status)) {
      throw new Error(`Invalid status: "${input.status}". Must be 'success', 'error', or 'abort'.`)
    }
    if (typeof input.latencyMs !== 'number' || !Number.isFinite(input.latencyMs) || input.latencyMs < 0) {
      throw new Error(`Invalid latencyMs: ${input.latencyMs}. Must be a non-negative finite number.`)
    }
    if (input.ttftMs !== undefined) {
      if (typeof input.ttftMs !== 'number' || !Number.isFinite(input.ttftMs) || input.ttftMs < 0) {
        throw new Error(`Invalid ttftMs: ${input.ttftMs}. Must be a non-negative finite number.`)
      }
    }
    if (typeof input.promptTokens !== 'number' || !Number.isFinite(input.promptTokens) || input.promptTokens < 0) {
      throw new Error(`Invalid promptTokens: ${input.promptTokens}. Must be a non-negative finite number.`)
    }
    if (typeof input.cachedTokens !== 'number' || !Number.isFinite(input.cachedTokens) || input.cachedTokens < 0) {
      throw new Error(`Invalid cachedTokens: ${input.cachedTokens}. Must be a non-negative finite number.`)
    }
    if (typeof input.outputTokens !== 'number' || !Number.isFinite(input.outputTokens) || input.outputTokens < 0) {
      throw new Error(`Invalid outputTokens: ${input.outputTokens}. Must be a non-negative finite number.`)
    }
  }
}
