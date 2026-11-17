// QuotaService: fetch and refresh live quota statistics and user profile
// directly from Google Cloud Code / Antigravity backend (v1internal:fetchAvailableModels).
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  modelFamilyOf,
  shouldPollAccount,
  type DiscoveredModelEntry,
  type DiscoveredModelsResponse,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
  type ModelQuotaInfo,
} from './types/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { AGY_ENDPOINTS, OAUTH_USERINFO_URL, refreshTokens } from './oauth.ts'
import { agyFetch } from './net.ts'

export function mergeFallbackFamilyQuota(
  prev: FamilyQuotaInfo | undefined,
  fallback: FamilyQuotaInfo,
): FamilyQuotaInfo {
  if (!prev) return fallback
  return {
    ...prev,
    remainingFraction: fallback.remainingFraction ?? prev.remainingFraction,
    resetTime: fallback.resetTime ?? prev.resetTime,
    updatedAt: fallback.updatedAt ?? Date.now(),
  }
}

export function detectEmailFromAgyLogs(homeDir: string): string | undefined {
  const logDir = join(homeDir, '.gemini', 'antigravity-cli', 'log')
  if (!existsSync(logDir)) return undefined
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.startsWith('cli-') && f.endsWith('.log'))
      .map((f) => ({ name: f, time: statSync(join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(0, 5)

    for (const file of files) {
      try {
        const content = readFileSync(join(logDir, file.name), 'utf8')
        const re = /(?:authenticated successfully as|applyAuthResult:\s*email=|"email"\s*:\s*"|User:\s*)\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi
        let last: string | undefined
        for (let m = re.exec(content); m !== null; m = re.exec(content)) {
          if (m[1]) last = m[1]
        }
        if (last) return last
      } catch {
        // ignore unreadable log
      }
    }
  } catch {
    // ignore
  }
  return undefined
}


export function resolveClientPlatform(): { osType: string; arch: string } {
  const osType = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch
  return { osType, arch }
}

export function buildAgyCliUserAgent(version = '1.3.5'): string {
  const { osType, arch } = resolveClientPlatform()
  return `antigravity/cli/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=998863838; auth_method=consumer)`
}

export const AGY_DISCOVERY_USER_AGENT = buildAgyCliUserAgent('1.3.5')
export const AGY_QUOTA_USER_AGENT = 'antigravity/1.1.15 linux/amd64'

export function agyUserAgent(version = '1.3.5'): string {
  return buildAgyCliUserAgent(version)
}

export function agyQuotaUserAgent(): string {
  return AGY_QUOTA_USER_AGENT
}

export interface StoredToken {
  accessToken?: string
  refreshToken?: string
  expiryMs?: number
}

function parseExpiryMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e11 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

function stringField(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

export function normalizeStoredToken(raw: Record<string, unknown>): StoredToken | null {
  const nested = raw.token
  const source: Record<string, unknown> =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : raw
  const accessToken = stringField(source, 'access_token', 'accessToken')
  const refreshToken =
    stringField(source, 'refresh_token', 'refreshToken') ??
    (source === raw ? undefined : stringField(raw, 'refresh_token', 'refreshToken'))
  const expiryMs =
    parseExpiryMs(source.expiry) ??
    parseExpiryMs(source.expiresAt) ??
    parseExpiryMs(source.expires_in ? Date.now() / 1000 + Number(source.expires_in) : undefined) ??
    parseExpiryMs(raw.expiry)
  if (!accessToken && !refreshToken) return null
  return { accessToken: accessToken ?? '', refreshToken, expiryMs }
}

function mergeAgentModelSorts(
  target: DiscoveredModelsResponse['agentModelSorts'] | undefined,
  incoming: DiscoveredModelsResponse['agentModelSorts'] | undefined,
): DiscoveredModelsResponse['agentModelSorts'] | undefined {
  if (!incoming || !Array.isArray(incoming) || incoming.length === 0) return target
  if (!target || !Array.isArray(target) || target.length === 0) {
    return incoming.map((s) => ({
      ...s,
      groups: s.groups?.map((g) => ({ ...g, modelIds: g.modelIds ? [...g.modelIds] : undefined })),
      modelIds: s.modelIds ? [...s.modelIds] : undefined,
    }))
  }

  for (const incSort of incoming) {
    const matchedSort = target.find((t) => t.displayName === incSort.displayName)
    if (!matchedSort) {
      target.push({
        ...incSort,
        groups: incSort.groups?.map((g) => ({ ...g, modelIds: g.modelIds ? [...g.modelIds] : undefined })),
        modelIds: incSort.modelIds ? [...incSort.modelIds] : undefined,
      })
      continue
    }

    if (Array.isArray(incSort.groups)) {
      matchedSort.groups = matchedSort.groups || []
      for (const incGroup of incSort.groups) {
        const matchedGroup = matchedSort.groups.find((g) => g.displayName === incGroup.displayName)
        if (!matchedGroup) {
          matchedSort.groups.push({
            ...incGroup,
            modelIds: incGroup.modelIds ? [...incGroup.modelIds] : undefined,
          })
          continue
        }
        if (Array.isArray(incGroup.modelIds)) {
          const incIds = incGroup.modelIds
          const curIds = matchedGroup.modelIds || []
          if (incIds.length > curIds.length) {
            const seen = new Set(incIds)
            const mergedIds = [...incIds]
            for (const mid of curIds) {
              if (!seen.has(mid)) {
                seen.add(mid)
                mergedIds.push(mid)
              }
            }
            matchedGroup.modelIds = mergedIds
          } else {
            const seen = new Set(curIds)
            matchedGroup.modelIds = [...curIds]
            for (const mid of incIds) {
              if (!seen.has(mid)) {
                seen.add(mid)
                matchedGroup.modelIds.push(mid)
              }
            }
          }
        }
      }
    }

    if (Array.isArray(incSort.modelIds)) {
      const incIds = incSort.modelIds
      const curIds = matchedSort.modelIds || []
      if (incIds.length > curIds.length) {
        const seen = new Set(incIds)
        const mergedIds = [...incIds]
        for (const mid of curIds) {
          if (!seen.has(mid)) {
            seen.add(mid)
            mergedIds.push(mid)
          }
        }
        matchedSort.modelIds = mergedIds
      } else {
        const seen = new Set(curIds)
        matchedSort.modelIds = [...curIds]
        for (const mid of incIds) {
          if (!seen.has(mid)) {
            seen.add(mid)
            matchedSort.modelIds.push(mid)
          }
        }
      }
    }
  }

  return target
}

// Cross-account model discovery budgets. Upstream single-account single-endpoint
// fetches measure 6.5-9.2s, and ModelCatalog aborts a refresh after 30s, so the
// whole merge must stay well inside that ceiling.
const DISCOVER_MAX_CONCURRENCY = 4
const DISCOVER_ACCOUNT_TIMEOUT_MS = 8_000
const DISCOVER_TOTAL_BUDGET_MS = 20_000

/** Resolve to `value` or `null` once `ms` elapses; the underlying promise keeps running. */
function raceTimeout<T>(value: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([value, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

interface QuotaSummaryBucket {
  bucketId?: string
  displayName?: string
  window?: string
  resetTime?: string
  description?: string
  remainingFraction?: number
}

interface QuotaSummaryGroup {
  displayName?: string
  description?: string
  buckets?: QuotaSummaryBucket[]
}

interface QuotaSummaryResponse {
  groups?: QuotaSummaryGroup[]
  description?: string
}

export function readMacKeychainToken(): StoredToken | null {
  if (process.platform !== 'darwin') return null
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!raw) return null
    let jsonStr = raw
    if (raw.startsWith('go-keyring-base64:')) {
      const b64 = raw.slice('go-keyring-base64:'.length)
      jsonStr = Buffer.from(b64, 'base64').toString('utf8')
    }
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>
    return normalizeStoredToken(parsed)
  } catch {
    return null
  }
}

export class QuotaService {
  private preferredEndpointIndex = 0
  private readonly pool: AccountPoolManager
  private readonly refreshLocks = new Map<string, Promise<string | null>>()
  public lastEndpointErrors: string[] = []
  public lastQuotaEndpointErrors: string[] = []
  public lastDiscoveryDiagnostics?: {
    at: number
    succeeded: number
    failures: number
    skippedOverBudget: number
    accountFailures: Array<{ accountId: string; error: string }>
    endpointErrors?: string[]
  }

  constructor(pool: AccountPoolManager) {
    this.pool = pool
  }

  private getTokenFilePath(account: ManagedAccount): string {
    const home = account.systemHome || !account.dir ? homedir() : account.dir
    return join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  }

  protected doRefreshToken(refreshToken: string, proxyUrl?: string): Promise<{ access_token: string; expiryMs?: number } | null> {
    return refreshTokens(refreshToken, proxyUrl)
  }

  protected readSystemKeychainToken(): StoredToken | null {
    return readMacKeychainToken()
  }

  getStoredToken(account: ManagedAccount): StoredToken | null {
    const disk = (() => {
      const file = this.getTokenFilePath(account)
      if (!existsSync(file)) return null
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        const tok = normalizeStoredToken(raw)
        if (tok && (tok.accessToken || tok.refreshToken)) return tok
      } catch {
        // corrupted disk file
      }
      return null
    })()

    if (account.systemHome || !account.dir) {
      const keychainToken = this.readSystemKeychainToken()
      if (keychainToken && (keychainToken.accessToken || keychainToken.refreshToken)) {
        return keychainToken
      }
    }

    return disk
  }

  private persistRefreshedToken(account: ManagedAccount, tokens: { access_token: string; expiryMs?: number }): void {
    this.pool.setMemoryToken(account.id, tokens.access_token, tokens.expiryMs)
    const file = this.getTokenFilePath(account)
    try {
      const dir = dirname(file)
      const geminiDir = dirname(dir)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try {
        chmodSync(geminiDir, 0o700)
        chmodSync(dir, 0o700)
      } catch {}
      let raw: Record<string, unknown> = {}
      if (existsSync(file)) {
        try {
          raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        } catch {
          raw = {}
        }
      }
      const expiryIso = tokens.expiryMs ? new Date(tokens.expiryMs).toISOString() : undefined
      if (raw && typeof raw.token === 'object' && raw.token !== null) {
        const nested = raw.token as Record<string, unknown>
        nested.access_token = tokens.access_token
        if (expiryIso) nested.expiry = expiryIso
      } else {
        raw.access_token = tokens.access_token
        if (tokens.expiryMs) raw.expiry = tokens.expiryMs
      }
      writeFileSync(file, JSON.stringify(raw), { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(file, 0o600)
      } catch {}
    } catch {
      // Best-effort
    }
  }

  async getValidAccessToken(account: ManagedAccount): Promise<string | null> {
    if (process.env.ANTIGRAVITY_TOKEN?.trim()) {
      return process.env.ANTIGRAVITY_TOKEN.trim()
    }

    const mem = this.pool.getMemoryToken(account.id)
    if (mem) return mem

    const tok = this.getStoredToken(account)
    if (!tok) return null

    if (tok.accessToken && (!tok.expiryMs || tok.expiryMs > Date.now() + 60_000)) {
      this.pool.setMemoryToken(account.id, tok.accessToken, tok.expiryMs)
      if (account.authRequired) {
        this.pool.clearAuthRequired(account.id)
      }
      return tok.accessToken
    }

    if (tok.refreshToken) {
      const existing = this.refreshLocks.get(account.id)
      if (existing) {
        return existing
      }

      const refreshPromise = (async () => {
        try {
          const refreshed = await this.doRefreshToken(tok.refreshToken!, account.proxyUrl)
          if (refreshed?.access_token) {
            this.persistRefreshedToken(account, {
              access_token: refreshed.access_token,
              expiryMs: refreshed.expiryMs,
            })
            if (account.authRequired) {
              this.pool.clearAuthRequired(account.id)
            }
            return refreshed.access_token
          }
        } catch (err: unknown) {
          const errMsg = String(err)
          if (/invalid_grant|revoked|disabled|unauthorized_client|token endpoint 400/i.test(errMsg)) {
            this.pool.markAuthRequired(account.id, errMsg)
          }
        }
        return tok.accessToken || null
      })().finally(() => {
        this.refreshLocks.delete(account.id)
      })

      this.refreshLocks.set(account.id, refreshPromise)
      return refreshPromise
    }

    return tok.accessToken || null
  }

  async fetchUserInfo(accessToken: string, proxyUrl?: string): Promise<{ email?: string; name?: string } | null> {
    try {
      const res = await agyFetch(OAUTH_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, proxyUrl)
      if (res.ok) {
        return (await res.json()) as { email?: string; name?: string }
      }
    } catch {
      // Ignore userinfo fetch errors
    }
    return null
  }

  private getOrderedEndpoints(): string[] {
    const total = AGY_ENDPOINTS.length
    const ordered: string[] = []
    for (let i = 0; i < total; i++) {
      ordered.push(AGY_ENDPOINTS[(this.preferredEndpointIndex + i) % total]!)
    }
    return ordered
  }

  async fetchQuotaSummary(accessToken: string, proxyUrl?: string): Promise<QuotaSummaryResponse | null> {
    const endpoints = this.getOrderedEndpoints()
    const endpointErrors: string[] = []
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i]!
      try {
        const res = await agyFetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': agyQuotaUserAgent(),
          },
          body: JSON.stringify({}),
        }, proxyUrl)
        if (res.ok) {
          this.preferredEndpointIndex = AGY_ENDPOINTS.indexOf(endpoint)
          this.lastQuotaEndpointErrors = endpointErrors
          return (await res.json()) as QuotaSummaryResponse
        }
        endpointErrors.push(`${endpoint} returned ${res.status}`)
        if (res.status === 401 || res.status === 403) {
          continue
        }
      } catch (err) {
        endpointErrors.push(`${endpoint} error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.lastQuotaEndpointErrors = endpointErrors
    return null
  }

  async fetchAvailableModels(accessToken: string, proxyUrl?: string): Promise<DiscoveredModelsResponse | null> {
    const endpoints = this.getOrderedEndpoints()
    const endpointErrors: string[] = []
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i]!
      try {
        const res = await agyFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': agyUserAgent(),
          },
          body: JSON.stringify({}),
        }, proxyUrl)
        if (res.ok) {
          this.preferredEndpointIndex = AGY_ENDPOINTS.indexOf(endpoint)
          this.lastEndpointErrors = endpointErrors
          return (await res.json()) as DiscoveredModelsResponse
        }
        endpointErrors.push(`${endpoint} returned ${res.status}`)
        if (res.status === 401 || res.status === 403) {
          continue
        }
      } catch (err) {
        endpointErrors.push(`${endpoint} error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.lastEndpointErrors = endpointErrors
    return null
  }

  /**
   * Discover the models this installation can actually serve.
   *
   * Upstream answers per account: an id can be missing from the primary account's
   * `fetchAvailableModels` payload yet present in a pooled secondary account. So the
   * whole usable pool is fetched and the `models` maps are unioned by model id —
   * same id in several accounts keeps the entry that carries `quotaInfo`, otherwise
   * the first one seen (primary account first). A single failing account never fails
   * the discovery; only an all-failed pool returns null (which makes ModelCatalog
   * keep its previous catalog and record `lastError`).
   *
   * Budget: at most `concurrency` accounts in flight, `accountTimeoutMs` per account,
   * and `totalBudgetMs` overall — accounts started after the budget is exhausted are
   * skipped rather than delaying the merge.
   */
  async discoverAvailableModels(options?: {
    concurrency?: number
    accountTimeoutMs?: number
    totalBudgetMs?: number
  }): Promise<DiscoveredModelsResponse | null> {
    if (process.env.ANTIGRAVITY_TOKEN?.trim()) {
      return this.fetchAvailableModels(process.env.ANTIGRAVITY_TOKEN.trim())
    }

    const poolData = this.pool.getPoolData()
    const primaryAcc = poolData.primaryAccountId ? this.pool.getAccount(poolData.primaryAccountId) : undefined
    const usable = this.pool.getAccounts().filter((a) => a.enabled && !a.authRequired)
    if (usable.length === 0) return null

    // Primary first: its entries win id collisions, and if the budget runs out the
    // primary account's models are the ones already merged.
    const ordered: ManagedAccount[] = []
    if (primaryAcc && primaryAcc.enabled && !primaryAcc.authRequired) ordered.push(primaryAcc)
    for (const acc of usable) {
      if (!ordered.some((a) => a.id === acc.id)) ordered.push(acc)
    }

    const concurrency = Math.max(1, Math.min(options?.concurrency ?? DISCOVER_MAX_CONCURRENCY, ordered.length))
    const accountTimeoutMs = options?.accountTimeoutMs ?? DISCOVER_ACCOUNT_TIMEOUT_MS
    const deadline = Date.now() + (options?.totalBudgetMs ?? DISCOVER_TOTAL_BUDGET_MS)

    const merged = new Map<string, DiscoveredModelEntry>()
    const accountSorts = new Map<string, DiscoveredModelsResponse['agentModelSorts']>()
    let succeeded = 0
    let failures = 0
    let skippedOverBudget = 0
    const failureDetails: Array<{ accountId: string; error: string }> = []

    let cursor = 0
    const fetchOne = async (acc: ManagedAccount): Promise<{ res: DiscoveredModelsResponse | null; error?: string }> => {
      const accessToken = await this.getValidAccessToken(acc)
      if (!accessToken) return { res: null, error: 'Failed to acquire valid access token' }
      try {
        const res = await this.fetchAvailableModels(accessToken, acc.proxyUrl)
        if (!res) return { res: null, error: 'fetchAvailableModels returned null from all endpoints' }
        return { res }
      } catch (err) {
        return { res: null, error: err instanceof Error ? err.message : String(err) }
      }
    }

    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        const acc = ordered[cursor++]
        if (acc === undefined) return
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          skippedOverBudget++
          failureDetails.push({ accountId: acc.id, error: 'Skipped over budget' })
          continue
        }
        try {
          const outcome = await raceTimeout(fetchOne(acc), Math.min(accountTimeoutMs, remaining))
          if (!outcome?.res) {
            failures++
            failureDetails.push({ accountId: acc.id, error: outcome?.error ?? 'Timeout or empty response' })
            continue
          }
          const res = outcome.res
          succeeded++
          if (Array.isArray(res.agentModelSorts) && res.agentModelSorts.length > 0) {
            accountSorts.set(acc.id, res.agentModelSorts)
          }
          for (const [modelId, entry] of Object.entries(res.models ?? {})) {
            const prev = merged.get(modelId)
            if (!prev) {
              merged.set(modelId, entry ?? {})
              continue
            }
            const prevHasQuota = prev.quotaInfo !== undefined
            const nextHasQuota = entry?.quotaInfo !== undefined
            if (!prevHasQuota && nextHasQuota) merged.set(modelId, entry)
          }
        } catch (err) {
          // One account must never sink the discovery: keep what the others returned.
          failures++
          failureDetails.push({ accountId: acc.id, error: err instanceof Error ? err.message : String(err) })
        }
      }
    })
    await Promise.allSettled(workers)

    if (succeeded === 0 || merged.size === 0) return null

    // Deterministically merge agentModelSorts in fixed ordered account sequence (primary first)
    let primarySorts: DiscoveredModelsResponse['agentModelSorts'] = undefined
    for (const acc of ordered) {
      const sorts = accountSorts.get(acc.id)
      if (sorts) {
        primarySorts = mergeAgentModelSorts(primarySorts, sorts)
      }
    }

    this.lastDiscoveryDiagnostics = {
      at: Date.now(),
      succeeded,
      failures,
      skippedOverBudget,
      accountFailures: failureDetails,
      endpointErrors: this.lastEndpointErrors,
    }

    return {
      models: Object.fromEntries(merged),
      ...(primarySorts ? { agentModelSorts: primarySorts } : {}),
      discoveredFromAccounts: succeeded,
      discoveredAccountFailures: failures,
      discoveredSkippedOverBudget: skippedOverBudget,
      accountFailures: failureDetails,
      endpointErrors: this.lastEndpointErrors,
    }
  }

  async refreshAccountQuota(
    account: ManagedAccount,
    force = false,
    options?: { lightweight?: boolean; summaryOnly?: boolean },
  ): Promise<Partial<Record<ModelFamily, FamilyQuotaInfo>> | null> {
    const now = Date.now()
    if (!force && account.quotas) {
      const latestUpdate = Math.max(
        ...Object.values(account.quotas).map((q) => q?.updatedAt ?? 0),
      )
      if (latestUpdate > 0 && now - latestUpdate < 10_000) {
        return account.quotas
      }
    }
    const home = account.systemHome || !account.dir ? homedir() : account.dir
    let email = account.email
    if (account.systemHome || !email) {
      const detected = detectEmailFromAgyLogs(home)
      if (detected) email = detected
    }

    const accessToken = await this.getValidAccessToken(account)
    if (!accessToken) {
      return null
    }

    const isLightweight = Boolean(options?.lightweight || options?.summaryOnly)

    if (force && !isLightweight) {
      const info = await this.fetchUserInfo(accessToken, account.proxyUrl)
      if (info?.email) email = info.email
    }

    if (email && email !== account.email) {
      this.pool.resetAccountIdentity(account.id, email)
    }

    let summary: QuotaSummaryResponse | null = null
    let discovered: DiscoveredModelsResponse | null = null

    if (options?.summaryOnly) {
      summary = await this.fetchQuotaSummary(accessToken, account.proxyUrl)
      const hasGoogleInSummary = summary?.groups?.some((g) => {
        const dName = (g.displayName || '').toLowerCase()
        const desc = (g.description || '').toLowerCase()
        return dName.includes('gemini') || desc.includes('gemini')
      })
      if (!hasGoogleInSummary) {
        discovered = await this.fetchAvailableModels(accessToken, account.proxyUrl)
      }
    } else {
      const [sum, disc] = await Promise.all([
        this.fetchQuotaSummary(accessToken, account.proxyUrl),
        this.fetchAvailableModels(accessToken, account.proxyUrl),
      ])
      summary = sum
      discovered = disc
    }

    if (!email && !isLightweight) {
      const info = await this.fetchUserInfo(accessToken, account.proxyUrl)
      if (info?.email) email = info.email
    }

    if (!summary && (!discovered || !discovered.models)) {
      return null
    }

    if (account.authRequired) {
      this.pool.clearAuthRequired(account.id)
    }

    const familyQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>> = {}
    const summaryFamilies = new Set<ModelFamily>()

    if (summary && Array.isArray(summary.groups)) {
      for (const group of summary.groups) {
        const dName = (group.displayName || '').toLowerCase()
        const desc = (group.description || '').toLowerCase()
        const isGoogle = dName.includes('gemini') || desc.includes('gemini')
        const is3P = dName.includes('claude') || dName.includes('gpt') || desc.includes('claude') || desc.includes('gpt')

        const targetFamilies: ModelFamily[] = isGoogle
          ? ['google']
          : is3P
          ? ['anthropic', 'openai']
          : []

        let fiveHourFrac: number | undefined
        let fiveHourReset: string | undefined
        let weeklyFrac: number | undefined
        let weeklyReset: string | undefined

        for (const b of group.buckets || []) {
          const w = (b.window || b.bucketId || '').toLowerCase()
          if (w.includes('5h')) {
            fiveHourFrac = b.remainingFraction
            fiveHourReset = b.resetTime
          } else if (w.includes('weekly')) {
            weeklyFrac = b.remainingFraction
            weeklyReset = b.resetTime
          }
        }

        for (const fam of targetFamilies) {
          summaryFamilies.add(fam)
          const prev = familyQuotas[fam]
          familyQuotas[fam] = {
            remainingFraction: fiveHourFrac !== undefined ? fiveHourFrac : prev?.remainingFraction,
            resetTime: fiveHourReset !== undefined ? fiveHourReset : prev?.resetTime,
            weeklyFraction: weeklyFrac !== undefined ? weeklyFrac : prev?.weeklyFraction,
            weeklyResetTime: weeklyReset !== undefined ? weeklyReset : prev?.weeklyResetTime,
            description: group.description || prev?.description,
            updatedAt: now,
          }
        }
      }
    }

    const familyModels: Partial<Record<ModelFamily, ModelQuotaInfo[]>> = {}
    if (discovered && discovered.models) {
      for (const [modelId, entry] of Object.entries(discovered.models)) {
        const fam = modelFamilyOf(modelId)
        if (fam === 'unknown') continue
        const remaining = entry.quotaInfo?.remainingFraction
        const resetTime = entry.quotaInfo?.resetTime

        if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue

        if (!familyModels[fam]) familyModels[fam] = []
        familyModels[fam]!.push({
          modelId,
          displayName: entry.displayName || modelId,
          remainingFraction: remaining,
          resetTime,
        })

        if (!familyQuotas[fam]) {
          familyQuotas[fam] = mergeFallbackFamilyQuota(account.quotas[fam], {
            remainingFraction: remaining,
            resetTime,
            updatedAt: now,
          })
        } else if (!summaryFamilies.has(fam) || familyQuotas[fam]!.remainingFraction === undefined) {
          const curRemaining = familyQuotas[fam]!.remainingFraction ?? 1
          if (remaining < curRemaining) {
            familyQuotas[fam]!.remainingFraction = remaining
            familyQuotas[fam]!.resetTime = resetTime
          } else if (remaining === curRemaining) {
            if (resetTime && (!familyQuotas[fam]!.resetTime || Date.parse(resetTime) > Date.parse(familyQuotas[fam]!.resetTime!))) {
              familyQuotas[fam]!.resetTime = resetTime
            }
          }
        }
      }
    }

    for (const [famKey, list] of Object.entries(familyModels)) {
      const fam = famKey as ModelFamily
      if (familyQuotas[fam]) {
        familyQuotas[fam]!.models = list
      }
    }

    if (options?.summaryOnly && account.quotas) {
      for (const fam of Object.keys(familyQuotas) as ModelFamily[]) {
        if (familyQuotas[fam] && !familyQuotas[fam]!.models && account.quotas[fam]?.models) {
          familyQuotas[fam]!.models = account.quotas[fam]!.models
        }
      }
    }

    this.pool.updateAccountQuotas(account.id, familyQuotas, email)
    return familyQuotas
  }

  async refreshQuotaSummaryOnly(account: ManagedAccount): Promise<Partial<Record<ModelFamily, FamilyQuotaInfo>> | null> {
    return this.refreshAccountQuota(account, true, { lightweight: true, summaryOnly: true })
  }

  async selfHealQuarantinedAccounts(): Promise<number> {
    let healed = 0
    for (const acc of this.pool.getAccounts()) {
      if (!acc.enabled || !acc.authRequired) continue
      const tok = this.getStoredToken(acc)
      if (!tok) continue
      if (!tok.refreshToken && (!tok.accessToken || (tok.expiryMs && tok.expiryMs <= Date.now() + 60_000))) {
        continue
      }
      try {
        const token = await this.getValidAccessToken(acc)
        if (token) {
          this.pool.clearAuthRequired(acc.id)
          healed++
        }
      } catch {
        // Refresh failed
      }
    }
    return healed
  }

  async refreshAllQuotas(force = false): Promise<void> {
    if (!force) {
      const now = Date.now()
      for (const acc of this.pool.getAccounts()) {
        const flagged = acc.authRequired || Object.values(acc.cooldowns).some((cd) => cd && cd.cooldownUntil > now)
        if (!acc.systemHome || !flagged) continue
        const home = acc.systemHome || !acc.dir ? homedir() : acc.dir
        const detected = detectEmailFromAgyLogs(home)
        if (detected && detected !== acc.email) {
          this.pool.resetAccountIdentity(acc.id, detected)
        }
      }
      await this.selfHealQuarantinedAccounts()
    }
    let accounts = this.pool.getAccounts()
    if (!force) {
      accounts = accounts.filter(shouldPollAccount)
    }
    await Promise.allSettled(accounts.map((acc) => this.refreshAccountQuota(acc, force)))
  }
}
