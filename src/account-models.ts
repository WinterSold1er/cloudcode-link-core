/**
 * account-models.ts — the normalized "which grayscale models does this account actually
 * support" view, built only from what a quota refresh recorded on the account itself
 * (`account.quotas[family].models`, written by `QuotaService.refreshAccountQuota`).
 *
 * Contract rules the GUI relies on:
 *  - Nothing is invented. A family whose `models` array is missing or empty is reported as
 *    `known: false` with `models: []`; the global model catalog is never consulted here, so a
 *    model the backend never granted to this account can never appear in the answer.
 *  - Ordering is stable: families come back in `MODEL_FAMILY_ORDER`, models in ascending id
 *    order. The same account renders the same list in the same order every time, which keeps
 *    the UI diffless and makes the function testable.
 *  - One entry per (family, modelId): the more informative record wins, and when both records
 *    carry a remaining fraction the smaller (more conservative) one wins.
 *  - Family attribution follows the recorded quota key, corrected by `modelFamilyOf(id)` when
 *    the key is `unknown` or contradicts the model id.
 *  - Pure: the account is read, never written; no I/O, no clock. Callers own their refresh —
 *    see `handleAccountModels`, which injects it as a dependency.
 */
import {
  modelFamilyOf,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from './types/pool-types.ts'

/** Rendering order for the family list: named providers first, undetermined last. */
export const MODEL_FAMILY_ORDER: readonly ModelFamily[] = ['google', 'anthropic', 'openai', 'unknown']

/** One model this account is entitled to, as recorded by the last quota refresh. */
export interface AccountModelEntry {
  /** Wire model id, e.g. `gemini-4-hydrogen-medium`. */
  id: string
  /** Backend display name when upstream provided one, otherwise the id itself. */
  name: string
  /** Family this model was attributed to after `modelFamilyOf` correction. */
  family: ModelFamily
  /** Remaining quota fraction for this model, when upstream reported one. */
  remainingFraction?: number
  /** ISO-8601 reset timestamp for this model, when upstream reported one. */
  resetTime?: string
}

/** Family-level quota summary copied from `FamilyQuotaInfo`, minus internal-only fields. */
export interface AccountFamilyQuota {
  remainingFraction?: number
  weeklyFraction?: number
  resetTime?: string
  weeklyResetTime?: string
  updatedAt?: number
}

/** What this account is known to support inside one family. */
export interface AccountFamilyModels {
  family: ModelFamily
  /** False when the account has no recorded model list for this family (nothing to show). */
  known: boolean
  /** Family quota summary, present only when the account actually has quota data for it. */
  quota?: AccountFamilyQuota
  models: AccountModelEntry[]
}

/** The whole per-account catalog, in `MODEL_FAMILY_ORDER`. */
export interface AccountModelCatalog {
  /** True when at least one family has a recorded model list. */
  known: boolean
  /** Deduplicated model ids across every family. */
  total: number
  /** Newest `quota.updatedAt` across the families, or null when nothing was refreshed. */
  refreshedAt: number | null
  familyModels: AccountFamilyModels[]
}

const FAMILY_KEYS: readonly string[] = MODEL_FAMILY_ORDER

function isModelFamily(value: string): value is ModelFamily {
  return FAMILY_KEYS.includes(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** How much optional detail an entry carries: display name, reset time, remaining fraction. */
function infoWeight(entry: AccountModelEntry): number {
  let weight = 0
  if (entry.name !== entry.id) weight += 1
  if (entry.resetTime !== undefined) weight += 1
  if (entry.remainingFraction !== undefined) weight += 1
  return weight
}

/**
 * True when `candidate` should replace `current` for the same model id in the same family.
 * A concrete remaining fraction beats a missing one, a smaller fraction beats a bigger one
 * (more conservative about what is left), and otherwise the richer record wins. Ties keep the
 * record already seen, so the result does not depend on upstream array order.
 */
function preferModel(current: AccountModelEntry, candidate: AccountModelEntry): boolean {
  const known = current.remainingFraction
  const incoming = candidate.remainingFraction
  if (known !== undefined && incoming !== undefined && known !== incoming) {
    return incoming < known
  }
  if ((incoming !== undefined) !== (known !== undefined)) {
    return incoming !== undefined
  }
  return infoWeight(candidate) > infoWeight(current)
}

/** Copy the family quota summary, dropping fields upstream never filled in. */
function familyQuotaSummary(info: FamilyQuotaInfo | undefined): AccountFamilyQuota | undefined {
  if (!info || typeof info !== 'object') return undefined
  const summary: AccountFamilyQuota = {}
  const remainingFraction = finiteNumber(info.remainingFraction)
  if (remainingFraction !== undefined) summary.remainingFraction = remainingFraction
  const weeklyFraction = finiteNumber(info.weeklyFraction)
  if (weeklyFraction !== undefined) summary.weeklyFraction = weeklyFraction
  const resetTime = trimmedString(info.resetTime)
  if (resetTime !== undefined) summary.resetTime = resetTime
  const weeklyResetTime = trimmedString(info.weeklyResetTime)
  if (weeklyResetTime !== undefined) summary.weeklyResetTime = weeklyResetTime
  const updatedAt = finiteNumber(info.updatedAt)
  if (updatedAt !== undefined) summary.updatedAt = updatedAt
  return Object.keys(summary).length > 0 ? summary : undefined
}

/**
 * Normalize one account's recorded model entitlements. Read-only: `account` is never mutated,
 * every returned object is freshly built, and no clock or I/O is touched.
 */
export function describeAccountModels(account: ManagedAccount): AccountModelCatalog {
  const quotas = account.quotas ?? {}
  const byFamily = new Map<ModelFamily, Map<string, AccountModelEntry>>()

  const bucketFor = (family: ModelFamily): Map<string, AccountModelEntry> => {
    let bucket = byFamily.get(family)
    if (!bucket) {
      bucket = new Map()
      byFamily.set(family, bucket)
    }
    return bucket
  }

  // Any recorded key is walked (a malformed key still describes real models), but the family a
  // model lands in is the key only when it agrees with `modelFamilyOf(id)`.
  for (const [rawKey, info] of Object.entries(quotas)) {
    if (!info || typeof info !== 'object') continue
    const declared: ModelFamily = isModelFamily(rawKey) ? rawKey : 'unknown'
    const models = Array.isArray(info.models) ? info.models : []
    for (const raw of models) {
      if (!raw || typeof raw !== 'object') continue
      const id = trimmedString(raw.modelId)
      if (!id) continue
      const detected = modelFamilyOf(id)
      const family = declared !== 'unknown' && detected === declared ? declared : detected

      const entry: AccountModelEntry = { id, name: trimmedString(raw.displayName) ?? id, family }
      const remainingFraction = finiteNumber(raw.remainingFraction)
      if (remainingFraction !== undefined) entry.remainingFraction = remainingFraction
      const resetTime = trimmedString(raw.resetTime)
      if (resetTime !== undefined) entry.resetTime = resetTime

      const bucket = bucketFor(family)
      const seen = bucket.get(id)
      if (!seen || preferModel(seen, entry)) bucket.set(id, entry)
    }
  }

  const familyModels: AccountFamilyModels[] = []
  let total = 0
  for (const family of MODEL_FAMILY_ORDER) {
    const bucket = byFamily.get(family)
    const models = bucket
      ? [...bucket.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : []
    const described: AccountFamilyModels = { family, known: models.length > 0, models }
    const quota = familyQuotaSummary(quotas[family])
    if (quota !== undefined) described.quota = quota
    total += models.length
    familyModels.push(described)
  }

  let refreshedAt: number | null = null
  for (const family of MODEL_FAMILY_ORDER) {
    const updatedAt = finiteNumber(quotas[family]?.updatedAt)
    if (updatedAt !== undefined && (refreshedAt === null || updatedAt > refreshedAt)) {
      refreshedAt = updatedAt
    }
  }

  return {
    known: familyModels.some((f) => f.known),
    total,
    refreshedAt,
    familyModels,
  }
}

/** A request as it arrives off the wire: the values are untrusted query/body fields. */
export interface AccountModelsRequest {
  /** Account id, from the GET query string or the POST JSON body. */
  id?: unknown
  /** Ask for a live quota refresh before describing the account (POST body). */
  refresh?: unknown
}

/** Everything the handler is allowed to reach for — injected so tests can fake both. */
export interface AccountModelsDeps {
  getAccount: (id: string) => ManagedAccount | undefined
  /** Typically `QuotaService.refreshAccountQuota(account, true)`. Absent = refresh unsupported. */
  refreshQuota?: (account: ManagedAccount) => unknown
}

/** Status + JSON body, ready for `sendJson`. No HTTP types, so it is testable without a server. */
export interface AccountModelsResponse {
  status: number
  body: Record<string, unknown>
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

/**
 * The single code path behind `GET|POST /plugins/cloudcode-link/pool/account-models`.
 *
 * Framework-free on purpose: it takes its account lookup and its refresh as dependencies and
 * returns `{ status, body }`, so the route in `src/index.ts` and the unit tests in
 * `test/account-models-api.test.ts` exercise the same logic instead of a re-implemented copy.
 *
 * A failed refresh never turns into a 500: the account's previously recorded data is still
 * worth showing, so the response stays 200 with `refreshError` alongside it.
 */
export async function handleAccountModels(
  req: AccountModelsRequest,
  deps: AccountModelsDeps,
): Promise<AccountModelsResponse> {
  const id = trimmedString(req.id)
  if (!id) return { status: 400, body: { ok: false, error: 'id_required' } }

  const found = deps.getAccount(id)
  if (!found) return { status: 404, body: { ok: false, error: 'account_not_found' } }

  let account = found
  let refreshError: string | undefined
  const wantsRefresh = req.refresh === true || req.refresh === 'true'
  if (wantsRefresh) {
    if (deps.refreshQuota) {
      try {
        await deps.refreshQuota(account)
      } catch (err: unknown) {
        refreshError = errorMessage(err)
      }
      // A refresh can rewrite the recorded identity (email/alias) and replace the quota
      // objects, so re-resolve the account instead of trusting the pre-refresh reference.
      account = deps.getAccount(id) ?? account
    } else {
      refreshError = 'refresh_unavailable'
    }
  }

  const catalog = describeAccountModels(account)
  const alias = trimmedString(account.alias)
  const email = trimmedString(account.email)

  const body: Record<string, unknown> = {
    ok: true,
    id: account.id,
    ...(alias !== undefined ? { alias } : {}),
    ...(email !== undefined ? { email } : {}),
    known: catalog.known,
    total: catalog.total,
    refreshedAt: catalog.refreshedAt,
    familyModels: catalog.familyModels,
    ...(refreshError !== undefined ? { refreshError } : {}),
  }

  return { status: 200, body }
}
