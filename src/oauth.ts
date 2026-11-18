// OAuth (self-owned Antigravity / Google Cloud Code authorization flow).
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { agyFetch } from './net.ts'

export const AGY_PUBLIC_CLIENT_ID =
  ['1071006060591', 'tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'].join('-')

export const AGY_PUBLIC_CLIENT_SECRET =
  ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-')

export function resolveClientCredentials(): { clientId: string; clientSecret: string } {
  return {
    clientId: process.env.AGY_CLIENT_ID || AGY_PUBLIC_CLIENT_ID,
    clientSecret: process.env.AGY_CLIENT_SECRET || AGY_PUBLIC_CLIENT_SECRET,
  }
}

/**
 * Consent-time scope set, aligned with what the real `agy` 1.3.5 CLI requests.
 *
 * Evidence (`strings -a /usr/bin/agy`, read-only inspection, 2026-11-18): the binary
 * carries exactly 16 distinct `https://www.googleapis.com/auth/*` strings, split into
 * two families:
 *   - CLI auth family (6): cloud-platform, userinfo.email, userinfo.profile, cclog,
 *     experimentsandconfigs, aicode  -> this constant
 *   - Drive integration family (10): drive, drive.appdata, drive.apps.readonly,
 *     drive.file, drive.meet.readonly, drive.metadata, drive.metadata.readonly,
 *     drive.photos.readonly, drive.readonly, drive.scripts
 * The Drive family backs agy's Drive/workspace project features and is deliberately
 * NOT requested here: it widens the consent screen for our shared client, a scope the
 * client is not registered for makes Google reject the whole authorize request, and the
 * AICode path needs none of it. `aicode` is what closes the observed gap — a token
 * minted from the previous set gets `403 PERMISSION_DENIED /
 * Request had insufficient authentication scopes / ACCESS_TOKEN_SCOPE_INSUFFICIENT`
 * from the AICode backend that `use-aicode-mendel=true` routes agy through.
 *
 * Only scopes were added, none removed: dropping a scope changes the behaviour of
 * refresh_tokens that were issued with it.
 */
export const AGY_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

/**
 * The set AGY_SCOPES held before `aicode` was added. Tokens written before a scope
 * record existed were authorized with exactly this set, so it is the assumption used
 * for an unrecorded grant (see {@link needsReauth}). Kept as an explicit constant so
 * the fallback is auditable instead of implicit.
 */
export const LEGACY_AGY_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

/**
 * Key that records the authorized scope set inside the on-disk agy token document.
 * `granted_scopes` is a repeated string field in agy's own credential protos
 * (`strings -a /usr/bin/agy` shows `protobuf:"...,rep,name=granted_scopes..."`), so a
 * string array under this name matches agy's field name and its type: agy's JSON/protobuf
 * reader ignores unknown keys, and this one is not a type clash with a key it already uses.
 */
export const AGY_TOKEN_SCOPE_KEY = 'granted_scopes'

/**
 * Canonicalize a scope collection: trim, drop empties, de-duplicate, and order it
 * deterministically (scopes required by agy in AGY_SCOPES declaration order, any extra
 * scope after them in ascending byte order). Same input set -> same output regardless
 * of the input order, so a stored grant can be compared to the required set reliably.
 */
export function normalizeScopes(input?: readonly string[] | string | null): string[] {
  const raw = typeof input === 'string' ? input.split(/[\s,]+/) : (input ?? [])
  const unique = new Set<string>()
  for (const entry of raw) {
    const trimmed = typeof entry === 'string' ? entry.trim() : ''
    if (trimmed) unique.add(trimmed)
  }
  const rank = new Map<string, number>(AGY_SCOPES.map((scope, index) => [scope, index]))
  return [...unique].sort((a, b) => {
    const rankA = rank.get(a) ?? Number.MAX_SAFE_INTEGER
    const rankB = rank.get(b) ?? Number.MAX_SAFE_INTEGER
    if (rankA !== rankB) return rankA - rankB
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/** Required scopes missing from `granted`. */
export function missingScopes(
  granted: readonly string[] | string | null | undefined,
  required: readonly string[] = AGY_SCOPES,
): string[] {
  const have = new Set(normalizeScopes(granted))
  return required.filter((scope) => !have.has(scope))
}

/**
 * True when the stored grant cannot satisfy the current AGY_SCOPES.
 *
 * Refreshing a refresh_token never widens the grant — Google re-issues an access token
 * for the scopes the consent already covered, and the refresh response carries no scope
 * field. So a token authorized with an older set stays short until the user reconsents;
 * callers use this to decide whether to surface a re-auth (`/ccl auth`) prompt.
 * A grant with no recorded scope is treated as {@link LEGACY_AGY_SCOPES}: that is what
 * the consent asked for when the token was issued, and it is the safe reading (a stale
 * prompt costs one re-auth; a false "no re-auth needed" keeps a 403 token in the pool).
 */
export function needsReauth(grantedScopes: readonly string[] | string | null | undefined): boolean {
  const unrecorded =
    grantedScopes === undefined ||
    grantedScopes === null ||
    (Array.isArray(grantedScopes) && grantedScopes.length === 0)
  return missingScopes(unrecorded ? LEGACY_AGY_SCOPES : grantedScopes).length > 0
}

/**
 * Read the authorized scope set back out of a parsed agy token document.
 * Tolerates both shapes seen in the wild — a top-level record and one nested inside
 * `token` — and both encodings (string array, space-separated string).
 * Returns undefined when the document records no scopes (a pre-scope-record token).
 */
export function readGrantedScopes(raw: Record<string, unknown> | null | undefined): string[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const nested = raw.token
  const documents: Record<string, unknown>[] = [raw]
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) documents.push(nested as Record<string, unknown>)
  for (const document of documents) {
    for (const key of [AGY_TOKEN_SCOPE_KEY, 'scopes', 'scope']) {
      const value = document[key]
      if (typeof value === 'string' || Array.isArray(value)) {
        const normalized = normalizeScopes(value)
        if (normalized.length > 0) return normalized
      }
    }
  }
  return undefined
}

export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

export const OAUTH_CALLBACK_PORT = 51121
export const OAUTH_CALLBACK_PATH = '/oauth-callback'
/** Redirect URI for the registered callback port; overridable so a listener can bind an isolated port. */
export function oauthRedirectUri(port: number = OAUTH_CALLBACK_PORT): string {
  return `http://localhost:${port}${OAUTH_CALLBACK_PATH}`
}
export const OAUTH_REDIRECT_URI = oauthRedirectUri()

export const AGY_ENDPOINTS: readonly string[] = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
]

export interface PkcePair {
  verifier: string
  challenge: string
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function buildAuthorizeUrl(challenge: string, state: string, redirectUri: string = OAUTH_REDIRECT_URI): string {
  const { clientId } = resolveClientCredentials()
  const url = new URL(OAUTH_AUTHORIZE_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', AGY_SCOPES.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

export interface TokenSet {
  access_token: string
  token_type?: string
  refresh_token?: string
  expiryMs?: number
  /**
   * Scopes the token endpoint actually reported. Recorded only from a response that carried a
   * `scope` field: a code exchange whose response omits it leaves the grant unrecorded instead of
   * claiming the consent-time request, and a refresh response never carries scope (the previously
   * recorded grant stays authoritative). "Unrecorded" is a real state, not a gap:
   * {@link needsReauth} judges it as a legacy grant and asks for one re-consent.
   */
  grantedScopes?: string[]
}

interface TokenEndpointPayload {
  access_token?: string
  token_type?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string | { message?: string; status?: string }
  error_description?: string
}

async function postTokenForm(fields: Record<string, string>, proxyUrl?: string): Promise<TokenEndpointPayload> {
  const { clientId, clientSecret } = resolveClientCredentials()
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields })
  const res = await agyFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, proxyUrl)
  const payload = (await res.json().catch(() => ({}))) as TokenEndpointPayload
  if (!res.ok) {
    const code = typeof payload.error === 'string' ? payload.error : payload.error?.status
    const desc = payload.error_description ?? (typeof payload.error === 'object' ? payload.error?.message : undefined)
    throw new Error(`token endpoint ${res.status}: ${[code, desc].filter(Boolean).join(' — ') || 'unknown error'}`)
  }
  if (!payload.access_token) throw new Error('token endpoint returned no access_token')
  return payload
}

/**
 * Translate one token-endpoint response into a TokenSet. `scope` is the only place a grant is
 * learned from, so it is the only thing recorded; exported because the meaning of a response
 * without it is a contract worth testing directly (see test/agy-oauth-scope.test.ts) and the
 * exchange path itself needs the network.
 */
export function toTokenSet(payload: TokenEndpointPayload, refreshTokenFallback?: string): TokenSet {
  const grantedScopes = payload.scope === undefined ? undefined : normalizeScopes(payload.scope)
  return {
    access_token: payload.access_token as string,
    token_type: payload.token_type ?? 'Bearer',
    refresh_token: payload.refresh_token ?? refreshTokenFallback,
    expiryMs: typeof payload.expires_in === 'number' ? Date.now() + payload.expires_in * 1000 : undefined,
    ...(grantedScopes && grantedScopes.length > 0 ? { grantedScopes } : {}),
  }
}

/** Exchange an authorization code for tokens (PKCE-verified). */
export async function exchangeCode(code: string, verifier: string, proxyUrl?: string, redirectUri: string = OAUTH_REDIRECT_URI): Promise<TokenSet> {
  const tokens = toTokenSet(
    await postTokenForm({
      grant_type: 'authorization_code',
      code: code.trim(),
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }, proxyUrl),
  )
  // Only a scope Google actually echoed is recorded. A code-exchange response without `scope`
  // leaves the grant unrecorded, and an unrecorded grant is precisely the case needsReauth judges
  // as a legacy / pre-scope token: re-auth required. Claiming AGY_SCOPES here — because the
  // consent URL asked for them — would assert a grant this client never saw, and needsReauth would
  // then answer "no re-auth needed" for a token whose real scopes are unknown. That false
  // negative is what keeps a scope-insufficient token (403
  // ACCESS_TOKEN_SCOPE_INSUFFICIENT) in the pool instead of prompting one re-consent.
  return tokens
}

/** Refresh an access token; throws on invalid_grant (credential revoked).
 *
 * A refresh response carries no `scope` field, so `grantedScopes` stays unset: a refresh
 * re-issues an access token for the scopes the original consent covered, it never widens
 * them. Callers keep the recorded grant (or use `needsReauth`) instead of assuming a
 * refreshed token gained anything.
 */
export async function refreshTokens(refreshToken: string, proxyUrl?: string): Promise<TokenSet> {
  return toTokenSet(
    await postTokenForm({ grant_type: 'refresh_token', refresh_token: refreshToken }, proxyUrl),
    refreshToken,
  )
}

/** Fetch the account email for a valid access token (best effort). */
export async function fetchUserEmail(accessToken: string, proxyUrl?: string): Promise<string | undefined> {
  try {
    const res = await agyFetch(OAUTH_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, proxyUrl)
    if (!res.ok) return undefined
    const info = (await res.json()) as { email?: string }
    return typeof info.email === 'string' && info.email ? info.email : undefined
  } catch {
    return undefined
  }
}

/** Parse an existing on-disk token document; undefined when it is absent or unreadable. */
function readTokenDocument(file: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist tokens in on-disk format:
 *   {"token": {access_token, token_type, refresh_token, expiry}, "auth_method": "consumer",
 *    "granted_scopes": [ ... ] }
 * The `granted_scopes` entry is only present once the grant is known; a token file written
 * before scope recording existed stays exactly as it was, so existing accounts keep working.
 */
export function writeAgyTokenFile(homeDir: string, tokens: TokenSet): string {
  const geminiDir = join(homeDir, '.gemini')
  const dir = join(geminiDir, 'antigravity-cli')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(homeDir, 0o700)
    chmodSync(geminiDir, 0o700)
    chmodSync(dir, 0o700)
  } catch {}
  const file = join(dir, 'antigravity-oauth-token')
  const expiryIso = tokens.expiryMs
    ? formatLocalIso(tokens.expiryMs)
    : formatLocalIso(Date.now() + 3600_000)
  // A refreshed TokenSet carries no scope information, so a rewrite must not erase what
  // the original consent recorded.
  const grantedScopes = normalizeScopes(tokens.grantedScopes ?? readGrantedScopes(readTokenDocument(file)))
  const doc = {
    token: {
      access_token: tokens.access_token,
      token_type: tokens.token_type ?? 'Bearer',
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      expiry: expiryIso,
    },
    auth_method: 'consumer',
    ...(grantedScopes.length > 0 ? { [AGY_TOKEN_SCOPE_KEY]: grantedScopes } : {}),
  }
  writeFileSync(file, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows: mode bits unsupported — best effort
  }
  return file
}

function formatLocalIso(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

export interface CallbackResult {
  code: string
  state: string
}

export interface CallbackHandle {
  result: Promise<CallbackResult>
  close(): Promise<void>
}

const CALLBACK_SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>登录成功</title></head>
<body style="font-family:system-ui;text-align:center;padding:3rem">
<h2>✓ 授权成功</h2>
<p>可以关闭此标签页返回终端或应用。</p>
</body></html>`

export function startCallbackListener(options: { port?: number; timeoutMs?: number } = {}): CallbackHandle {
  const timeoutMs = options.timeoutMs ?? 300_000
  const port = options.port ?? OAUTH_CALLBACK_PORT
  let resolveResult!: (value: CallbackResult) => void
  let rejectResult!: (reason: Error) => void
  const result = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      res.writeHead(400, { 'Content-Type': 'text/html', connection: 'close' })
      res.end(`<h2>Authorization failed: ${oauthError}</h2>`)
      rejectResult(new Error(`oauth error: ${oauthError}`))
      setTimeout(() => server.close(), 1500)
      return
    }
    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<h2>Missing code or state</h2>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html', connection: 'close' })
    res.end(CALLBACK_SUCCESS_HTML)
    resolveResult({ code, state })
    setTimeout(() => server.close(), 1500)
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    rejectResult(
      error.code === 'EADDRINUSE'
        ? new Error(`port ${port} is busy`)
        : error,
    )
  })

  server.listen(port, '127.0.0.1')

  const timeout = setTimeout(() => {
    rejectResult(new Error('timed out waiting for the OAuth callback'))
    server.close()
  }, timeoutMs)

  return {
    result,
    async close() {
      clearTimeout(timeout)
      if (server.listening) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  }
}

export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (process.platform === 'darwin') {
        execFile('open', [url], (err) => resolve(!err))
      } else if (process.platform === 'win32') {
        execFile(
          'cmd.exe',
          ['/d', '/s', '/c', `start "" "${url}"`],
          { windowsVerbatimArguments: true },
          (err) => resolve(!err),
        )
      } else {
        execFile('xdg-open', [url], (err) => resolve(!err))
      }
    } catch {
      resolve(false)
    }
  })
}

export function parsePastedCode(input: string): { code: string; state?: string } | null {
  const text = input.trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      const code = url.searchParams.get('code')
      if (!code) return null
      const state = url.searchParams.get('state') ?? undefined
      return { code, state }
    } catch {
      return null
    }
  }
  if (/^[\w\-/.%]+$/.test(text) && text.length >= 10) return { code: text }
  return null
}
