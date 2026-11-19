// Domain types and models for the Antigravity Multi-Account Pool & Sequential Drain.

export type ModelFamily = 'google' | 'anthropic' | 'openai' | 'unknown'

/** Map a model slug to its backend quota counter family. */
export function modelFamilyOf(modelId?: string): ModelFamily {
  if (!modelId) return 'unknown'
  const id = modelId.toLowerCase()
  if (id.startsWith('claude-') || id.includes('claude')) return 'anthropic'
  if (id.startsWith('gemini-') || id.startsWith('gemma-') || id.includes('gemini')) return 'google'
  if (id.startsWith('gpt-') || id.startsWith('openai/') || id.includes('gpt-oss')) return 'openai'
  return 'unknown'
}

export interface ModelQuotaInfo {
  modelId: string
  displayName?: string
  remainingFraction?: number
  resetTime?: string
}

export interface FamilyQuotaInfo {
  /** 5-hour rolling remaining quota fraction: 0.0 (exhausted) to 1.0 (full). */
  remainingFraction?: number
  /** ISO-8601 timestamp for when the 5-hour quota window resets. */
  resetTime?: string
  /** Weekly remaining quota fraction: 0.0 (exhausted) to 1.0 (full). */
  weeklyFraction?: number
  /** ISO-8601 timestamp for when the weekly quota resets. */
  weeklyResetTime?: string
  /** Description / tooltip from upstream backend */
  description?: string
  /** Timestamp when this quota was last updated locally. */
  updatedAt?: number
  /** Optional model-level breakdown in this family. */
  models?: ModelQuotaInfo[]
}

export interface FamilyCooldownState {
  /** Timestamp when cooldown expires and account becomes available again. */
  cooldownUntil: number
  /** Reason for cooldown (e.g. "429 Rate Limit", "Quota Exhausted"). */
  reason: string
  /** Consecutive rate-limit failure count (for exponential/tiered backoff). */
  consecutiveFailures: number
}

export interface ManagedAccount {
  id: string
  alias: string
  email?: string
  /**
   * Absolute path to the isolated account home directory. Empty for the
   * primary/system account: agy stores credentials in the Keychain,
   * so the primary account keeps the real system HOME.
   */
  dir: string
  /**
   * True when this account rides the real system HOME (no HOME injection).
   */
  systemHome?: boolean
  /** Optional custom proxy URL override (e.g. "socks5://127.0.0.1:7890"). */
  proxyUrl?: string
  enabled: boolean
  /** Whether this account is pinned by user as the locked preferred account. */
  pinned?: boolean
  createdAt: number
  lastUsedAt?: number
  /** Set to true when OAuth token refresh fails with invalid_grant or authentication is rejected. */
  authRequired?: boolean
  /** Last authentication failure reason. */
  authError?: string
  /** Cooldown state tracked per model family. */
  cooldowns: Partial<Record<ModelFamily, FamilyCooldownState>>
  /** Cached real-time quota statistics per model family. */
  quotas: Partial<Record<ModelFamily, FamilyQuotaInfo>>
}

export type AccountHealthStatus = 'healthy' | 'cooldown' | 'auth_required' | 'disabled'

export interface AccountHealthInfo {
  status: AccountHealthStatus
  message?: string
  cooldownMs?: number
}

export interface FamilyStatus {
  hasAccount: boolean
  suppressed: boolean
  reason?: 'quota_exhausted' | 'rate_limited' | 'auth_required' | 'disabled' | 'no_accounts' | string
  resetInMs: number | null
}

/**
 * Whether the background quota poller should touch this account at all.
 */
export function shouldPollAccount(account: ManagedAccount): boolean {
  if (!account.enabled) return false
  if (account.authRequired) return false
  const now = Date.now()
  for (const cd of Object.values(account.cooldowns)) {
    if (cd && cd.cooldownUntil > now) return false
  }
  return true
}

/** Compute real-time health indicator for an account. */
export function getAccountHealth(account: ManagedAccount, family: ModelFamily = 'google'): AccountHealthInfo {
  if (!account.enabled) return { status: 'disabled', message: 'Account disabled' }
  if (account.authRequired) return { status: 'auth_required', message: account.authError || 'Authentication required' }
  const cd = account.cooldowns[family]
  if (cd && cd.cooldownUntil > Date.now()) {
    return {
      status: 'cooldown',
      message: cd.reason,
      cooldownMs: cd.cooldownUntil - Date.now(),
    }
  }
  return { status: 'healthy' }
}

export interface AccountPoolData {
  version: 1
  mode: 'sequential' | 'round-robin'
  defaultCooldownMs: number
  maxCooldownMs: number
  primaryAccountId?: string
  /** User-pinned account ID with absolute selection priority. */
  pinnedAccountId?: string
  /** Currently active account id per model family for sticky sequential drain */
  activeAccountIds?: Partial<Record<ModelFamily, string>>
  accounts: ManagedAccount[]
}

export function defaultPoolData(): AccountPoolData {
  return {
    version: 1,
    mode: 'sequential',
    defaultCooldownMs: 15 * 60 * 1000, // 15 minutes
    maxCooldownMs: 60 * 60 * 1000,    // 60 minutes
    accounts: [],
  }
}

export interface DiscoveredModelEntry {
  quotaInfo?: {
    remainingFraction?: number
    resetTime?: string
  }
  displayName?: string
  modelName?: string
  disabled?: boolean
  enabled?: boolean
  /**
   * Set by `QuotaService` on entries that come from an account's last-known model list
   * (pool.json `accounts[].quotas[fam].models`, or a model payload that account answered
   * with earlier). It marks the id as "some still-usable account was last seen serving
   * this", which is what keeps an account's exclusive models in the catalog when that
   * account's own probe times out this round.
   */
  accountListed?: true
}

/** One account's contribution to the composed catalog union. */
export interface ModelUnionAccount {
  accountId: string
  /** Number of model ids this account contributed. */
  models: number
  /** 'probed' = answered during the discovery round that produced this snapshot. */
  origin: 'probed' | 'last-known'
}

/**
 * Cross-account model union: the cheap, network-free synthesis the catalog is built from.
 * `models` is keyed by model id, `providers` maps a model id to the account ids whose
 * last-known list contains it.
 */
export interface ModelUnionSnapshot {
  models: Record<string, DiscoveredModelEntry>
  providers: Record<string, string[]>
  accounts: ModelUnionAccount[]
}

export interface DiscoveredModelsResponse {
  models?: Record<string, DiscoveredModelEntry>
  agentModelSorts?: Array<{
    displayName?: string
    groups?: Array<{
      displayName?: string
      modelIds?: string[]
    }>
    modelIds?: string[]
  }>
  defaultAgentModelId?: string
  /** Cross-account discovery bookkeeping (set by discoverAvailableModels only). */
  discoveredFromAccounts?: number
  discoveredAccountFailures?: number
  discoveredSkippedOverBudget?: number
  accountFailures?: Array<{ accountId: string; error: string }>
  endpointErrors?: string[]
  /**
   * Accounts that made up the returned `models` union, including the ones whose probe failed
   * this round and contributed their last-known list instead. Set by `discoverAvailableModels`
   * and `composeAvailableModels`.
   */
  catalogAccounts?: ModelUnionAccount[]
  /** How many accounts contributed to `models` (`catalogAccounts.length`). */
  unionAccounts?: number
  /** model id -> ids of the accounts whose last-known model list contains it. */
  modelProviders?: Record<string, string[]>
  /**
   * Accounts whose probe answered but carried no model list at all: their roster was kept
   * unchanged rather than wiped. Kept separate from `accountFailures` so a payload-shape
   * problem is never counted as an upstream failure.
   */
  rosterKeptAccounts?: string[]
}

