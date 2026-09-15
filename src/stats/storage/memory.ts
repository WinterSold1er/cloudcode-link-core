import type {
  AccountUsageMetric,
  AggregatedBucketMetric,
  IStatsStorage,
  OverviewMetricsResult,
  RequestMetric,
  RequestMetricFilter,
  SessionMetric,
  SessionMetricDelta,
  SessionMetricFilter,
  StatsConfig,
  StatsOverviewAccount,
} from '../types.ts'
import { isSqliteAvailable, SqliteStatsStorage } from './sqlite.ts'

export class MemoryStatsStorage implements IStatsStorage {
  private requests: RequestMetric[] = []
  private readonly sessions: Map<string, SessionMetric> = new Map()
  private isClosed = false

  async init(): Promise<void> {
    this.assertNotClosed()
  }

  async close(): Promise<void> {
    this.isClosed = true
    this.requests = []
    this.sessions.clear()
  }

  async saveRequestMetrics(metrics: readonly RequestMetric[]): Promise<void> {
    this.assertNotClosed()
    if (metrics.length === 0) {
      return
    }
    for (const metric of metrics) {
      this.requests.push({ ...metric })
    }
  }

  async upsertSessionMetrics(metrics: readonly SessionMetric[]): Promise<void> {
    this.assertNotClosed()
    if (metrics.length === 0) {
      return
    }
    for (const metric of metrics) {
      this.sessions.set(metric.sessionId, { ...metric })
    }
  }

  async upsertSessionDeltas(deltas: readonly SessionMetricDelta[]): Promise<void> {
    this.assertNotClosed()
    if (deltas.length === 0) {
      return
    }

    for (const delta of deltas) {
      const existing = this.sessions.get(delta.sessionId)
      if (!existing) {
        const totalPromptTokens = Math.max(0, delta.promptTokens)
        const totalCachedTokens = Math.max(0, delta.cachedTokens)
        const cacheHitRate = totalPromptTokens > 0 ? totalCachedTokens / totalPromptTokens : 0

        const newSession: SessionMetric = {
          sessionId: delta.sessionId,
          accountId: delta.accountId,
          createdAt: delta.createdAt,
          updatedAt: delta.updatedAt,
          totalRequests: delta.requestCount,
          totalSuccess: delta.successCount,
          totalFailed: delta.failedCount,
          totalPromptTokens,
          totalCachedTokens,
          cacheHitRate,
        }
        this.sessions.set(delta.sessionId, newSession)
      } else {
        const totalRequests = existing.totalRequests + delta.requestCount
        const totalSuccess = existing.totalSuccess + delta.successCount
        const totalFailed = existing.totalFailed + delta.failedCount
        const totalPromptTokens = existing.totalPromptTokens + delta.promptTokens
        const totalCachedTokens = existing.totalCachedTokens + delta.cachedTokens
        const cacheHitRate = totalPromptTokens > 0 ? totalCachedTokens / totalPromptTokens : 0

        const updatedSession: SessionMetric = {
          ...existing,
          accountId: delta.accountId,
          createdAt: Math.min(existing.createdAt, delta.createdAt),
          updatedAt: Math.max(existing.updatedAt, delta.updatedAt),
          totalRequests,
          totalSuccess,
          totalFailed,
          totalPromptTokens,
          totalCachedTokens,
          cacheHitRate,
        }
        this.sessions.set(delta.sessionId, updatedSession)
      }
    }
  }

  async getSessionMetric(sessionId: string): Promise<SessionMetric | null> {
    this.assertNotClosed()
    const found = this.sessions.get(sessionId)
    if (!found) {
      return null
    }
    return { ...found }
  }

  async deleteRequestsBefore(cutoffTime: number): Promise<number> {
    this.assertNotClosed()
    const initialCount = this.requests.length
    this.requests = this.requests.filter((r) => r.timestamp >= cutoffTime)
    return initialCount - this.requests.length
  }

  async deleteSessionsBefore(cutoffTime: number): Promise<number> {
    this.assertNotClosed()
    let deletedCount = 0
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.updatedAt < cutoffTime) {
        this.sessions.delete(sessionId)
        deletedCount++
      }
    }
    return deletedCount
  }

  async queryRequests(filter?: RequestMetricFilter): Promise<RequestMetric[]> {
    this.assertNotClosed()
    let result = this.requests
    if (filter?.sessionId) {
      result = result.filter((r) => r.sessionId === filter.sessionId)
    }
    if (filter?.accountId) {
      result = result.filter((r) => r.accountId === filter.accountId)
    }
    if (filter?.status) {
      result = result.filter((r) => r.status === filter.status)
    }
    if (filter?.since !== undefined) {
      result = result.filter((r) => r.timestamp >= filter.since!)
    }
    if (filter?.until !== undefined) {
      result = result.filter((r) => r.timestamp <= filter.until!)
    }
    result = [...result].sort((a, b) => b.timestamp - a.timestamp)
    const offset = filter?.offset !== undefined && filter.offset >= 0 ? filter.offset : 0
    if (offset > 0) {
      result = result.slice(offset)
    }
    if (filter?.limit !== undefined && filter.limit >= 0) {
      result = result.slice(0, filter.limit)
    }
    return result.map((r) => ({ ...r }))
  }

  async countRequests(filter?: RequestMetricFilter): Promise<number> {
    this.assertNotClosed()
    let result = this.requests
    if (filter?.sessionId) {
      result = result.filter((r) => r.sessionId === filter.sessionId)
    }
    if (filter?.accountId) {
      result = result.filter((r) => r.accountId === filter.accountId)
    }
    if (filter?.status) {
      result = result.filter((r) => r.status === filter.status)
    }
    if (filter?.since !== undefined) {
      result = result.filter((r) => r.timestamp >= filter.since!)
    }
    if (filter?.until !== undefined) {
      result = result.filter((r) => r.timestamp <= filter.until!)
    }
    return result.length
  }

  async querySessions(filter?: SessionMetricFilter): Promise<SessionMetric[]> {
    this.assertNotClosed()
    let list = Array.from(this.sessions.values())
    if (filter?.accountId) {
      list = list.filter((s) => s.accountId === filter.accountId)
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    if (filter?.limit !== undefined && filter.limit >= 0) {
      list = list.slice(0, filter.limit)
    }
    return list.map((s) => ({ ...s }))
  }

  async getOverviewMetrics(): Promise<OverviewMetricsResult> {
    this.assertNotClosed()
    const emptyResult: OverviewMetricsResult = {
      overview: {
        totalRequests: 0,
        totalSuccess: 0,
        totalFailed: 0,
        totalAbort: 0,
        totalTokens: 0,
        totalPromptTokens: 0,
        totalCachedTokens: 0,
        totalOutputTokens: 0,
        cacheHitRate: 0,
        avgLatencyMs: 0,
        avgTtftMs: 0,
        p50LatencyMs: 0,
        p90LatencyMs: 0,
      },
      accounts: [],
    }

    if (this.requests.length === 0) {
      return emptyResult
    }

    let totalSuccess = 0
    let totalFailed = 0
    let totalAbort = 0
    let totalPromptTokens = 0
    let totalCachedTokens = 0
    let totalOutputTokens = 0
    let totalLatencyMs = 0
    let totalTtftMs = 0
    let ttftCount = 0
    const latencies: number[] = []

    const accountMap = new Map<
      string,
      {
        accountId: string
        totalRequests: number
        successRequests: number
        failedRequests: number
        promptTokens: number
        cachedTokens: number
        outputTokens: number
        totalLatencyMs: number
      }
    >()

    for (const r of this.requests) {
      if (r.status === 'success') totalSuccess++
      else if (r.status === 'abort') totalAbort++
      else totalFailed++

      totalPromptTokens += r.promptTokens
      totalCachedTokens += r.cachedTokens
      totalOutputTokens += r.outputTokens
      totalLatencyMs += r.latencyMs
      latencies.push(r.latencyMs)
      if (typeof r.ttftMs === 'number') {
        totalTtftMs += r.ttftMs
        ttftCount++
      }

      let acc = accountMap.get(r.accountId)
      if (!acc) {
        acc = {
          accountId: r.accountId,
          totalRequests: 0,
          successRequests: 0,
          failedRequests: 0,
          promptTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          totalLatencyMs: 0,
        }
        accountMap.set(r.accountId, acc)
      }
      acc.totalRequests++
      if (r.status === 'success') acc.successRequests++
      else acc.failedRequests++
      acc.promptTokens += r.promptTokens
      acc.cachedTokens += r.cachedTokens
      acc.outputTokens += r.outputTokens
      acc.totalLatencyMs += r.latencyMs
    }

    latencies.sort((a, b) => a - b)
    const totalRequests = this.requests.length
    const p50LatencyMs =
      latencies.length > 0 ? (latencies[Math.floor(latencies.length * 0.5)] ?? 0) : 0
    const p90LatencyMs =
      latencies.length > 0 ? (latencies[Math.floor(latencies.length * 0.9)] ?? 0) : 0
    const avgLatencyMs = totalRequests > 0 ? Math.round(totalLatencyMs / totalRequests) : 0
    const avgTtftMs = ttftCount > 0 ? Math.round(totalTtftMs / ttftCount) : 0
    const cacheHitRate =
      totalPromptTokens > 0 ? Number((totalCachedTokens / totalPromptTokens).toFixed(4)) : 0

    const accounts: StatsOverviewAccount[] = Array.from(accountMap.values()).map((acc) => ({
      accountId: acc.accountId,
      totalRequests: acc.totalRequests,
      successRequests: acc.successRequests,
      failedRequests: acc.failedRequests,
      promptTokens: acc.promptTokens,
      cachedTokens: acc.cachedTokens,
      outputTokens: acc.outputTokens,
      cacheHitRate:
        acc.promptTokens > 0 ? Number((acc.cachedTokens / acc.promptTokens).toFixed(4)) : 0,
      avgLatencyMs: acc.totalRequests > 0 ? Math.round(acc.totalLatencyMs / acc.totalRequests) : 0,
    }))

    return {
      overview: {
        totalRequests,
        totalSuccess,
        totalFailed,
        totalAbort,
        totalTokens: totalPromptTokens + totalOutputTokens,
        totalPromptTokens,
        totalCachedTokens,
        totalOutputTokens,
        cacheHitRate,
        avgLatencyMs,
        avgTtftMs,
        p50LatencyMs,
        p90LatencyMs,
      },
      accounts,
    }
  }

  async getAccountUsage(): Promise<AccountUsageMetric[]> {
    this.assertNotClosed()
    const map = new Map<string, AccountUsageMetric>()
    for (const r of this.requests) {
      let u = map.get(r.accountId)
      if (!u) {
        u = {
          accountId: r.accountId,
          totalRequests: 0,
          successRequests: 0,
          failedRequests: 0,
          promptTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          totalLatencyMs: 0,
          lastUsed: null,
        }
        map.set(r.accountId, u)
      }
      u.totalRequests++
      if (r.status === 'success') u.successRequests++
      else u.failedRequests++
      u.promptTokens += r.promptTokens
      u.cachedTokens += r.cachedTokens
      u.outputTokens += r.outputTokens
      u.totalLatencyMs += r.latencyMs
      if (u.lastUsed === null || r.timestamp > u.lastUsed) {
        u.lastUsed = r.timestamp
      }
    }
    return Array.from(map.values())
  }

  async getAggregatedMetrics(
    intervalMs: number,
    since?: number,
    until?: number,
    limit = 1000,
  ): Promise<AggregatedBucketMetric[]> {
    this.assertNotClosed()
    const safeInterval = Math.max(1000, intervalMs)
    const bucketMap = new Map<number, AggregatedBucketMetric>()

    for (const r of this.requests) {
      if (since !== undefined && r.timestamp < since) continue
      if (until !== undefined && r.timestamp > until) continue

      const bKey = Math.floor(r.timestamp / safeInterval) * safeInterval
      let b = bucketMap.get(bKey)
      if (!b) {
        b = {
          bucket: bKey,
          requests: 0,
          successCount: 0,
          failedCount: 0,
          promptTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
          totalLatencyMs: 0,
          totalTtftMs: 0,
          ttftCount: 0,
        }
        bucketMap.set(bKey, b)
      }
      b.requests++
      if (r.status === 'success') b.successCount++
      else b.failedCount++
      b.promptTokens += r.promptTokens
      b.cachedTokens += r.cachedTokens
      b.outputTokens += r.outputTokens
      b.totalLatencyMs += r.latencyMs
      if (typeof r.ttftMs === 'number') {
        b.totalTtftMs += r.ttftMs
        b.ttftCount++
      }
    }

    const sorted = Array.from(bucketMap.values())
      .sort((a, b) => a.bucket - b.bucket)
      .slice(0, Math.max(1, limit))

    return sorted
  }

  private assertNotClosed(): void {
    if (this.isClosed) {
      throw new Error('MemoryStatsStorage has already been closed')
    }
  }
}

export function createStatsStorage(config: StatsConfig): IStatsStorage {
  if (!config || typeof config !== 'object') {
    throw new Error('StatsConfig must be a non-null object.')
  }
  const dbPath = config.dbPath?.trim()
  if (!dbPath) {
    throw new Error('Invalid dbPath: must be a non-empty string.')
  }
  if (dbPath === ':memory:' || dbPath.startsWith('memory://')) {
    return new MemoryStatsStorage()
  }

  // Reject unsupported remote protocols
  if (dbPath.includes('://') && !dbPath.startsWith('sqlite://') && !dbPath.startsWith('file://')) {
    throw new Error(
      `Unsupported dbPath protocol: "${config.dbPath}". Only "memory://", ":memory:", or local SQLite files are currently supported by default storage factory.`,
    )
  }

  // If node:sqlite is available, use SqliteStatsStorage for local/sqlite files
  if (isSqliteAvailable()) {
    try {
      return new SqliteStatsStorage(dbPath)
    } catch (err) {
      console.warn(
        `[cloudcode-link-core] Failed to initialize SqliteStatsStorage for "${dbPath}". Falling back to MemoryStatsStorage.`,
        err,
      )
      return new MemoryStatsStorage()
    }
  }

  console.warn(
    `[cloudcode-link-core] node:sqlite is not available in current runtime. Falling back to MemoryStatsStorage for path "${config.dbPath}".`,
  )
  return new MemoryStatsStorage()
}
