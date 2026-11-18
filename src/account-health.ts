/**
 * account-health.ts — the runtime wiring for the scope-aware auth helpers in oauth.ts.
 *
 * `oauth.ts` knows how to record a grant (`granted_scopes` on the credential document)
 * and how to judge it (`needsReauth` / `missingScopes`), but nothing outside `oauth.ts`
 * consulted that knowledge. An account whose token predates the `aicode` scope therefore
 * stayed invisible in `/ccl accounts` and in the GUI, and the only symptom was a bare
 * 401/403 from the upstream.
 *
 * This module is the wiring layer: it turns a `ManagedAccount` plus its credential
 * document into a verdict a caller can show, and it formats the one sentence the user
 * has to act on. It is deliberately read-only:
 *
 *   - it never disables an account and never drops it from the pool — a missing scope
 *     narrows what the account can serve, the existing grant is still valid for
 *     everything it was actually authorized to do;
 *   - it never invents a grant. An account whose document records no scope set is
 *     reported through `needsReauth`'s own rule (unrecorded grant => re-auth prompt),
 *     which is `oauth.ts`'s documented semantics, not this module's guess.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { LEGACY_AGY_SCOPES, missingScopes, needsReauth, normalizeScopes, readGrantedScopes } from './oauth.ts'
import type { AccountPoolData, ManagedAccount } from './types/pool-types.ts'

/**
 * Where agy keeps the credential document inside an account home. Mirrors
 * `QuotaService.getTokenFilePath` (quota.ts) and `writeAgyTokenFile` (oauth.ts) —
 * the three must agree or the verdict is read off the wrong file.
 */
export const AGY_TOKEN_FILE_SEGMENTS: readonly string[] = [
  '.gemini',
  'antigravity-cli',
  'antigravity-oauth-token',
]

/** The command the user has to run to widen a grant. Single source for every message. */
export const REAUTH_COMMAND = '/ccl auth'

/** The fields of a `ManagedAccount` that decide where its credential lives. */
export type AccountHome = Pick<ManagedAccount, 'dir' | 'systemHome'>

/** Verdict a caller can render: is a re-auth needed, and what exactly is missing. */
export interface AccountAuthHealth {
  /** True when the recorded grant does not cover `AGY_SCOPES` (an unrecorded grant counts as not covering it). */
  reauthRequired: boolean
  /** Required scopes absent from the recorded grant, in `AGY_SCOPES` order. */
  missingScopes: string[]
}

/** A `ManagedAccount` plus the auth fields the account list publishes. */
export type AccountWithAuthHealth = ManagedAccount & AccountAuthHealth

/** `AccountPoolData` with every account annotated, as served to the GUI. */
export type PoolDataWithAuthHealth = Omit<AccountPoolData, 'accounts'> & {
  accounts: AccountWithAuthHealth[]
  /** How many accounts need `/ccl auth`; lets a list header warn without scanning rows. */
  accountsNeedingReauth: number
}

/** Home directory whose `.gemini` tree holds this account's credential. */
export function accountHomeDir(account: AccountHome, systemHome: string = homedir()): string {
  return account.systemHome || !account.dir ? systemHome : account.dir
}

/** Absolute path of the agy credential document for this account. */
export function agyTokenFilePath(account: AccountHome, systemHome?: string): string {
  return join(accountHomeDir(account, systemHome), ...AGY_TOKEN_FILE_SEGMENTS)
}

/** Parse the account's credential document; undefined when absent or unreadable. */
export function readAccountTokenDocument(
  account: AccountHome,
  systemHome?: string,
): Record<string, unknown> | undefined {
  const file = agyTokenFilePath(account, systemHome)
  try {
    if (!existsSync(file)) return undefined
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Scope set this account was actually authorized with, as recorded on its credential
 * document. `undefined` means "not recorded" — the same distinction `readGrantedScopes`
 * makes, and the trigger for `needsReauth`.
 */
export function readAccountGrantedScopes(
  account: AccountHome,
  systemHome?: string,
): string[] | undefined {
  return readGrantedScopes(readAccountTokenDocument(account, systemHome))
}

/**
 * Judge an explicit grant snapshot. No I/O: the pure entry point for callers and tests.
 *
 * The missing set is computed against the grant `needsReauth` actually judges. A snapshot
 * that normalizes to nothing — an absent key, `null`, `[]`, `''` — is "no scope recorded",
 * and `oauth.ts` judges that case against `LEGACY_AGY_SCOPES` (the set AGY_SCOPES held
 * before `aicode` was added), so the reported gap is `aicode`. Listing all six scopes as
 * missing would claim evidence the credential document never recorded.
 */
export function authHealthFromScopes(
  granted: readonly string[] | string | null | undefined,
): AccountAuthHealth {
  const recorded = normalizeScopes(granted)
  return {
    reauthRequired: needsReauth(granted),
    missingScopes: missingScopes(recorded.length === 0 ? LEGACY_AGY_SCOPES : recorded),
  }
}

/**
 * The verdict for one account. Pass `grantedScopes` to judge a snapshot you already hold;
 * omit it to read the account's own credential document (`systemHome` overrides the home a
 * system-home account resolves to, which is what makes this callable in a sandbox).
 */
export function describeAccountAuth(
  account: AccountHome,
  grantedScopes?: readonly string[] | string | null,
  systemHome?: string,
): AccountAuthHealth {
  return authHealthFromScopes(
    grantedScopes === undefined ? readAccountGrantedScopes(account, systemHome) : grantedScopes,
  )
}

/** `https://www.googleapis.com/auth/aicode` -> `auth/aicode`, for a readable one-liner. */
export function scopeLabel(scope: string): string {
  return scope.replace(/^https?:\/\/[^/]+\//, '')
}

/**
 * The sentence the user must end up reading: which account, which scopes are missing,
 * and the command that fixes it. Built from `health.missingScopes`, never from a
 * fixed string, so a different gap produces a different sentence.
 */
export function reauthGuidance(health: AccountAuthHealth, accountLabel?: string): string {
  const who = accountLabel ? `account ${accountLabel}` : 'this account'
  const missing =
    health.missingScopes.length > 0
      ? health.missingScopes.map(scopeLabel).join(', ')
      : 'the scopes Antigravity requires'
  const plural = health.missingScopes.length > 1 ? 's' : ''
  return (
    `Google authorization for ${who} is missing scope${plural} ${missing} — ` +
    `re-authorize ${who} with \`${REAUTH_COMMAND}\`. The account stays in the pool for the scopes it does have.`
  )
}

/**
 * HTTP statuses for which a narrow Google grant is a credible cause, so the re-auth
 * sentence is worth attaching: 401 says the credential was rejected, 403 says the
 * credential is valid but not entitled — which is exactly what a missing scope looks
 * like from the client side. Anything else (429, 5xx, timeout) is not an authorization
 * verdict and must not be dressed up as one.
 */
export const REAUTH_CANDIDATE_STATUSES: readonly number[] = [401, 403]

/** One failed attempt, in the shape this module needs. Field-compatible with the adapter's `AttemptFailure`. */
export interface AuthFailureContext {
  /** HTTP status the upstream answered for this account. */
  status: number
  /** Grant snapshot for that account; omit to read its credential document. */
  grantedScopes?: readonly string[] | string | null
  /** Home a system-home account resolves to; omit to use the process home directory. */
  systemHome?: string
}

/**
 * The re-auth sentence for one failed attempt, or `undefined` when this failure is not
 * an authorization gap. Callers (the adapter's 401/403 branches) attach the result to the
 * failure they already record, so the user reads "re-run /ccl auth for this account"
 * instead of a bare "authentication failed".
 */
export function reauthGuidanceFor(
  account: AccountHome & { id?: string; alias?: string },
  failure: AuthFailureContext,
): string | undefined {
  if (!REAUTH_CANDIDATE_STATUSES.includes(failure.status)) return undefined
  const health = describeAccountAuth(account, failure.grantedScopes, failure.systemHome)
  if (!health.reauthRequired) return undefined
  return reauthGuidance(health, account.alias || account.id)
}

/** What the failover loop hands over for one attempt. */
export interface AttemptFailureLike {
  readonly httpStatus: number | null
}

/**
 * Build the per-attempt resolver the failover loop asks for: `accountId` -> the sentence, or
 * `undefined`. The adapter cannot decide this itself — a 403 is either "this account does not
 * serve this model" or "this grant is missing a scope", and only the recorded credential grant
 * can tell them apart. Registration hands the adapter the resolver built here.
 */
export function reauthGuidanceResolver(
  lookup: (accountId: string) => AccountHome & { id?: string; alias?: string } | undefined,
  systemHome?: string,
): (accountId: string, failure: AttemptFailureLike) => string | undefined {
  return (accountId, failure) => {
    if (failure.httpStatus === null) return undefined
    const account = lookup(accountId)
    if (!account) return undefined
    return reauthGuidanceFor(account, { status: failure.httpStatus, systemHome })
  }
}

/** Annotate one account with the fields the account list publishes. */
export function withAccountAuthHealth(
  account: ManagedAccount,
  grantedScopes?: readonly string[] | string | null,
  systemHome?: string,
): AccountWithAuthHealth {
  return { ...account, ...describeAccountAuth(account, grantedScopes, systemHome) }
}

/**
 * Annotate a whole pool payload for the account-list API. The account objects keep every
 * field they had; `reauthRequired` / `missingScopes` are added on top, and the count is
 * published so a list header can warn without walking the rows.
 */
export function describePoolAuthHealth(
  data: AccountPoolData,
  grantedOf?: (account: ManagedAccount) => readonly string[] | string | null | undefined,
  systemHome?: string,
): PoolDataWithAuthHealth {
  const accounts = data.accounts.map((account) =>
    withAccountAuthHealth(
      account,
      grantedOf ? grantedOf(account) : undefined,
      systemHome,
    ),
  )
  return {
    ...data,
    accounts,
    accountsNeedingReauth: accounts.filter((account) => account.reauthRequired).length,
  }
}
