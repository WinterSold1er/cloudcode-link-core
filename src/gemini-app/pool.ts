// Multi-account pool manager with 1-hour silent GMS token refresh for Google Gemini App (Robin / AGSA).

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exchangeMasterTokenForAccessToken } from './gms-auth.ts'
import {
  GeminiAppError,
  type GeminiAppAccount,
  type GeminiAppAccountSummary,
  type GeminiAppPoolState,
  type GeminiAppPoolSummary,
} from './types.ts'

const DEFAULT_POOL_PATH = path.join(os.homedir(), '.dsh', 'gemini-app', 'pool.json')
const TOKEN_REFRESH_BUFFER_MS = 60_000
const BASE_COOLDOWN_MS = 60_000
const MAX_COOLDOWN_MS = 30 * 60_000

export interface AddGeminiAppAccountInput {
  id?: string
  email: string
  accessToken: string
  masterToken?: string
  expiresAt?: number
}

export class GeminiAppPoolManager {
  private readonly poolPath: string
  private readonly fetchFn: typeof fetch
  private state: GeminiAppPoolState

  constructor(poolPath: string = DEFAULT_POOL_PATH, fetchFn: typeof fetch = fetch) {
    this.poolPath = poolPath
    this.fetchFn = fetchFn
    this.state = this.load()
  }

  getPoolPath(): string {
    return this.poolPath
  }

  private load(): GeminiAppPoolState {
    if (!existsSync(this.poolPath)) {
      return { version: 1, accounts: [] }
    }
    const raw = readFileSync(this.poolPath, 'utf8')
    if (!raw.trim()) {
      return { version: 1, accounts: [] }
    }
    const parsed = JSON.parse(raw) as Partial<GeminiAppPoolState>
    if (!parsed || !Array.isArray(parsed.accounts)) {
      throw new GeminiAppError(
        `Invalid Gemini App pool file format at ${this.poolPath}`,
        'POOL_CORRUPT',
      )
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      accounts: parsed.accounts.map((acc) => ({ ...acc })),
    }
  }

  private save(): void {
    const dir = path.dirname(this.poolPath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmpPath = `${this.poolPath}.tmp.${process.pid}.${Date.now()}`
    const payload = JSON.stringify(this.state, null, 2)
    try {
      writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmpPath, this.poolPath)
    } catch (err) {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath)
      }
      throw err
    }
  }

  private recoverExpiredCooldowns(now: number): boolean {
    let changed = false
    for (const acc of this.state.accounts) {
      if (acc.status === 'cooldown' && acc.cooldownUntil !== undefined && acc.cooldownUntil <= now) {
        acc.status = 'ready'
        acc.cooldownUntil = undefined
        changed = true
      }
    }
    return changed
  }

  addAccount(input: AddGeminiAppAccountInput): GeminiAppAccount {
    const email = input.email.trim()
    const accessToken = input.accessToken.trim()
    if (!email) {
      throw new GeminiAppError('Account email is required', 'INVALID_ARGUMENT')
    }
    if (!accessToken) {
      throw new GeminiAppError('Account accessToken is required', 'AUTH_REQUIRED')
    }

    const id = input.id?.trim() || email
    const existingIdx = this.state.accounts.findIndex(
      (a) => a.id === id || a.email.toLowerCase() === email.toLowerCase(),
    )

    const account: GeminiAppAccount = {
      id,
      email,
      accessToken,
      ...(input.masterToken?.trim() ? { masterToken: input.masterToken.trim() } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      status: 'ready',
      errorCount: 0,
    }

    if (existingIdx >= 0) {
      const prev = this.state.accounts[existingIdx]
      this.state.accounts[existingIdx] = {
        ...account,
        id: prev?.id || id,
        ...(prev?.lastUsedAt !== undefined ? { lastUsedAt: prev.lastUsedAt } : {}),
      }
    } else {
      this.state.accounts.push(account)
    }

    this.save()
    const stored = this.state.accounts.find((a) => a.id === (existingIdx >= 0 ? this.state.accounts[existingIdx]?.id : id))
    return { ...(stored || account) }
  }

  removeAccount(id: string): boolean {
    const before = this.state.accounts.length
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id)
    if (this.state.accounts.length === before) {
      return false
    }
    this.save()
    return true
  }

  listAccounts(now: number = Date.now()): GeminiAppAccount[] {
    if (this.recoverExpiredCooldowns(now)) {
      this.save()
    }
    return this.state.accounts.map((a) => ({ ...a }))
  }

  getSummary(now: number = Date.now()): GeminiAppPoolSummary {
    const accounts = this.listAccounts(now)
    const summaries: GeminiAppAccountSummary[] = accounts.map((a) => ({
      id: a.id,
      email: a.email,
      status: a.status,
      hasMasterToken: Boolean(a.masterToken),
      ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}),
      ...(a.cooldownUntil !== undefined ? { cooldownUntil: a.cooldownUntil } : {}),
      ...(a.lastUsedAt !== undefined ? { lastUsedAt: a.lastUsedAt } : {}),
      errorCount: a.errorCount,
      ...(a.lastError !== undefined ? { lastError: a.lastError } : {}),
    }))
    return {
      total: summaries.length,
      ready: summaries.filter((a) => a.status === 'ready').length,
      accounts: summaries,
    }
  }

  selectAccount(now: number = Date.now()): GeminiAppAccount | null {
    if (this.recoverExpiredCooldowns(now)) {
      this.save()
    }
    const ready = this.state.accounts
      .filter((a) => a.status === 'ready')
      .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))

    const chosen = ready[0]
    return chosen ? { ...chosen } : null
  }

  async ensureValidToken(
    account: GeminiAppAccount,
    now: number = Date.now(),
  ): Promise<GeminiAppAccount> {
    const stored = this.state.accounts.find((a) => a.id === account.id)
    const target = stored || account

    const needsRefresh =
      !target.accessToken ||
      (target.expiresAt !== undefined && target.expiresAt <= now + TOKEN_REFRESH_BUFFER_MS)

    if (!needsRefresh) {
      return { ...target }
    }

    if (!target.masterToken) {
      if (target.expiresAt !== undefined && target.expiresAt <= now) {
        this.markAuthRequired(target.id, 'Access token expired and no masterToken is available', now)
        throw new GeminiAppError(
          `Gemini App account ${target.email} access token expired and has no masterToken`,
          'AUTH_REQUIRED',
        )
      }
      return { ...target }
    }

    return this.forceRefreshAccount(target.id)
  }

  async forceRefreshAccount(id: string): Promise<GeminiAppAccount> {
    const target = this.state.accounts.find((a) => a.id === id)
    if (!target) {
      throw new GeminiAppError(`Gemini App account not found: ${id}`, 'AUTH_REQUIRED')
    }
    if (!target.masterToken) {
      this.markAuthRequired(id, 'No masterToken available for silent refresh')
      throw new GeminiAppError(
        `Gemini App account ${target.email} has no masterToken for silent refresh`,
        'AUTH_REQUIRED',
      )
    }

    try {
      const refreshed = await exchangeMasterTokenForAccessToken(
        target.masterToken,
        target.email,
        this.fetchFn,
      )
      target.accessToken = refreshed.accessToken
      target.expiresAt = refreshed.expiresAt
      target.status = 'ready'
      target.errorCount = 0
      target.cooldownUntil = undefined
      target.lastError = undefined
      this.save()
      return { ...target }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof GeminiAppError && err.code === 'AUTH_REQUIRED') {
        this.markAuthRequired(id, message)
      }
      throw err
    }
  }

  markCooldown(id: string, reason: string, now: number = Date.now()): void {
    const target = this.state.accounts.find((a) => a.id === id)
    if (!target) return
    target.errorCount = (target.errorCount || 0) + 1
    const backoffMs = Math.min(
      BASE_COOLDOWN_MS * Math.pow(2, target.errorCount - 1),
      MAX_COOLDOWN_MS,
    )
    target.status = 'cooldown'
    target.cooldownUntil = now + backoffMs
    target.lastUsedAt = now
    target.lastError = reason
    this.save()
  }

  markAuthRequired(id: string, reason: string, now: number = Date.now()): void {
    const target = this.state.accounts.find((a) => a.id === id)
    if (!target) return
    target.errorCount = (target.errorCount || 0) + 1
    target.status = 'auth_required'
    target.cooldownUntil = undefined
    target.lastUsedAt = now
    target.lastError = reason
    this.save()
  }

  markSuccess(id: string, now: number = Date.now()): void {
    const target = this.state.accounts.find((a) => a.id === id)
    if (!target) return
    target.status = 'ready'
    target.errorCount = 0
    target.cooldownUntil = undefined
    target.lastError = undefined
    target.lastUsedAt = now
    this.save()
  }
}
