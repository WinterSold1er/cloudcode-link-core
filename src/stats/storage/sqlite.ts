import { createRequire } from 'node:module'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type {
  IStatsStorage,
  RequestMetric,
  RequestMetricFilter,
  SessionMetric,
  SessionMetricDelta,
  SessionMetricFilter,
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
        cacheHit INTEGER NOT NULL,
        promptTokens INTEGER NOT NULL,
        cachedTokens INTEGER NOT NULL,
        outputTokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON request_metrics(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_requests_session ON request_metrics(sessionId);
      CREATE INDEX IF NOT EXISTS idx_requests_account ON request_metrics(accountId);

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

    this.insertRequestStmt = this.db.prepare(`
      INSERT OR REPLACE INTO request_metrics (
        requestId, sessionId, accountId, model, timestamp, status,
        latencyMs, cacheHit, promptTokens, cachedTokens, outputTokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    query += ' ORDER BY timestamp DESC'
    if (filter?.limit !== undefined && filter.limit >= 0) {
      query += ' LIMIT ?'
      params.push(filter.limit)
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
      cacheHit: Boolean(r.cacheHit),
      promptTokens: Number(r.promptTokens),
      cachedTokens: Number(r.cachedTokens),
      outputTokens: Number(r.outputTokens),
    }))
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

  private assertNotClosed(): void {
    if (this.isClosed || !this.db) {
      throw new Error('SqliteStatsStorage has already been closed')
    }
  }
}
