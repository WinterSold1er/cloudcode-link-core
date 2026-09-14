import type {
  IStatsStorage,
  RequestMetric,
  RequestMetricFilter,
  SessionMetric,
  SessionMetricDelta,
  SessionMetricFilter,
  StatsConfig,
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
    result = [...result].sort((a, b) => b.timestamp - a.timestamp)
    if (filter?.limit !== undefined && filter.limit >= 0) {
      result = result.slice(0, filter.limit)
    }
    return result.map((r) => ({ ...r }))
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
    return new SqliteStatsStorage(dbPath)
  }

  console.warn(
    `[cloudcode-link-core] node:sqlite is not available in current runtime. Falling back to MemoryStatsStorage for path "${config.dbPath}".`,
  )
  return new MemoryStatsStorage()
}
