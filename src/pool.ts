// AccountPoolManager: multi-profile credential isolation, family-scoped cooldown,
// and sticky sequential drain scheduling for Google Cloud Code / Antigravity accounts.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  defaultPoolData,
  modelFamilyOf,
  type AccountPoolData,
  type FamilyCooldownState,
  type FamilyQuotaInfo,
  type FamilyStatus,
  type ManagedAccount,
  type ModelFamily,
} from './types/pool-types.ts'
import { parseResetDurationMs } from './types/config-types.ts'
import { isGemini4Model } from './models.ts'

export function defaultPoolDir(customBase?: string): string {
  if (customBase) return customBase
  if (process.env.CLOUDCODE_ACCOUNTS_DIR?.trim()) return process.env.CLOUDCODE_ACCOUNTS_DIR.trim()
  if (process.env.ANTIGRAVITY_ACCOUNTS_DIR?.trim()) return process.env.ANTIGRAVITY_ACCOUNTS_DIR.trim()
  return join(homedir(), '.cloudcode', 'accounts')
}

/**
 * Effort / routing modifiers the backend appends to a wire model id
 * (`gemini-4-hydrogen-high`, `gemini-4-hydrogen-tiered-high`, `gemini-2.5-flash-thinking`).
 * They are stripped from the tail so a requested wire id can be compared with the model ids an
 * account is actually entitled to: an account that serves `gemini-4-hydrogen-medium` can serve a
 * `gemini-4-hydrogen-high` request even when that exact effort string is absent from its list.
 * Longer modifiers come first so `-xhigh` is never half-stripped as `-high`.
 */
const MODEL_EFFORT_SUFFIXES = [
  'xhigh',
  'high',
  'medium',
  'low',
  'minimal',
  'none',
  'off',
  'auto',
  'thinking',
  'tiered',
] as const

/**
 * Suffixes the backend uses to publish a model id it explicitly refuses to serve
 * (`gemini-4-hydrogen-disabled`, carried with `disabled: true` and an "Unavailable" tag in the
 * captured FetchAvailableModels response). `disabled` is the server's own refusal marker.
 *
 * `sonar` is NOT such a marker, contrary to what this comment used to claim. In the same capture
 * `gemini-4-hydrogen-sonar` is published with a live `quotaInfo` (remainingFraction ~1 plus a
 * resetTime), no `disabled` / `beta` / `isInternal` flag and `recommended: true`, in no
 * `agentModelSorts` / `tieredModelIds` group only because agy's picker does not show it — and live
 * requests against it returned HTTP 200 with SSE text and `modelVersion: gemini-4-hydrogen-sonar`
 * on three accounts (free-tier included). So it is a servable model of its own, and a list holding
 * only `...-disabled` entries still says nothing about the base model.
 */
const MODEL_UNSERVABLE_SUFFIXES = ['disabled'] as const

/** Quarantine window for one (account, family, model base) triple after an upstream 403. */
export const MODEL_UNSUPPORTED_COOLDOWN_MS = 5 * 60_000

/** Repeated 403s for the same model escalate the quarantine, but never past this bound. */
export const MODEL_UNSUPPORTED_MAX_COOLDOWN_MS = 30 * 60_000

/** Verdict of "can this account serve this wire model?" for one family. */
export interface ModelEntitlement {
  /** Effort-stripped base of the requested wire model. */
  readonly base: string
  /** False when the account has never published a model list for this family. */
  readonly known: boolean
  /** True when serving the requested wire model is plausible for this account. */
  readonly supported: boolean
}

/**
 * `gemini-4-hydrogen-tiered-high` -> `gemini-4-hydrogen`; unservable markers are NOT stripped.
 * `gemini-4-hydrogen-sonar` keeps its full id on purpose: it has no effort ladder, so it is not a
 * variant of `gemini-4-hydrogen`, and folding it in would make a sonar-only account look entitled
 * to `gemini-4-hydrogen-medium` — a request the upstream answers with 403, which would quarantine
 * the whole hydrogen family for that account.
 */
export function modelBaseOf(modelId: string): string {
  let base = modelId.trim().toLowerCase()
  for (;;) {
    const modifier = MODEL_EFFORT_SUFFIXES.find(
      (suffix) => base.endsWith(`-${suffix}`) && base.length > suffix.length + 1,
    )
    if (!modifier) return base
    base = base.slice(0, -(modifier.length + 1))
  }
}

/** False for ids the backend marks as not serviceable (`...-disabled`). */
export function isServableModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  if (!id) return false
  if (id === 'disabled' || id.endsWith('-disabled') || id.includes('-disabled')) {
    return false
  }
  return !MODEL_UNSERVABLE_SUFFIXES.some(
    (marker) => id === marker || id.endsWith(`-${marker}`) || id.includes(`-${marker}-`),
  )
}

/** Result of resolving an account capable of serving a specific model (including capability lending). */
export interface CapableAccountResult {
  account: ManagedAccount
  borrowedFrom?: ManagedAccount
  modelToUse: string
  isFallback: boolean
}

/**
 * Model-level entitlement of one account.
 *
 * An account whose family quota carries no `models[]` list (never refreshed, or the backend did
 * not send the breakdown) is treated as ENTITLED: missing data must not disqualify the whole pool.
 */
export function modelEntitlementOf(
  account: ManagedAccount,
  family: ModelFamily,
  wireModel: string,
): ModelEntitlement {
  const requested = wireModel.trim().toLowerCase()
  const base = modelBaseOf(requested)
  const listing = account.quotas[family]?.models
  if (!Array.isArray(listing) || listing.length === 0) {
    return { base, known: false, supported: true }
  }
  if (!isServableModelId(requested)) {
    return { base, known: true, supported: false }
  }
  const supported = listing.some((entry) => {
    const listed = typeof entry.modelId === 'string' ? entry.modelId.trim().toLowerCase() : ''
    if (!listed || !isServableModelId(listed)) return false
    const listedBase = modelBaseOf(listed)
    return (
      listed === requested ||
      listedBase === base ||
      (base === 'gemini-4-hydrogen' && listedBase === 'gemini-4-argon') ||
      (base === 'gemini-4-argon' && listedBase === 'gemini-4-hydrogen')
    )
  })
  return { base, known: true, supported }
}

/** Key of the model quarantine map: one account, one family, one effort-stripped model base. */
function modelQuarantineKey(id: string, family: ModelFamily, wireModel: string): string {
  return `${id}|${family}|${modelBaseOf(wireModel)}`
}

export class Semaphore {
  private active = 0
  private queue: Array<() => void> = []
  private readonly max: () => number
  constructor(max: () => number) {
    this.max = max
  }
  async acquire(): Promise<() => void> {
    if (this.active < Math.max(1, this.max())) {
      this.active++
      return () => this.releaseOne()
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve(() => this.releaseOne())
      })
    })
  }
  private releaseOne(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

/** Check if a specific account natively has entitlement for wireModel. */
export function hasModelCapability(account: ManagedAccount, wireModel: string): boolean {
  if (!wireModel || !wireModel.trim()) return false
  const trimmed = wireModel.trim()
  if (!isServableModelId(trimmed)) return false
  const family = modelFamilyOf(trimmed)
  const listing = account.quotas[family]?.models
  if (!Array.isArray(listing) || listing.length === 0) return false
  return modelEntitlementOf(account, family, trimmed).supported
}

export class AccountPoolManager {
  private data: AccountPoolData
  private isBrandNew = false
  private readonly baseDir: string
  private readonly file: string
  private readonly activeMemoryTokens = new Map<string, { token: string; expiresAt: number }>()
  private readonly accountSemaphores = new Map<string, Semaphore>()
  private readonly runtimeActiveAccountIds = new Map<ModelFamily, string>()
  /**
   * Model-scoped soft failures: `id|family|modelBase` -> quarantine state. Populated when the
   * backend answers 403 for a model an account is not entitled to. Runtime-only on purpose —
   * entitlement is re-probed from `quotas[family].models` after a quota refresh, and a stale
   * "this account cannot do X" verdict must never outlive the process that observed it.
   */
  private readonly modelQuarantine = new Map<string, { cooldownUntil: number; reason: string; consecutiveFailures: number }>()
  private writeQueue: Promise<void> = Promise.resolve()
  private lowQuotaThreshold = 0.05

  constructor(baseDir = defaultPoolDir(), lowQuotaThreshold = 0.05) {
    this.baseDir = baseDir
    this.lowQuotaThreshold = typeof lowQuotaThreshold === 'number' && Number.isFinite(lowQuotaThreshold) && lowQuotaThreshold >= 0 && lowQuotaThreshold <= 1
      ? lowQuotaThreshold
      : 0.05
    this.file = join(baseDir, 'pool.json')
    try {
      chmodSync(this.baseDir, 0o700)
    } catch {}
    this.data = this.load()
    this.bootstrapDefaultAccount()
    this.normalizeLegacyPrimary()
    this.normalizeAccountAliases()
  }

  getBaseDir(): string {
    return this.baseDir
  }

  setLowQuotaThreshold(threshold: number): void {
    if (typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) {
      this.lowQuotaThreshold = threshold
    }
  }

  getLowQuotaThreshold(): number {
    return this.lowQuotaThreshold
  }

  private load(): AccountPoolData {
    if (!existsSync(this.file)) {
      this.isBrandNew = true
      return defaultPoolData()
    }
    const raw = readFileSync(this.file, 'utf8')
    try {
      const parsed = JSON.parse(raw) as AccountPoolData
      if (parsed && Array.isArray(parsed.accounts)) {
        this.isBrandNew = false
        return {
          ...defaultPoolData(),
          ...parsed,
        }
      }
      throw new Error('Missing or invalid accounts array')
    } catch (err: unknown) {
      const corruptBackup = `${this.file}.corrupted`
      try {
        if (existsSync(corruptBackup)) {
          rmSync(corruptBackup, { force: true })
        }
        renameSync(this.file, corruptBackup)
      } catch {
        try {
          renameSync(this.file, `${this.file}.corrupted.${Date.now()}`)
        } catch {}
      }
      this.isBrandNew = true
      const empty = defaultPoolData()
      this.data = empty
      return empty
    }
  }

  private persist(): void {
    const doWrite = () => {
      try {
        const dir = dirname(this.file)
        mkdirSync(dir, { recursive: true })
        try {
          chmodSync(dir, 0o700)
        } catch {}
        const tmp = join(
          dir,
          `.pool.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
        )
        writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
        try {
          chmodSync(tmp, 0o600)
        } catch {}
        renameSync(tmp, this.file)
      } catch {
        // Best-effort persistence
      }
    }

    // Queue writes to serialize concurrent async persist calls
    this.writeQueue = this.writeQueue.then(doWrite, doWrite)
    // Synchronously write immediately to satisfy synchronous callers and tests
    doWrite()
  }

  /**
   * Bootstraps the primary account on first start.
   */
  private bootstrapDefaultAccount(): void {
    if (!this.isBrandNew) return
    const hasSystemHome = this.data.accounts.some((a) => a.systemHome)
    if (hasSystemHome) return

    const primary: ManagedAccount = {
      id: 'acc_primary',
      alias: '主账号 (系统登录)',
      dir: '',
      systemHome: true,
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }

    this.data.accounts.unshift(primary)
    this.data.primaryAccountId = primary.id
    this.persist()
  }

  private normalizeLegacyPrimary(): void {
    const primary = this.data.accounts.find((a) => a.id === 'acc_primary')
    if (!primary) {
      if (this.data.primaryAccountId && !this.data.accounts.some((a) => a.id === this.data.primaryAccountId)) {
        this.data.primaryAccountId = this.data.accounts[0]?.id
        this.persist()
      }
      return
    }
    if (primary.systemHome) return
    primary.dir = ''
    primary.systemHome = true
    if (!primary.alias || /^主账号/i.test(primary.alias) || /^备用.*账号/i.test(primary.alias)) {
      primary.alias = primary.email || '主账号 (系统登录)'
    }
    this.data.primaryAccountId = primary.id
    this.persist()
  }

  normalizeAccountAliases(): void {
    let changed = false
    for (const acc of this.data.accounts) {
      if (acc.email && (!acc.alias || /^备用.*账号/i.test(acc.alias) || /^主账号/i.test(acc.alias) || acc.alias === acc.id)) {
        if (acc.alias !== acc.email) {
          acc.alias = acc.email
          changed = true
        }
      }
    }
    if (changed) this.persist()
  }

  getPoolData(): Readonly<AccountPoolData> {
    return this.data
  }

  setMemoryToken(id: string, token: string, expiresAt?: number): void {
    this.activeMemoryTokens.set(id, {
      token,
      expiresAt: expiresAt ?? Date.now() + 55 * 60 * 1000,
    })
  }

  getMemoryToken(id: string): string | null {
    const entry = this.activeMemoryTokens.get(id)
    if (!entry) return null
    if (entry.expiresAt <= Date.now() + 10_000) {
      this.activeMemoryTokens.delete(id)
      return null
    }
    return entry.token
  }

  clearMemoryToken(id: string): void {
    this.activeMemoryTokens.delete(id)
  }

  async acquireAccount(id: string, maxConcurrent = 1): Promise<() => void> {
    let sem = this.accountSemaphores.get(id)
    if (!sem) {
      sem = new Semaphore(() => maxConcurrent)
      this.accountSemaphores.set(id, sem)
    }
    return sem.acquire()
  }

  getAccounts(): readonly ManagedAccount[] {
    return this.data.accounts
  }

  getAccount(id: string): ManagedAccount | undefined {
    return this.data.accounts.find((a) => a.id === id)
  }

  createStagingSlot(): { id: string; dir: string } {
    const id = `acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const dir = join(this.baseDir, `staging_${id}`)
    const geminiDir = join(dir, '.gemini')
    const tokenDir = join(geminiDir, 'antigravity-cli')
    mkdirSync(tokenDir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dir, 0o700)
      chmodSync(geminiDir, 0o700)
      chmodSync(tokenDir, 0o700)
    } catch {}
    return { id, dir }
  }

  commitStagingAccount(id: string, dir: string, alias?: string, email?: string, proxyUrl?: string): ManagedAccount {
    const finalDir = join(this.baseDir, id)
    try {
      if (existsSync(dir)) {
        renameSync(dir, finalDir)
        try {
          chmodSync(finalDir, 0o700)
        } catch {}
      }
    } catch {
      // If rename fails, keep dir
    }
    const isAutoName = !alias || /^备用.*账号/i.test(alias) || /^主账号/i.test(alias)
    const effectiveAlias = isAutoName ? (email || id) : alias
    const newAccount: ManagedAccount = {
      id,
      alias: effectiveAlias,
      dir: existsSync(finalDir) ? finalDir : dir,
      ...(email ? { email } : {}),
      ...(proxyUrl ? { proxyUrl } : {}),
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }

    this.data.accounts.push(newAccount)
    this.persist()
    return newAccount
  }

  cleanupStagingSlot(dir: string): void {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup error
    }
  }

  sweepStaleStaging(): number {
    let removed = 0
    try {
      for (const entry of readdirSync(this.baseDir)) {
        if (!entry.startsWith('staging_')) continue
        rmSync(join(this.baseDir, entry), { recursive: true, force: true })
        removed++
      }
    } catch {
      // Ignore sweep errors
    }
    return removed
  }

  sweepOldLogs(maxDays = 7): number {
    const maxAgeMs = Math.max(1, maxDays) * 86_400_000
    const now = Date.now()
    let removed = 0

    const targetLogDirs = [
      join(homedir(), '.gemini', 'antigravity-cli', 'log'),
    ]

    for (const acc of this.data.accounts) {
      if (acc.dir) {
        targetLogDirs.push(join(acc.dir, '.gemini', 'antigravity-cli', 'log'))
      }
    }

    for (const logDir of targetLogDirs) {
      if (!existsSync(logDir)) continue
      try {
        const files = readdirSync(logDir)
        for (const f of files) {
          if (!f.startsWith('cli-') || !f.endsWith('.log')) continue
          const fp = join(logDir, f)
          try {
            const st = statSync(fp)
            if (now - st.mtimeMs > maxAgeMs) {
              rmSync(fp, { force: true })
              removed++
            }
          } catch {
            // Ignore file error
          }
        }
      } catch {
        // Ignore dir error
      }
    }

    return removed
  }

  createAccountSlot(alias?: string): ManagedAccount {
    const id = `acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const dir = join(this.baseDir, id)
    const geminiDir = join(dir, '.gemini')
    const tokenDir = join(geminiDir, 'antigravity-cli')
    mkdirSync(tokenDir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dir, 0o700)
      chmodSync(geminiDir, 0o700)
      chmodSync(tokenDir, 0o700)
    } catch {}

    const isAutoName = !alias || /^备用.*账号/i.test(alias) || /^主账号/i.test(alias)
    const effectiveAlias = isAutoName ? id : alias
    const newAccount: ManagedAccount = {
      id,
      alias: effectiveAlias,
      dir,
      enabled: true,
      createdAt: Date.now(),
      cooldowns: {},
      quotas: {},
    }

    this.data.accounts.push(newAccount)
    this.persist()
    return newAccount
  }

  deleteAccount(id: string): boolean {
    const idx = this.data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return false
    const [removed] = this.data.accounts.splice(idx, 1)
    if (removed) {
      try {
        if (existsSync(removed.dir)) {
          rmSync(removed.dir, { recursive: true, force: true })
        }
      } catch {
        // Ignore deletion errors
      }
    }
    if (this.data.primaryAccountId === id) {
      this.data.primaryAccountId = this.data.accounts[0]?.id
    }
    if (this.data.pinnedAccountId === id) {
      this.data.pinnedAccountId = undefined
    }
    for (const [fam, accId] of this.runtimeActiveAccountIds.entries()) {
      if (accId === id) this.runtimeActiveAccountIds.delete(fam as ModelFamily)
    }
    if (this.data.activeAccountIds) {
      for (const [fam, accId] of Object.entries(this.data.activeAccountIds)) {
        if (accId === id) delete this.data.activeAccountIds[fam as ModelFamily]
      }
    }
    this.persist()
    return true
  }

  setAccountProxy(id: string, proxyUrl?: string): boolean {
    const acc = this.getAccount(id)
    if (!acc) return false
    acc.proxyUrl = proxyUrl?.trim() ? proxyUrl.trim() : undefined
    this.persist()
    return true
  }

  setAccountAlias(id: string, alias: string): boolean {
    const acc = this.getAccount(id)
    if (!acc) return false
    const trimmed = alias.trim()
    acc.alias = trimmed || acc.email || acc.id
    this.persist()
    return true
  }

  setAccountEnabled(id: string, enabled: boolean): boolean {
    const acc = this.getAccount(id)
    if (!acc) return false
    acc.enabled = enabled
    if (!enabled) {
      for (const [fam, accId] of this.runtimeActiveAccountIds.entries()) {
        if (accId === id) this.runtimeActiveAccountIds.delete(fam as ModelFamily)
      }
      if (this.data.activeAccountIds) {
        for (const [fam, accId] of Object.entries(this.data.activeAccountIds)) {
          if (accId === id) delete this.data.activeAccountIds[fam as ModelFamily]
        }
      }
      if (this.data.pinnedAccountId === id) {
        this.data.pinnedAccountId = undefined
      }
      delete acc.pinned
    }
    this.persist()
    return true
  }

  markAuthRequired(id: string, reason?: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.authRequired = true
    acc.authError = reason || 'Authentication expired or revoked (invalid_grant)'
    for (const [fam, accId] of this.runtimeActiveAccountIds.entries()) {
      if (accId === id) this.runtimeActiveAccountIds.delete(fam as ModelFamily)
    }
    if (this.data.activeAccountIds) {
      for (const [fam, accId] of Object.entries(this.data.activeAccountIds)) {
        if (accId === id) delete this.data.activeAccountIds[fam as ModelFamily]
      }
    }
    this.persist()
  }

  resetAccountIdentity(id: string, newEmail: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.email = newEmail
    if (!acc.alias || /^备用.*账号/i.test(acc.alias) || /^主账号/i.test(acc.alias) || acc.alias === acc.id) {
      acc.alias = newEmail
    }
    acc.cooldowns = {}
    acc.quotas = {}
    delete acc.authRequired
    delete acc.authError
    this.normalizeAccountAliases()
    this.persist()
  }

  clearAuthRequired(id: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    delete acc.authRequired
    delete acc.authError
    this.persist()
  }

  setPrimaryAccount(id: string): boolean {
    const idx = this.data.accounts.findIndex((a) => a.id === id)
    if (idx === -1) return false
    this.data.primaryAccountId = id
    const [acc] = this.data.accounts.splice(idx, 1)
    if (acc) this.data.accounts.unshift(acc)
    this.data.activeAccountIds = {
      google: id,
      anthropic: id,
      openai: id,
    }
    this.runtimeActiveAccountIds.set('google', id)
    this.runtimeActiveAccountIds.set('anthropic', id)
    this.runtimeActiveAccountIds.set('openai', id)
    this.persist()
    return true
  }

  pinAccount(id: string | null): boolean {
    if (!id) {
      this.data.pinnedAccountId = undefined
      for (const acc of this.data.accounts) {
        delete acc.pinned
      }
      this.persist()
      return true
    }
    const acc = this.getAccount(id)
    if (!acc || !acc.enabled) return false
    this.data.pinnedAccountId = id
    for (const a of this.data.accounts) {
      if (a.id === id) {
        a.pinned = true
      } else {
        delete a.pinned
      }
    }
    this.runtimeActiveAccountIds.set('google', id)
    this.runtimeActiveAccountIds.set('anthropic', id)
    this.runtimeActiveAccountIds.set('openai', id)
    this.persist()
    return true
  }

  getPinnedAccount(): ManagedAccount | null {
    if (this.data.pinnedAccountId) {
      return this.getAccount(this.data.pinnedAccountId) ?? null
    }
    return this.data.accounts.find((a) => a.pinned) ?? null
  }

  reorderAccounts(ids: string[]): boolean {
    const map = new Map(this.data.accounts.map((a) => [a.id, a]))
    const reordered: ManagedAccount[] = []
    for (const id of ids) {
      const acc = map.get(id)
      if (acc) {
        reordered.push(acc)
        map.delete(id)
      }
    }
    for (const remaining of map.values()) {
      reordered.push(remaining)
    }
    this.data.accounts = reordered
    this.persist()
    return true
  }

  setMode(mode: 'sequential' | 'round-robin'): void {
    this.data.mode = mode
    this.persist()
  }

  updateAccountQuotas(id: string, quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>, email?: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.quotas = {
      ...acc.quotas,
      ...quotas,
    }
    if (email) {
      acc.email = email
      if (!acc.alias || /^备用.*账号/i.test(acc.alias) || /^主账号/i.test(acc.alias) || acc.alias === acc.id) {
        acc.alias = email
      }
    }
    this.normalizeAccountAliases()
    this.persist()
  }

  recordFailure(id: string, family: ModelFamily, reason: string, serverResetTime?: string): void {
    const acc = this.getAccount(id)
    if (!acc) return

    const prev = acc.cooldowns[family]
    const failures = (prev?.consecutiveFailures ?? 0) + 1

    let cooldownUntil: number
    const parsedDuration = parseResetDurationMs(serverResetTime || reason)

    if (serverResetTime && !parsedDuration) {
      const parsed = Date.parse(serverResetTime)
      if (!Number.isNaN(parsed) && parsed > Date.now()) {
        cooldownUntil = parsed + 10_000 // 10s safety buffer
      } else {
        cooldownUntil = Date.now() + Math.min(this.data.defaultCooldownMs * failures, this.data.maxCooldownMs)
      }
    } else if (parsedDuration && parsedDuration > 0) {
      cooldownUntil = Date.now() + parsedDuration + 10_000
    } else {
      cooldownUntil = Date.now() + Math.min(this.data.defaultCooldownMs * failures, this.data.maxCooldownMs)
    }

    acc.cooldowns[family] = {
      cooldownUntil,
      reason,
      consecutiveFailures: failures,
    }
    this.persist()
  }

  /**
   * Soft-fail an account for ONE model only (upstream 403 / "no such model for this user").
   *
   * This is deliberately NOT `markAuthRequired`: a 403 says "this credential may be fine, but not
   * for this model". Quarantining the whole account turns a model mismatch into a pool-wide
   * "sign in again" error, which is what made the pool report
   * `No authenticated Antigravity account available` while every account was actually signed in.
   * Repeated refusals for the same model escalate the quarantine within
   * {@link MODEL_UNSUPPORTED_MAX_COOLDOWN_MS}.
   */
  recordModelUnsupported(id: string, family: ModelFamily, wireModel: string, reason?: string): void {
    const acc = this.getAccount(id)
    if (!acc) return
    const key = modelQuarantineKey(id, family, wireModel)
    const prev = this.modelQuarantine.get(key)
    const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1
    const cooldownMs = Math.min(
      MODEL_UNSUPPORTED_COOLDOWN_MS * consecutiveFailures,
      MODEL_UNSUPPORTED_MAX_COOLDOWN_MS,
    )
    this.modelQuarantine.set(key, {
      cooldownUntil: Date.now() + cooldownMs,
      reason: reason || `Model '${wireModel}' refused by this account`,
      consecutiveFailures,
    })
  }

  /** Current model quarantine for an account, or null when none applies (expired entries cleared). */
  getModelQuarantine(id: string, family: ModelFamily, wireModel: string): {
    cooldownUntil: number
    reason: string
    consecutiveFailures: number
  } | null {
    const key = modelQuarantineKey(id, family, wireModel)
    const entry = this.modelQuarantine.get(key)
    if (!entry) return null
    if (entry.cooldownUntil <= Date.now()) {
      this.modelQuarantine.delete(key)
      return null
    }
    return entry
  }

  /** Drop model quarantines (all accounts / one account / one family). Used by `/ccl` remediation. */
  clearModelQuarantine(id?: string, family?: ModelFamily): void {
    for (const key of [...this.modelQuarantine.keys()]) {
      const [accId, accFamily] = key.split('|')
      if (id && accId !== id) continue
      if (family && accFamily !== family) continue
      this.modelQuarantine.delete(key)
    }
  }

  recordSuccess(id: string, family: ModelFamily): void {
    const acc = this.getAccount(id)
    if (!acc) return
    acc.lastUsedAt = Date.now()
    if (acc.authRequired) {
      delete acc.authRequired
      delete acc.authError
    }
    if (acc.cooldowns[family]) {
      delete acc.cooldowns[family]
    }
    this.persist()
  }

  clearCooldown(id?: string, family?: ModelFamily): void {
    if (id) {
      const acc = this.getAccount(id)
      if (!acc) return
      if (family) delete acc.cooldowns[family]
      else acc.cooldowns = {}
    } else {
      for (const acc of this.data.accounts) {
        if (family) delete acc.cooldowns[family]
        else acc.cooldowns = {}
      }
    }
    this.persist()
  }

  /**
   * Health check for scheduling.
   *
   * Overloads keep every existing caller working: the third argument is the wire model when it is
   * a string (`isAccountHealthy(acc, 'google', 'gemini-4-hydrogen-high')`) and the low-quota
   * threshold when it is a number. Passing no third argument behaves exactly as before.
   */
  isAccountHealthy(account: ManagedAccount, family: ModelFamily, wireModel?: string): boolean
  isAccountHealthy(account: ManagedAccount, family: ModelFamily, threshold: number, wireModel?: string): boolean
  isAccountHealthy(
    account: ManagedAccount,
    family: ModelFamily,
    thresholdOrWireModel?: number | string,
    maybeWireModel?: string,
  ): boolean {
    const threshold =
      typeof thresholdOrWireModel === 'number' ? thresholdOrWireModel : this.lowQuotaThreshold
    const wireModel =
      typeof thresholdOrWireModel === 'string' ? thresholdOrWireModel : maybeWireModel
    if (!account.enabled || account.authRequired) return false
    const now = Date.now()
    const cd = account.cooldowns[family]
    if (cd && cd.cooldownUntil > now) return false
    const quota = account.quotas[family]
    if (quota && typeof quota.remainingFraction === 'number' && quota.remainingFraction <= threshold) {
      if (quota.resetTime) {
        const resetMs = Date.parse(quota.resetTime)
        if (!Number.isNaN(resetMs) && resetMs > now) return false
      }
    }
    if (quota && typeof quota.weeklyFraction === 'number' && quota.weeklyFraction <= 0.01) {
      if (quota.weeklyResetTime) {
        const resetMs = Date.parse(quota.weeklyResetTime)
        if (!Number.isNaN(resetMs) && resetMs > now) return false
      }
    }
    if (wireModel?.trim()) {
      // Model-level entitlement: the account's own quota snapshot lists the ids it can serve.
      if (!modelEntitlementOf(account, family, wireModel).supported) return false
      // Soft 403 quarantine recorded earlier for this exact model base.
      if (this.getModelQuarantine(account.id, family, wireModel)) return false
    }
    return true
  }

  /**
   * Pick a schedulable account. When `wireModel` is given, entitlement filtering happens HERE so
   * every strategy below (pin, round-robin, sticky drain) only ever sees accounts that can serve
   * the requested model. Without `wireModel` the behaviour is unchanged.
   */
  selectAccount(family: ModelFamily, wireModel?: string): ManagedAccount | null {
    const candidates = this.data.accounts.filter((acc) =>
      this.isAccountHealthy(acc, family, wireModel),
    )

    if (candidates.length === 0) return null

    // 0. Pin check: if a pinned account is configured and healthy, ALWAYS prefer it!
    const pinned = this.getPinnedAccount()
    if (pinned && candidates.some((c) => c.id === pinned.id)) {
      this.runtimeActiveAccountIds.set(family, pinned.id)
      return pinned
    }

    // Round-robin: Quota-Aware Selection — pick account with highest 5H remaining quota,
    // rotate in round-robin order when quotas are equal (e.g. all accounts at 100%).
    if (this.data.mode === 'round-robin' && candidates.length > 1) {
      const activeId = this.runtimeActiveAccountIds.get(family) ?? this.data.activeAccountIds?.[family]
      const lastIndex = activeId ? this.data.accounts.findIndex((a) => a.id === activeId) : -1
      const total = this.data.accounts.length

      const sorted = candidates.slice().sort((a, b) => {
        const aFrac = a.quotas[family]?.remainingFraction ?? 1.0
        const bFrac = b.quotas[family]?.remainingFraction ?? 1.0
        if (Math.abs(bFrac - aFrac) >= 0.001) {
          return bFrac - aFrac // descending: most remaining first
        }

        // Equal fraction: rotate in circular order after the last active account
        const aIndex = this.data.accounts.indexOf(a)
        const bIndex = this.data.accounts.indexOf(b)
        const aDist = lastIndex !== -1 ? (aIndex - lastIndex - 1 + total) % total : aIndex
        const bDist = lastIndex !== -1 ? (bIndex - lastIndex - 1 + total) % total : bIndex
        return aDist - bDist
      })
      const chosen = sorted[0]!
      this.runtimeActiveAccountIds.set(family, chosen.id)
      return chosen
    }

    // Default 'sequential' (Sticky Sequential Drain): — 恢复原始逻辑
    const activeId = this.runtimeActiveAccountIds.get(family) ?? this.data.activeAccountIds?.[family]
    if (activeId) {
      const activeCandidate = candidates.find((a) => a.id === activeId)
      if (activeCandidate) {
        this.runtimeActiveAccountIds.set(family, activeCandidate.id)
        return activeCandidate
      }
    }

    let nextAccount: ManagedAccount = candidates[0]!
    if (activeId) {
      const currentIndex = this.data.accounts.findIndex((a) => a.id === activeId)
      if (currentIndex !== -1) {
        const total = this.data.accounts.length
        for (let i = 1; i < total; i++) {
          const checkAcc = this.data.accounts[(currentIndex + i) % total]!
          if (candidates.some((c) => c.id === checkAcc.id)) {
            nextAccount = checkAcc
            break
          }
        }
      }
    }

    this.runtimeActiveAccountIds.set(family, nextAccount.id)
    return nextAccount
  }

  getEarliestResetCountdown(family: ModelFamily): number | null {
    const now = Date.now()
    let earliest: number | null = null
    for (const acc of this.data.accounts) {
      if (!acc.enabled || acc.authRequired) continue
      let accReset: number | null = null
      const cd = acc.cooldowns[family]
      if (cd && cd.cooldownUntil > now) {
        accReset = Math.max(accReset ?? 0, cd.cooldownUntil)
      }
      const quota = acc.quotas[family]
      if (quota && typeof quota.remainingFraction === 'number' && quota.remainingFraction <= this.lowQuotaThreshold) {
        if (quota.resetTime) {
          const resetMs = Date.parse(quota.resetTime)
          if (!Number.isNaN(resetMs) && resetMs > now) {
            accReset = Math.max(accReset ?? 0, resetMs)
          }
        }
      }
      if (quota && typeof quota.weeklyFraction === 'number' && quota.weeklyFraction <= 0.01) {
        if (quota.weeklyResetTime) {
          const resetMs = Date.parse(quota.weeklyResetTime)
          if (!Number.isNaN(resetMs) && resetMs > now) {
            accReset = Math.max(accReset ?? 0, resetMs)
          }
        }
      }
      if (accReset !== null) {
        if (earliest === null || accReset < earliest) {
          earliest = accReset
        }
      }
    }
    return earliest !== null ? Math.max(0, earliest - now) : null
  }

  /**
   * Pool verdict for one family. With `wireModel` the verdict is model-aware: when every signed-in
   * account publishes a model list that excludes the requested model, the reason is
   * `model_not_available` — NOT `auth_required`, which would send the user to `/ccl auth` for a
   * problem re-authenticating cannot fix.
   */
  getFamilyStatus(family: ModelFamily, wireModel?: string): FamilyStatus {
    const accounts = this.data.accounts
    if (accounts.length === 0) {
      return { hasAccount: false, suppressed: false, reason: 'no_accounts', resetInMs: null }
    }

    const enabledAccounts = accounts.filter((a) => a.enabled)
    if (enabledAccounts.length === 0) {
      return { hasAccount: false, suppressed: false, reason: 'disabled', resetInMs: null }
    }

    const authValidAccounts = enabledAccounts.filter((a) => !a.authRequired)
    if (authValidAccounts.length === 0) {
      return { hasAccount: false, suppressed: false, reason: 'auth_required', resetInMs: null }
    }

    const candidate = this.selectAccount(family, wireModel)
    if (candidate) {
      return { hasAccount: true, suppressed: false, resetInMs: null }
    }

    if (wireModel?.trim()) {
      // Entitlement blocks scheduling only when every signed-in account is KNOWN not to serve the
      // model. Accounts whose model list was never refreshed stay "unknown = allowed".
      const allKnownUnsupported = authValidAccounts.every(
        (a) => !modelEntitlementOf(a, family, wireModel).supported,
      )
      if (allKnownUnsupported) {
        return { hasAccount: true, suppressed: true, reason: 'model_not_available', resetInMs: null }
      }
    }

    const resetInMs = this.getEarliestResetCountdown(family)
    const hasRateLimitCooldown = authValidAccounts.some(
      (a) => a.cooldowns[family] && a.cooldowns[family]!.cooldownUntil > Date.now(),
    )
    const reason = hasRateLimitCooldown ? 'rate_limited' : 'quota_exhausted'

    return {
      hasAccount: true,
      suppressed: true,
      reason,
      resetInMs,
    }
  }

  /** Check if a specific account natively has entitlement for wireModel. */
  hasModelCapability(account: ManagedAccount, wireModel: string): boolean {
    return hasModelCapability(account, wireModel)
  }

  /** Check if any account in the pool (even if in cooldown) has entitlement for wireModel. */
  isModelKnownInPool(wireModel: string): boolean {
    const family = modelFamilyOf(wireModel)
    return this.data.accounts.some((acc) => acc.enabled && this.hasModelCapability(acc, wireModel))
  }

  /**
   * Dynamically find a healthy account in the pool that natively supports wireModel.
   * Never hardcodes account IDs or emails; dynamically probes pool account quotas.
   */
  findCapableAccount(family: ModelFamily, wireModel: string): ManagedAccount | null {
    const candidates = this.data.accounts.filter(
      (acc) =>
        this.isAccountHealthy(acc, family) &&
        this.hasModelCapability(acc, wireModel) &&
        !this.getModelQuarantine(acc.id, family, wireModel),
    )
    if (candidates.length === 0) return null
    return (
      candidates.slice().sort((a, b) => {
        const aFrac = a.quotas[family]?.remainingFraction ?? 1.0
        const bFrac = b.quotas[family]?.remainingFraction ?? 1.0
        return bFrac - aFrac
      })[0] ?? null
    )
  }

  /**
   * Resolve an account capable of serving wireModel, leveraging capability lending if necessary.
   * If preferredAccountId is healthy but lacks native entitlement (e.g. regular account requesting
   * high-tier Gemini 4), transparently borrows a privileged account's credentials while keeping
   * session affinity. If no privileged account is available, falls back to gemini-4-hydrogen-sonar.
   */
  getCapableAccount(wireModel: string, preferredAccountId?: string): CapableAccountResult | null {
    const family = modelFamilyOf(wireModel)
    const preferred = preferredAccountId ? this.getAccount(preferredAccountId) ?? null : this.getPinnedAccount()

    // 1. Preferred account exists, is healthy, and natively supports wireModel
    if (preferred && this.isAccountHealthy(preferred, family) && this.hasModelCapability(preferred, wireModel)) {
      return {
        account: preferred,
        modelToUse: wireModel,
        isFallback: false,
      }
    }

    // 2. Preferred account exists and is healthy for family, but lacks native entitlement for wireModel
    if (preferred && this.isAccountHealthy(preferred, family)) {
      const capable = this.findCapableAccount(family, wireModel)
      if (capable && capable.id !== preferred.id) {
        console.log(
          '[G4-Lend] Borrowing account ' +
            capable.id +
            ' (' +
            capable.email +
            ') for ' +
            preferred.id +
            ' (' +
            preferred.email +
            ') to serve ' +
            wireModel,
        )
        return {
          account: preferred,
          borrowedFrom: capable,
          modelToUse: wireModel,
          isFallback: false,
        }
      }
      if (this.isModelKnownInPool(wireModel) && isGemini4Model(wireModel) && wireModel !== 'gemini-4-hydrogen-sonar') {
        return {
          account: preferred,
          modelToUse: 'gemini-4-hydrogen-sonar',
          isFallback: true,
        }
      }
      return null
    }

    // 3. No preferred account or preferred is unhealthy: select an account from pool
    const nativeAccount = this.selectAccount(family, wireModel)
    if (nativeAccount) {
      return {
        account: nativeAccount,
        modelToUse: wireModel,
        isFallback: false,
      }
    }

    const candidate = this.selectAccount(family)
    if (candidate) {
      const capable = this.findCapableAccount(family, wireModel)
      if (capable && capable.id !== candidate.id) {
        console.log(
          '[G4-Lend] Borrowing account ' +
            capable.id +
            ' (' +
            capable.email +
            ') for ' +
            candidate.id +
            ' (' +
            candidate.email +
            ') to serve ' +
            wireModel,
        )
        return {
          account: candidate,
          borrowedFrom: capable,
          modelToUse: wireModel,
          isFallback: false,
        }
      }
      if (this.isModelKnownInPool(wireModel) && isGemini4Model(wireModel) && wireModel !== 'gemini-4-hydrogen-sonar') {
        return {
          account: candidate,
          modelToUse: 'gemini-4-hydrogen-sonar',
          isFallback: true,
        }
      }
      return null
    }

    return null
  }

  /**
   * Broadcast model catalog union across all pool accounts.
   * If any account has Gemini 4 capability (or G4 is enabled), Gemini 4 models are broadcast
   * to all accounts in the pool.
   */
  getBroadcastedCatalogModels(family: ModelFamily): string[] {
    const allModels = new Set<string>()
    for (const acc of this.data.accounts) {
      if (!acc.enabled || acc.authRequired) continue
      const listing = acc.quotas[family]?.models
      if (Array.isArray(listing)) {
        for (const m of listing) {
          const modelId = typeof m === 'string' ? m : m?.modelId
          if (typeof modelId === 'string' && isServableModelId(modelId)) {
            allModels.add(modelId.trim())
          }
        }
      }
    }
    let hasG4 = Array.from(allModels).some(isGemini4Model)
    if (!hasG4) {
      for (const acc of this.data.accounts) {
        if (!acc.enabled || acc.authRequired) continue
        if (
          this.hasModelCapability(acc, 'gemini-4-hydrogen') ||
          this.hasModelCapability(acc, 'gemini-4-argon') ||
          this.hasModelCapability(acc, 'gemini-4-hydrogen-sonar')
        ) {
          hasG4 = true
          break
        }
      }
    }
    if (hasG4) {
      allModels.add('gemini-4-hydrogen')
      allModels.add('gemini-4-hydrogen-sonar')
      allModels.add('gemini-4-argon')
    }
    return Array.from(allModels)
  }
}
