// Android GMS authentication & token exchange for Google Gemini App (Robin / AGSA).

import { GeminiAppError } from './types.ts'

export const GMS_AUTH_URL = 'https://android.clients.google.com/auth'
export const GMS_EMBEDDED_SETUP_URL = 'https://accounts.google.com/EmbeddedSetup'
export const AGSA_PACKAGE_NAME = 'com.google.android.googlequicksearchbox'
export const AGSA_CLIENT_SIG = '38918a453d07199354f8b19af05ec6562ced5788'
export const AGSA_ASSISTANT_SERVICE = 'oauth2:https://www.googleapis.com/auth/assistant'

const GMS_USER_AGENT = 'GoogleAuth/1.4 (PJZ110 UP1A.231005.007)'

export interface MasterTokenExchangeResult {
  masterToken: string
  email: string
}

export interface AccessTokenExchangeResult {
  accessToken: string
  expiresAt: number
  email?: string
}

export function parseGmsKeyValueResponse(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx <= 0) continue
    const key = line.slice(0, eqIdx).trim()
    const value = line.slice(eqIdx + 1).trim()
    if (key) {
      result[key] = value
    }
  }
  return result
}

function classifyGmsErrorCode(gmsError: string | undefined, httpStatus: number): string {
  const normalized = (gmsError || '').toLowerCase()
  if (
    normalized.includes('badauthentication') ||
    normalized.includes('needsbrowser') ||
    normalized.includes('invalidsecondfactor') ||
    normalized.includes('tokenexpired') ||
    normalized.includes('accountdeleted') ||
    normalized.includes('accountdisabled') ||
    normalized.includes('unknown') ||
    httpStatus === 401 ||
    httpStatus === 403
  ) {
    return 'AUTH_REQUIRED'
  }
  if (httpStatus === 429) {
    return 'RATE_LIMIT'
  }
  return 'AUTH_REQUIRED'
}

async function postGmsAuth(
  params: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<{ status: number; ok: boolean; parsed: Record<string, string>; rawBody: string }> {
  const body = new URLSearchParams(params).toString()
  let res: Response
  try {
    res = await fetchFn(GMS_AUTH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': GMS_USER_AGENT,
      },
      body,
    })
  } catch (err) {
    throw new GeminiAppError(
      `GMS auth request failed: ${err instanceof Error ? err.message : String(err)}`,
      'CONNECTION_ERROR',
    )
  }

  const rawBody = await res.text()
  const parsed = parseGmsKeyValueResponse(rawBody)
  return { status: res.status, ok: res.ok, parsed, rawBody }
}

/**
 * Exchange an EmbeddedSetup OAuth token (oauth2_4/...) for a long-lived Android Master Token (aas_et/...).
 */
export async function exchangeOAuthTokenForMasterToken(
  oauthToken: string,
  email?: string,
  fetchFn: typeof fetch = fetch,
): Promise<MasterTokenExchangeResult> {
  const trimmedToken = oauthToken.trim()
  if (!trimmedToken) {
    throw new GeminiAppError('OAuth token is required for GMS master token exchange', 'AUTH_REQUIRED')
  }

  const params: Record<string, string> = {
    Token: trimmedToken,
    ACCESS_TOKEN: '1',
    service: 'ac2dm',
    get_accountid: '1',
    droidguard_results: 'null',
    sdk_version: '35',
    device_country: 'us',
    operatorCountry: 'us',
    lang: 'en',
    callerPkg: AGSA_PACKAGE_NAME,
    callerSig: AGSA_CLIENT_SIG,
  }
  if (email?.trim()) {
    params.Email = email.trim()
  }

  const { status, ok, parsed, rawBody } = await postGmsAuth(params, fetchFn)

  if (parsed.Error) {
    throw new GeminiAppError(
      `GMS master token exchange failed: ${parsed.Error}${parsed.ErrorDetail ? ` (${parsed.ErrorDetail})` : ''}`,
      classifyGmsErrorCode(parsed.Error, status),
      status,
    )
  }

  if (!ok) {
    throw new GeminiAppError(
      `GMS master token exchange failed with HTTP ${status}: ${rawBody.slice(0, 200)}`,
      classifyGmsErrorCode(undefined, status),
      status,
    )
  }

  const masterToken = parsed.Token
  if (!masterToken) {
    throw new GeminiAppError(
      'GMS master token exchange succeeded but response did not contain Token=',
      'AUTH_REQUIRED',
      status,
    )
  }

  return {
    masterToken,
    email: parsed.Email || email?.trim() || '',
  }
}

/**
 * Exchange a long-lived Android Master Token (aas_et/...) for a short-lived AGSA Assistant Access Token (ya29.m.*).
 */
export async function exchangeMasterTokenForAccessToken(
  masterToken: string,
  email?: string,
  fetchFn: typeof fetch = fetch,
): Promise<AccessTokenExchangeResult> {
  const trimmedMaster = masterToken.trim()
  if (!trimmedMaster) {
    throw new GeminiAppError('Master token is required for GMS access token exchange', 'AUTH_REQUIRED')
  }

  const params: Record<string, string> = {
    Token: trimmedMaster,
    service: AGSA_ASSISTANT_SERVICE,
    app: AGSA_PACKAGE_NAME,
    client_sig: AGSA_CLIENT_SIG,
    callerPkg: AGSA_PACKAGE_NAME,
    callerSig: AGSA_CLIENT_SIG,
    sdk_version: '35',
    device_country: 'us',
    operatorCountry: 'us',
    lang: 'en',
  }
  if (email?.trim()) {
    params.Email = email.trim()
  }

  const { status, ok, parsed, rawBody } = await postGmsAuth(params, fetchFn)

  if (parsed.Error) {
    throw new GeminiAppError(
      `GMS access token exchange failed: ${parsed.Error}${parsed.ErrorDetail ? ` (${parsed.ErrorDetail})` : ''}`,
      classifyGmsErrorCode(parsed.Error, status),
      status,
    )
  }

  if (!ok) {
    throw new GeminiAppError(
      `GMS access token exchange failed with HTTP ${status}: ${rawBody.slice(0, 200)}`,
      classifyGmsErrorCode(undefined, status),
      status,
    )
  }

  const accessToken = parsed.Auth
  if (!accessToken) {
    throw new GeminiAppError(
      'GMS access token exchange succeeded but response did not contain Auth=',
      'AUTH_REQUIRED',
      status,
    )
  }

  const now = Date.now()
  let expiresAt = now + 3600_000
  if (parsed.Expiry) {
    const expirySec = Number(parsed.Expiry)
    if (Number.isFinite(expirySec) && expirySec > 0) {
      expiresAt = expirySec * 1000
    }
  }

  return {
    accessToken,
    expiresAt,
    ...(parsed.Email || email?.trim() ? { email: parsed.Email || email?.trim() } : {}),
  }
}
