import { createHash, randomUUID } from 'node:crypto'
import { agyFetch } from './net.ts'
import { lookupModelEnum, isDailyEndpointModel } from './models.ts'
import { buildAgyCliUserAgent } from './quota.ts'
import { fnv1a64Signed } from './sessions.ts'

export const DEFAULT_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
export const ENDPOINT_FALLBACKS: readonly string[] = [
  'https://daily-cloudcode-pa.googleapis.com',
  DEFAULT_ENDPOINT,
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
]

/* ──────────────────────────────────────────────────────────────────────────────
 * Antigravity CLI (agy 1.3.5) protocol constants.
 *
 * Field numbers and enum member names come from the protobuf descriptors recovered
 * from the /usr/bin/agy 1.3.5 binary (see ops/relink/t2-binary-findings.md), and the
 * wire shapes are cross-checked against the live capture summary in
 * ops/relink/t2-traffic-findings.md plus the recorded loadCodeAssist payloads in
 * ops/relink/t3-evidence/. Anything without a binary literal is labelled as a
 * client-side default so nobody later mistakes it for a wire-verified constant.
 * ─────────────────────────────────────────────────────────────────────────── */

/** LoadCodeAssistRequest.mode — 0 MODE_UNSPECIFIED / 1 FULL_ELIGIBILITY_CHECK / 2 HEALTH_CHECK. */
export const AGY_LOAD_MODE = {
  /** What agy itself sends: protojson drops default-valued enums, and the captured
   *  loadCodeAssist body (`{"metadata":{"ideType":"ANTIGRAVITY"}}`) carries no mode field. */
  unspecified: 'MODE_UNSPECIFIED',
  /** Ask for the full entitlement view (allowedTiers / ineligibleTiers). */
  eligibilityCheck: 'FULL_ELIGIBILITY_CHECK',
  /** Liveness probe variant used by keepalive style callers. */
  healthCheck: 'HEALTH_CHECK',
} as const

/** ClientMetadata.ideType — IdeType enum member (JSON uses the bare member name). This is the
 *  only ClientMetadata member agy sets: every captured request body is exactly
 *  `{"metadata":{"ideType":"ANTIGRAVITY"}}` (38 bytes, t2-traffic-findings.md). */
export const AGY_IDE_TYPE = 'ANTIGRAVITY'

/** The other ClientMetadata members stay unset, exactly as agy leaves them — proto3 drops unset
 *  fields from JSON. Recorded so nobody re-invents them: `PLATFORM_LINUX`, the value this client
 *  used to put in the now-deleted `Client-Metadata` header, is not a member of
 *  ClientMetadata.Platform, whose full member list (read out of the FileDescriptorProto embedded in
 *  the binary) is PLATFORM_UNSPECIFIED, DARWIN_AMD64, DARWIN_ARM64, LINUX_AMD64, LINUX_ARM64,
 *  WINDOWS_AMD64. IdeType's members are IDE_UNSPECIFIED, VSCODE, INTELLIJ,
 *  VSCODE_CLOUD_WORKSTATION, INTELLIJ_CLOUD_WORKSTATION, CLOUD_SHELL, CIDER, CLOUD_RUN,
 *  ANDROID_STUDIO, ANTIGRAVITY, JETSKI, COLAB, FIREBASE, CHROME_DEVTOOLS, GEMINI_CLI; PluginType's
 *  are PLUGIN_UNSPECIFIED, CLOUD_CODE, GEMINI, AIPLUGIN_INTELLIJ, AIPLUGIN_STUDIO, PANTHEON.
 *  updateChannel (field 5) and duetProject (field 6) are plain strings with no proto default, and
 *  agy sends neither. */

/** CLI version the HTTP User-Agent advertises when ANTIGRAVITY_CLI_VERSION is not pinned. */
export const AGY_CLI_VERSION = '1.3.5'

export type AgyLoadMode = (typeof AGY_LOAD_MODE)[keyof typeof AGY_LOAD_MODE]

/** Body fields of the generation request, exactly as captured: `requestType` is the lowercase
 *  `agent` for the main conversation and `checkpoint` for session-title requests, and
 *  `userAgent` is the short name `antigravity` (not the full HTTP User-Agent). */
export const AGY_REQUEST_TYPE = {
  agent: 'agent',
  checkpoint: 'checkpoint',
} as const
export type AgyRequestType = (typeof AGY_REQUEST_TYPE)[keyof typeof AGY_REQUEST_TYPE]
/** The two verbs this client knows, widened only enough that a caller can pass another lowercase
 *  verb it has evidence for - the capture also shows `TUI_STREAMED` for TUI mode, which this client
 *  never chooses on its own. Uppercase legacy values such as the old `'AGENT'` are excluded. */
export type AgyRequestVerb = AgyRequestType | Lowercase<string>
export const AGY_WIRE_USER_AGENT = 'antigravity'

/* Request headers, per the same capture (t2-traffic-findings.md §2.2, the union of 67 flows is
 * only Host, User-Agent, Authorization, Content-Type, Accept-Encoding, Content-Length,
 * Proxy-Connection, Accept, Transfer-Encoding, Cookie): nothing else. So this client sends no
 * `Client-Metadata` header — the single hit for that string in the binary is a local file name,
 * client-metadata.json — and it sends no `X-Goog-Api-Client` header either, because the value used
 * here before, 'google-cloud-sdk vscode_cloudshelleditor/0.1', has zero hits in the agy binary and
 * was copied from a different Google client. The HTTP User-Agent stays the one agy really sends,
 * built by quota.ts buildAgyCliUserAgent(): `antigravity/cli/<ver> (aidev_client; os_type=…;
 * arch=…; cl=998863838; auth_method=consumer)`, captured byte-for-byte at t2-traffic-findings.md:41. */

/** Tier ids are data, not constants: the only ones seen in live loadCodeAssist payloads are
 *  `free-tier`, `standard-tier` and `g1-pro-tier` (ops/relink/t3-evidence/b1-lca-antigravity),
 *  and the binary contains no `TIER_FREE` literal. These markers only classify what the
 *  response returned; the tierId sent to onboardUser always comes from the response itself. */
const AGY_TIER_FREE_MARKER = 'free'
const AGY_TIER_TRIAL_MARKER = 'trial'
/** Known paid tiers, best first. Ids not listed here still qualify, they just rank lower. */
export const AGY_TIER_PREFERENCE: readonly string[] = ['g1-pro-tier', 'standard-tier']

/** Wire-model prefix that marks a Gemini model for the `used_non_gemini_model` label. */
const GEMINI_WIRE_MODEL_PREFIX = 'gemini'

/** onboardUser is a long-running operation; polling stays bounded so a slow LRO can never
 *  block a generation request (ops/tests can retune via the ANTIGRAVITY_ONBOARD_POLL_* envs). */
const ONBOARD_POLL_INTERVAL_MS = 2_000
const ONBOARD_POLL_MAX_ATTEMPTS = 12
const ONBOARD_POLL_DEADLINE_MS = 60_000
/** The descriptor does not pin down the request message behind onboardUserBackgroundTasks,
 *  so both protojson shapes are attempted with a hard attempt cap. */
const BACKGROUND_TASK_MAX_ATTEMPTS = 3

const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000
const PROJECT_CACHE_MAX_ENTRIES = 32
/** Seed used when a caller gives no alias: the same value quota.ts calls AGY_PROJECT_FALLBACK_SEED. */
const DEFAULT_PROJECT_SEED = 'antigravity-default'

/**
 * One resolved project id, plus the honest record of where it came from.
 *
 * `synthesized` is `true` when no upstream response named the id and it is this repo's own
 * `defaultProjectId(seedOrEmail)` derivation (the sha1-shaped `stableProjectId`), and `false`
 * when loadCodeAssist, the eligibility view or onboardUser actually handed the id to us.
 * A synthesized id is derived *from the seed*, so it is only meaningful for the exact
 * (token, seed) pair it was written under and must never be presented as a backend-named project.
 */
interface ProjectCacheEntry {
  projectId: string
  expiresAt: number
  info?: LoadCodeAssistInfo
  synthesized: boolean
}

/**
 * `ensureProject` results, keyed by token AND seed — the same `${token}\u0000${seed}` identity
 * quota.ts already uses for its own in-flight lookup map (quota.ts:679).
 *
 * Keying by token alone was the defect reviewer2 reproduced: `ensureProject(t, 'alias-A')`
 * synthesized sha1("antigravity:alias-A"), cached it under `t`, and `ensureProject(t, 'alias-B')`
 * returned that same id with zero loadCodeAssist calls — which quota.ts then credited to the
 * backend and sent as `{"project": "<A's derived id>"}` for account B.
 */
const projectCache = new Map<string, ProjectCacheEntry>()

/**
 * Projects an upstream response really named, keyed by token only (the plain `loadCodeAssist`
 * lookup has no seed to key on). A backend-named project belongs to the account, so sharing it
 * across seeds is legitimate and avoids a second round-trip; a synthesized id is *never* stored
 * here, which is structurally what stops `loadCodeAssist` from handing an invented id back as if
 * it had been discovered.
 */
const discoveredProjectCache = new Map<string, ProjectCacheEntry>()

/** Cache identity for one project lookup. Mirrors quota.ts's `${accessToken}\u0000${seed}` key. */
function projectCacheKey(token: string, seed: string): string {
  return `${token}\u0000${seed}`
}

const MODEL_CACHE_TTL_MS = 30 * 60 * 1000
const modelCache = new Map<string, { result: DynamicModelInfo | undefined; expiresAt: number }>()
const inFlightModelLookups = new Map<string, Promise<DynamicModelInfo | undefined>>()

const DISCOVERY_TIMEOUT_MS = 10_000

export interface DynamicModelInfo {
  id: string
  experiments?: string[]
  apiProvider?: string
  modelProvider?: string
}

export type GeminiTextPart = { text: string; thoughtSignature?: string }
export type GeminiInlineDataPart = { inlineData: { mimeType: string; data: string } }
export type GeminiThoughtPart = { thought: true; text: string; thoughtSignature?: string }
export type GeminiFunctionCallPart = {
  functionCall: {
    name: string
    args: Record<string, unknown>
    id?: string
  }
  thoughtSignature?: string
}
export type GeminiFunctionResponsePart = {
  functionResponse: {
    name: string
    response: { error: string } | { output: string }
    id?: string
  }
}
export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiThoughtPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  parametersJsonSchema?: Record<string, unknown>
}

export interface GeminiToolConfig {
  functionCallingConfig: {
    mode: 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED'
  }
}

export interface GeminiGenerationConfig {
  temperature?: number
  maxOutputTokens?: number
  thinkingConfig?: {
    includeThoughts?: boolean
    thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'
    thinkingBudget?: number
  }
}

export interface GeminiRequestBody {
  contents: GeminiContent[]
  systemInstruction?: {
    parts: GeminiTextPart[]
  }
  generationConfig?: GeminiGenerationConfig
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[]
  toolConfig?: GeminiToolConfig
  sessionId?: string
  labels?: Record<string, string>
}

/** Top-level body of `v1internal:streamGenerateContent`. Declared in the order the captured flows
 *  serialize it — project, requestId, request, model, userAgent, requestType — because
 *  JSON.stringify follows the insertion order of the object literal that builds it. */
export interface AntigravityGenerateRequest {
  project: string
  requestId: string
  request: GeminiRequestBody
  model: string
  userAgent: typeof AGY_WIRE_USER_AGENT
  requestType: AgyRequestVerb
}

export function endpointCandidates(customBaseUrl?: string): string[] {
  const explicit = customBaseUrl?.trim() || process.env.ANTIGRAVITY_BASE_URL?.trim()
  if (explicit) {
    return [explicit.replace(/\/+$/, '')]
  }
  return [...ENDPOINT_FALLBACKS]
}

/**
 * Return endpoint candidates prioritized for the requested model.
 * Gemini 4 generation models (argon, hydrogen, etc.) are strictly routed daily-first
 * because production endpoints return HTTP 429 for Gemini 4 requests.
 */
export function getEndpointCandidatesForModel(model: string, customBaseUrl?: string): string[] {
  const explicit = customBaseUrl?.trim() || process.env.ANTIGRAVITY_BASE_URL?.trim()
  if (explicit) {
    return [explicit.replace(/\/+$/, '')]
  }
  if (isDailyEndpointModel(model)) {
    return [
      'https://daily-cloudcode-pa.googleapis.com',
      'https://daily-cloudcode-pa.sandbox.googleapis.com',
      DEFAULT_ENDPOINT,
    ]
  }
  return [...ENDPOINT_FALLBACKS]
}

const LOG_PREFIX = '[agy-client]'

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * HTTP User-Agent, byte-for-byte the one agy sends (t2-traffic-findings.md:41):
 * `antigravity/cli/<version> (aidev_client; os_type=…; arch=…; cl=998863838; auth_method=consumer)`.
 * ANTIGRAVITY_CLI_VERSION stays the knob for pinning another CLI version.
 */
function defaultUserAgent(): string {
  const pinned = process.env.ANTIGRAVITY_CLI_VERSION?.trim()
  return buildAgyCliUserAgent(pinned || AGY_CLI_VERSION)
}

/** ClientMetadata as agy fills it: `ideType` is the only member it sets, which is why every
 *  captured request body is exactly `{"metadata":{"ideType":"ANTIGRAVITY"}}`. */
export interface AgyClientMetadata {
  ideType: string
}

export function agyClientMetadata(): AgyClientMetadata {
  return { ideType: AGY_IDE_TYPE }
}

export function antigravityHeaders(token: string): Record<string, string> {
  // The header set agy's own flows show (raw dumps: Host, User-Agent, Transfer-Encoding or
  // Content-Length, Authorization, Content-Type, Accept-Encoding). `Client-Metadata` and
  // `X-Goog-Api-Client` are dropped because agy sends neither — and neither does it send an `Accept`
  // header, the SSE flavour being requested by the `?alt=sse` query instead. Host and
  // Content-Length are supplied by fetch itself.
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': defaultUserAgent(),
  }
}

export function stableProjectId(seed: string): string {
  const bytes = createHash('sha1').update(`antigravity:${seed}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function defaultProjectId(seed = 'antigravity-default'): string {
  return process.env.ANTIGRAVITY_PROJECT_ID?.trim() || stableProjectId(seed)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function extractProjectId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  const direct =
    data.antigravityProjectId ??
    data.projectId ??
    data.backendProjectId ??
    data.userDefinedCloudaicompanionProject ??
    data.cloudaicompanionProject ??
    data.project ??
    data.id
  const directId = asString(direct)
  if (directId) return directId
  if (isRecord(direct)) {
    const nestedId = asString(direct.id) ?? asString(direct.name) ?? extractProjectId(direct)
    if (nestedId) return nestedId
  }
  for (const key of ['projects', 'projectIds', 'cloudaicompanionProjects']) {
    const value = data[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractProjectId(item)
        if (nested) return nested
        const itemId = asString(item)
        if (itemId) return itemId
        if (isRecord(item)) {
          const id = asString(item.id) ?? asString(item.projectId) ?? asString(item.project)
          if (id) return id
        }
      }
    }
  }
  return undefined
}

export async function listCloudAICompanionProjects(
  token: string,
  proxyUrl?: string,
  customEndpoints?: string[],
): Promise<string | undefined> {
  const endpoints = customEndpoints && customEndpoints.length ? customEndpoints : endpointCandidates()
  for (const endpoint of endpoints) {
    try {
      const res = await agyFetch(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
        method: 'POST',
        headers: antigravityHeaders(token),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      }, proxyUrl)
      if (!res.ok) continue
      const data: unknown = await res.json().catch(() => ({}))
      const proj = extractProjectId(data)
      if (proj) return proj
    } catch {
      // try next endpoint
    }
  }
  return undefined
}

/** A `UserTier` of the loadCodeAssist response (`allowedTiers[]`, `currentTier`, `paidTier`). */
export interface AgyUserTier {
  id?: string
  name?: string
  description?: string
  isDefault?: boolean
  /** Seen on paid/GCP-backed tiers (`standard-tier`) in recorded payloads. */
  userDefinedCloudaicompanionProject?: boolean
  /** Seen on paid/GCP-backed tiers (`standard-tier`) in recorded payloads. */
  usesGcpTos?: boolean
}

/** One `ineligibleTiers[]` entry. A non-empty list is a client-side gate, not an HTTP error:
 *  a restricted account still gets 200 and the decision belongs here (t2-traffic-findings.md). */
export interface AgyIneligibleTier {
  tierId?: string
  tierName?: string
  reasonCode?: string
  reasonMessage?: string
}

/** The parts of LoadCodeAssistResponse that decide the project id and the onboardUser tierId. */
export interface LoadCodeAssistInfo {
  projectId?: string
  currentTier?: AgyUserTier
  allowedTiers: AgyUserTier[]
  ineligibleTiers: AgyIneligibleTier[]
  paidTier?: AgyUserTier
  paidTierId?: string
  gcpManaged?: boolean
  /** Recorded payloads spell this `upgradeSubscriptionUri`; `manageSubscriptionUri` is accepted too. */
  subscriptionUri?: string
  /** First ineligible reason code, kept so a skipped onboarding can be explained. */
  ineligibleReason?: string
}

function parseTier(value: unknown): AgyUserTier | undefined {
  if (!isRecord(value)) return undefined
  const tier: AgyUserTier = {}
  const id = asString(value.id)
  if (id) tier.id = id
  const name = asString(value.name)
  if (name) tier.name = name
  const description = asString(value.description)
  if (description) tier.description = description
  if (typeof value.isDefault === 'boolean') tier.isDefault = value.isDefault
  if (typeof value.userDefinedCloudaicompanionProject === 'boolean') {
    tier.userDefinedCloudaicompanionProject = value.userDefinedCloudaicompanionProject
  }
  if (typeof value.usesGcpTos === 'boolean') tier.usesGcpTos = value.usesGcpTos
  return tier.id ? tier : undefined
}

function parseTierList(value: unknown): AgyUserTier[] {
  if (!Array.isArray(value)) return []
  const tiers: AgyUserTier[] = []
  for (const entry of value) {
    const tier = parseTier(entry)
    if (tier) tiers.push(tier)
  }
  return tiers
}

function parseIneligibleTier(value: unknown): AgyIneligibleTier | undefined {
  if (!isRecord(value)) return undefined
  const entry: AgyIneligibleTier = {}
  const tierId = asString(value.tierId)
  if (tierId) entry.tierId = tierId
  const tierName = asString(value.tierName)
  if (tierName) entry.tierName = tierName
  const reasonCode = asString(value.reasonCode)
  if (reasonCode) entry.reasonCode = reasonCode
  const reasonMessage = asString(value.reasonMessage)
  if (reasonMessage) entry.reasonMessage = reasonMessage
  return Object.keys(entry).length > 0 ? entry : undefined
}

/** Pure (network-free) parser for LoadCodeAssistResponse, kept separate so the tier/eligibility
 *  decisions can be tested against recorded payloads. */
export function parseLoadCodeAssistResponse(data: unknown): LoadCodeAssistInfo {
  const info: LoadCodeAssistInfo = { allowedTiers: [], ineligibleTiers: [] }
  if (!isRecord(data)) return info
  const projectId = extractProjectId(data)
  if (projectId) info.projectId = projectId
  const currentTier = parseTier(data.currentTier)
  if (currentTier) info.currentTier = currentTier
  info.allowedTiers = parseTierList(data.allowedTiers)
  for (const entry of Array.isArray(data.ineligibleTiers) ? data.ineligibleTiers : []) {
    const parsed = parseIneligibleTier(entry)
    if (parsed) info.ineligibleTiers.push(parsed)
  }
  const paidTier = parseTier(data.paidTier)
  if (paidTier?.id) {
    info.paidTier = paidTier
    info.paidTierId = paidTier.id
  }
  if (typeof data.gcpManaged === 'boolean') info.gcpManaged = data.gcpManaged
  const subscriptionUri =
    asString(data.manageSubscriptionUri) ??
    asString(data.upgradeSubscriptionUri) ??
    (isRecord(data.paidTier) ? asString(data.paidTier.upgradeSubscriptionUri) : undefined)
  if (subscriptionUri) info.subscriptionUri = subscriptionUri
  const firstBlocker = info.ineligibleTiers[0]
  if (firstBlocker?.reasonCode) info.ineligibleReason = firstBlocker.reasonCode
  return info
}

/** Free / trial tiers, classified from the tier id itself (`free-tier`, `…-trial`). */
export function isFreeTierId(tierId: string): boolean {
  const id = tierId.trim().toLowerCase()
  return id.includes(AGY_TIER_FREE_MARKER) || id.includes(AGY_TIER_TRIAL_MARKER)
}

function tierScore(tier: AgyUserTier, paidTierId: string | undefined, currentTierId: string | undefined): number {
  const id = tier.id?.trim().toLowerCase() ?? ''
  let score = 0
  // The tier the server declares this account already pays for.
  if (paidTierId && id === paidTierId) score += 4
  // The tier the account currently holds (its entitlement is the safest one to reuse).
  if (currentTierId && id === currentTierId) score += 3
  // Known paid tiers, best first; ids the server invents later simply score 0 here.
  const preferred = AGY_TIER_PREFERENCE.indexOf(id)
  if (preferred >= 0) score += AGY_TIER_PREFERENCE.length - preferred
  // Flags that only appear on the GCP-ToS (paid) tier in recorded payloads.
  if (tier.userDefinedCloudaicompanionProject === true || tier.usesGcpTos === true) score += 1
  if (tier.isDefault === true) score += 1
  return score
}

/**
 * Pick the tierId to send to onboardUser: the highest-ranked tier that is not a free/trial tier
 * and is not listed in `ineligibleTiers[]`. Only when every allowed tier is free does a free tier
 * get used — and even then the id is the server's own id, never an invented literal.
 */
export function selectTierId(info: LoadCodeAssistInfo): string | undefined {
  const blocked = new Set<string>()
  for (const entry of info.ineligibleTiers) {
    const tierId = entry.tierId?.trim().toLowerCase()
    if (tierId) blocked.add(tierId)
  }
  const allowed = info.allowedTiers.filter(
    (tier): tier is AgyUserTier & { id: string } =>
      typeof tier.id === 'string' && tier.id.trim() !== '' && !blocked.has(tier.id.trim().toLowerCase()),
  )
  if (allowed.length === 0) return undefined

  const nonFree = allowed.filter((tier) => !isFreeTierId(tier.id))
  const pool = nonFree.length > 0 ? nonFree : allowed
  const paidTierId = info.paidTierId?.trim().toLowerCase()
  const currentTierId = info.currentTier?.id?.trim().toLowerCase()
  const ranked = pool
    .map((tier, order) => ({ tier, order, score: tierScore(tier, paidTierId, currentTierId) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
  return ranked[0]?.tier.id.trim()
}

export interface LoadCodeAssistOptions {
  mode?: AgyLoadMode
  projectId?: string
}

/** LoadCodeAssistRequest body: 1 cloudaicompanionProject, 2 metadata (ClientMetadata), 3 mode.
 *  `mode` is only emitted when a check is actually requested — protojson drops default-valued
 *  enums, which is why agy's captured body has no mode field at all. */
export function loadCodeAssistBody(options: LoadCodeAssistOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { metadata: agyClientMetadata() }
  if (options.projectId) body.cloudaicompanionProject = options.projectId
  if (options.mode && options.mode !== AGY_LOAD_MODE.unspecified) body.mode = options.mode
  return body
}

/**
 * Record a resolved project id.
 *
 * `seed === undefined` marks the seedless lookup (plain `loadCodeAssist`): such a result may
 * only go into the token-keyed cache. A project an upstream response named is also recorded
 * under its own (token, seed) key so a later lookup for that seed reuses it without another
 * round-trip. A synthesized id is recorded under its (token, seed) key and never anywhere else —
 * that is the boundary that keeps one seed's derivation from being served to another seed.
 */
function cacheProject(
  token: string,
  seed: string | undefined,
  projectId: string,
  options: { info?: LoadCodeAssistInfo; synthesized: boolean },
): void {
  const entry: ProjectCacheEntry = {
    projectId,
    expiresAt: Date.now() + PROJECT_CACHE_TTL_MS,
    ...(options.info ? { info: options.info } : {}),
    synthesized: options.synthesized,
  }
  if (seed !== undefined) rememberProject(projectCache, projectCacheKey(token, seed), entry)
  if (seed === undefined || !options.synthesized) rememberProject(discoveredProjectCache, token, entry)
}

/** Insert or refresh an entry as the most recently used, capped at PROJECT_CACHE_MAX_ENTRIES. */
function rememberProject(
  cache: Map<string, ProjectCacheEntry>,
  key: string,
  entry: ProjectCacheEntry,
): void {
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > PROJECT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/** Live entry for a key (touched so the LRU window slides); undefined when absent or expired. */
function liveProject(cache: Map<string, ProjectCacheEntry>, key: string): ProjectCacheEntry | undefined {
  const entry = cache.get(key)
  if (entry === undefined) return undefined
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

/** One loadCodeAssist round over the endpoint list; returns undefined if none produced a body. */
async function requestLoadCodeAssist(
  token: string,
  proxyUrl: string | undefined,
  endpoints: string[],
  options: LoadCodeAssistOptions,
): Promise<LoadCodeAssistInfo | undefined> {
  const body = JSON.stringify(loadCodeAssistBody(options))
  let lastStatus: number | undefined
  let lastError: Error | undefined
  for (const endpoint of endpoints) {
    try {
      const res = await agyFetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: antigravityHeaders(token),
        body,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      }, proxyUrl)
      if (!res.ok) {
        lastStatus = res.status
        continue
      }
      const data: unknown = await res.json().catch(() => undefined)
      if (!isRecord(data)) {
        lastError = new Error(`loadCodeAssist on ${endpoint} returned a non-object body`)
        continue
      }
      return parseLoadCodeAssistResponse(data)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  console.warn(
    `${LOG_PREFIX} loadCodeAssist produced no usable response on ${endpoints.length} endpoint(s) ` +
      `(mode=${options.mode ?? AGY_LOAD_MODE.unspecified}, lastStatus=${lastStatus ?? 'n/a'}, ` +
      `lastError=${lastError?.message ?? 'no body parsed'})`,
  )
  return undefined
}

/**
 * Discover project ID via loadCodeAssist (30-min in-memory LRU cache keyed by token; that cache
 * only ever holds a project an upstream response named — see {@link discoveredProjectCache}).
 * `mode` defaults to MODE_UNSPECIFIED; pass AGY_LOAD_MODE.healthCheck for a liveness probe and
 * AGY_LOAD_MODE.eligibilityCheck for the full entitlement view.
 */
export async function loadCodeAssist(
  token: string,
  proxyUrl?: string,
  customEndpoints?: string[],
  bypassCache = false,
  mode: AgyLoadMode = AGY_LOAD_MODE.unspecified,
): Promise<string | undefined> {
  if (!bypassCache) {
    // Token-keyed on purpose: this lookup has no seed, and the cache it reads only ever holds
    // ids an upstream response named (cacheProject refuses to store a synthesized id here), so
    // a fallback derived for some other seed can never be handed back as a discovered project.
    const cached = liveProject(discoveredProjectCache, token)
    if (cached) return cached.projectId
  }

  const endpoints = customEndpoints && customEndpoints.length ? customEndpoints : endpointCandidates()
  const info = await requestLoadCodeAssist(token, proxyUrl, endpoints, { mode })
  const proj = info?.projectId ?? (await listCloudAICompanionProjects(token, proxyUrl, endpoints))
  if (proj) {
    cacheProject(token, undefined, proj, { info, synthesized: false })
    return proj
  }
  return undefined
}

/**
 * loadCodeAssist variant that keeps the tier / eligibility payload (allowedTiers,
 * ineligibleTiers, currentTier, paidTier, gcpManaged, subscription uri) instead of only the
 * project id. It asks for FULL_ELIGIBILITY_CHECK and degrades to the mode agy itself sends if
 * the deployment rejects that field, so an unknown build never costs us the tier data.
 */
export async function loadCodeAssistTiers(
  token: string,
  proxyUrl?: string,
  customEndpoints?: string[],
  mode: AgyLoadMode = AGY_LOAD_MODE.eligibilityCheck,
): Promise<LoadCodeAssistInfo | undefined> {
  const endpoints = customEndpoints && customEndpoints.length ? customEndpoints : endpointCandidates()
  const info = await requestLoadCodeAssist(token, proxyUrl, endpoints, { mode })
  if (info) return info
  if (mode === AGY_LOAD_MODE.unspecified) return undefined
  console.warn(
    `${LOG_PREFIX} loadCodeAssist(${mode}) failed; retrying with ${AGY_LOAD_MODE.unspecified} ` +
      'so tier selection still has data to work from',
  )
  return requestLoadCodeAssist(token, proxyUrl, endpoints, { mode: AGY_LOAD_MODE.unspecified })
}

export interface OnboardResponse {
  done?: boolean
  name?: string
  response?: {
    cloudaicompanionProject?: {
      id?: string
    }
    project?: string
  }
  error?: {
    code?: number
    message?: string
  }
}

/** Optional cloudaicompanionProject (OnboardUserRequest field 2) for a project that is already known. */
export interface OnboardUserOptions {
  projectId?: string
}

/** OnboardUserRequest: 1 tier_id, 2 cloudaicompanion_project, 3 metadata (ClientMetadata).
 *  `tierId` is required and must be an id taken from the loadCodeAssist payload
 *  (allowedTiers[].id / currentTier.id): the agy binary has no `TIER_FREE` literal, so inventing a
 *  tier id here would send a request the real CLI can never make. */
export async function onboardUser(
  token: string,
  tierId: string,
  proxyUrl?: string,
  customEndpoints?: string[],
  options?: OnboardUserOptions,
): Promise<OnboardResponse | null> {
  const tier = tierId.trim()
  if (!tier) {
    throw new Error(
      `${LOG_PREFIX} onboardUser needs a tierId from loadCodeAssist (allowedTiers[].id / currentTier.id); ` +
        'the Antigravity API has no TIER_FREE tier id.',
    )
  }
  const body: Record<string, unknown> = { tierId: tier, metadata: agyClientMetadata() }
  const knownProject = options?.projectId?.trim()
  if (knownProject) body.cloudaicompanionProject = knownProject
  let lastStatus: number | undefined
  let lastError: Error | undefined
  const endpoints = customEndpoints && customEndpoints.length ? customEndpoints : endpointCandidates()
  for (const endpoint of endpoints) {
    try {
      const res = await agyFetch(`${endpoint}/v1internal:onboardUser`, {
        method: 'POST',
        headers: antigravityHeaders(token),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      }, proxyUrl)
      if (res.ok) {
        const parsed = parseOnboardResponse(await res.json().catch(() => undefined))
        if (parsed) return parsed
        lastError = new Error(`${endpoint} returned a body that is not an Operation`)
        continue
      }
      lastStatus = res.status
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  console.warn(
    `${LOG_PREFIX} onboardUser(tier=${tier}) produced no Operation on ${endpoints.length} endpoint(s) ` +
      `(lastStatus=${lastStatus ?? 'n/a'}, lastError=${lastError?.message ?? 'no body parsed'})`,
  )
  return null
}

function parseOnboardResponse(data: unknown): OnboardResponse | undefined {
  if (!isRecord(data)) return undefined
  const out: OnboardResponse = {}
  if (typeof data.done === 'boolean') out.done = data.done
  const name = asString(data.name)
  if (name) out.name = name
  if (isRecord(data.response)) {
    const response: NonNullable<OnboardResponse['response']> = {}
    if (isRecord(data.response.cloudaicompanionProject)) {
      const projectId = asString(data.response.cloudaicompanionProject.id)
      if (projectId) response.cloudaicompanionProject = { id: projectId }
    }
    const project = asString(data.response.project)
    if (project) response.project = project
    if (Object.keys(response).length > 0) out.response = response
  }
  if (isRecord(data.error)) {
    const error: NonNullable<OnboardResponse['error']> = {}
    if (typeof data.error.code === 'number') error.code = data.error.code
    const message = asString(data.error.message)
    if (message) error.message = message
    if (Object.keys(error).length > 0) out.error = error
  }
  return out
}

/**
 * Continue an onboardUser long-running operation. The agy method table has
 * `/v1internal:onboardUser` and `/v1internal:onboardUserBackgroundTasks` but no
 * `/v1internal:getOperation` — that one only exists in the vendored genai library, which is why
 * this is the only polling entry point this client uses.
 *
 * cloudcode.proto spells the request message out as OnboardUserBackgroundTasksRequest:
 *   1 projectNumber (int64) · 2 operation (.google.longrunning.GetOperationRequest) ·
 *   3 tierId (string) · 4 isAntigravityUser (bool)
 * so the operation name goes inside `operation` (GetOperationRequest.name), which is the first
 * shape tried. No capture or log on this machine ever shows the live body — onboarding completed
 * long ago here (~/.gemini/antigravity-cli/cache/onboarding.json) — so the two older shapes are
 * kept as fallbacks under a hard attempt cap, and a dead end is reported rather than swallowed.
 */
export async function onboardUserBackgroundTasks(
  token: string,
  operationName: string,
  proxyUrl?: string,
  customEndpoints?: string[],
): Promise<OnboardResponse | null> {
  const name = operationName.trim()
  if (!name) {
    throw new Error(`${LOG_PREFIX} onboardUserBackgroundTasks needs the operation name from onboardUser`)
  }
  const endpoints = customEndpoints && customEndpoints.length ? customEndpoints : endpointCandidates()
  const shapes: Record<string, unknown>[] = [{ operation: { name } }, { name }, {}]

  let attempts = 0
  let lastStatus: number | undefined
  let lastError: Error | undefined
  for (const endpoint of endpoints) {
    for (const shape of shapes) {
      if (attempts >= BACKGROUND_TASK_MAX_ATTEMPTS) break
      attempts += 1
      try {
        const res = await agyFetch(`${endpoint}/v1internal:onboardUserBackgroundTasks`, {
          method: 'POST',
          headers: antigravityHeaders(token),
          body: JSON.stringify(shape),
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        }, proxyUrl)
        if (res.ok) {
          const parsed = parseOnboardResponse(await res.json().catch(() => undefined))
          if (parsed) return parsed
          lastError = new Error(`${endpoint} returned a body that is not an Operation`)
          continue
        }
        lastStatus = res.status
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }
    if (attempts >= BACKGROUND_TASK_MAX_ATTEMPTS) break
  }
  console.warn(
    `${LOG_PREFIX} onboardUserBackgroundTasks(${name}) produced no Operation in ${attempts} attempt(s) ` +
      `(lastStatus=${lastStatus ?? 'n/a'}, lastError=${lastError?.message ?? 'no body parsed'})`,
  )
  return null
}

/**
 * Bounded polling of an onboardUser operation: at most `maxAttempts` polls spaced by `intervalMs`,
 * never past `deadlineMs`, and an operation-level error stops polling instead of burning the whole
 * budget. A stalled onboarding is reported and left to the caller's fallback - it never blocks a
 * generation request.
 */
async function pollOnboardOperation(
  token: string,
  operationName: string,
  proxyUrl: string | undefined,
  endpoints: string[],
): Promise<OnboardResponse | undefined> {
  const intervalMs = envNumber('ANTIGRAVITY_ONBOARD_POLL_INTERVAL_MS', ONBOARD_POLL_INTERVAL_MS)
  const maxAttempts = envNumber('ANTIGRAVITY_ONBOARD_POLL_MAX_ATTEMPTS', ONBOARD_POLL_MAX_ATTEMPTS)
  const deadlineMs = envNumber('ANTIGRAVITY_ONBOARD_POLL_DEADLINE_MS', ONBOARD_POLL_DEADLINE_MS)
  const deadline = Date.now() + deadlineMs
  let latest: OnboardResponse | undefined
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)))
    const operation = await onboardUserBackgroundTasks(token, operationName, proxyUrl, endpoints)
    if (!operation) continue
    latest = operation
    if (operation.done) return operation
    if (operation.error) {
      console.warn(
        `${LOG_PREFIX} onboardUser operation ${operationName} reported ` +
          `${operation.error.code ?? 'n/a'}: ${operation.error.message ?? 'no message'}`,
      )
      return operation
    }
  }
  if (!latest) {
    console.warn(
      `${LOG_PREFIX} onboardUser operation ${operationName} said nothing in ${maxAttempts} poll(s) ` +
        `within ${deadlineMs}ms; using the fallback instead of blocking the request`,
    )
  }
  return latest
}

/**
 * Make sure a project id exists for this (token, seed). Order: the id loadCodeAssist already
 * hands out, then the FULL_ELIGIBILITY_CHECK view whose allowedTiers decide the onboardUser
 * tierId, then bounded operation polling, and only as a last resort the deterministic seed id.
 * Nothing in here throws into the request path.
 *
 * The cache is read and written under `token + '\u0000' + seed`, so a fallback synthesized for
 * one seed is never served to another seed that happens to share the access token. The last
 * resort is marked `synthesized: true`; read it back with {@link getProjectResolution} so a
 * caller can tell the two apart instead of guessing from the id's shape. The signature stays
 * `Promise<string>` for every existing caller.
 */
export async function ensureProject(
  token: string,
  seedOrEmail = DEFAULT_PROJECT_SEED,
  proxyUrl?: string,
  customEndpoints?: string[],
): Promise<string> {
  // Same normalization quota.ts applies (`projectSeed?.trim() || AGY_PROJECT_FALLBACK_SEED`), so
  // generation (adapter.ts / oneshot.ts) and quota resolve one account under one cache key even
  // when the alias carries stray whitespace or is empty.
  const seed = seedOrEmail.trim() || DEFAULT_PROJECT_SEED
  const cached = liveProject(projectCache, projectCacheKey(token, seed))
  if (cached) return cached.projectId

  const discovered = await loadCodeAssist(token, proxyUrl, customEndpoints)
  if (discovered) {
    cacheProject(token, seed, discovered, { synthesized: false })
    return discovered
  }

  const eligibility = await loadCodeAssistTiers(token, proxyUrl, customEndpoints)
  if (eligibility?.projectId) {
    cacheProject(token, seed, eligibility.projectId, { info: eligibility, synthesized: false })
    return eligibility.projectId
  }

  const tierId = eligibility ? selectTierId(eligibility) : undefined
  if (!tierId) {
    const blocker = eligibility?.ineligibleTiers[0]
    console.warn(
      `${LOG_PREFIX} skipping onboardUser - loadCodeAssist offered no eligible tier id ` +
        `(allowedTiers=${eligibility?.allowedTiers.map((tier) => tier.id ?? '?').join(',') || 'none'}` +
        `${blocker ? `, blocked ${blocker.tierId ?? '?'} by ${blocker.reasonCode ?? 'unknown reason'}` : ''})`,
    )
  } else {
    try {
      let onboard = await onboardUser(token, tierId, proxyUrl, customEndpoints)
      if (onboard && !onboard.done && onboard.name) {
        const endpoints = customEndpoints && customEndpoints.length ? customEndpoints : endpointCandidates()
        const polled = await pollOnboardOperation(token, onboard.name, proxyUrl, endpoints)
        if (polled) onboard = polled
      }
      const onboardedProject = onboard?.response?.cloudaicompanionProject?.id || onboard?.response?.project
      if (onboardedProject) {
        cacheProject(token, seed, onboardedProject, { synthesized: false })
        return onboardedProject
      }
      if (onboard?.error) {
        console.warn(
          `${LOG_PREFIX} onboardUser(tier=${tierId}) reported ` +
            `${onboard.error.code ?? 'n/a'}: ${onboard.error.message ?? 'no message'}`,
        )
      }
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} onboardUser(tier=${tierId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const fallback = defaultProjectId(seed)
  cacheProject(token, seed, fallback, { synthesized: true })
  return fallback
}

/** What one (token, seed) project lookup actually produced, as recorded when it was cached. */
export interface ProjectResolution {
  /** The id `ensureProject` returned for this pair. */
  projectId: string
  /**
   * `true` when nothing upstream named the id and it is this repo's last-resort
   * `defaultProjectId(seed)` (the sha1-shaped derivation, or the ANTIGRAVITY_PROJECT_ID value
   * that function prefers when it is set). `false` when loadCodeAssist, the eligibility view or
   * onboardUser actually handed the id over.
   */
  synthesized: boolean
}

/**
 * Read back what the project cache holds for one (token, seed) lookup, including whether the id
 * was synthesized here or named by the backend. Returns `undefined` when no live entry exists —
 * it reports the outcome of a lookup, it does not perform one, so call it after `ensureProject`.
 *
 * Added alongside `ensureProject` instead of changing its `Promise<string>` return type, so every
 * existing caller is untouched while quota.ts stops inferring the difference from the id's shape.
 */
export function getProjectResolution(token: string, seed: string): ProjectResolution | undefined {
  const entry = liveProject(projectCache, projectCacheKey(token, seed.trim() || DEFAULT_PROJECT_SEED))
  if (entry === undefined) return undefined
  return { projectId: entry.projectId, synthesized: entry.synthesized }
}

export function clearProjectCache(): void {
  projectCache.clear()
  discoveredProjectCache.clear()
}

export function clearModelCache(): void {
  modelCache.clear()
}

export interface EnvelopeOptions {
  sessionId?: string
  trajectoryId?: string
  step?: number
  /** agy groups every step of one run under a cascade id; we do not implement agy's cascade
   *  semantics, so the trajectory id stands in for it when no cascade id is given. */
  cascadeId?: string
  /** Cascade id of the top-level run; defaults to cascadeId (same stand-in as above). */
  rootCascadeId?: string
  /** `agent` for the main conversation, `checkpoint` for the short title/summary requests; another
   *  lowercase verb may be passed by a caller that has evidence for it. */
  requestType?: AgyRequestVerb
  /** Clock for the epoch_ms segment of the requestId. Production uses the real clock; a caller that
   *  needs a byte-identical requestId injects its own. */
  now?: () => number
  /** Split from `isClaude` only when a caller knows the conservative flag differs; agy's own
   *  distinction between the two Claude labels is not observable in the capture. */
  usedClaudeConservative?: boolean
}

/** `used_non_gemini_model`: the capture marks a Gemini wire id (`gemini-4-hydrogen-medium`) as
 *  false, so anything whose wire id is not a Gemini slug counts as a non-Gemini model. */
function isNonGeminiWireModel(wireModelId: string): boolean {
  return !wireModelId.trim().toLowerCase().startsWith(GEMINI_WIRE_MODEL_PREFIX)
}

/**
 * Build the identity fields of a generation request: the top-level `requestId` plus the
 * `sessionId` and `labels` fields of the `request` object. Shapes taken from the captured flows
 * (20261116T081812Z-35.req.txt / …Z-33.req.txt):
 *   requestId  agent/<cascade_id>/<epoch_ms>/<trajectory_id>/<step>  (…/1 for the first step)
 *              checkpoint/<uuid>
 *   labels     cascade_id, root_cascade_id, trajectory_id, request_id (`<trajectory_id>-<n>`),
 *              last_step_index, model_enum, used_claude, used_claude_conservative,
 *              used_non_gemini_model
 * `step` stays the 1-based step number this client has always used for `last_step_index`; agy
 * writes the 0-based index there while its requestId carries the 1-based count, so the two
 * segments differ by one in the capture. Offsetting ours would silently break every existing
 * caller and test that reads last_step_index, so the label keeps its 1-based meaning.
 */
export function antigravityRequestEnvelope(
  wireModelId: string,
  isClaude: boolean,
  options?: EnvelopeOptions,
): {
  requestId: string
  sessionId: string
  requestType: AgyRequestVerb
  userAgent: typeof AGY_WIRE_USER_AGENT
  labels: Record<string, string>
} {
  const trajectoryId = options?.trajectoryId ?? randomUUID()
  const step = options?.step ?? 1
  const requestType = options?.requestType ?? AGY_REQUEST_TYPE.agent
  const cascadeId = options?.cascadeId?.trim() || trajectoryId
  const rootCascadeId = options?.rootCascadeId?.trim() || cascadeId
  const wireSessionId = options?.sessionId ? fnv1a64Signed(options.sessionId) : fnv1a64Signed(trajectoryId)
  const epochMs = (options?.now ?? Date.now)()
  const requestId =
    requestType === AGY_REQUEST_TYPE.checkpoint
      ? `${AGY_REQUEST_TYPE.checkpoint}/${cascadeId}`
      : `${requestType}/${cascadeId}/${epochMs}/${trajectoryId}/${step}`
  const usedClaudeConservative = options?.usedClaudeConservative ?? isClaude
  const labels: Record<string, string> = {
    cascade_id: cascadeId,
    root_cascade_id: rootCascadeId,
    trajectory_id: trajectoryId,
    request_id: `${trajectoryId}-${step}`,
    last_step_index: String(step),
    used_claude: isClaude ? 'true' : 'false',
    used_claude_conservative: usedClaudeConservative ? 'true' : 'false',
    used_non_gemini_model: isNonGeminiWireModel(wireModelId) ? 'true' : 'false',
  }
  const modelEnum = lookupModelEnum(wireModelId)
  if (modelEnum) labels.model_enum = modelEnum
  return { requestId, sessionId: wireSessionId, requestType, userAgent: AGY_WIRE_USER_AGENT, labels }
}

/**
 * Execute streamGenerateContent against Google CloudCode PA endpoint with fallback.
 */
export async function streamGenerateContent(
  token: string,
  request: AntigravityGenerateRequest,
  signal?: AbortSignal,
  proxyUrl?: string,
  customEndpoints?: string[],
): Promise<{ response: Response; endpoint: string }> {
  const endpoints = customEndpoints && customEndpoints.length ? customEndpoints : getEndpointCandidatesForModel(request.model)
  const isClaude = request.model.startsWith('claude-')
  const headers: Record<string, string> = {
    ...antigravityHeaders(token),
    ...(isClaude ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {}),
  }
  const body = JSON.stringify(request)

  let lastResponse: Response | undefined
  let lastError: Error | undefined

  for (const endpoint of endpoints) {
    if (signal?.aborted) throw new Error('Request was aborted')
    try {
      const res = await agyFetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers,
        body,
        signal,
        timeoutMs: null,
      }, proxyUrl)

      if (res.ok) {
        return { response: res, endpoint }
      }

      lastResponse = res
      if (res.status === 401 || res.status === 403 || res.status === 400 || res.status === 429) {
        return { response: res, endpoint }
      }
    } catch (err) {
      lastError = err as Error
      if (signal?.aborted) throw err
    }
  }

  if (lastResponse) {
    return { response: lastResponse, endpoint: endpoints[0] || DEFAULT_ENDPOINT }
  }
  throw lastError || new Error('All Google CloudCode endpoints failed to connect')
}
