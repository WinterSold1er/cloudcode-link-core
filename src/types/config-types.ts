// Configuration and error classifications for cloudcode-link-core

export const PROVIDER_ID = 'antigravity'
export const PLUGIN_ID = 'cloudcode-link'
export const PKG_NAME = 'cloudcode-link-core'

export type ModelModality = 'text' | 'image'

export interface FallbackModelDef {
  id: string
  name: string
  /** Selectable reasoning efforts; omit for fixed-thinking models. */
  efforts?: readonly string[]
  /** Accepted input modalities (e.g. ['text', 'image']). */
  inputModalities?: readonly ModelModality[]
}

export interface CoreConfig {
  enabled?: boolean
  baseUrl?: string
  endpointCandidates?: readonly string[]
  timeoutMs?: number
  defaultModel?: string
  defaultEffort?: string
  maxConcurrent?: number
  heartbeatEnabled?: boolean
  heartbeatIntervalMs?: number
  logRetentionDays?: number
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1') return true
    if (s === 'false' || s === '0') return false
  }
  return undefined
}

function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export type PluginConfig = CoreConfig

export function resolveConfig(
  entry?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Record<string, unknown>,
): CoreConfig {
  const base = defaultConfig()
  const e = entry ?? {}
  const ovr = overrides ?? {}
  const layers: Array<Record<string, unknown>> = [e, ovr]
  const get = (k: string): unknown => {
    for (const l of layers) if (l[k] !== undefined && l[k] !== null && l[k] !== '') return l[k]
    return undefined
  }
  const cfg: CoreConfig = {
    ...base,
    enabled: asBool(get('enabled')) ?? base.enabled,
    defaultModel: typeof get('defaultModel') === 'string' ? (get('defaultModel') as string) : base.defaultModel,
    defaultEffort: typeof get('defaultEffort') === 'string' ? (get('defaultEffort') as string) : base.defaultEffort,
    timeoutMs: asNum(get('timeoutMs')) ?? base.timeoutMs,
    baseUrl: typeof get('baseUrl') === 'string' ? (get('baseUrl') as string) : base.baseUrl,
    endpointCandidates: Array.isArray(get('endpointCandidates'))
      ? (get('endpointCandidates') as string[])
      : base.endpointCandidates,
    heartbeatEnabled: asBool(get('heartbeatEnabled')) ?? base.heartbeatEnabled,
    heartbeatIntervalMs: asNum(get('heartbeatIntervalMs')) !== undefined
      ? Math.max(30_000, asNum(get('heartbeatIntervalMs'))!)
      : base.heartbeatIntervalMs,
    logRetentionDays: asNum(get('logRetentionDays')) ?? base.logRetentionDays,
  }

  const envTimeout = env.CLOUDCODE_TIMEOUT_MS ?? env.ANTIGRAVITY_TIMEOUT_MS ?? env.DSH_CLOUDCODE_TIMEOUT_MS ?? env.DSH_AGY_TIMEOUT_MS
  if (envTimeout !== undefined) {
    const n = asNum(envTimeout)
    if (n !== undefined) cfg.timeoutMs = n
  }
  const envMaxConcurrent = env.CLOUDCODE_MAX_CONCURRENT ?? env.ANTIGRAVITY_MAX_CONCURRENT ?? env.DSH_CLOUDCODE_MAX_CONCURRENT ?? env.DSH_AGY_MAX_CONCURRENT
  if (envMaxConcurrent !== undefined) {
    const n = asNum(envMaxConcurrent)
    if (n !== undefined) cfg.maxConcurrent = n
  }
  const envHeartbeat = env.CLOUDCODE_HEARTBEAT_ENABLED ?? env.ANTIGRAVITY_HEARTBEAT_ENABLED ?? env.DSH_CLOUDCODE_HEARTBEAT_ENABLED ?? env.DSH_AGY_HEARTBEAT_ENABLED
  if (envHeartbeat !== undefined) {
    const b = asBool(envHeartbeat)
    if (b !== undefined) cfg.heartbeatEnabled = b
  }
  const envHeartbeatInterval = env.CLOUDCODE_HEARTBEAT_INTERVAL_MS ?? env.ANTIGRAVITY_HEARTBEAT_INTERVAL_MS ?? env.DSH_CLOUDCODE_HEARTBEAT_INTERVAL_MS ?? env.DSH_AGY_HEARTBEAT_INTERVAL_MS
  if (envHeartbeatInterval !== undefined) {
    const n = asNum(envHeartbeatInterval)
    if (n !== undefined) cfg.heartbeatIntervalMs = Math.max(30_000, n)
  }

  return cfg
}

export function defaultConfig(): CoreConfig {
  return {
    enabled: true,
    defaultModel: '',
    defaultEffort: '',
    timeoutMs: 600_000,
    baseUrl: '',
    endpointCandidates: DEFAULT_ENDPOINT_CANDIDATES,
    heartbeatEnabled: true,
    heartbeatIntervalMs: 180_000,
    logRetentionDays: 7,
  }
}

export const DEFAULT_ENDPOINT_CANDIDATES: readonly string[] = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
]

// Full fallback line-up
export const DEFAULT_FALLBACK_MODELS: readonly FallbackModelDef[] = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], inputModalities: ['text', 'image'] },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'], inputModalities: ['text', 'image'] },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'], inputModalities: ['text', 'image'] },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', efforts: ['low', 'medium', 'high'], inputModalities: ['text', 'image'] },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', efforts: ['low', 'high'], inputModalities: ['text', 'image'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', inputModalities: ['text', 'image'] },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', inputModalities: ['text', 'image'] },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', inputModalities: ['text'] },
]

export const Err = {
  AUTH: 'AUTH',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  CONNECT_ERROR: 'CONNECT_ERROR',
  STREAM_ERROR: 'STREAM_ERROR',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
} as const

export function looksLikeAuthFailure(text?: string): boolean {
  if (!text) return false
  return /auth|unauthorized|permission denied|invalid credential|login required|token expired|please sign in/i.test(text)
}

export function looksLikeHardRateLimit(text?: string): boolean {
  if (!text) return false
  return /RESOURCE_EXHAUSTED|code[ :]?429\b|status[ :]?429\b|HTTP[ :]?429\b|too many requests|individual quota reached|quota (?:exceeded|reached|exhausted)|rate[ -]?limit(?:ed)? (?:exceeded|reached|hit)|exceeded (?:your |the )?quota/i.test(
    text,
  )
}

export function looksLikeRateLimit(text?: string): boolean {
  if (!text) return false
  return (
    looksLikeHardRateLimit(text) || /model overloaded|experiencing high traffic/i.test(text)
  )
}

export function parseResetDurationMs(text?: string): number | undefined {
  if (!text) return undefined

  // 1. Compact: "Resets in 2h26m6s", "resets in 21m25s", "resets in 45s"
  const compactMatch = text.match(/resets?\s+in\s+((?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?)/i)
  if (compactMatch && compactMatch[1]?.trim()) {
    const hours = parseInt(compactMatch[2] || '0', 10)
    const minutes = parseInt(compactMatch[3] || '0', 10)
    const seconds = parseInt(compactMatch[4] || '0', 10)
    const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000
    if (totalMs > 0) return totalMs
  }

  // 2. Word-based: "Resets in 15 minutes", "resets in 2 hours", "retry after 30 seconds"
  const wordMatch = text.match(/(?:resets?|retry)\s+(?:in|after)\s+(\d+)\s*(hour|hr|minute|min|second|sec)s?/i)
  if (wordMatch) {
    const num = parseInt(wordMatch[1]!, 10)
    const unit = wordMatch[2]!.toLowerCase()
    if (unit.startsWith('h')) return num * 3600 * 1000
    if (unit.startsWith('m')) return num * 60 * 1000
    if (unit.startsWith('s')) return num * 1000
  }

  // 3. ISO timestamp or future date string
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/)
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0])
    if (!Number.isNaN(parsed) && parsed > Date.now()) {
      return parsed - Date.now()
    }
  }

  const retrySec = parseInt(text.trim(), 10)
  if (!Number.isNaN(retrySec) && retrySec > 0 && retrySec < 86400 * 7) {
    return retrySec * 1000
  }

  return undefined
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  const totalSecs = Math.ceil(ms / 1000)
  const days = Math.floor(totalSecs / 86400)
  const hours = Math.floor((totalSecs % 86400) / 3600)
  const mins = Math.floor((totalSecs % 3600) / 60)
  const secs = totalSecs % 60

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  if (mins > 0) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  return `${secs}s`
}
