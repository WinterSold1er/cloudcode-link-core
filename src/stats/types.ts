export type RequestMetricStatus = 'success' | 'error' | 'abort'

export interface RequestMetric {
  requestId: string
  sessionId: string | null
  accountId: string
  model: string
  timestamp: number
  status: RequestMetricStatus
  latencyMs: number
  ttftMs?: number
  cacheHit: boolean
  promptTokens: number
  cachedTokens: number
  outputTokens: number
}

export interface SessionMetric {
  sessionId: string
  accountId: string
  createdAt: number
  updatedAt: number
  totalRequests: number
  totalSuccess: number
  totalFailed: number
  totalPromptTokens: number
  totalCachedTokens: number
  cacheHitRate: number
}

export interface SessionMetricDelta {
  sessionId: string
  accountId: string
  createdAt: number
  updatedAt: number
  requestCount: number
  successCount: number
  failedCount: number
  promptTokens: number
  cachedTokens: number
  outputTokens: number
}

export interface RecordRequestInput {
  requestId: string
  sessionId?: string | null
  accountId: string
  model: string
  timestamp?: number
  status: RequestMetricStatus
  latencyMs: number
  ttftMs?: number
  promptTokens: number
  cachedTokens: number
  outputTokens: number
}

export interface StatsConfig {
  retentionDays: number
  dbPath: string
  flushIntervalMs: number
  maxQueueSize: number
  maxSessionQueueSize?: number
  batchSize?: number
  cleanupIntervalMs: number
}

export interface CleanupResult {
  cutoffTime: number
  deletedRequests: number
  deletedSessions: number
}

export type OnDropCallback = (
  droppedRequests: RequestMetric[],
  queueSize: number,
  droppedSessions?: SessionMetricDelta[],
) => void

export type OnErrorCallback = (error: unknown, context: string) => void
export type OnCleanupCallback = (result: CleanupResult) => void

export interface StatsCollectorOptions {
  onDrop?: OnDropCallback
  onError?: OnErrorCallback
  onCleanup?: OnCleanupCallback
}

export interface RequestMetricFilter {
  sessionId?: string
  accountId?: string
  status?: RequestMetricStatus
  limit?: number
  offset?: number
  since?: number
  until?: number
}

export interface SessionMetricFilter {
  accountId?: string
  limit?: number
  offset?: number
}

export interface StatsOverviewAccount {
  accountId: string
  totalRequests: number
  successRequests: number
  failedRequests: number
  promptTokens: number
  cachedTokens: number
  outputTokens: number
  cacheHitRate: number
  avgLatencyMs: number
}

export interface StatsOverview {
  totalRequests: number
  totalSuccess: number
  totalFailed: number
  totalAbort: number
  totalTokens: number
  totalPromptTokens: number
  totalCachedTokens: number
  totalOutputTokens: number
  cacheHitRate: number
  avgLatencyMs: number
  avgTtftMs: number
  p50LatencyMs: number
  p90LatencyMs: number
}

export interface OverviewMetricsResult {
  overview: StatsOverview
  accounts: StatsOverviewAccount[]
}

export interface AccountUsageMetric {
  accountId: string
  totalRequests: number
  successRequests: number
  failedRequests: number
  promptTokens: number
  cachedTokens: number
  outputTokens: number
  totalLatencyMs: number
  lastUsed: number | null
}

export interface AggregatedBucketMetric {
  bucket: number
  requests: number
  successCount: number
  failedCount: number
  promptTokens: number
  cachedTokens: number
  outputTokens: number
  totalLatencyMs: number
  totalTtftMs: number
  ttftCount: number
}

export function maskEmail(email?: string): string {
  if (!email || typeof email !== 'string') return ''
  const atIdx = email.indexOf('@')
  if (atIdx <= 0) return email
  const user = email.slice(0, atIdx)
  const domain = email.slice(atIdx)
  if (user.length <= 2) {
    return `${user[0]}***${domain}`
  }
  return `${user.slice(0, 2)}***${domain}`
}

export interface IStatsStorage {
  init(): Promise<void>
  close(): Promise<void>
  saveRequestMetrics(metrics: readonly RequestMetric[]): Promise<void>
  upsertSessionMetrics?(metrics: readonly SessionMetric[]): Promise<void>
  upsertSessionDeltas?(deltas: readonly SessionMetricDelta[]): Promise<void>
  getSessionMetric(sessionId: string): Promise<SessionMetric | null>
  deleteRequestsBefore(cutoffTime: number): Promise<number>
  deleteSessionsBefore(cutoffTime: number): Promise<number>
  queryRequests?(filter?: RequestMetricFilter): Promise<RequestMetric[]>
  querySessions?(filter?: SessionMetricFilter): Promise<SessionMetric[]>
  countRequests?(filter?: RequestMetricFilter): Promise<number>
  getOverviewMetrics?(): Promise<OverviewMetricsResult>
  getAccountUsage?(): Promise<AccountUsageMetric[]>
  getAggregatedMetrics?(
    intervalMs: number,
    since?: number,
    until?: number,
    limit?: number,
  ): Promise<AggregatedBucketMetric[]>
}
