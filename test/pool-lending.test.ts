import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AccountPoolManager,
  hasModelCapability,
  type CapableAccountResult,
} from '../src/pool.ts'
import type { ManagedAccount } from '../src/types/pool-types.ts'

function createTestAccount(
  id: string,
  email: string,
  models: Array<{ modelId: string; displayName?: string }>,
  options?: {
    enabled?: boolean
    authRequired?: boolean
    remainingFraction?: number
    cooldowns?: Record<string, number>
  },
): ManagedAccount {
  return {
    id,
    alias: email,
    dir: `/tmp/test-accounts/${id}`,
    email,
    enabled: options?.enabled ?? true,
    authRequired: options?.authRequired ?? false,
    createdAt: Date.now(),
    cooldowns: options?.cooldowns ?? {},
    quotas: {
      google: {
        remainingFraction: options?.remainingFraction ?? 1,
        resetTime: new Date(Date.now() + 3600000).toISOString(),
        models,
      },
    },
  }
}

test('1. hasModelCapability correctly inspects account models for G4 capability with boundary conditions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lending-test-'))
  try {
    const pool = new AccountPoolManager(dir)

    // Account A: Privileged account (quotas include gemini-4-hydrogen-high)
    const accountA = createTestAccount('acc-priv-A', 'priv-a@example.com', [
      { modelId: 'gemini-4-hydrogen-high' },
      { modelId: 'gemini-4-hydrogen-sonar' },
      { modelId: 'gemini-4-argon' },
      { modelId: 'gemini-4-carbon-disabled' },
    ])

    // Account B: Regular account (quotas only include gemini-4-hydrogen-sonar and gemini-4-hydrogen-disabled)
    const accountB = createTestAccount('acc-reg-B', 'reg-b@example.com', [
      { modelId: 'gemini-2.5-flash' },
      { modelId: 'gemini-4-hydrogen-sonar' },
      { modelId: 'gemini-4-hydrogen-disabled' },
    ])

    // Verification on Account A
    // Standalone function hasModelCapability
    assert.equal(hasModelCapability(accountA, 'gemini-4-hydrogen-high'), true)
    assert.equal(hasModelCapability(accountA, 'gemini-4-hydrogen-sonar'), true)
    assert.equal(hasModelCapability(accountA, 'gemini-4-argon'), true)
    assert.equal(hasModelCapability(accountA, 'gemini-4-carbon-disabled'), false) // unservable disabled model
    // Manager method pool.hasModelCapability
    assert.equal(pool.hasModelCapability(accountA, 'gemini-4-hydrogen-high'), true)
    assert.equal(pool.hasModelCapability(accountA, 'gemini-4-carbon-disabled'), false)

    // Verification on Account B (Regular account)
    // Standalone function hasModelCapability: high -> false, sonar -> true, disabled -> false
    assert.equal(hasModelCapability(accountB, 'gemini-4-hydrogen-high'), false)
    assert.equal(hasModelCapability(accountB, 'gemini-4-hydrogen-sonar'), true)
    assert.equal(hasModelCapability(accountB, 'gemini-4-hydrogen-disabled'), false)
    assert.equal(hasModelCapability(accountB, 'gemini-4-argon'), false)
    assert.equal(hasModelCapability(accountB, 'gemini-2.5-flash'), true)
    // Manager method pool.hasModelCapability
    assert.equal(pool.hasModelCapability(accountB, 'gemini-4-hydrogen-high'), false)
    assert.equal(pool.hasModelCapability(accountB, 'gemini-4-hydrogen-sonar'), true)
    assert.equal(pool.hasModelCapability(accountB, 'gemini-4-hydrogen-disabled'), false)

    // Boundary & Edge checks: casing, whitespace, unservable suffixes
    assert.equal(hasModelCapability(accountA, 'GEMINI-4-HYDROGEN-HIGH'), true)
    assert.equal(hasModelCapability(accountA, '  gemini-4-hydrogen-high  '), true)
    assert.equal(hasModelCapability(accountB, 'GEMINI-4-HYDROGEN-HIGH'), false)
    assert.equal(hasModelCapability(accountB, 'gemini-4-disabled'), false)
    assert.equal(hasModelCapability(accountB, ''), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('2. findCapableAccount dynamically locates privileged account without hardcoding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lending-test-'))
  try {
    // Generate unpredictable dynamic account IDs
    const dynamicPrivId = `acc_priv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const dynamicRegId1 = `acc_reg1_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const dynamicRegId2 = `acc_reg2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const poolData = {
      version: 1,
      mode: 'round-robin',
      defaultCooldownMs: 900000,
      maxCooldownMs: 3600000,
      accounts: [
        createTestAccount(dynamicRegId1, 'regular1@example.com', [
          { modelId: 'gemini-2.5-flash' },
          { modelId: 'gemini-4-hydrogen-sonar' },
        ]),
        createTestAccount(dynamicRegId2, 'regular2@example.com', [
          { modelId: 'gemini-2.5-flash' },
          { modelId: 'gemini-4-hydrogen-disabled' },
        ]),
        createTestAccount(dynamicPrivId, 'privileged@example.com', [
          { modelId: 'gemini-4-hydrogen-high' },
          { modelId: 'gemini-4-hydrogen-sonar' },
        ]),
      ],
    }
    writeFileSync(join(dir, 'pool.json'), JSON.stringify(poolData, null, 2))

    const pool = new AccountPoolManager(dir)

    // Dynamically find account capable of serving gemini-4-hydrogen-high
    const capable = pool.findCapableAccount('google', 'gemini-4-hydrogen-high')
    assert.ok(capable, 'Expected a capable account to be found dynamically')
    assert.equal(capable.id, dynamicPrivId, 'Must dynamically find the privileged account id, not a hardcoded value')
    assert.equal(capable.email, 'privileged@example.com')

    // Boundary: When the privileged account is put into cooldown (e.g. 429 quota exhausted), no capable account remains
    pool.recordFailure(dynamicPrivId, 'google', 'Rate limit exceeded 429')
    const capableAfterCooldown = pool.findCapableAccount('google', 'gemini-4-hydrogen-high')
    assert.equal(capableAfterCooldown, null, 'Must return null when the only capable account is cooling down')

    // Boundary: Unknown model returns null when no account supports it
    const capableUnknown = pool.findCapableAccount('google', 'non-existent-g4-ultra-model-disabled')
    assert.equal(capableUnknown, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('3. findCapableAccount prioritizes accounts with higher remaining quota fraction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lending-test-'))
  try {
    const privLowQuotaId = `priv_low_${Date.now()}`
    const privHighQuotaId = `priv_high_${Date.now()}`

    const poolData = {
      version: 1,
      mode: 'round-robin',
      defaultCooldownMs: 900000,
      maxCooldownMs: 3600000,
      accounts: [
        createTestAccount(
          privLowQuotaId,
          'priv_low@example.com',
          [{ modelId: 'gemini-4-hydrogen-high' }],
          { remainingFraction: 0.2 },
        ),
        createTestAccount(
          privHighQuotaId,
          'priv_high@example.com',
          [{ modelId: 'gemini-4-hydrogen-high' }],
          { remainingFraction: 0.95 },
        ),
      ],
    }
    writeFileSync(join(dir, 'pool.json'), JSON.stringify(poolData, null, 2))

    const pool = new AccountPoolManager(dir)
    const capable = pool.findCapableAccount('google', 'gemini-4-hydrogen-high')
    assert.ok(capable)
    assert.equal(capable.id, privHighQuotaId, 'Should pick the account with higher remaining quota fraction')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('4. getCapableAccount executes native direct, capability lending, universal model, and graceful fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lending-test-'))
  try {
    const privId = `priv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const regId = `reg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

    const poolData = {
      version: 1,
      mode: 'round-robin',
      defaultCooldownMs: 900000,
      maxCooldownMs: 3600000,
      accounts: [
        createTestAccount(regId, 'regular@example.com', [
          { modelId: 'gemini-2.5-flash' },
          { modelId: 'gemini-4-hydrogen-sonar' },
        ]),
        createTestAccount(privId, 'privileged@example.com', [
          { modelId: 'gemini-4-hydrogen-high' },
          { modelId: 'gemini-4-hydrogen-sonar' },
        ]),
      ],
    }
    writeFileSync(join(dir, 'pool.json'), JSON.stringify(poolData, null, 2))
    const pool = new AccountPoolManager(dir)

    // Scenario 1 (Native Direct): Specified preferredAccountId is privileged account requesting gemini-4-hydrogen-high
    const resNative: CapableAccountResult | null = pool.getCapableAccount('gemini-4-hydrogen-high', privId)
    assert.ok(resNative, 'Expected valid CapableAccountResult for native account')
    assert.equal(resNative.account.id, privId)
    assert.equal(resNative.borrowedFrom, undefined, 'Native direct must have borrowedFrom: undefined')
    assert.equal(resNative.modelToUse, 'gemini-4-hydrogen-high')
    assert.equal(resNative.isFallback, false)

    // Scenario 2 (Capability Lending): Specified preferredAccountId is regular account requesting gemini-4-hydrogen-high
    const resLended: CapableAccountResult | null = pool.getCapableAccount('gemini-4-hydrogen-high', regId)
    assert.ok(resLended, 'Expected valid CapableAccountResult with capability lending')
    assert.equal(resLended.account.id, regId, 'Keeps original regular account identity for session affinity')
    assert.ok(resLended.borrowedFrom, 'Must have borrowedFrom account')
    assert.equal(resLended.borrowedFrom?.id, privId, 'Must borrow from the privileged account')
    assert.equal(resLended.modelToUse, 'gemini-4-hydrogen-high')
    assert.equal(resLended.isFallback, false)

    // Scenario 3 (Universal Model No Lending): Specified preferredAccountId is regular account requesting gemini-4-hydrogen-sonar
    const resSonar: CapableAccountResult | null = pool.getCapableAccount('gemini-4-hydrogen-sonar', regId)
    assert.ok(resSonar, 'Expected valid CapableAccountResult for sonar')
    assert.equal(resSonar.account.id, regId)
    assert.equal(resSonar.borrowedFrom, undefined, 'Universal model supported natively requires no lending')
    assert.equal(resSonar.modelToUse, 'gemini-4-hydrogen-sonar')
    assert.equal(resSonar.isFallback, false)

    // Scenario 4 (Fallback Disaster Recovery): When privileged account is exhausted or cooling down
    pool.recordFailure(privId, 'google', 'Quota exhausted 429')
    const resFallback: CapableAccountResult | null = pool.getCapableAccount('gemini-4-hydrogen-high', regId)
    assert.ok(resFallback, 'Expected fallback CapableAccountResult when privileged account is in cooldown')
    assert.equal(resFallback.account.id, regId)
    assert.equal(resFallback.borrowedFrom, undefined, 'Fallback does not borrow')
    assert.equal(resFallback.modelToUse, 'gemini-4-hydrogen-sonar', 'Gracefully degrades to gemini-4-hydrogen-sonar')
    assert.equal(resFallback.isFallback, true, 'isFallback must be true')

    // Scenario 5: No preferred account specified -> Pool automatically resolves account and capability
    // Reset priv cooldown to test automatic selection
    const resetPoolData = {
      ...poolData,
      accounts: [
        createTestAccount(regId, 'regular@example.com', [
          { modelId: 'gemini-2.5-flash' },
          { modelId: 'gemini-4-hydrogen-sonar' },
        ]),
        createTestAccount(privId, 'privileged@example.com', [
          { modelId: 'gemini-4-hydrogen-high' },
          { modelId: 'gemini-4-hydrogen-sonar' },
        ]),
      ],
    }
    writeFileSync(join(dir, 'pool.json'), JSON.stringify(resetPoolData, null, 2))
    const freshPool = new AccountPoolManager(dir)

    const resAuto = freshPool.getCapableAccount('gemini-4-hydrogen-high')
    assert.ok(resAuto)
    // The model to use must be gemini-4-hydrogen-high
    assert.equal(resAuto.modelToUse, 'gemini-4-hydrogen-high')
    assert.equal(resAuto.isFallback, false)

    // Scenario 6: All accounts in cooldown -> returns null
    freshPool.recordFailure(privId, 'google', '429 Rate Limit')
    freshPool.recordFailure(regId, 'google', '429 Rate Limit')
    const resExhausted = freshPool.getCapableAccount('gemini-4-hydrogen-high')
    assert.equal(resExhausted, null, 'Must return null when all accounts in pool are in cooldown')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('5. getBroadcastedCatalogModels aggregates pool models and exposes Gemini 4 to all accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lending-test-'))
  try {
    const poolData = {
      version: 1,
      mode: 'round-robin',
      defaultCooldownMs: 900000,
      maxCooldownMs: 3600000,
      accounts: [
        createTestAccount('acc-1', 'user1@example.com', [
          { modelId: 'gemini-2.5-flash' },
          { modelId: 'gemini-2.5-pro' },
        ]),
        createTestAccount('acc-2', 'user2@example.com', [
          { modelId: 'gemini-4-hydrogen-high' },
          { modelId: 'gemini-4-hydrogen-sonar' },
          { modelId: 'gemini-4-hydrogen-disabled' }, // unservable, must be excluded
        ]),
        createTestAccount('acc-disabled', 'disabled@example.com', [
          { modelId: 'gemini-4-carbon' },
        ], { enabled: false }), // disabled account, must not broadcast
        createTestAccount('acc-auth-req', 'authreq@example.com', [
          { modelId: 'gemini-4-neon' },
        ], { authRequired: true }), // auth required, must not broadcast
      ],
    }
    writeFileSync(join(dir, 'pool.json'), JSON.stringify(poolData, null, 2))

    const pool = new AccountPoolManager(dir)

    const catalog = pool.getBroadcastedCatalogModels('google')
    assert.ok(Array.isArray(catalog), 'Catalog must be an array of strings')

    // Servable models from active accounts
    assert.ok(catalog.includes('gemini-2.5-flash'))
    assert.ok(catalog.includes('gemini-2.5-pro'))
    assert.ok(catalog.includes('gemini-4-hydrogen-high'))
    assert.ok(catalog.includes('gemini-4-hydrogen-sonar'))

    // Automatic G4 core models broadcasted when any account has G4 capability
    assert.ok(catalog.includes('gemini-4-hydrogen'))
    assert.ok(catalog.includes('gemini-4-argon'))

    // Boundary: Disabled / unservable models must NEVER be broadcast
    assert.equal(catalog.includes('gemini-4-hydrogen-disabled'), false, '-disabled models must not be broadcast')

    // Boundary: Disabled accounts and authRequired accounts must not leak their unique models
    assert.equal(catalog.includes('gemini-4-carbon'), false, 'Models from disabled accounts must not be broadcast')
    assert.equal(catalog.includes('gemini-4-neon'), false, 'Models from authRequired accounts must not be broadcast')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('6. getBroadcastedCatalogModels does not inject G4 models when no pool account supports G4', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lending-no-g4-'))
  try {
    const poolData = {
      version: 1,
      mode: 'round-robin',
      defaultCooldownMs: 900000,
      maxCooldownMs: 3600000,
      accounts: [
        createTestAccount('acc-legacy-1', 'legacy1@example.com', [
          { modelId: 'gemini-2.5-flash' },
          { modelId: 'gemini-2.5-pro' },
        ]),
      ],
    }
    writeFileSync(join(dir, 'pool.json'), JSON.stringify(poolData, null, 2))

    const pool = new AccountPoolManager(dir)
    const catalog = pool.getBroadcastedCatalogModels('google')

    assert.ok(catalog.includes('gemini-2.5-flash'))
    assert.ok(catalog.includes('gemini-2.5-pro'))
    assert.equal(catalog.includes('gemini-4-hydrogen'), false, 'G4 models should not be injected if no account has G4')
    assert.equal(catalog.includes('gemini-4-argon'), false)
    assert.equal(catalog.includes('gemini-4-hydrogen-sonar'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
