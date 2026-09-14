import type {
  CleanupResult,
  IStatsStorage,
  OnCleanupCallback,
  OnErrorCallback,
} from './types.ts'

export interface StatsRetentionCleanerOptions {
  storage: IStatsStorage
  retentionDays: number
  cleanupIntervalMs: number
  onCleanup?: OnCleanupCallback
  onError?: OnErrorCallback
}

export class StatsRetentionCleaner {
  public static readonly MILLISECONDS_PER_DAY = 86_400_000

  private readonly storage: IStatsStorage
  private readonly retentionDays: number
  private readonly cleanupIntervalMs: number
  private readonly onCleanup?: OnCleanupCallback
  private readonly onError?: OnErrorCallback

  private timer: NodeJS.Timeout | null = null
  private activeCleanupPromise: Promise<CleanupResult> | null = null
  private isClosed = false

  constructor(options: StatsRetentionCleanerOptions) {
    if (options.retentionDays <= 0 || !Number.isFinite(options.retentionDays)) {
      throw new Error(`Invalid retentionDays: ${options.retentionDays}. Must be a positive finite number.`)
    }
    if (options.cleanupIntervalMs <= 0 || !Number.isFinite(options.cleanupIntervalMs)) {
      throw new Error(`Invalid cleanupIntervalMs: ${options.cleanupIntervalMs}. Must be a positive finite integer.`)
    }

    this.storage = options.storage
    this.retentionDays = options.retentionDays
    this.cleanupIntervalMs = Math.floor(options.cleanupIntervalMs)
    this.onCleanup = options.onCleanup
    this.onError = options.onError
  }

  start(): void {
    if (this.timer !== null || this.isClosed) {
      return
    }

    this.timer = setInterval(() => {
      void this.cleanup().catch((error) => {
        this.safeReportError(error, 'interval-cleanup')
      })
    }, this.cleanupIntervalMs)

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

  async cleanup(referenceNow?: number): Promise<CleanupResult> {
    if (this.activeCleanupPromise) {
      return await this.activeCleanupPromise
    }

    const cleanupExecution = (async (): Promise<CleanupResult> => {
      try {
        const now = referenceNow ?? Date.now()
        const cutoffTime = now - this.retentionDays * StatsRetentionCleaner.MILLISECONDS_PER_DAY

        const deletedRequests = await this.storage.deleteRequestsBefore(cutoffTime)
        const deletedSessions = await this.storage.deleteSessionsBefore(cutoffTime)

        const result: CleanupResult = {
          cutoffTime,
          deletedRequests,
          deletedSessions,
        }

        if (this.onCleanup) {
          try {
            this.onCleanup(result)
          } catch (callbackError) {
            this.safeReportError(callbackError, 'onCleanup-handler')
          }
        }

        return result
      } catch (error) {
        this.safeReportError(error, 'cleanup-execution')
        throw error
      } finally {
        this.activeCleanupPromise = null
      }
    })()

    this.activeCleanupPromise = cleanupExecution
    return await cleanupExecution
  }

  async close(): Promise<void> {
    this.isClosed = true
    this.stop()
    if (this.activeCleanupPromise) {
      try {
        await this.activeCleanupPromise
      } catch {
        // Suppress during graceful shutdown
      }
    }
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
