// account-health.ts: the runtime verdict built on oauth.ts's scope helpers.
// Covers the pure judgement, the credential-document data source, the guidance sentence,
// the per-attempt 401/403 gate, and the account-list payload — with both the
// "needs re-auth" and the "already authorized" direction asserted so nothing here can pass
// by returning a fixed answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGY_SCOPES,
  AGY_TOKEN_SCOPE_KEY,
  LEGACY_AGY_SCOPES,
  missingScopes,
  needsReauth,
  writeAgyTokenFile,
} from '../src/oauth.ts'
import {
  AGY_TOKEN_FILE_SEGMENTS,
  REAUTH_CANDIDATE_STATUSES,
  accountHomeDir,
  agyTokenFilePath,
  authHealthFromScopes,
  describeAccountAuth,
  describePoolAuthHealth,
  readAccountGrantedScopes,
  readAccountTokenDocument,
  reauthGuidance,
  reauthGuidanceFor,
  reauthGuidanceResolver,
  scopeLabel,
  withAccountAuthHealth,
} from '../src/account-health.ts'
import { AccountPoolManager } from '../src/pool.ts'
import type { ManagedAccount } from '../src/types/pool-types.ts'

const AICODE = 'https://www.googleapis.com/auth/aicode'

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `acct-health-${label}-`))
}

/** Minimal account shape; `dir` is an isolated home, exactly like a pool slot. */
function accountAt(dir: string, id = 'acc-1', alias = 'primary'): ManagedAccount {
  return { id, alias, dir, enabled: true, createdAt: 0, cooldowns: {}, quotas: {} }
}

function writeGrant(dir: string, scopes?: string[]): string {
  const file = writeAgyTokenFile(dir, {
    access_token: 'ya29.test',
    refresh_token: 'rt.test',
    ...(scopes ? { grantedScopes: scopes } : {}),
  })
  return file
}

test('a grant that predates the aicode scope is reported as needing re-auth', () => {
  const health = authHealthFromScopes(LEGACY_AGY_SCOPES)
  assert.equal(health.reauthRequired, true)
  assert.deepEqual(health.missingScopes, [AICODE])
})

test('a grant that covers AGY_SCOPES is reported as authorized', () => {
  const health = authHealthFromScopes(AGY_SCOPES)
  assert.equal(health.reauthRequired, false)
  assert.deepEqual(health.missingScopes, [])
})

test('an unrecorded grant follows oauth.ts semantics: re-auth yes, gap = aicode only', () => {
  for (const unrecorded of [undefined, null, [], ''] as const) {
    const health = authHealthFromScopes(unrecorded)
    assert.equal(health.reauthRequired, true, `unrecorded grant ${JSON.stringify(unrecorded)} must prompt re-auth`)
    assert.equal(health.reauthRequired, needsReauth(unrecorded))
    assert.deepEqual(
      health.missingScopes,
      missingScopes(LEGACY_AGY_SCOPES),
      'an unrecorded grant is judged against LEGACY_AGY_SCOPES, so the gap must not be inflated to all of AGY_SCOPES',
    )
    assert.ok(health.missingScopes.includes(AICODE))
  }
})

test('the verdict tracks the actual gap instead of a fixed answer', () => {
  const noAicode = AGY_SCOPES.filter((s) => s !== AICODE)
  const noEmail = AGY_SCOPES.filter((s) => !s.endsWith('userinfo.email'))

  const a = authHealthFromScopes(noAicode)
  const b = authHealthFromScopes(noEmail)
  const full = authHealthFromScopes(AGY_SCOPES)

  assert.deepEqual(a.missingScopes, [AICODE])
  assert.deepEqual(b.missingScopes, ['https://www.googleapis.com/auth/userinfo.email'])
  assert.deepEqual(full.missingScopes, [])
  assert.notDeepEqual(a.missingScopes, b.missingScopes)

  // Extra scopes the consent happened to cover do not create a false gap.
  const wider = authHealthFromScopes([...AGY_SCOPES, 'https://www.googleapis.com/auth/drive.file'])
  assert.equal(wider.reauthRequired, false)
  assert.deepEqual(wider.missingScopes, [])

  // Scope order must not matter.
  assert.equal(authHealthFromScopes([...AGY_SCOPES].reverse()).reauthRequired, false)
})

test('the reader looks at the same credential document writeAgyTokenFile writes', () => {
  const home = tempDir('doc')
  try {
    const written = writeGrant(home, [...AGY_SCOPES])
    const account = accountAt(home)
    assert.equal(agyTokenFilePath(account), written, 'path disagreement would make the verdict read the wrong file')
    assert.deepEqual(AGY_TOKEN_FILE_SEGMENTS, written.slice(home.length + 1).split('/'))
    assert.deepEqual(readAccountGrantedScopes(account), [...AGY_SCOPES])
    assert.equal(describeAccountAuth(account).reauthRequired, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a token document without a recorded grant yields an undefined grant and a re-auth verdict', () => {
  const home = tempDir('legacy')
  try {
    const file = writeGrant(home)
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(doc[AGY_TOKEN_SCOPE_KEY], undefined, 'this test models a pre-scope token: no grant recorded')

    const account = accountAt(home)
    assert.equal(readAccountGrantedScopes(account), undefined)
    const health = describeAccountAuth(account)
    assert.equal(health.reauthRequired, true)
    assert.deepEqual(health.missingScopes, [AICODE])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the reader accepts the document shapes readGrantedScopes accepts', () => {
  const shapes: Record<string, Record<string, unknown>> = {
    array: { token: { [AGY_TOKEN_SCOPE_KEY]: [...AGY_SCOPES] } },
    'space-separated string': { [AGY_TOKEN_SCOPE_KEY]: AGY_SCOPES.join(' ') },
    'nested under token': { token: { scopes: [...AGY_SCOPES] } },
  }

  for (const [label, doc] of Object.entries(shapes)) {
    const home = tempDir(`shape-${label.replace(/\W+/g, '-')}`)
    try {
      const dir = join(home, ...AGY_TOKEN_FILE_SEGMENTS.slice(0, -1))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(home, ...AGY_TOKEN_FILE_SEGMENTS), JSON.stringify(doc), 'utf8')
      const account = accountAt(home)
      assert.equal(readAccountGrantedScopes(account)?.length, AGY_SCOPES.length, `shape ${label}`)
      assert.equal(describeAccountAuth(account).reauthRequired, false, `shape ${label}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('an absent or unreadable document is an unrecorded grant, not a crash', () => {
  const empty = tempDir('missing-doc')
  try {
    const account = accountAt(empty)
    assert.equal(readAccountTokenDocument(account), undefined)
    assert.equal(readAccountGrantedScopes(account), undefined)
    assert.equal(describeAccountAuth(account).reauthRequired, true)

    mkdirSync(join(empty, ...AGY_TOKEN_FILE_SEGMENTS.slice(0, -1)), { recursive: true })
    writeFileSync(join(empty, ...AGY_TOKEN_FILE_SEGMENTS), 'not json at all', 'utf8')
    assert.equal(readAccountTokenDocument(account), undefined)
    assert.equal(describeAccountAuth(account).reauthRequired, true)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('the system-home account is resolved through the injected system home', () => {
  const sysHome = tempDir('sys-home')
  try {
    const account: ManagedAccount = {
      id: 'acc-system',
      alias: 'system',
      dir: '',
      systemHome: true,
      enabled: true,
      createdAt: 0,
      cooldowns: {},
      quotas: {},
    }
    assert.equal(accountHomeDir(account, sysHome), sysHome)
    assert.equal(accountHomeDir(accountAt(join(sysHome, 'slot')), sysHome), join(sysHome, 'slot'))

    // No document yet => re-auth prompt.
    assert.equal(describeAccountAuth(account, readAccountGrantedScopes(account, sysHome)).reauthRequired, true)

    writeGrant(sysHome, [...AGY_SCOPES])
    assert.deepEqual(readAccountGrantedScopes(account, sysHome), [...AGY_SCOPES])
    assert.equal(describeAccountAuth(account, readAccountGrantedScopes(account, sysHome)).reauthRequired, false)
  } finally {
    rmSync(sysHome, { recursive: true, force: true })
  }
})

test('the guidance sentence names the missing scope and the command to run', () => {
  const health = authHealthFromScopes(LEGACY_AGY_SCOPES)
  const text = reauthGuidance(health, 'work')
  assert.ok(text.includes('/ccl auth'), `guidance must tell the user to re-authorize: ${text}`)
  assert.ok(text.includes('auth/aicode'), `guidance must name the missing scope: ${text}`)
  assert.ok(text.includes('work'))

  // A different gap produces a different sentence — the text is built from the verdict.
  const other = reauthGuidance(authHealthFromScopes(AGY_SCOPES.filter((s) => !s.endsWith('userinfo.email'))), 'work')
  assert.ok(other.includes('auth/userinfo.email'))
  assert.ok(!other.includes('auth/aicode'))
  assert.equal(scopeLabel(AICODE), 'auth/aicode')
})

test('reauthGuidanceFor only fires for authorization statuses on an account that needs it', () => {
  const home = tempDir('guidance')
  try {
    const legacyHome = join(home, 'legacy')
    const grantedHome = join(home, 'granted')
    writeGrant(legacyHome)
    writeGrant(grantedHome, [...AGY_SCOPES])
    const legacy = accountAt(legacyHome, 'acc-legacy', 'legacy')
    const granted = accountAt(grantedHome, 'acc-granted', 'granted')

    assert.deepEqual(REAUTH_CANDIDATE_STATUSES, [401, 403])

    for (const status of REAUTH_CANDIDATE_STATUSES) {
      const text = reauthGuidanceFor(legacy, { status })
      assert.ok(text, `status ${status} on an under-scoped account must produce guidance`)
      assert.ok(text!.includes('/ccl auth'))
      assert.ok(text!.includes('auth/aicode'))
      assert.ok(text!.includes('legacy'))
    }

    // Fully authorized accounts: the same 401/403 is not an authorization gap.
    for (const status of REAUTH_CANDIDATE_STATUSES) {
      assert.equal(reauthGuidanceFor(granted, { status }), undefined, `status ${status} on a full grant`)
    }

    // 429 / 500 / a timeout is not an authorization verdict, however narrow the grant is.
    for (const status of [429, 500, 503, 0]) {
      assert.equal(reauthGuidanceFor(legacy, { status }), undefined, `status ${status} must not be dressed up as an auth gap`)
    }

    // A grant snapshot handed in by the caller wins over the on-disk document.
    assert.equal(reauthGuidanceFor(legacy, { status: 403, grantedScopes: [...AGY_SCOPES] }), undefined)
    assert.ok(reauthGuidanceFor(granted, { status: 401, grantedScopes: LEGACY_AGY_SCOPES }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the account-list payload annotates every account and counts the gap', () => {
  const base = tempDir('pool')
  // The pool always carries a system-home account. Point that home at a sandbox directory
  // so the verdict depends on this test's fixtures and not on whoever runs it.
  const sysHome = tempDir('pool-sys-home')
  try {
    const pool = new AccountPoolManager(base)
    const primary = pool.getAccounts().find((a) => a.systemHome)
    assert.ok(primary, 'a pool always has the system-home account')
    const legacy = pool.createAccountSlot('legacy')
    const granted = pool.createAccountSlot('granted')
    writeGrant(legacy.dir)
    writeGrant(granted.dir, [...AGY_SCOPES])
    writeGrant(sysHome, [...AGY_SCOPES])

    const raw = pool.getPoolData()
    const payload = describePoolAuthHealth(raw, undefined, sysHome)

    assert.equal(payload.accounts.length, raw.accounts.length, 'no account may be dropped')
    assert.equal(payload.accountsNeedingReauth, 1, 'only the legacy slot needs re-auth')

    const byId = new Map(payload.accounts.map((a) => [a.id, a]))
    const legacyRow = byId.get(legacy.id)!
    const grantedRow = byId.get(granted.id)!
    const primaryRow = byId.get(primary!.id)!

    assert.equal(legacyRow.reauthRequired, true)
    assert.deepEqual(legacyRow.missingScopes, [AICODE])
    assert.equal(grantedRow.reauthRequired, false)
    assert.deepEqual(grantedRow.missingScopes, [])
    assert.equal(primaryRow.reauthRequired, false, 'the system account holds a full grant in the sandbox home')

    // Read-only: the account keeps the fields the pool gave it, and the pool's own data is untouched.
    for (const [row, source] of [
      [legacyRow, legacy],
      [grantedRow, granted],
    ] as const) {
      assert.equal(row.id, source.id)
      assert.equal(row.alias, source.alias)
      assert.equal(row.dir, source.dir)
      assert.equal(row.enabled, true, 'a scope gap must not disable an account')
    }
    assert.ok(
      !('reauthRequired' in (raw.accounts.find((a) => a.id === legacy.id) ?? {})),
      'describePoolAuthHealth must annotate copies, not mutate the pool data',
    )
    assert.ok(!('accountsNeedingReauth' in raw))

    // An explicitly supplied snapshot wins over the on-disk document, in both directions.
    const forced = describePoolAuthHealth(
      raw,
      (account) =>
        account.id === legacy.id
          ? AGY_SCOPES
          : account.id === granted.id
            ? LEGACY_AGY_SCOPES
            : undefined,
      sysHome,
    )
    assert.equal(
      forced.accounts.find((a) => a.id === legacy.id)!.reauthRequired,
      false,
      'the snapshot must override a legacy document',
    )
    assert.equal(
      forced.accounts.find((a) => a.id === granted.id)!.reauthRequired,
      true,
      'the snapshot must override a fully granted document',
    )
    assert.equal(forced.accountsNeedingReauth, 1)

    // withAccountAuthHealth is the per-row entry point the command surface uses.
    const row = withAccountAuthHealth(legacy)
    assert.equal(row.reauthRequired, true)
    assert.deepEqual(row.missingScopes, [AICODE])
  } finally {
    rmSync(base, { recursive: true, force: true })
    rmSync(sysHome, { recursive: true, force: true })
  }
})

test('the per-attempt resolver looks the account up and applies the same gate', () => {
  const home = tempDir('resolver')
  try {
    const legacyHome = join(home, 'legacy')
    const grantedHome = join(home, 'granted')
    writeGrant(legacyHome)
    writeGrant(grantedHome, [...AGY_SCOPES])
    const accounts = new Map<string, ManagedAccount>([
      ['acc-legacy', accountAt(legacyHome, 'acc-legacy', 'legacy')],
      ['acc-granted', accountAt(grantedHome, 'acc-granted', 'granted')],
    ])
    const resolve = reauthGuidanceResolver((accountId) => accounts.get(accountId))

    const gap403 = resolve('acc-legacy', { httpStatus: 403 })
    assert.ok(gap403, 'a 403 on an under-scoped account must be named as a scope gap')
    assert.ok(gap403.includes('/ccl auth'), gap403)
    assert.ok(gap403.includes('auth/aicode'), gap403)
    assert.ok(resolve('acc-legacy', { httpStatus: 401 }))

    assert.equal(resolve('acc-granted', { httpStatus: 403 }), undefined, 'a full grant is not an auth gap')
    assert.equal(resolve('acc-legacy', { httpStatus: null }), undefined, 'no HTTP answer is no verdict')
    assert.equal(resolve('acc-legacy', { httpStatus: 429 }), undefined)
    assert.equal(resolve('acc-not-indexed', { httpStatus: 401 }), undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
