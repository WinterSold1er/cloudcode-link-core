// Model discovery and projection (spec ADR-10): agy models output ->
// DSH catalog entries. Gemini slugs fold into a base model plus selectable
// reasoning efforts; non-Gemini slugs (claude-*, gpt-oss-* size variants)
// stay verbatim with no effort toggle, matching observed agy behavior
// (agy rejects --effort for Claude/GPT-OSS). Discovery failure falls back to
// a bundled catalog so the /model picker is never empty.
import { DEFAULT_FALLBACK_MODELS, type FallbackModelDef, type ModelModality, type PluginConfig } from './types/config-types.ts'
import type { DiscoveredModelEntry, DiscoveredModelsResponse, ModelUnionSnapshot } from './types/pool-types.ts'
export type { DiscoveredModelEntry, DiscoveredModelsResponse, ModelUnionSnapshot }

export interface RawModel { slug: string; label: string }

export interface CatalogEntry {
  id: string
  name: string
  /** null = fixed-thinking model (no effort flag). */
  efforts: readonly string[] | null
  /** Accepted input modalities (e.g. ['text', 'image']). */
  inputModalities?: readonly ModelModality[]
}

export interface Catalog {
  source: 'discovered' | 'fallback'
  models: readonly CatalogEntry[]
  discoveredAt: number
  /** Last discovery error, surfaced by /agy models and doctor. */
  lastError?: string
  /** Account-level discovery failures for observability. */
  accountFailures?: ReadonlyArray<{ accountId: string; error: string }>
  /** Endpoint-level discovery errors for observability. */
  endpointErrors?: readonly string[]
  /**
   * Catalog provenance: catalog entry id -> the accounts whose last-known model list contains
   * it (directly or through one of its effort / tiered variants). An entry with an empty list
   * cannot be served by any usable account, which is what the request path turns into
   * `MODEL_NOT_AVAILABLE`.
   */
  providers?: Record<string, readonly string[]>
  /** How many accounts the catalog union was composed from. */
  unionAccounts?: number
}

/**
 * Names for ids the server ships without any `displayName`. Their shape follows the labels the
 * server itself uses for the siblings of the same family in the same capture — the capture labels
 * `gemini-4-hydrogen-high` as "Gemini 4 Hydrogen (High)" and `gemini-4-hydrogen-xhigh` as
 * "Gemini 4 Hydrogen (XHigh)" — so the sonar sibling reads alike. The name states nothing about
 * capabilities beyond what the capture reports (`supportsThinking: true`, `thinkingLevel: 1`).
 */
const UNLABELED_MODEL_NAMES: Readonly<Record<string, string>> = {
  'gemini-4-hydrogen-sonar': 'Gemini 4 Hydrogen (Sonar)',
}

function prettifyToken(token: string): string {
  const lower = token.toLowerCase()
  if (lower === 'gpt') return 'GPT'
  if (lower === 'oss') return 'OSS'
  if (/^\d+b$/i.test(lower)) return lower.toUpperCase()
  if (/^\d+(?:\.\d+)?$/.test(token)) return token
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
}

export function prettifyModelSlug(slug: string): string {
  if (!slug) return ''
  const key = slug.trim().toLowerCase()
  const serverName = UNLABELED_MODEL_NAMES[key]
  if (serverName !== undefined) return serverName
  const normalized = slug.trim().replace(/(\d+)-(\d+)/g, '$1.$2')
  const tokens = normalized.split(/[-_]+/)
  return tokens.map(prettifyToken).join(' ')
}

/**
 * Slugs that are never a user-selectable model: server-internal families (`chat_*`, `tab_*`),
 * preview builds, ids the server marks `...-disabled`, and tiered-group ids (`-tiered-`), which
 * fold into their base model instead of appearing on their own.
 * `gemini-4-hydrogen-sonar` is deliberately NOT internal — the server publishes it with live quota
 * and it answers live requests; see the note on MODEL_UNSERVABLE_SUFFIXES in pool.ts.
 */
export function isInternalModel(slug: string): boolean {
  const s = slug.trim().toLowerCase()
  return (
    /^chat_\d+$/i.test(s) ||
    /^tab[_-]/i.test(s) ||
    /_preview$/i.test(s) ||
    /-preview$/i.test(s) ||
    s.includes('-disabled') ||
    s.endsWith('disabled') ||
    /-disabled(?:-|$)/i.test(s) ||
    s.endsWith('-disabled') ||
    s.includes('-disabled-') ||
    /-tiered-/i.test(s)
  )
}

/** Check if a model belongs to the Gemini 4 generation (argon, hydrogen, neon, carbon). */
export function isGemini4Model(modelId: string): boolean {
  const s = modelId.trim().toLowerCase()
  return (
    s.startsWith('gemini-4') ||
    s.includes('hydrogen') ||
    s.includes('argon') ||
    s.includes('neon') ||
    s.includes('carbon')
  )
}

/** Determine if a model requires routing to daily endpoints first (Gemini 4 models). */
export function isDailyEndpointModel(modelId: string): boolean {
  return isGemini4Model(modelId)
}

/** Parse `agy models` stdout: JSON shapes first, then two-column text. */
export function parseModelsOutput(stdout: string): RawModel[] {
  const text = stdout.trim()
  if (text === '') return []
  try {
    const parsed: unknown = JSON.parse(text)
    const list = extractModelList(parsed)
    if (list) return dedupeBySlug(list)
  } catch {
    // fall through to text parsing
  }
  const out: RawModel[] = []
  for (const line of text.split(/\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('Fetching') || t.startsWith('Error') || /^(please sign in|warning|tip:)/i.test(t)) continue
    // agy 1.1.15 prints a TAB-separated two-column table; older builds and
    // some locales use two-or-more spaces.
    const m = t.match(/^(\S+)(?:\t+|\s{2,})(.+)$/)
    if (m && m[1] !== undefined && m[2] !== undefined) {
      if (!isInternalModel(m[1])) out.push({ slug: m[1], label: m[2].trim() });
    } else if (/^\S+$/.test(t)) {
      if (!isInternalModel(t)) out.push({ slug: t, label: prettifyModelSlug(t) });
    }
  }
  return dedupeBySlug(out);
}

/** First occurrence wins: duplicate raw slugs would become duplicate catalog ids. */
function dedupeBySlug(raw: readonly RawModel[]): RawModel[] {
  const seen = new Set<string>()
  const out: RawModel[] = []
  for (const r of raw) {
    if (!r.slug || typeof r.slug !== 'string') continue
    const slug = r.slug.trim()
    if (slug === '' || seen.has(slug)) continue
    seen.add(slug)
    const label = (typeof r.label === 'string' && r.label.trim() !== '' && r.label.trim() !== slug)
      ? r.label.trim()
      : prettifyModelSlug(slug)
    out.push({ slug, label })
  }
  return out
}

/**
 * A model the server published with a live quota but placed in no display group. The gate is
 * explicit server data - a numeric `quotaInfo.remainingFraction` on an entry the server did not
 * mark `disabled` / `enabled: false` / `isInternal` - never a match on the slug's spelling.
 * This is how an upstream-hidden but measurable model (`gemini-4-hydrogen-sonar`) reaches the
 * catalog without inventing a name-based allow list.
 */
function isQuotaPublishedModel(entry: Record<string, unknown> | undefined): boolean {
  if (!entry || typeof entry !== 'object') return false
  if (entry.disabled === true || entry.enabled === false || entry.isInternal === true) return false
  const quota = entry.quotaInfo
  if (!quota || typeof quota !== 'object') return false
  const fraction = (quota as Record<string, unknown>).remainingFraction
  return typeof fraction === 'number' && Number.isFinite(fraction)
}

/** The label the server itself supplies for a models-dict entry, if it supplies one at all. */
function serverDisplayName(entry: Record<string, unknown> | undefined): string {
  if (!entry || typeof entry !== 'object') return ''
  return (typeof entry.displayName === 'string' && entry.displayName.trim() !== '') ? entry.displayName.trim()
    : (typeof entry.display_name === 'string' && entry.display_name.trim() !== '') ? entry.display_name.trim()
    : (typeof entry.modelName === 'string' && entry.modelName.trim() !== '') ? entry.modelName.trim()
    : (typeof entry.name === 'string' && entry.name.trim() !== '') ? entry.name.trim()
    : ''
}

/** Server labels claimed by more than one slug; such a label is not a usable name for any of them. */
function sharedServerLabels(labels: readonly string[]): Set<string> {
  const owners = new Set<string>()
  const shared = new Set<string>()
  for (const label of labels) {
    if (label === '') continue
    if (owners.has(label)) shared.add(label)
    else owners.add(label)
  }
  return shared
}

function extractModelList(parsed: unknown): RawModel[] | null {
  let arr: unknown[] | null = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    const modelsMap = (o.models && typeof o.models === 'object' && !Array.isArray(o.models))
      ? (o.models as Record<string, Record<string, unknown>>)
      : null

    // 1. Authoritative order from agentModelSorts (exact parity with agy models)
    if (Array.isArray(o.agentModelSorts) && o.agentModelSorts.length > 0) {
      const sortedIds: string[] = []
      for (const sortItem of o.agentModelSorts as Array<Record<string, unknown>>) {
        if (Array.isArray(sortItem.groups)) {
          for (const group of sortItem.groups as Array<Record<string, unknown>>) {
            if (Array.isArray(group.modelIds)) {
              for (const mid of group.modelIds) {
                if (typeof mid === 'string' && mid.trim() !== '') sortedIds.push(mid.trim())
              }
            }
          }
        } else if (Array.isArray(sortItem.modelIds)) {
          for (const mid of sortItem.modelIds) {
            if (typeof mid === 'string' && mid.trim() !== '') sortedIds.push(mid.trim())
          }
        }
      }

      if (sortedIds.length > 0) {
        const out: RawModel[] = []
        const seen = new Set<string>()
        const sortLabels: string[] = []
        for (const mid of sortedIds) {
          if (seen.has(mid)) continue
          seen.add(mid)
          if (isInternalModel(mid)) continue
          const entry = modelsMap?.[mid]
          if (entry && (entry.disabled === true || entry.enabled === false)) continue

          const rawLabel = serverDisplayName(entry)
          const label = rawLabel !== '' && rawLabel !== mid ? rawLabel : prettifyModelSlug(mid)
          out.push({ slug: mid, label })
          sortLabels.push(rawLabel)
        }

        // Union step: models the server published with a live quota but placed in no
        // agentModelSorts group. agy's own picker hides them — the measured case is
        // gemini-4-hydrogen-sonar, which carries its own quotaInfo (remainingFraction ~1 and a
        // resetTime) and answers live generation requests, yet appears in no sort group, no
        // tieredModelIds list and no defaultAgentModelId. The gate is therefore the server's own
        // signal (numeric quotaInfo.remainingFraction, no disabled / enabled:false / isInternal
        // flag), never a match on the slug's name. The second accepted signal is
        // `accountListed`: an id some usable account's last-known model list contains, which is
        // how an account's exclusive models survive that account's own failed probe.
        const published: Array<{ slug: string; rawLabel: string }> = []
        for (const [key, entry] of Object.entries(modelsMap ?? {})) {
          const slug = typeof key === 'string' ? key.trim() : ''
          if (slug === '' || seen.has(slug)) continue
          if (!entry || typeof entry !== 'object') continue
          if (!isQuotaPublishedModel(entry) && entry.accountListed !== true) continue
          if (isInternalModel(slug)) continue
          seen.add(slug)
          published.push({ slug, rawLabel: serverDisplayName(entry) })
        }
        const sharedLabels = sharedServerLabels([...sortLabels, ...published.map((p) => p.rawLabel)])
        for (const item of published) {
          const label = item.rawLabel !== '' && item.rawLabel !== item.slug && !sharedLabels.has(item.rawLabel)
            ? item.rawLabel
            : prettifyModelSlug(item.slug)
          out.push({ slug: item.slug, label })
        }
        if (out.length > 0) return out
      }
    }

    // 2. Fallback: traverse models dict if present
    if (modelsMap) {
      const out: RawModel[] = []
      const labelOwners = new Map<string, string>()
      const duplicateLabels = new Set<string>()

      for (const [key, val] of Object.entries(modelsMap)) {
        if (!key || typeof key !== 'string') continue
        const trimmedKey = key.trim()
        if (isInternalModel(trimmedKey)) continue
        const v = (val && typeof val === 'object' ? val : {}) as Record<string, unknown>
        if (v.disabled === true || v.enabled === false) continue
        const rawLabel = serverDisplayName(v)
        if (rawLabel !== '') {
          if (labelOwners.has(rawLabel)) {
            duplicateLabels.add(rawLabel)
          } else {
            labelOwners.set(rawLabel, trimmedKey)
          }
        }
      }

      for (const [key, val] of Object.entries(modelsMap)) {
        if (!key || typeof key !== 'string') continue
        const trimmedKey = key.trim()
        if (isInternalModel(trimmedKey)) continue
        const v = (val && typeof val === 'object' ? val : {}) as Record<string, unknown>
        if (v.disabled === true || v.enabled === false) continue
        const rawLabel =
          (typeof v.displayName === 'string' && v.displayName.trim() !== '') ? v.displayName.trim()
          : (typeof v.display_name === 'string' && v.display_name.trim() !== '') ? v.display_name.trim()
          : (typeof v.modelName === 'string' && v.modelName.trim() !== '') ? v.modelName.trim()
          : (typeof v.name === 'string' && v.name.trim() !== '') ? v.name.trim()
          : ''
        const label = (rawLabel !== '' && rawLabel !== trimmedKey && !duplicateLabels.has(rawLabel))
          ? rawLabel
          : prettifyModelSlug(trimmedKey)
        out.push({ slug: trimmedKey, label })
      }
      return out
    }
    for (const k of ['models', 'items', 'data', 'result']) {
      if (Array.isArray(o[k])) {
        arr = o[k] as unknown[];
        break;
      }
    }
  }
  if (!arr) return null;
  const out: RawModel[] = []
  for (const item of arr) {
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (isInternalModel(trimmed)) continue
      out.push({ slug: trimmed, label: prettifyModelSlug(trimmed) });
      continue;
    }
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const slugV = o.slug ?? o.id ?? o.name ?? o.model;
    if (typeof slugV !== 'string' || slugV.trim() === '') continue
    const trimmedSlug = slugV.trim()
    if (isInternalModel(trimmedSlug)) continue
    if (o.disabled === true || o.enabled === false) continue
    const rawLabel = o.label ?? o.display_name ?? o.displayName ?? o.title;
    const labelStr = (typeof rawLabel === 'string' && rawLabel.trim() !== '' && rawLabel.trim() !== trimmedSlug)
      ? rawLabel.trim()
      : prettifyModelSlug(trimmedSlug)
    out.push({ slug: trimmedSlug, label: labelStr });
  }
  return out;
}

export const EFFORT_SUFFIXES = ['low', 'medium', 'high', 'xhigh'] as const

export function getInputModalitiesForModel(modelId: string): readonly ModelModality[] {
  const wire = resolveModelSlug(modelId).toLowerCase()
  if (wire.startsWith('gpt-oss-')) {
    return ['text']
  }
  return ['text', 'image']
}

export function deriveEffortsForModel(modelId: string): string[] | null {
  const id = modelId.toLowerCase()
  if (id === 'gemini-3.1-pro' || id.startsWith('gemini-3.1-pro')) {
    return ['low', 'high']
  }
  if (id === 'gemini-4-hydrogen' || id.startsWith('gemini-4-hydrogen')) {
    return ['low', 'medium', 'high', 'xhigh']
  }
  if (/^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/i.test(id)) {
    return ['low', 'medium', 'high']
  }
  return null
}

function stripTieredLabel(label: string): string {
  return label.replace(/\s*\((?:Tiered|tiered)\)\s*$/i, '').replace(/\s+(?:Tiered|tiered)\s*$/i, '').trim()
}

/**
 * Guard for Gemini folding. `-tiered` / `-disabled` variants are never a fold target. A
 * `...-sonar` id is NOT a variant of its prefix: it is a model with its own wire id and no effort
 * ladder, so it must survive as its own (verbatim) catalog entry rather than fold into
 * `gemini-4-hydrogen`, which would produce a second entry with the same catalog id.
 */
function isValidGeminiBase(base: string): boolean {
  return !base.includes('-tiered') && !base.includes('-disabled')
}

/** Fold Gemini effort variants into base + effort set (spec ADR-10). */
export function foldEfforts(raw: readonly RawModel[]): CatalogEntry[] {
  const bases = new Map<string, { label: string; efforts: Set<string> }>()
  const verbatim: CatalogEntry[] = []
  const slugSet = new Set(raw.map((r) => r.slug))
  for (const r of raw) {
    if (!r.slug.startsWith('gemini')) {
      const displayLabel = (r.label && r.label.trim() !== '' && r.label.trim() !== r.slug)
        ? r.label.trim()
        : prettifyModelSlug(r.slug)
      verbatim.push({ id: r.slug, name: displayLabel, efforts: null, inputModalities: getInputModalitiesForModel(r.slug) });
      continue;
    }

    if (r.slug.endsWith('-tiered')) {
      const base = r.slug.slice(0, -7)
      if (!isValidGeminiBase(base)) continue
      const inferredEfforts = deriveEffortsForModel(base)
      const cleanLabel = stripTieredLabel(r.label)
      const displayLabel = (cleanLabel !== '' && cleanLabel !== base && cleanLabel !== r.slug)
        ? cleanLabel
        : prettifyModelSlug(base)
      const entry = bases.get(base) ?? {
        label: displayLabel,
        efforts: new Set<string>(),
      }
      if (inferredEfforts) {
        for (const eff of inferredEfforts) entry.efforts.add(eff)
      }
      bases.set(base, entry)
      continue
    }

    let folded = false
    for (const eff of EFFORT_SUFFIXES) {
      const suffix = '-' + eff;
      if (r.slug.endsWith(suffix)) {
        const base = r.slug.slice(0, -suffix.length)
        // Only fold when the base is a real catalog member (either listed
        // bare or via another variant); gpt-oss-120b-medium never reaches here
        // (not gemini), but a lone gemini-x-medium with no siblings stays
        // verbatim rather than inventing a base.
        const hasBare = slugSet.has(base)
        const hasSibling = raw.some(
          (x) => x.slug.startsWith(base + '-') && EFFORT_SUFFIXES.some((e) => x.slug.endsWith('-' + e)) && x.slug !== r.slug,
        );
        if ((hasBare || hasSibling) && isValidGeminiBase(base)) {
          const stripped = stripEffortLabel(r.label, eff)
          const displayLabel = (stripped !== '' && stripped !== base && stripped !== r.slug)
            ? stripped
            : prettifyModelSlug(base)
          const entry = bases.get(base) ?? { label: displayLabel, efforts: new Set<string>() };
          entry.efforts.add(eff)
          bases.set(base, entry)
          folded = true;
          break;
        }
      }
    }
    if (!folded) {
      if (!isValidGeminiBase(r.slug)) continue
      const displayLabel = (r.label && r.label.trim() !== '' && r.label.trim() !== r.slug)
        ? r.label.trim()
        : prettifyModelSlug(r.slug)
      verbatim.push({ id: r.slug, name: displayLabel, efforts: null, inputModalities: getInputModalitiesForModel(r.slug) });
    }
  }
  const folded: CatalogEntry[] = []
  for (const [id, v] of bases) {
    const efforts = EFFORT_SUFFIXES.filter((e) => v.efforts.has(e));
    folded.push({
      id,
      name: (v.label !== '' && v.label !== id) ? v.label : prettifyModelSlug(id),
      efforts: efforts.length > 0 ? efforts : null,
      inputModalities: getInputModalitiesForModel(id),
    });
  }
  // Folded bases first, then verbatim, both stable by original order.
  const rawOrder = new Map(raw.map((r, i) => [r.slug, i] as const))
  const rank = (e: CatalogEntry): number => {
    let best = Infinity;
    for (const r of raw) if (r.slug === e.id || r.slug.startsWith(e.id + '-')) best = Math.min(best, rawOrder.get(r.slug) ?? Infinity)
    return best;
  };
  folded.sort((a, b) => rank(a) - rank(b));
  verbatim.sort((a, b) => rank(a) - rank(b));
  // A bare base listed alongside its variants (agy 1.1.13 shape) is already
  // represented by its folded entry; emitting it verbatim too would duplicate
  // the id and DSH's llm.listModels would reject the whole provider catalog
  // (INVALID_CATALOG), dropping every Antigravity model from the picker.
  return [...folded, ...verbatim.filter((e) => !bases.has(e.id))];
}

function stripEffortLabel(label: string, eff: string): string {
  const re = new RegExp('\\s*\\(?'+ eff +'\\)?\\s*$', 'i')
  return label.replace(re, '').trim()
}

export function buildFallbackCatalog(defs: readonly FallbackModelDef[]): CatalogEntry[] {
  return defs
    .filter((d) => Boolean(d && typeof d.id === 'string' && d.id.trim() !== ''))
    .map((d) => ({
      id: d.id.trim(),
      name: (typeof d.name === 'string' && d.name.trim() !== '') ? d.name.trim() : d.id.trim(),
      efforts: Array.isArray(d.efforts) && d.efforts.length > 0 ? d.efforts.filter((e) => typeof e === 'string' && e.trim() !== '') : null,
      inputModalities: d.inputModalities ?? getInputModalitiesForModel(d.id),
    }));
}

// ---------------------------------------------------------------------------
// Catalog cache with TTL + stale-while-revalidate (pi-bridge pattern).

export type DiscoverResult =
  | DiscoveredModelsResponse
  | RawModel[]
  | { stdout: string; stderr?: string }
  | null
  | undefined

export type DiscoverFn = (signal?: AbortSignal) => Promise<DiscoverResult>

/**
 * Union a discovered catalog with the built-in fallback table.
 *
 * Kept for callers that explicitly want the union (and as the documented shape of
 * the historical behaviour). `ModelCatalog.refresh()` no longer calls it on the
 * success path: a successful discovery is reported as-is, so ids upstream does not
 * serve can never leak into a `source: 'discovered'` catalog.
 */
export function mergeDiscoveredWithFallback(
  discovered: readonly CatalogEntry[],
  fallbackDefs: readonly FallbackModelDef[] = DEFAULT_FALLBACK_MODELS,
): CatalogEntry[] {
  const fallbackEntries = buildFallbackCatalog(fallbackDefs)
  if (discovered.length === 0) return fallbackEntries

  const existingIds = new Set<string>()
  for (const e of discovered) {
    existingIds.add(e.id.toLowerCase())
    const resolved = resolveModelSlug(e.id).toLowerCase()
    existingIds.add(resolved)
  }

  const result = [...discovered]
  for (const fb of fallbackEntries) {
    const fbId = fb.id.toLowerCase()
    const resolvedFbId = resolveModelSlug(fb.id).toLowerCase()
    if (!existingIds.has(fbId) && !existingIds.has(resolvedFbId)) {
      result.push(fb)
      existingIds.add(fbId)
      existingIds.add(resolvedFbId)
    }
  }
  return result
}

/** Raw model entries for a composed cross-account union, filtered like the live payload path. */
function rawFromUnionModels(models: Record<string, DiscoveredModelEntry> | undefined): RawModel[] {
  const out: RawModel[] = []
  for (const [key, entry] of Object.entries(models ?? {})) {
    const slug = typeof key === 'string' ? key.trim() : ''
    if (slug === '' || isInternalModel(slug)) continue
    const record = entry as Record<string, unknown> | undefined
    if (record?.disabled === true || record?.enabled === false || record?.isInternal === true) continue
    out.push({ slug, label: serverDisplayName(record) })
  }
  return out
}

/** True when `slug` is `base` itself or one of its effort / tiered variants. */
function isVariantOf(base: string, slug: string): boolean {
  if (slug === base) return true
  if (!slug.startsWith(base + '-')) return false
  const rest = slug.slice(base.length + 1)
  return rest === 'tiered' || rest.startsWith('tiered-') || (EFFORT_SUFFIXES as readonly string[]).includes(rest)
}

/**
 * Move provenance from raw slugs onto folded entries: a base is served by every account that
 * lists the base or any of its variants, so `gemini-4-hydrogen` inherits the owners of
 * `gemini-4-hydrogen-low` / `-xhigh`, while `gemini-4-hydrogen-sonar` stays its own entry.
 */
function providersForEntries(
  entries: readonly CatalogEntry[],
  providers: Record<string, string[]> | undefined,
): Record<string, readonly string[]> {
  const raw = Object.entries(providers ?? {})
  const out: Record<string, readonly string[]> = {}
  for (const entry of entries) {
    const owners = new Set<string>()
    for (const [slug, accounts] of raw) {
      if (!isVariantOf(entry.id, slug)) continue
      for (const accountId of accounts) owners.add(accountId)
    }
    out[entry.id] = [...owners]
  }
  return out
}

export class ModelCatalog {
  private current: Catalog;
  private refreshing: Promise<void> | null = null;
  private readonly discover?: DiscoverFn;
  private readonly fallbackDefs: readonly FallbackModelDef[];
  private readonly ttlMs: number;
  /** Cheap, network-free source of the cross-account model union (see `recomposeFromUnion`). */
  private readonly unionSource?: () => ModelUnionSnapshot;

  constructor(
    discover?: DiscoverFn,
    fallbackDefs: readonly FallbackModelDef[] = DEFAULT_FALLBACK_MODELS,
    ttlMs: number = 300_000,
    unionSource?: () => ModelUnionSnapshot,
  ) {
    this.discover = discover;
    this.fallbackDefs = fallbackDefs;
    this.ttlMs = ttlMs;
    this.unionSource = unionSource;
    this.current = {
      source: 'fallback',
      models: buildFallbackCatalog(fallbackDefs),
      discoveredAt: 0,
    };
  }

  get(): Catalog {
    return this.current;
  }

  /** Refresh if stale; never throws — failures keep the previous catalog. */
  async refreshIfNeeded(): Promise<void> {
    if (!this.discover) return;
    if (this.refreshing) return this.refreshing;
    const age = Date.now() - this.current.discoveredAt;
    if (this.current.source === 'discovered' && age < this.ttlMs) {
      // Inside the TTL no endpoint is contacted, but the union is folded again from the pool:
      // an account added or refreshed since the last round reaches the picker without waiting
      // for the next discovery.
      if (this.unionSource) this.recomposeFromUnion()
      return;
    }
    this.refreshing = this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async forceRefresh(): Promise<Catalog> {
    if (!this.discover) return this.current;
    await this.refresh();
    return this.current;
  }

  /**
   * Re-fold the cross-account union without contacting an endpoint.
   *
   * The union is read from the pool (`QuotaService.composeAvailableModels`), so an account that
   * was just added, refreshed or removed changes the catalog immediately; an account whose probe
   * is failing keeps contributing its last-known list. `discoveredAt` is deliberately not moved:
   * local re-synthesis is not new information from upstream and must not postpone the next probe.
   */
  private recomposeFromUnion(): void {
    const snapshot = this.unionSource?.()
    if (!snapshot) return
    const raw = rawFromUnionModels(snapshot.models)
    if (raw.length === 0) return
    const folded = foldEfforts(raw)
    const { lastError, accountFailures, endpointErrors } = this.current
    this.current = {
      source: 'discovered',
      models: folded,
      discoveredAt: this.current.discoveredAt,
      providers: providersForEntries(folded, snapshot.providers),
      unionAccounts: snapshot.accounts.length,
      ...(lastError !== undefined ? { lastError } : {}),
      ...(accountFailures ? { accountFailures } : {}),
      ...(endpointErrors ? { endpointErrors } : {}),
    };
  }

  private async refresh(): Promise<void> {
    if (!this.discover) return;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      try {
        const res = await this.discover(ac.signal);
        if (res == null) {
          if (this.current.source === 'fallback') {
            const { lastError: _, ...rest } = this.current;
            this.current = rest;
          }
          return;
        }

        let raw: RawModel[] = []
        if (typeof res === 'object' && 'stdout' in res && typeof res.stdout === 'string') {
          raw = parseModelsOutput(res.stdout);
        } else if (Array.isArray(res)) {
          raw = dedupeBySlug(res);
        } else if (typeof res === 'object' && 'models' in res) {
          const list = extractModelList(res);
          if (list) raw = dedupeBySlug(list);
        }

        const accountFailures =
          typeof res === 'object' && res && 'accountFailures' in res && Array.isArray((res as DiscoveredModelsResponse).accountFailures)
            ? (res as DiscoveredModelsResponse).accountFailures
            : undefined

        const endpointErrors =
          typeof res === 'object' && res && 'endpointErrors' in res && Array.isArray((res as DiscoveredModelsResponse).endpointErrors)
            ? (res as DiscoveredModelsResponse).endpointErrors
            : undefined

        if (raw.length > 0) {
          const folded = foldEfforts(raw);
          const response = (typeof res === 'object' && res && !Array.isArray(res))
            ? (res as DiscoveredModelsResponse)
            : undefined
          const providers = providersForEntries(folded, response?.modelProviders)
          const unionAccounts = Array.isArray(response?.catalogAccounts) ? response.catalogAccounts.length : undefined
          // A discovery answers with the union over every usable account's last-known model
          // list (see QuotaService.discoverAvailableModels): still exactly what upstream
          // serves, never a union with the built-in table, but no longer a snapshot of only
          // the accounts that happened to answer this round. `fallbackDefs` stay the initial
          // catalog (constructor) and the keep-previous-catalog path used when discovery fails.
          const allAccountsFailed = typeof response?.discoveredFromAccounts === 'number'
            && response.discoveredFromAccounts === 0
            && (accountFailures?.length ?? 0) > 0
          this.current = {
            source: 'discovered',
            models: folded,
            discoveredAt: Date.now(),
            ...(response?.modelProviders ? { providers } : {}),
            ...(unionAccounts !== undefined ? { unionAccounts } : {}),
            ...(accountFailures && accountFailures.length > 0 ? { accountFailures } : {}),
            ...(endpointErrors && endpointErrors.length > 0 ? { endpointErrors } : {}),
            ...(allAccountsFailed
              ? { lastError: `models discovery failed for all ${accountFailures!.length} account(s); catalog composed from their last-known model lists` }
              : {}),
          };
          return;
        }
        if (this.current.source === 'fallback') {
          const { lastError: _, ...rest } = this.current;
          this.current = rest;
          return;
        }
        this.current = { ...this.current, lastError: 'models discovery returned no entries' };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.current = { ...this.current, lastError: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function resolveModelSlug(id: string): string {
  const s = id.trim().toLowerCase()
  if (
    s === 'claude-opus-4-6' ||
    s === 'claude-opus-4-8' ||
    s === 'claude-opus' ||
    s === 'claude-opus-4.6' ||
    s === 'claude-opus-4-5' ||
    s === 'opus'
  ) {
    return 'claude-opus-4-6-thinking'
  }
  if (
    s === 'claude-sonnet' ||
    s === 'claude-sonnet-4.6' ||
    s === 'claude-sonnet-4-5' ||
    s === 'sonnet'
  ) {
    return 'claude-sonnet-4-6'
  }
  if (s === 'gpt-oss-120b' || s === 'gpt-oss-20b' || s === 'gpt-oss') {
    return 'gpt-oss-120b-medium'
  }
  return id.trim()
}

export function findEntry(catalog: Catalog, id: string): CatalogEntry | undefined {
  const direct = catalog.models.find((m) => m.id === id);
  if (direct) return direct;
  const resolved = resolveModelSlug(id);
  if (resolved !== id) {
    const directResolved = catalog.models.find((m) => m.id === resolved);
    if (directResolved) return directResolved;
  }
  if (id.endsWith('-tiered')) {
    const base = id.slice(0, -7);
    const baseEntry = catalog.models.find((m) => m.id === base);
    if (baseEntry) return baseEntry;
  }
  return undefined;
}

export function defaultEffortFor(entry: CatalogEntry, cfg: { defaultEffort?: string }): string | undefined {
  if (!entry.efforts || entry.efforts.length === 0) return undefined
  if (cfg.defaultEffort && cfg.defaultEffort !== '' && entry.efforts.includes(cfg.defaultEffort)) return cfg.defaultEffort
  // Default to the highest reasoning effort (high), then fall back down.
  for (const pref of ['high', 'medium', 'low']) {
    if (entry.efforts.includes(pref)) return pref
  }
  return entry.efforts[entry.efforts.length - 1];
}

/**
 * agy (Antigravity CLI) 1.3.5 wire model id -> `exa.codeium_common_pb.Model` enum name,
 * i.e. the value agy puts in `request.labels.model_enum`. Single source of truth;
 * `ANTIGRAVITY_MODEL_ENUM` below is derived from it.
 *
 * Evidence (every row is a measured pair — no `1000 + n` back-computation here):
 *  - agy 1.3.5 binary descriptor: the enum is `exa.codeium_common_pb.Model`, and
 *    `MODEL_PLACEHOLDER_M{n}` carries the value `1000 + n` (1651 placeholder members).
 *    The numbering rule is only used to *read* pairs found elsewhere, never to invent one.
 *  - Per-variant values come from `test/fixtures/fetch-available-models.json`, a real
 *    `FetchAvailableModelsResponse` capture: the map key is the wire model id and
 *    `ModelDetails.model` (field 15) is the enum the server issues for that exact variant
 *    (gemini-4-hydrogen-high -> M525, -medium -> M526, -low -> M527, -xhigh -> M528,
 *    -tiered-high -> M530, -tiered-xhigh -> M531, -sonar -> M578; gemini-4-argon-high -> M417,
 *    -medium -> M418, -low -> M419; gemini-4-carbon-disabled -> M670; gemini-3.5-flash-lite -> M198).
 *  - Family rows (bare ids) come from agy's own `conversations/*.db`, where `model_enum` and the
 *    wire model string appear together: `gemini-4-hydrogen` -> M526,
 *    `gemini-4-argon-medium` / `gemini-4-argon-trial` -> M418. They also serve as the fallback
 *    for a variant the capture does not list.
 *  - Captured upstream request (ops/relink/t2-traffic-findings.md:57/65/121): body
 *    `model: "gemini-4-hydrogen-medium"` with `labels.model_enum = MODEL_PLACEHOLDER_M526`,
 *    which is exactly the `-medium` variant row below — the reason exact variants win.
 *  - The three rows the capture does not carry (`gemini-4-hydrogen`, `gemini-4-argon`,
 *    `gemini-4-argon-trial`) are the pairs written down in ops/relink/t2-model-enum-evidence.md:
 *    read out of agy's own `gen_metadata` blobs (`gemini-4-argon-trial` -> M418 observed; the two
 *    family values derived from the captured `-medium` variant, which the live request pairs with
 *    the same enum). The capture neither lists nor contradicts them.
 *
 * A row exists for every entry the capture serves, and for nothing else: ids with no measured
 * pair (`claude-opus-4-6-thinking`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`,
 * `gemini-3.6-flash-*`, `gemini-3.7-flash-*`, the bare `gemini-3.5-flash` / `gemini-3.8-flash` /
 * `gemini-4-carbon` families, and the five ids whose pairing reviewer2 could not source —
 * `gemini-3.5-flash-extra-low`, `gemini-3.5-flash-low`, `gemini-3-flash-agent`,
 * `gemini-3.1-pro-low`, `gemini-pro-agent`, all five deleted from this table on 2026-11-18)
 * resolve to `undefined` rather than a guess. That bidirectional lock is asserted by
 * test/agy-models-alignment.test.ts.
 *
 * Lookup order: the exact wire id wins, and only a variant the capture does not list falls back
 * to its family row (e.g. `gemini-4-hydrogen-tiered-low` -> M526). Internal variants keep their
 * measured enum here but never reach the catalog (see isInternalModel), so they stay unselectable.
 */
export const AGY_MODEL_ENUM_BY_WIRE_ID: Readonly<Record<string, string>> = {
  // gemini-4-hydrogen: family row + every variant the captured response issues.
  'gemini-4-hydrogen': 'MODEL_PLACEHOLDER_M526',
  'gemini-4-hydrogen-high': 'MODEL_PLACEHOLDER_M525',
  'gemini-4-hydrogen-medium': 'MODEL_PLACEHOLDER_M526',
  'gemini-4-hydrogen-low': 'MODEL_PLACEHOLDER_M527',
  'gemini-4-hydrogen-xhigh': 'MODEL_PLACEHOLDER_M528',
  'gemini-4-hydrogen-tiered-high': 'MODEL_PLACEHOLDER_M530',
  'gemini-4-hydrogen-tiered-xhigh': 'MODEL_PLACEHOLDER_M531',
  'gemini-4-hydrogen-sonar': 'MODEL_PLACEHOLDER_M578',
  // gemini-4-argon: same shape. -trial is its own wire id, not an effort variant.
  'gemini-4-argon': 'MODEL_PLACEHOLDER_M418',
  'gemini-4-argon-high': 'MODEL_PLACEHOLDER_M417',
  'gemini-4-argon-medium': 'MODEL_PLACEHOLDER_M418',
  'gemini-4-argon-low': 'MODEL_PLACEHOLDER_M419',
  'gemini-4-argon-trial': 'MODEL_PLACEHOLDER_M418',
  // gemini-4-carbon is only ever served disabled; no family row is claimed for it.
  'gemini-4-carbon-disabled': 'MODEL_PLACEHOLDER_M670',
  // gemini-3.8-flash: every variant the captured response issues (no bare family row is claimed).
  'gemini-3.8-flash-high': 'MODEL_PLACEHOLDER_M318',
  'gemini-3.8-flash-medium': 'MODEL_PLACEHOLDER_M319',
  'gemini-3.8-flash-low': 'MODEL_PLACEHOLDER_M320',
  'gemini-3.8-flash-tiered': 'MODEL_PLACEHOLDER_M322',
  // Older gemini generations, one row per wire id the capture serves.
  'gemini-3.5-flash-lite': 'MODEL_PLACEHOLDER_M198',
  'gemini-3.1-flash-image': 'MODEL_PLACEHOLDER_M21',
  'gemini-3.1-flash-lite': 'MODEL_PLACEHOLDER_M50',
  'gemini-3-flash': 'MODEL_PLACEHOLDER_M18',
  'gemini-2.5-flash': 'MODEL_GOOGLE_GEMINI_2_5_FLASH',
  'gemini-2.5-flash-lite': 'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
  'gemini-2.5-flash-thinking': 'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
  'gemini-2.5-pro': 'MODEL_GOOGLE_GEMINI_2_5_PRO',
  // Claude 5.5 family as the capture names it. claude-opus-4-6 / -4-8 / sonnet-4-6 / haiku-4-5
  // have no measured enum anywhere yet, so they deliberately have no row (lookupModelEnum
  // returns undefined for them instead of guessing).
  'claude-opus-5-5-high': 'MODEL_PLACEHOLDER_M402',
  'claude-opus-5-5-medium': 'MODEL_PLACEHOLDER_M401',
  'claude-opus-5-5-low': 'MODEL_PLACEHOLDER_M400',
  'claude-sonnet-5-5-high': 'MODEL_PLACEHOLDER_M405',
  'claude-sonnet-5-5-medium': 'MODEL_PLACEHOLDER_M404',
  'claude-sonnet-5-5-low': 'MODEL_PLACEHOLDER_M403',
  'gpt-oss-120b-medium': 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
  // Internal ids: recorded because the capture issues a real enum for them, but isInternalModel
  // keeps them out of the catalog, so they can never be selected.
  'chat_20706': 'MODEL_CHAT_20706',
  'chat_23310': 'MODEL_CHAT_23310',
  'tab_flash_lite_preview': 'MODEL_PLACEHOLDER_M19',
  'tab_jump_flash_lite_preview': 'MODEL_PLACEHOLDER_M28',
  // No row here for `gemini-3.5-flash-extra-low`, `gemini-3.5-flash-low`, `gemini-3-flash-agent`,
  // `gemini-3.1-pro-low` or `gemini-pro-agent` (five rows deleted on 2026-11-18, reviewer2
  // finding B3). They were inherited as "confirmed pairs", and nothing in this repo confirms
  // them: the fixture does not list those wire ids, ops/relink/t2-model-enum-evidence.md evidences
  // only M526/M418, and /usr/bin/agy contains the wire ids (1-3 occurrences each) and
  // placeholder *names* such as MODEL_PLACEHOLDER_M187 (3 occurrences) without ever pairing one
  // name to one wire id. The wire ids themselves are real — ANTIGRAVITY_ROUTING below issues
  // them — so they stay, but their enum is unknown: lookupModelEnum returns undefined and
  // client.ts antigravityRequestEnvelope omits `labels.model_enum` rather than sending a
  // back-computed guess.
}

/**
 * Suffixes agy appends to a family wire id to select a reasoning effort / tier.
 * Longest first so `-tiered-xhigh` peels off before a bare `-xhigh` could match it.
 */
const AGY_MODEL_VARIANT_SUFFIXES: readonly string[] = [
  'tiered-xhigh',
  'tiered-high',
  'tiered-medium',
  'tiered-low',
  'tiered',
  'extra-low',
  'extra-high',
  'xhigh',
  'high',
  'low',
  'medium',
  'minimal',
  'thinking',
  'trial',
  'sonar',
]

/**
 * Resolve the wire model enum (model_enum label) for a wire model id.
 *
 * Exact row first, family row second. `gemini-4-hydrogen-high` (own row, M525) and
 * `gemini-4-hydrogen-tiered-xhigh` (own row, M531) resolve directly and never fall back —
 * a measured suffixed id always keeps its own value. A family row takes over only for a
 * variant the table does not list, by peeling the effort / tier suffixes that belong to the
 * request's `model` string: `gemini-4-hydrogen-tiered-low` and `gemini-4-hydrogen-tiered-medium`
 * -> `MODEL_PLACEHOLDER_M526` (via the `gemini-4-hydrogen` row), `gemini-4-argon-xhigh`
 * -> `MODEL_PLACEHOLDER_M418` (via the `gemini-4-argon` row). Evidence for those family rows:
 * ops/relink/t2-model-enum-evidence.md.
 * Returns `undefined` for a family this repo has no measured pair for (never a guess).
 */
export function lookupModelEnum(wireModelId: string): string | undefined {
  const trimmed = wireModelId.trim().toLowerCase()
  if (trimmed === '') return undefined

  const queue: string[] = [trimmed]
  const visited = new Set<string>()
  for (let i = 0; i < queue.length; i += 1) {
    const candidate = queue[i]
    if (candidate === undefined || candidate === '' || visited.has(candidate)) continue
    visited.add(candidate)

    const hit = AGY_MODEL_ENUM_BY_WIRE_ID[candidate]
    if (hit !== undefined) return hit

    for (const suffix of AGY_MODEL_VARIANT_SUFFIXES) {
      const tail = `-${suffix}`
      if (!candidate.endsWith(tail)) continue
      const base = candidate.slice(0, -tail.length)
      if (base !== '') queue.push(base)
    }
  }
  return undefined
}

/**
 * @deprecated Legacy alias kept for existing imports (client.ts labels); it is now derived
 * from {@link AGY_MODEL_ENUM_BY_WIRE_ID}. New call sites should use {@link lookupModelEnum},
 * which also resolves effort-suffixed wire ids.
 */
export const ANTIGRAVITY_MODEL_ENUM: Record<string, string> = { ...AGY_MODEL_ENUM_BY_WIRE_ID }

export interface AntigravityRouting {
  off?: string
  routing?: Partial<Record<'minimal' | 'low' | 'medium' | 'high' | 'xhigh', string>>
  defaultRequestId?: string
}

export const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {
  'claude-opus-4-6': {
    routing: {
      minimal: 'claude-opus-4-6-thinking',
      low: 'claude-opus-4-6-thinking',
      medium: 'claude-opus-4-6-thinking',
      high: 'claude-opus-4-6-thinking',
    },
    defaultRequestId: 'claude-opus-4-6-thinking',
  },
  'claude-sonnet-4-6': {
    off: 'claude-sonnet-4-6',
    routing: {
      minimal: 'claude-sonnet-4-6',
      low: 'claude-sonnet-4-6',
      medium: 'claude-sonnet-4-6',
      high: 'claude-sonnet-4-6',
      xhigh: 'claude-sonnet-4-6',
    },
    defaultRequestId: 'claude-sonnet-4-6',
  },
  // agy rejects --effort for the Claude families (see the note at the top of this file), so
  // every effort maps to the single confirmed wire id and no effort suffix can leak into it.
  'claude-haiku-4-5': {
    off: 'claude-haiku-4-5',
    routing: {
      minimal: 'claude-haiku-4-5',
      low: 'claude-haiku-4-5',
      medium: 'claude-haiku-4-5',
      high: 'claude-haiku-4-5',
      xhigh: 'claude-haiku-4-5',
    },
    defaultRequestId: 'claude-haiku-4-5',
  },
  // claude-opus-4-8 is a confirmed 1.3.5 wire id, but resolveModelSlug() deliberately aliases
  // it to claude-opus-4-6-thinking (locked by test/models.test.ts:255). The row mirrors that
  // alias so the key exists for the family without changing any request id.
  'claude-opus-4-8': {
    off: 'claude-opus-4-6-thinking',
    routing: {
      minimal: 'claude-opus-4-6-thinking',
      low: 'claude-opus-4-6-thinking',
      medium: 'claude-opus-4-6-thinking',
      high: 'claude-opus-4-6-thinking',
      xhigh: 'claude-opus-4-6-thinking',
    },
    defaultRequestId: 'claude-opus-4-6-thinking',
  },
  // gemini-4 families. Wire ids taken from the agy 1.3.5 string table / captured traffic
  // (gemini-4-hydrogen-low|-medium|-high|-xhigh, gemini-4-argon-low|-medium|-high; there is
  // no -minimal or -xhigh wire id for argon, so minimal falls to -low and xhigh to -high).
  // The default/off id is the one agy itself sends for the family: the captured agent request
  // uses gemini-4-hydrogen-medium (ops/relink/t2-traffic-findings.md:57/108). Must stay in
  // step with deriveEffortsForModel(), which yields low|medium|high|xhigh for hydrogen and
  // low|medium|high for argon.
  'gemini-4-hydrogen': {
    off: 'gemini-4-hydrogen-medium',
    routing: {
      minimal: 'gemini-4-hydrogen-low',
      low: 'gemini-4-hydrogen-low',
      medium: 'gemini-4-hydrogen-medium',
      high: 'gemini-4-hydrogen-high',
      xhigh: 'gemini-4-hydrogen-xhigh',
    },
    defaultRequestId: 'gemini-4-hydrogen-medium',
  },
  // gemini-4-hydrogen-sonar is a model of its own, not a rung of the hydrogen ladder: the capture
  // gives it its own wire id (enum MODEL_PLACEHOLDER_M578) and a fixed `thinkingLevel: 1` with no
  // effort variants, and the live request echoes back `modelVersion: gemini-4-hydrogen-sonar`.
  // Every effort level therefore routes to the same id. Without this row the generic Gemini branch
  // in getAntigravityRequestModelId() appends an effort and invents `gemini-4-hydrogen-sonar-low`,
  // a wire id agy has never advertised.
  'gemini-4-hydrogen-sonar': {
    off: 'gemini-4-hydrogen-sonar',
    routing: {
      minimal: 'gemini-4-hydrogen-sonar',
      low: 'gemini-4-hydrogen-sonar',
      medium: 'gemini-4-hydrogen-sonar',
      high: 'gemini-4-hydrogen-sonar',
      xhigh: 'gemini-4-hydrogen-sonar',
    },
    defaultRequestId: 'gemini-4-hydrogen-sonar',
  },
  // Legacy models that reach the catalog through the server-side signal union (they appear in the
  // captured FetchAvailableModels response with their own quotaInfo and their own base enum row:
  // gemini-3-flash -> M18, gemini-3.5-flash-lite -> M198, gemini-3.1-flash-image -> M21,
  // gemini-3.1-flash-lite -> M50) but for which agy has never published an effort variant: none of
  // `gemini-3-flash-low|-medium|-xhigh`, `gemini-3.5-flash-lite-*`, `gemini-3.1-flash-image-*` or
  // `gemini-3.1-flash-lite-*` exists in the 1.3.5 string table or in any captured request.
  // Measured on the bare slug instead: each of the four answers HTTP 200 with SSE text, echoes
  // `modelVersion` equal to the requested id, and finishes STOP (one call per id on n0tdx free tier
  // and once on pqxkh standard tier). So identity routing is the evidenced mapping, and these rows
  // exist for exactly that reason: without them the generic Gemini branch in
  // getAntigravityRequestModelId() appends an effort and invents a wire id agy has never advertised,
  // which pairs a non-existent request string with the base enum (M18/M198/M21/M50) and answers
  // 400/403, quarantining the account for 5-30 min. No effort suffix may be fabricated here.
  'gemini-3-flash': {
    off: 'gemini-3-flash',
    routing: {
      minimal: 'gemini-3-flash',
      low: 'gemini-3-flash',
      medium: 'gemini-3-flash',
      high: 'gemini-3-flash',
      xhigh: 'gemini-3-flash',
    },
    defaultRequestId: 'gemini-3-flash',
  },
  'gemini-3.5-flash-lite': {
    off: 'gemini-3.5-flash-lite',
    routing: {
      minimal: 'gemini-3.5-flash-lite',
      low: 'gemini-3.5-flash-lite',
      medium: 'gemini-3.5-flash-lite',
      high: 'gemini-3.5-flash-lite',
      xhigh: 'gemini-3.5-flash-lite',
    },
    defaultRequestId: 'gemini-3.5-flash-lite',
  },
  'gemini-3.1-flash-image': {
    off: 'gemini-3.1-flash-image',
    routing: {
      minimal: 'gemini-3.1-flash-image',
      low: 'gemini-3.1-flash-image',
      medium: 'gemini-3.1-flash-image',
      high: 'gemini-3.1-flash-image',
      xhigh: 'gemini-3.1-flash-image',
    },
    defaultRequestId: 'gemini-3.1-flash-image',
  },
  'gemini-3.1-flash-lite': {
    off: 'gemini-3.1-flash-lite',
    routing: {
      minimal: 'gemini-3.1-flash-lite',
      low: 'gemini-3.1-flash-lite',
      medium: 'gemini-3.1-flash-lite',
      high: 'gemini-3.1-flash-lite',
      xhigh: 'gemini-3.1-flash-lite',
    },
    defaultRequestId: 'gemini-3.1-flash-lite',
  },
  // gemini-2.5-flash / -flash-lite / -flash-thinking / -pro need no row: the generic branch leaves a
  // `gemini-2.` id untouched (the version regex starts at 3), so they are already sent as bare slugs.
  // gemini-2.5-pro does resolve upstream but answers 503 MODEL_CAPACITY_EXHAUSTED (error_number 2010),
  // which is an upstream capacity state, not a routing problem - inventing an effort variant for it
  // would hide that, so it stays a bare slug.
  'gemini-4-argon': {
    off: 'gemini-4-argon-medium',
    routing: {
      minimal: 'gemini-4-argon-low',
      low: 'gemini-4-argon-low',
      medium: 'gemini-4-argon-medium',
      high: 'gemini-4-argon-high',
      xhigh: 'gemini-4-argon-high',
    },
    defaultRequestId: 'gemini-4-argon-medium',
  },
  'gemini-3.1-pro': {
    off: 'gemini-3.1-pro-low',
    routing: {
      minimal: 'gemini-3.1-pro-low',
      low: 'gemini-3.1-pro-low',
      medium: 'gemini-3.1-pro-low',
      high: 'gemini-pro-agent',
      xhigh: 'gemini-pro-agent',
    },
    defaultRequestId: 'gemini-3.1-pro-low',
  },
  'gemini-3.8-flash': {
    off: 'gemini-3.8-flash-low',
    routing: {
      minimal: 'gemini-3.8-flash-low',
      low: 'gemini-3.8-flash-low',
      medium: 'gemini-3.8-flash-medium',
      high: 'gemini-3.8-flash-high',
      xhigh: 'gemini-3.8-flash-high',
    },
    defaultRequestId: 'gemini-3.8-flash-low',
  },
  'gemini-3.7-flash': {
    off: 'gemini-3.7-flash-low',
    routing: {
      minimal: 'gemini-3.7-flash-low',
      low: 'gemini-3.7-flash-low',
      medium: 'gemini-3.7-flash-medium',
      high: 'gemini-3.7-flash-high',
      xhigh: 'gemini-3.7-flash-high',
    },
    defaultRequestId: 'gemini-3.7-flash-low',
  },
  'gemini-3.6-flash': {
    off: 'gemini-3.6-flash-low',
    routing: {
      minimal: 'gemini-3.6-flash-low',
      low: 'gemini-3.6-flash-low',
      medium: 'gemini-3.6-flash-medium',
      high: 'gemini-3.6-flash-high',
      xhigh: 'gemini-3.6-flash-high',
    },
    defaultRequestId: 'gemini-3.6-flash-low',
  },
  'gemini-3.5-flash': {
    off: 'gemini-3.5-flash-extra-low',
    routing: {
      minimal: 'gemini-3.5-flash-extra-low',
      low: 'gemini-3.5-flash-extra-low',
      medium: 'gemini-3.5-flash-low',
      high: 'gemini-3-flash-agent',
      xhigh: 'gemini-3-flash-agent',
    },
    defaultRequestId: 'gemini-3.5-flash-extra-low',
  },
  'gpt-oss-120b': {
    off: 'gpt-oss-120b-medium',
    routing: {
      minimal: 'gpt-oss-120b-medium',
      low: 'gpt-oss-120b-medium',
      medium: 'gpt-oss-120b-medium',
      high: 'gpt-oss-120b-medium',
    },
    defaultRequestId: 'gpt-oss-120b-medium',
  },
}

export const RUNTIME_MAX_OUTPUT_TOKENS: Record<string, number> = {
  'gemini-3.8-flash': 65536,
  'gemini-3.8-flash-tiered': 65536,
  'gemini-3.8-flash-low': 65536,
  'gemini-3.8-flash-medium': 65536,
  'gemini-3.8-flash-high': 65536,
  'gemini-3.7-flash': 65536,
  'gemini-3.7-flash-tiered': 65536,
  'gemini-3.7-flash-low': 65536,
  'gemini-3.7-flash-medium': 65536,
  'gemini-3.7-flash-high': 65536,
  'gemini-3.6-flash': 65536,
  'gemini-3.6-flash-low': 65536,
  'gemini-3.6-flash-medium': 65536,
  'gemini-3.6-flash-high': 65536,
  'gemini-3.5-flash': 65536,
  'gemini-3.5-flash-extra-low': 65536,
  'gemini-3.5-flash-low': 65536,
  'gemini-3-flash-agent': 65536,
  'gemini-3.1-pro': 65535,
  'gemini-3.1-pro-low': 65535,
  'gemini-3.1-pro-high': 65535,
  'gemini-pro-agent': 65535,
  'gemini-3-flash': 65536,
  'gemini-2.5-pro': 65535,
  'gemini-2.5-flash': 65536,
  'gemini-2.5-flash-lite': 65536,
  'gemini-2.5-flash-thinking': 65536,
  'gemini-3.1-flash-lite': 65536,
  'gemini-3.1-flash-image': 65536,
  'claude-opus-4-6': 64000,
  'claude-opus-4-6-thinking': 64000,
  'claude-sonnet-4-6': 64000,
  'gpt-oss-120b': 32768,
  'gpt-oss-120b-medium': 32768,
}

export function getMaxOutputTokens(modelId: string, runtimeModel?: string): number {
  if (runtimeModel && RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel]!
  }
  if (RUNTIME_MAX_OUTPUT_TOKENS[modelId] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[modelId]!
  }
  if (runtimeModel) {
    if (runtimeModel.startsWith('claude-')) return 64000
    if (runtimeModel.startsWith('gpt-oss-')) return 32768
    if (runtimeModel.startsWith('gemini-3.1-pro') || runtimeModel === 'gemini-pro-agent') return 65535
    if (runtimeModel.startsWith('gemini-')) return 65536
  }
  return 8192
}

export function getAntigravityRequestModelId(modelId: string, effort?: string): string {
  const resolvedId = resolveModelSlug(modelId)
  const r = ANTIGRAVITY_ROUTING[resolvedId] ?? ANTIGRAVITY_ROUTING[modelId]
  if (!r) {
    const isWireModel =
      resolvedId.endsWith('-low') ||
      resolvedId.endsWith('-medium') ||
      resolvedId.endsWith('-high') ||
      resolvedId.endsWith('-xhigh') ||
      resolvedId.endsWith('-tiered') ||
      resolvedId.endsWith('-extra-low') ||
      resolvedId.endsWith('-thinking')
    if ((isGemini4Model(resolvedId) || /^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/i.test(resolvedId)) && !isWireModel) {
      if (effort && effort !== 'off' && ['low', 'medium', 'high', 'xhigh'].includes(effort.toLowerCase())) {
        return `${resolvedId}-${effort.toLowerCase()}`
      }
      return `${resolvedId}-low`
    }
    return resolvedId
  }

  if (effort === undefined || effort === 'off' || effort === '') {
    return r.off ?? r.routing?.minimal ?? r.routing?.low ?? r.defaultRequestId ?? resolvedId
  }

  const effortKey = effort.toLowerCase() as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  return (
    r.routing?.[effortKey] ??
    r.routing?.high ??
    r.routing?.low ??
    r.routing?.minimal ??
    r.off ??
    r.defaultRequestId ??
    resolvedId
  )
}

export function getFallbackRuntimeModel(runtimeModel: string, effort?: string): string | undefined {
  if (runtimeModel === 'gemini-3.8-flash-tiered') {
    return getAntigravityRequestModelId('gemini-3.7-flash', effort)
  }
  if (runtimeModel.startsWith('gemini-3.8-flash-')) {
    return runtimeModel.replace('gemini-3.8-flash-', 'gemini-3.7-flash-')
  }
  if (runtimeModel === 'gemini-3.8-flash') {
    return 'gemini-3.7-flash-low'
  }
  if (runtimeModel === 'gemini-3.7-flash-tiered') {
    return getAntigravityRequestModelId('gemini-3.6-flash', effort)
  }
  if (runtimeModel.startsWith('gemini-3.7-flash-')) {
    return runtimeModel.replace('gemini-3.7-flash-', 'gemini-3.6-flash-')
  }
  if (runtimeModel === 'gemini-3.7-flash') {
    return 'gemini-3.6-flash-low'
  }
  return undefined
}

export type GeminiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'

export interface ThinkingWire {
  includeThoughts?: boolean
  thinkingLevel?: GeminiThinkingLevel
  thinkingBudget?: number
}

function googleLevel(effort: string | undefined): GeminiThinkingLevel {
  if (effort === 'high' || effort === 'xhigh') return 'HIGH'
  if (effort === 'medium') return 'MEDIUM'
  return 'LOW'
}

export function getThinkingConfig(modelId: string, effort?: string): ThinkingWire | undefined {
  if (
    modelId === 'gemini-3.8-flash' ||
    modelId === 'gemini-3.7-flash' ||
    modelId === 'gemini-3.6-flash' ||
    (/^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/i.test(modelId) &&
      !modelId.startsWith('gemini-3.5') &&
      !modelId.startsWith('gemini-3.1'))
  ) {
    return { includeThoughts: true, thinkingLevel: googleLevel(effort) }
  }
  if (modelId === 'gemini-3.5-flash') {
    if (!effort || effort === 'off') return { includeThoughts: false, thinkingBudget: 0 }
    const thinkingBudget =
      effort === 'high' || effort === 'xhigh' ? 10_000 : effort === 'medium' ? 4_000 : 1_000
    return { includeThoughts: true, thinkingBudget }
  }
  if (modelId === 'gemini-3.1-pro') {
    if (!effort || effort === 'off') return { includeThoughts: false, thinkingBudget: 0 }
    return {
      includeThoughts: true,
      thinkingBudget: effort === 'high' || effort === 'xhigh' ? 10_001 : 1_001,
    }
  }
  return undefined
}


