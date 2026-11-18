// Scope alignment with the real agy 1.3.5 CLI + scope-aware re-auth detection.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGY_SCOPES,
  AGY_TOKEN_SCOPE_KEY,
  LEGACY_AGY_SCOPES,
  buildAuthorizeUrl,
  missingScopes,
  needsReauth,
  normalizeScopes,
  readGrantedScopes,
  toTokenSet,
  writeAgyTokenFile,
} from '../src/oauth.ts'

const AICODE = 'https://www.googleapis.com/auth/aicode'
const EXTRA_SCOPE = 'https://www.googleapis.com/auth/drive.file'

function readTokenDoc(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

test('AGY_SCOPES includes the AICode scope that agy requests', () => {
  assert.ok(
    AGY_SCOPES.includes(AICODE),
    'agy 1.3.5 requests https://www.googleapis.com/auth/aicode; without it the AICode ' +
      'backend answers 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  )
})

test('the alignment only adds scopes (nothing an existing token was granted is dropped)', () => {
  const dropped = LEGACY_AGY_SCOPES.filter((scope) => !AGY_SCOPES.includes(scope))
  assert.deepEqual(dropped, [], 'dropping a scope changes the behaviour of already-issued refresh_tokens')
  assert.ok(AGY_SCOPES.length > LEGACY_AGY_SCOPES.length)
})

test('AGY_SCOPES has no blank or duplicate entry and is already in canonical order', () => {
  const trimmed = AGY_SCOPES.map((scope) => scope.trim())
  assert.deepEqual(trimmed, AGY_SCOPES, 'scope strings must not carry stray whitespace')
  assert.equal(new Set(trimmed).size, trimmed.length, 'duplicate scope in AGY_SCOPES')
  assert.ok(trimmed.every((scope) => scope.startsWith('https://www.googleapis.com/auth/')))
  assert.deepEqual(normalizeScopes(AGY_SCOPES), AGY_SCOPES)
})

test('normalizeScopes de-duplicates and is order-stable', () => {
  const reversed = [...AGY_SCOPES].reverse()
  const sorted = [...AGY_SCOPES].sort()
  const padded = AGY_SCOPES.slice(1, 2).map((scope) => `  ${scope}  `)
  const withDupes = [...AGY_SCOPES, AICODE, ...AGY_SCOPES.slice(0, 1), ...padded, '']
  assert.deepEqual(normalizeScopes(reversed), AGY_SCOPES)
  assert.deepEqual(normalizeScopes(sorted), AGY_SCOPES)
  assert.deepEqual(normalizeScopes(withDupes), AGY_SCOPES, 'duplicates and padding must collapse')
  assert.deepEqual(normalizeScopes(AGY_SCOPES.join(' ')), AGY_SCOPES, 'space-separated wire form round-trips')
  assert.deepEqual(normalizeScopes(reversed), normalizeScopes(sorted), 'canonical order must not follow input order')
})

test('normalizeScopes appends non-required scopes in a stable trailing block', () => {
  const otherExtra = 'https://www.googleapis.com/auth/cclog'
  const withExtra = normalizeScopes([EXTRA_SCOPE, ...AGY_SCOPES])
  assert.equal(withExtra.length, AGY_SCOPES.length + 1)
  assert.deepEqual(withExtra.slice(0, AGY_SCOPES.length), AGY_SCOPES, 'required scopes keep their declared precedence')
  assert.deepEqual(withExtra.slice(AGY_SCOPES.length), [EXTRA_SCOPE])
  assert.deepEqual(normalizeScopes([EXTRA_SCOPE, otherExtra]), normalizeScopes([otherExtra, EXTRA_SCOPE]))
  assert.deepEqual(normalizeScopes([]), [])
  assert.deepEqual(normalizeScopes(undefined), [])
  assert.deepEqual(normalizeScopes('   '), [])
})

test('missingScopes reports exactly what a stored grant does not cover', () => {
  assert.deepEqual(missingScopes(LEGACY_AGY_SCOPES), [AICODE])
  assert.deepEqual(missingScopes(AGY_SCOPES), [])
  assert.deepEqual(missingScopes([...AGY_SCOPES, EXTRA_SCOPE]), [])
  assert.deepEqual(missingScopes(AGY_SCOPES.filter((scope) => scope !== AICODE)), [AICODE])
  assert.deepEqual(missingScopes(undefined), AGY_SCOPES, 'an unknown grant covers nothing verifiable')
})

test('needsReauth is true for the old pre-aicode grant and false for the current one', () => {
  assert.equal(needsReauth(LEGACY_AGY_SCOPES), true, 'a token minted without aicode must be re-authorized')
  assert.equal(needsReauth([...LEGACY_AGY_SCOPES].reverse()), true, 'input order must not change the verdict')
  assert.equal(needsReauth(AGY_SCOPES), false, 'the current grant satisfies the current requirement')
  assert.equal(needsReauth([...AGY_SCOPES, EXTRA_SCOPE]), false)
  assert.equal(needsReauth(AGY_SCOPES.filter((scope) => scope !== AICODE)), true)
  assert.equal(needsReauth(AGY_SCOPES.join(' ')), false, 'space-separated stored form is accepted')
})

test('needsReauth never assumes an unrecorded grant is current', () => {
  for (const unrecorded of [undefined, null, []]) {
    assert.equal(needsReauth(unrecorded), true, `${String(unrecorded)} must not be treated as an up-to-date grant`)
  }
})

test('readGrantedScopes reads the recorded grant out of an agy token document', () => {
  assert.deepEqual(readGrantedScopes({ [AGY_TOKEN_SCOPE_KEY]: AGY_SCOPES }), AGY_SCOPES)
  assert.deepEqual(readGrantedScopes({ token: { [AGY_TOKEN_SCOPE_KEY]: AGY_SCOPES.join(' ') } }), AGY_SCOPES)
  assert.deepEqual(readGrantedScopes({ scope: LEGACY_AGY_SCOPES.join(' ') }), LEGACY_AGY_SCOPES)
  assert.equal(readGrantedScopes({ token: { access_token: 'ya29.x' } }), undefined, 'a legacy token file records no scopes')
  assert.equal(readGrantedScopes(undefined), undefined)
  assert.equal(readGrantedScopes({ [AGY_TOKEN_SCOPE_KEY]: [] }), undefined, 'an empty record is not a grant')
})

test('writeAgyTokenFile records the grant, canonicalizes it, and keeps the agy on-disk shape', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-scope-'))
  const file = writeAgyTokenFile(home, {
    access_token: 'ya29.with_aicode',
    refresh_token: '1//with_aicode',
    expiryMs: Date.parse('2026-11-18T00:00:00Z'),
    grantedScopes: [...AGY_SCOPES].reverse(),
  })
  assert.ok(file.endsWith(join('.gemini', 'antigravity-cli', 'antigravity-oauth-token')))

  const doc = readTokenDoc(file)
  const recorded = doc[AGY_TOKEN_SCOPE_KEY]
  assert.ok(Array.isArray(recorded), 'the grant must be recorded as a string array')
  assert.deepEqual(recorded, AGY_SCOPES, 'the recorded grant is canonicalized on write')
  assert.equal(doc.auth_method, 'consumer', 'agy on-disk shape must not change')

  const token = doc.token as Record<string, unknown>
  assert.equal(token.access_token, 'ya29.with_aicode')
  assert.equal(token.token_type, 'Bearer')
  assert.equal(token.refresh_token, '1//with_aicode')
  assert.equal(typeof token.expiry, 'string')
  assert.ok(!Number.isNaN(Date.parse(token.expiry as string)))
  assert.equal(needsReauth(readGrantedScopes(doc)), false)
})

test('writeAgyTokenFile leaves a legacy token file unrecorded instead of inventing a grant', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-scope-legacy-'))
  const file = writeAgyTokenFile(home, {
    access_token: 'ya29.old',
    refresh_token: '1//old',
    expiryMs: Date.parse('2026-11-18T00:00:00Z'),
  })
  const doc = readTokenDoc(file)
  assert.equal(doc[AGY_TOKEN_SCOPE_KEY], undefined, 'no scopes known -> nothing is claimed')
  assert.deepEqual(Object.keys(doc), ['token', 'auth_method'], 'legacy write keeps the pre-change document')
  assert.equal(readGrantedScopes(doc), undefined)
  assert.equal(needsReauth(readGrantedScopes(doc)), true, 'an existing account is flagged for /ccl auth, not broken')
})

test('rewriting after a scope-less refresh keeps the previously recorded grant', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-scope-refresh-'))
  const first = writeAgyTokenFile(home, {
    access_token: 'ya29.first',
    refresh_token: '1//first',
    expiryMs: Date.parse('2026-11-18T00:00:00Z'),
    grantedScopes: [...AGY_SCOPES],
  })
  // refreshTokens() never learns the scope set; rewriting the file must not erase it.
  const second = writeAgyTokenFile(home, {
    access_token: 'ya29.refreshed',
    refresh_token: '1//first',
    expiryMs: Date.parse('2026-11-18T02:00:00Z'),
  })
  assert.equal(second, first, 'the same account path is rewritten in place')
  const doc = readTokenDoc(second)
  assert.deepEqual(readGrantedScopes(doc), AGY_SCOPES, 'recorded grant survives a scope-less refresh')
  assert.equal((doc.token as Record<string, unknown>).access_token, 'ya29.refreshed')
  assert.equal(needsReauth(readGrantedScopes(doc)), false, 'an already-authorized account is not pushed back to /ccl auth')
})

// Reviewer2 finding B4: the code exchange used to write the scopes the consent URL *asked for*
// whenever Google's response omitted `scope`, so needsReauth could never report the missing grant
// and a scope-insufficient token (403 ACCESS_TOKEN_SCOPE_INSUFFICIENT) stayed in the pool.
test('a code exchange whose response omits scope records no grant and still needs re-auth', () => {
  const exchanged = toTokenSet({ access_token: 'ya29.no_scope', refresh_token: '1//no_scope', expires_in: 3600 })
  assert.equal(exchanged.grantedScopes, undefined, 'nothing was echoed back, so nothing may be claimed')
  assert.equal(needsReauth(exchanged.grantedScopes), true, 'an unrecorded grant must stay a re-auth signal')

  const home = mkdtempSync(join(tmpdir(), 'agy-scope-unrecorded-'))
  const doc = readTokenDoc(writeAgyTokenFile(home, exchanged))
  assert.equal(doc[AGY_TOKEN_SCOPE_KEY], undefined, 'the credential file must not claim a grant either')
  assert.deepEqual(readGrantedScopes(doc), undefined)
  assert.notDeepEqual(readGrantedScopes(doc), AGY_SCOPES, 'what the consent URL requested is not what was granted')
  assert.equal(needsReauth(readGrantedScopes(doc)), true, 'the account must be pushed to /ccl auth, not trusted')
})

test('only the echoed scopes are recorded: a narrower echo is not widened into the requested set', () => {
  const echoedScope = `${AICODE} https://www.googleapis.com/auth/userinfo.email`
  const exchanged = toTokenSet({
    access_token: 'ya29.partial',
    refresh_token: '1//partial',
    expires_in: 3600,
    scope: echoedScope,
  })
  assert.deepEqual(exchanged.grantedScopes, normalizeScopes(echoedScope))
  assert.ok(
    AGY_SCOPES.some((scope) => !(exchanged.grantedScopes ?? []).includes(scope)),
    'this echo has to be genuinely narrower than the request for the assertion below to mean anything',
  )
  assert.deepEqual(
    missingScopes(exchanged.grantedScopes),
    AGY_SCOPES.filter((scope) => !echoedScope.split(' ').includes(scope)),
    'the missing scopes are the requested ones Google did not echo',
  )
  assert.equal(needsReauth(exchanged.grantedScopes), true, 'a partial grant must still be reported as insufficient')

  // The full echo is the only state that clears needsReauth.
  const full = toTokenSet({
    access_token: 'ya29.full',
    refresh_token: '1//full',
    expires_in: 3600,
    scope: AGY_SCOPES.join(' '),
  })
  assert.deepEqual(full.grantedScopes, AGY_SCOPES)
  assert.equal(needsReauth(full.grantedScopes), false)
})

test('the consent URL requests every required scope exactly once', () => {
  const url = new URL(buildAuthorizeUrl('challenge-value', 'state-value', 'http://localhost:51121/oauth-callback'))
  const requested = (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean)
  assert.deepEqual(requested, AGY_SCOPES)
  assert.equal(new Set(requested).size, requested.length, 'scope parameter must not repeat a scope')
  assert.ok(requested.includes(AICODE))
})
