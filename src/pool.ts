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

export function defaultPoolDir(customBase?: string): string {
  if (customBase) return customBase
  if (process.env.CLOUDCODE_ACCOUNTS_DIR?.trim()) return process.env.CLOUDCODE_ACCOUNTS_DIR.trim()
  if (process.env.ANTIGRAVITY_ACCOUNTS_DIR?.trim()) return process.env.ANTIGRAVITY_ACCOUNTS_DIR.trim()
  return join(homedir(), '.cloudcode', 'accounts')
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

export class AccountPoolManager {
  private data: AccountPoolData
  private readonly baseDir: string
  private readonly file: string
  private readonly activeMemoryTokens = new Map<string, { token: string; expiresAt: number }>()
  private readonly accountSemaphores = new Map<string, Semaphore>()
  private readonly runtimeActiveAccountIds = new Map<ModelFamily, string>()
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
      return defaultPoolData()
    }
    const raw = readFileSync(this.file, 'utf8')
    try {
      const parsed = JSON.parse(raw) as AccountPoolData
      if (parsed && Array.isArray(parsed.accounts)) {
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
    if (!primary || primary.systemHome) return
    primary.dir = ''
    primary.systemHome = true
    primary.alias = '主账号 (系统登录)'
    this.data.primaryAccountId = primary.id
    this.persist()
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
    const count = this.data.accounts.length + 1
    const newAccount: ManagedAccount = {
      id,
      alias: alias || `备用 Google 账号 ${count}`,
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

    const count = this.data.accounts.length + 1
    const newAccount: ManagedAccount = {
      id,
      alias: alias || `备用账号 ${count} (Account ${count})`,
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
      this.data.primaryAccountId = undefined
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
    acc.alias = alias.trim()
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
    acc.cooldowns = {}
    acc.quotas = {}
    delete acc.authRequired
    delete acc.authError
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
    if (email) acc.email = email
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

  isAccountHealthy(account: ManagedAccount, family: ModelFamily, threshold = this.lowQuotaThreshold): boolean {
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
    return true
  }

  selectAccount(family: ModelFamily): ManagedAccount | null {
    const candidates = this.data.accounts.filter((acc) => this.isAccountHealthy(acc, family))

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

  getFamilyStatus(family: ModelFamily): FamilyStatus {
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

    const candidate = this.selectAccount(family)
    if (candidate) {
      return { hasAccount: true, suppressed: false, resetInMs: null }
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
}
