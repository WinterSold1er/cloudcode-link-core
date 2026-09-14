export type RequestMetricStatus = 'success' | 'error' | 'abort'

export interface RequestMetric {
  requestId: string
  sessionId: string | null
  accountId: string
  model: string
  timestamp: number
  status: RequestMetricStatus
  latencyMs: number
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
  limit?: number
}

export interface SessionMetricFilter {
  accountId?: string
  limit?: number
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
}
