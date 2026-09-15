import { createRequire } from 'node:module'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
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
  StatsOverviewAccount,
} from '../types.ts'

const require = createRequire(import.meta.url)

export function getDatabaseSyncClass(): typeof DatabaseSync | null {
  try {
    const sqlite = require('node:sqlite')
    return sqlite.DatabaseSync ?? null
  } catch {
    return null
  }
}

export function isSqliteAvailable(): boolean {
  return getDatabaseSyncClass() !== null
}

export class SqliteStatsStorage implements IStatsStorage {
  private db: DatabaseSync | null = null
  private readonly dbPath: string
  private isClosed = false

  private insertRequestStmt: StatementSync | null = null
  private upsertSessionStmt: StatementSync | null = null
  private upsertDeltaStmt: StatementSync | null = null
  private getSessionStmt: StatementSync | null = null
  private deleteRequestsStmt: StatementSync | null = null
  private deleteSessionsStmt: StatementSync | null = null

  constructor(dbPath: string) {
    let cleanPath = dbPath.trim()
    if (cleanPath.startsWith('sqlite://')) {
      cleanPath = cleanPath.slice('sqlite://'.length)
    } else if (cleanPath.startsWith('file://')) {
      cleanPath = cleanPath.slice('file://'.length)
    }
    this.dbPath = cleanPath

    const DatabaseClass = getDatabaseSyncClass()
    if (!DatabaseClass) {
      throw new Error('node:sqlite DatabaseSync is not available in the current Node.js runtime.')
    }

    if (this.dbPath !== ':memory:' && !this.dbPath.startsWith(':memory:')) {
      const dir = dirname(this.dbPath)
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      } catch {
        // Directory may already exist or be managed externally
      }
    }

    this.db = new DatabaseClass(this.dbPath)
    if (this.dbPath !== ':memory:' && !this.dbPath.startsWith(':memory:')) {
      try {
        chmodSync(this.dbPath, 0o600)
      } catch {
        // Platform compatibility or permission fallback
      }
    }
    this.bootstrap()
  }

  private bootstrap(): void {
    if (!this.db) return

    if (this.dbPath !== ':memory:' && !this.dbPath.startsWith(':memory:')) {
      try {
        this.db.exec('PRAGMA journal_mode = WAL;')
      } catch {
        // Ignore filesystems where WAL is unsupported
      }
    }
    this.db.exec('PRAGMA synchronous = NORMAL;')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_metrics (
        requestId TEXT PRIMARY KEY,
        sessionId TEXT,
        accountId TEXT NOT NULL,
        model TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL,
        latencyMs INTEGER NOT NULL,
        ttftMs INTEGER,
        cacheHit INTEGER NOT NULL,
        promptTokens INTEGER NOT NULL,
        cachedTokens INTEGER NOT NULL,
        outputTokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON request_metrics(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_requests_session ON request_metrics(sessionId);
      CREATE INDEX IF NOT EXISTS idx_requests_account ON request_metrics(accountId);
      CREATE INDEX IF NOT EXISTS idx_requests_latency ON request_metrics(latencyMs ASC);

      CREATE TABLE IF NOT EXISTS session_metrics (
        sessionId TEXT PRIMARY KEY,
        accountId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        totalRequests INTEGER NOT NULL,
        totalSuccess INTEGER NOT NULL,
        totalFailed INTEGER NOT NULL,
        totalPromptTokens INTEGER NOT NULL,
        totalCachedTokens INTEGER NOT NULL,
        cacheHitRate REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON session_metrics(updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON session_metrics(accountId);
    `)

    try {
      this.db.exec('ALTER TABLE request_metrics ADD COLUMN ttftMs INTEGER;')
    } catch {
      // Column may already exist
    }

    this.insertRequestStmt = this.db.prepare(`
      INSERT OR REPLACE INTO request_metrics (
        requestId, sessionId, accountId, model, timestamp, status,
        latencyMs, ttftMs, cacheHit, promptTokens, cachedTokens, outputTokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.upsertSessionStmt = this.db.prepare(`
      INSERT INTO session_metrics (
        sessionId, accountId, createdAt, updatedAt,
        totalRequests, totalSuccess, totalFailed,
        totalPromptTokens, totalCachedTokens, cacheHitRate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        accountId = excluded.accountId,
        createdAt = excluded.createdAt,
        updatedAt = excluded.updatedAt,
        totalRequests = excluded.totalRequests,
        totalSuccess = excluded.totalSuccess,
        totalFailed = excluded.totalFailed,
        totalPromptTokens = excluded.totalPromptTokens,
        totalCachedTokens = excluded.totalCachedTokens,
        cacheHitRate = excluded.cacheHitRate
    `)

    this.upsertDeltaStmt = this.db.prepare(`
      INSERT INTO session_metrics (
        sessionId, accountId, createdAt, updatedAt,
        totalRequests, totalSuccess, totalFailed,
        totalPromptTokens, totalCachedTokens, cacheHitRate
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        CASE WHEN ? > 0 THEN CAST(? AS REAL) / ? ELSE 0.0 END
      )
      ON CONFLICT(sessionId) DO UPDATE SET
        accountId = excluded.accountId,
        createdAt = min(session_metrics.createdAt, excluded.createdAt),
        updatedAt = max(session_metrics.updatedAt, excluded.updatedAt),
        totalRequests = session_metrics.totalRequests + excluded.totalRequests,
        totalSuccess = session_metrics.totalSuccess + excluded.totalSuccess,
        totalFailed = session_metrics.totalFailed + excluded.totalFailed,
        totalPromptTokens = session_metrics.totalPromptTokens + excluded.totalPromptTokens,
        totalCachedTokens = session_metrics.totalCachedTokens + excluded.totalCachedTokens,
        cacheHitRate = CASE 
          WHEN (session_metrics.totalPromptTokens + excluded.totalPromptTokens) > 0 
          THEN CAST(session_metrics.totalCachedTokens + excluded.totalCachedTokens AS REAL) / (session_metrics.totalPromptTokens + excluded.totalPromptTokens)
          ELSE 0.0 
        END
    `)

    this.getSessionStmt = this.db.prepare('SELECT * FROM session_metrics WHERE sessionId = ?')
    this.deleteRequestsStmt = this.db.prepare('DELETE FROM request_metrics WHERE timestamp < ?')
    this.deleteSessionsStmt = this.db.prepare('DELETE FROM session_metrics WHERE updatedAt < ?')
  }

  async init(): Promise<void> {
    this.assertNotClosed()
  }

  async close(): Promise<void> {
    if (!this.isClosed) {
      this.isClosed = true
      if (this.db) {
        try {
          this.db.close()
        } catch {
          // Ignore errors on close
        }
        this.db = null
      }
    }
  }

  async saveRequestMetrics(metrics: readonly RequestMetric[]): Promise<void> {
    this.assertNotClosed()
    if (metrics.length === 0 || !this.db || !this.insertRequestStmt) {
      return
    }

    this.db.exec('BEGIN')
    try {
      for (const m of metrics) {
        this.insertRequestStmt.run(
          m.requestId,
          m.sessionId ?? null,
          m.accountId,
          m.model,
          m.timestamp,
          m.status,
          m.latencyMs,
          m.ttftMs ?? null,
          m.cacheHit ? 1 : 0,
          m.promptTokens,
          m.cachedTokens,
          m.outputTokens,
        )
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async upsertSessionMetrics(metrics: readonly SessionMetric[]): Promise<void> {
    this.assertNotClosed()
    if (metrics.length === 0 || !this.db || !this.upsertSessionStmt) {
      return
    }

    this.db.exec('BEGIN')
    try {
      for (const m of metrics) {
        this.upsertSessionStmt.run(
          m.sessionId,
          m.accountId,
          m.createdAt,
          m.updatedAt,
          m.totalRequests,
          m.totalSuccess,
          m.totalFailed,
          m.totalPromptTokens,
          m.totalCachedTokens,
          m.cacheHitRate,
        )
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async upsertSessionDeltas(deltas: readonly SessionMetricDelta[]): Promise<void> {
    this.assertNotClosed()
    if (deltas.length === 0 || !this.db || !this.upsertDeltaStmt) {
      return
    }

    this.db.exec('BEGIN')
    try {
      for (const d of deltas) {
        const promptTokens = Math.max(0, d.promptTokens)
        const cachedTokens = Math.max(0, d.cachedTokens)
        this.upsertDeltaStmt.run(
          d.sessionId,
          d.accountId,
          d.createdAt,
          d.updatedAt,
          d.requestCount,
          d.successCount,
          d.failedCount,
          promptTokens,
          cachedTokens,
          promptTokens,
          cachedTokens,
          promptTokens,
        )
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async getSessionMetric(sessionId: string): Promise<SessionMetric | null> {
    this.assertNotClosed()
    if (!this.getSessionStmt) return null

    const row = this.getSessionStmt.get(sessionId) as any
    if (!row) {
      return null
    }

    return {
      sessionId: String(row.sessionId),
      accountId: String(row.accountId),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      totalRequests: Number(row.totalRequests),
      totalSuccess: Number(row.totalSuccess),
      totalFailed: Number(row.totalFailed),
      totalPromptTokens: Number(row.totalPromptTokens),
      totalCachedTokens: Number(row.totalCachedTokens),
      cacheHitRate: Number(row.cacheHitRate),
    }
  }

  async deleteRequestsBefore(cutoffTime: number): Promise<number> {
    this.assertNotClosed()
    if (!this.deleteRequestsStmt) return 0
    const res = this.deleteRequestsStmt.run(cutoffTime)
    return Number(res.changes ?? 0)
  }

  async deleteSessionsBefore(cutoffTime: number): Promise<number> {
    this.assertNotClosed()
    if (!this.deleteSessionsStmt) return 0
    const res = this.deleteSessionsStmt.run(cutoffTime)
    return Number(res.changes ?? 0)
  }

  async queryRequests(filter?: RequestMetricFilter): Promise<RequestMetric[]> {
    this.assertNotClosed()
    if (!this.db) return []

    let query = 'SELECT * FROM request_metrics WHERE 1=1'
    const params: any[] = []

    if (filter?.sessionId) {
      query += ' AND sessionId = ?'
      params.push(filter.sessionId)
    }
    if (filter?.accountId) {
      query += ' AND accountId = ?'
      params.push(filter.accountId)
    }
    if (filter?.status) {
      query += ' AND status = ?'
      params.push(filter.status)
    }
    if (filter?.since !== undefined) {
      query += ' AND timestamp >= ?'
      params.push(filter.since)
    }
    if (filter?.until !== undefined) {
      query += ' AND timestamp <= ?'
      params.push(filter.until)
    }
    query += ' ORDER BY timestamp DESC'
    if (filter?.limit !== undefined && filter.limit >= 0) {
      query += ' LIMIT ?'
      params.push(filter.limit)
      if (filter?.offset !== undefined && filter.offset >= 0) {
        query += ' OFFSET ?'
        params.push(filter.offset)
      }
    }

    const stmt = this.db.prepare(query)
    const rows = stmt.all(...params) as any[]
    return rows.map((r) => ({
      requestId: String(r.requestId),
      sessionId: r.sessionId ? String(r.sessionId) : null,
      accountId: String(r.accountId),
      model: String(r.model),
      timestamp: Number(r.timestamp),
      status: r.status as RequestMetric['status'],
      latencyMs: Number(r.latencyMs),
      ttftMs: r.ttftMs != null ? Number(r.ttftMs) : undefined,
      cacheHit: Boolean(r.cacheHit),
      promptTokens: Number(r.promptTokens),
      cachedTokens: Number(r.cachedTokens),
      outputTokens: Number(r.outputTokens),
    }))
  }

  async countRequests(filter?: RequestMetricFilter): Promise<number> {
    this.assertNotClosed()
    if (!this.db) return 0

    let query = 'SELECT COUNT(*) as count FROM request_metrics WHERE 1=1'
    const params: any[] = []

    if (filter?.sessionId) {
      query += ' AND sessionId = ?'
      params.push(filter.sessionId)
    }
    if (filter?.accountId) {
      query += ' AND accountId = ?'
      params.push(filter.accountId)
    }
    if (filter?.status) {
      query += ' AND status = ?'
      params.push(filter.status)
    }
    if (filter?.since !== undefined) {
      query += ' AND timestamp >= ?'
      params.push(filter.since)
    }
    if (filter?.until !== undefined) {
      query += ' AND timestamp <= ?'
      params.push(filter.until)
    }

    const stmt = this.db.prepare(query)
    const row = stmt.get(...params) as any
    return Number(row?.count ?? 0)
  }

  async querySessions(filter?: SessionMetricFilter): Promise<SessionMetric[]> {
    this.assertNotClosed()
    if (!this.db) return []

    let query = 'SELECT * FROM session_metrics WHERE 1=1'
    const params: any[] = []

    if (filter?.accountId) {
      query += ' AND accountId = ?'
      params.push(filter.accountId)
    }
    query += ' ORDER BY updatedAt DESC'
    if (filter?.limit !== undefined && filter.limit >= 0) {
      query += ' LIMIT ?'
      params.push(filter.limit)
    }

    const stmt = this.db.prepare(query)
    const rows = stmt.all(...params) as any[]
    return rows.map((r) => ({
      sessionId: String(r.sessionId),
      accountId: String(r.accountId),
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
      totalRequests: Number(r.totalRequests),
      totalSuccess: Number(r.totalSuccess),
      totalFailed: Number(r.totalFailed),
      totalPromptTokens: Number(r.totalPromptTokens),
      totalCachedTokens: Number(r.totalCachedTokens),
      cacheHitRate: Number(r.cacheHitRate),
    }))
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
    if (!this.db) return emptyResult

    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) as totalRequests,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as totalSuccess,
          SUM(CASE WHEN status = 'abort' THEN 1 ELSE 0 END) as totalAbort,
          SUM(CASE WHEN status != 'success' AND status != 'abort' THEN 1 ELSE 0 END) as totalFailed,
          SUM(promptTokens) as totalPromptTokens,
          SUM(cachedTokens) as totalCachedTokens,
          SUM(outputTokens) as totalOutputTokens,
          AVG(latencyMs) as avgLatencyMs,
          AVG(CASE WHEN ttftMs IS NOT NULL THEN ttftMs ELSE NULL END) as avgTtftMs
        FROM request_metrics`,
      )
      .get() as any

    const totalRequests = Number(row?.totalRequests ?? 0)
    if (totalRequests === 0) {
      return emptyResult
    }

    const totalSuccess = Number(row?.totalSuccess ?? 0)
    const totalAbort = Number(row?.totalAbort ?? 0)
    const totalFailed = Number(row?.totalFailed ?? 0)
    const totalPromptTokens = Number(row?.totalPromptTokens ?? 0)
    const totalCachedTokens = Number(row?.totalCachedTokens ?? 0)
    const totalOutputTokens = Number(row?.totalOutputTokens ?? 0)
    const avgLatencyMs = Math.round(Number(row?.avgLatencyMs ?? 0))
    const avgTtftMs = Math.round(Number(row?.avgTtftMs ?? 0))
    const cacheHitRate =
      totalPromptTokens > 0 ? Number((totalCachedTokens / totalPromptTokens).toFixed(4)) : 0

    let p50LatencyMs = 0
    let p90LatencyMs = 0
    const off50 = Math.floor(totalRequests * 0.5)
    const off90 = Math.floor(totalRequests * 0.9)
    const p50Row = this.db
      .prepare('SELECT latencyMs FROM request_metrics ORDER BY latencyMs ASC LIMIT 1 OFFSET ?')
      .get(off50) as any
    if (p50Row) p50LatencyMs = Number(p50Row.latencyMs ?? 0)

    const p90Row = this.db
      .prepare('SELECT latencyMs FROM request_metrics ORDER BY latencyMs ASC LIMIT 1 OFFSET ?')
      .get(off90) as any
    if (p90Row) p90LatencyMs = Number(p90Row.latencyMs ?? 0)

    const accountRows = this.db
      .prepare(
        `SELECT
          accountId,
          COUNT(*) as totalRequests,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successRequests,
          SUM(CASE WHEN status != 'success' AND status != 'abort' THEN 1 ELSE 0 END) as failedRequests,
          SUM(promptTokens) as promptTokens,
          SUM(cachedTokens) as cachedTokens,
          SUM(outputTokens) as outputTokens,
          AVG(latencyMs) as avgLatencyMs
        FROM request_metrics
        GROUP BY accountId`,
      )
      .all() as any[]

    const accounts: StatsOverviewAccount[] = accountRows.map((r) => {
      const pTok = Number(r.promptTokens ?? 0)
      const cTok = Number(r.cachedTokens ?? 0)
      return {
        accountId: String(r.accountId),
        totalRequests: Number(r.totalRequests ?? 0),
        successRequests: Number(r.successRequests ?? 0),
        failedRequests: Number(r.failedRequests ?? 0),
        promptTokens: pTok,
        cachedTokens: cTok,
        outputTokens: Number(r.outputTokens ?? 0),
        cacheHitRate: pTok > 0 ? Number((cTok / pTok).toFixed(4)) : 0,
        avgLatencyMs: Math.round(Number(r.avgLatencyMs ?? 0)),
      }
    })

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
    if (!this.db) return []

    const rows = this.db
      .prepare(
        `SELECT
          accountId,
          COUNT(*) as totalRequests,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successRequests,
          SUM(CASE WHEN status != 'success' AND status != 'abort' THEN 1 ELSE 0 END) as failedRequests,
          SUM(promptTokens) as promptTokens,
          SUM(cachedTokens) as cachedTokens,
          SUM(outputTokens) as outputTokens,
          SUM(latencyMs) as totalLatencyMs,
          MAX(timestamp) as lastUsed
        FROM request_metrics
        GROUP BY accountId`,
      )
      .all() as any[]

    return rows.map((r) => ({
      accountId: String(r.accountId),
      totalRequests: Number(r.totalRequests ?? 0),
      successRequests: Number(r.successRequests ?? 0),
      failedRequests: Number(r.failedRequests ?? 0),
      promptTokens: Number(r.promptTokens ?? 0),
      cachedTokens: Number(r.cachedTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      totalLatencyMs: Number(r.totalLatencyMs ?? 0),
      lastUsed: r.lastUsed != null ? Number(r.lastUsed) : null,
    }))
  }

  async getAggregatedMetrics(
    intervalMs: number,
    since?: number,
    until?: number,
    limit = 1000,
  ): Promise<AggregatedBucketMetric[]> {
    this.assertNotClosed()
    if (!this.db) return []

    const safeInterval = Math.max(1000, intervalMs)
    let query = `SELECT
      CAST(timestamp / ? AS INTEGER) * ? as bucket,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
      SUM(CASE WHEN status != 'success' AND status != 'abort' THEN 1 ELSE 0 END) as failedCount,
      SUM(promptTokens) as promptTokens,
      SUM(cachedTokens) as cachedTokens,
      SUM(outputTokens) as outputTokens,
      SUM(latencyMs) as totalLatencyMs,
      SUM(CASE WHEN ttftMs IS NOT NULL THEN ttftMs ELSE 0 END) as totalTtftMs,
      COUNT(ttftMs) as ttftCount
    FROM request_metrics
    WHERE 1=1`

    const params: any[] = [safeInterval, safeInterval]
    if (since !== undefined) {
      query += ' AND timestamp >= ?'
      params.push(since)
    }
    if (until !== undefined) {
      query += ' AND timestamp <= ?'
      params.push(until)
    }

    query += ' GROUP BY bucket ORDER BY bucket ASC LIMIT ?'
    params.push(Math.max(1, limit))

    const rows = this.db.prepare(query).all(...params) as any[]
    return rows.map((r) => ({
      bucket: Number(r.bucket),
      requests: Number(r.requests ?? 0),
      successCount: Number(r.successCount ?? 0),
      failedCount: Number(r.failedCount ?? 0),
      promptTokens: Number(r.promptTokens ?? 0),
      cachedTokens: Number(r.cachedTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      totalLatencyMs: Number(r.totalLatencyMs ?? 0),
      totalTtftMs: Number(r.totalTtftMs ?? 0),
      ttftCount: Number(r.ttftCount ?? 0),
    }))
  }

  private assertNotClosed(): void {
    if (this.isClosed || !this.db) {
      throw new Error('SqliteStatsStorage has already been closed')
    }
  }
}
