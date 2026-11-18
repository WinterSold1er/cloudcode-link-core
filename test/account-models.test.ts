// account-models.ts — describeAccountModels: the normalized per-account model catalog.
// Asserts the whole contract: nothing invented for an unknown family, dedup inside a family,
// family correction from the model id, stable ordering, refreshedAt as a max over quota
// timestamps, and that the input account is never written to.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MODEL_FAMILY_ORDER,
  describeAccountModels,
  type AccountModelCatalog,
} from '../src/account-models.ts'
import type { ManagedAccount, ModelFamily } from '../src/types/pool-types.ts'

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc_test',
    alias: 'acc_test',
    dir: '',
    enabled: true,
    createdAt: 0,
    cooldowns: {},
    quotas: {},
    ...overrides,
  }
}

function familiesOf(catalog: AccountModelCatalog): ModelFamily[] {
  return catalog.familyModels.map((f) => f.family)
}

function modelsOf(catalog: AccountModelCatalog, family: ModelFamily): string[] {
  return (catalog.familyModels.find((f) => f.family === family)?.models ?? []).map((m) => m.id)
}

test('an account with no recorded quota knows nothing and fabricates no model', () => {
  const catalog = describeAccountModels(makeAccount())

  assert.equal(catalog.known, false)
  assert.equal(catalog.total, 0)
  assert.equal(catalog.refreshedAt, null)
  // Exactly the four canonical families, in contract order — the UI renders this list as-is.
  assert.deepEqual(familiesOf(catalog), ['google', 'anthropic', 'openai', 'unknown'])
  for (const family of catalog.familyModels) {
    assert.equal(family.known, false)
    assert.deepEqual(family.models, [])
    assert.equal('quota' in family, false, 'a family with no quota data must not carry a quota field')
  }
})

test('a family whose models array is empty is known:false even when its quota is filled in', () => {
  const account = makeAccount({
    quotas: {
      google: { remainingFraction: 0.4, weeklyFraction: 0.9, updatedAt: 1_700_000_000_000, models: [] },
    },
  })
  const catalog = describeAccountModels(account)
  const google = catalog.familyModels.find((f) => f.family === 'google')

  assert.ok(google)
  assert.equal(google.known, false)
  assert.deepEqual(google.models, [])
  assert.equal(catalog.known, false, 'quota numbers alone are not a model list')
  assert.equal(catalog.total, 0)
  // The quota summary is still real data and is passed through unchanged.
  assert.deepEqual(google.quota, {
    remainingFraction: 0.4,
    weeklyFraction: 0.9,
    updatedAt: 1_700_000_000_000,
  })
  // refreshedAt comes from the quota timestamp, not from the (empty) model list.
  assert.equal(catalog.refreshedAt, 1_700_000_000_000)
})

test('a single family reports its models sorted by id with the upstream display name', () => {
  const account = makeAccount({
    quotas: {
      google: {
        remainingFraction: 0.75,
        updatedAt: 10,
        models: [
          { modelId: 'gemini-4-hydrogen-medium', displayName: 'Gemini 4 Hydrogen', remainingFraction: 0.75, resetTime: '2026-11-18T12:00:00Z' },
          { modelId: 'gemini-3-flash' },
          { modelId: 'gemma-3-27b' },
        ],
      },
    },
  })
  const catalog = describeAccountModels(account)
  const google = catalog.familyModels.find((f) => f.family === 'google')

  assert.ok(google)
  assert.equal(google.known, true)
  assert.deepEqual(google.models.map((m) => m.id), ['gemini-3-flash', 'gemini-4-hydrogen-medium', 'gemma-3-27b'])
  assert.equal(catalog.known, true)
  assert.equal(catalog.total, 3)
  assert.equal(catalog.refreshedAt, 10)

  const hydrogen = google.models.find((m) => m.id === 'gemini-4-hydrogen-medium')
  assert.ok(hydrogen)
  assert.equal(hydrogen.name, 'Gemini 4 Hydrogen')
  assert.equal(hydrogen.family, 'google')
  assert.equal(hydrogen.remainingFraction, 0.75)
  assert.equal(hydrogen.resetTime, '2026-11-18T12:00:00Z')

  // No displayName upstream: the name falls back to the id instead of being made up.
  const bare = google.models.find((m) => m.id === 'gemini-3-flash')
  assert.ok(bare)
  assert.equal(bare.name, 'gemini-3-flash')
  assert.equal('remainingFraction' in bare, false)
  assert.equal('resetTime' in bare, false)

  // Families this account says nothing about stay empty rather than filled from a catalog.
  assert.deepEqual(modelsOf(catalog, 'anthropic'), [])
  assert.deepEqual(modelsOf(catalog, 'openai'), [])
})

test('several families come back in google → anthropic → openai → unknown order', () => {
  const account = makeAccount({
    quotas: {
      openai: { models: [{ modelId: 'gpt-5.1-codex', remainingFraction: 1 }], updatedAt: 3 },
      anthropic: { models: [{ modelId: 'claude-sonnet-4-5-20250929', remainingFraction: 0.5 }], updatedAt: 5 },
      google: { models: [{ modelId: 'gemini-3.7-flash', remainingFraction: 0.25 }], updatedAt: 1 },
      unknown: { models: [{ modelId: 'mystery-model-x' }], updatedAt: 2 },
    },
  })
  const catalog = describeAccountModels(account)

  assert.deepEqual(familiesOf(catalog), ['google', 'anthropic', 'openai', 'unknown'])
  assert.deepEqual(modelsOf(catalog, 'google'), ['gemini-3.7-flash'])
  assert.deepEqual(modelsOf(catalog, 'anthropic'), ['claude-sonnet-4-5-20250929'])
  assert.deepEqual(modelsOf(catalog, 'openai'), ['gpt-5.1-codex'])
  assert.deepEqual(modelsOf(catalog, 'unknown'), ['mystery-model-x'])
  assert.equal(catalog.total, 4)
  assert.equal(catalog.known, true)
  assert.equal(catalog.refreshedAt, 5, 'refreshedAt is the max updatedAt across families')
  const google = catalog.familyModels.find((f) => f.family === 'google')
  assert.ok(google)
  assert.deepEqual(google.quota, { updatedAt: 1 })
})

test('duplicate model ids collapse to one entry: the smaller remaining fraction wins', () => {
  const account = makeAccount({
    quotas: {
      google: {
        models: [
          { modelId: 'gemini-4-hydrogen-medium', remainingFraction: 0.7, resetTime: '2026-11-18T09:00:00Z' },
          { modelId: 'gemini-4-hydrogen-medium', remainingFraction: 0.2, resetTime: '2026-11-18T12:00:00Z' },
          { modelId: 'gemini-4-hydrogen-medium', remainingFraction: 0.9 },
        ],
      },
    },
  })
  const catalog = describeAccountModels(account)
  const models = catalog.familyModels.find((f) => f.family === 'google')?.models ?? []

  assert.equal(models.length, 1)
  assert.equal(catalog.total, 1)
  assert.equal(models[0]?.remainingFraction, 0.2, 'the most conservative fraction is reported')
  assert.equal(models[0]?.resetTime, '2026-11-18T12:00:00Z')
})

test('duplicate model ids without fractions collapse to the record that carries more detail', () => {
  const account = makeAccount({
    quotas: {
      anthropic: {
        models: [
          { modelId: 'claude-sonnet-4-5-20250929' },
          { modelId: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', remainingFraction: 0.33 },
          { modelId: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5' },
        ],
      },
    },
  })
  const models = describeAccountModels(account).familyModels.find((f) => f.family === 'anthropic')?.models ?? []

  assert.equal(models.length, 1)
  assert.equal(models[0]?.name, 'Claude Sonnet 4.5')
  assert.equal(models[0]?.remainingFraction, 0.33)
})

test('a model id that contradicts its quota key is re-attributed by modelFamilyOf', () => {
  const account = makeAccount({
    quotas: {
      // Upstream filed a Gemini model under the OpenAI counter key.
      openai: { models: [{ modelId: 'gemini-4-hydrogen-medium', remainingFraction: 0.6 }], updatedAt: 7 },
      // An "unknown" bucket holding a real Claude model.
      unknown: { models: [{ modelId: 'claude-opus-4-1-20250805' }], updatedAt: 4 },
      anthropic: { models: [{ modelId: 'claude-sonnet-4-5-20250929' }], updatedAt: 6 },
    },
  })
  const catalog = describeAccountModels(account)

  assert.deepEqual(modelsOf(catalog, 'google'), ['gemini-4-hydrogen-medium'])
  assert.deepEqual(modelsOf(catalog, 'anthropic'), ['claude-opus-4-1-20250805', 'claude-sonnet-4-5-20250929'])
  // The bucket that only held a mis-filed entry ends up with nothing to show, while its own
  // quota numbers are still real data and survive the re-attribution.
  const openai = catalog.familyModels.find((f) => f.family === 'openai')
  assert.ok(openai)
  assert.equal(openai.known, false)
  assert.deepEqual(openai.models, [])
  assert.deepEqual(openai.quota, { updatedAt: 7 })
  assert.deepEqual(modelsOf(catalog, 'unknown'), [])
  assert.equal(catalog.total, 3)
  assert.equal(catalog.known, true)
  assert.equal(catalog.refreshedAt, 7)
})

test('an id that no family claims lands in unknown instead of being dropped', () => {
  const account = makeAccount({ quotas: { google: { models: [{ modelId: 'grayscale-x1' }] } } })
  const catalog = describeAccountModels(account)

  assert.deepEqual(modelsOf(catalog, 'google'), [])
  assert.deepEqual(modelsOf(catalog, 'unknown'), ['grayscale-x1'])
  assert.equal(catalog.known, true)
  assert.equal(catalog.total, 1)
  const entry = catalog.familyModels.find((f) => f.family === 'unknown')?.models[0]
  assert.equal(entry?.family, 'unknown')
})

test('blank model ids are dropped and non-finite fractions are not reported', () => {
  const account = makeAccount({
    quotas: {
      google: {
        models: [
          { modelId: '' },
          { modelId: '   ' },
          { modelId: 'gemini-3-flash', remainingFraction: Number.NaN },
          { modelId: 'gemma-3-27b', remainingFraction: Number.POSITIVE_INFINITY, displayName: '  Gemma 3  ' },
        ],
      },
    },
  })
  const catalog = describeAccountModels(account)
  const models = catalog.familyModels.find((f) => f.family === 'unknown')?.models ?? []
  const googleModels = catalog.familyModels.find((f) => f.family === 'google')?.models ?? []

  assert.equal(catalog.total, 2)
  // A NaN fraction must not reach the UI as a number.
  const flash = [...googleModels, ...models].find((m) => m.id === 'gemini-3-flash')
  assert.ok(flash)
  assert.equal('remainingFraction' in flash, false)
  const gemma = [...googleModels, ...models].find((m) => m.id === 'gemma-3-27b')
  assert.ok(gemma)
  assert.equal('remainingFraction' in gemma, false)
  assert.equal(gemma.name, 'Gemma 3', 'display names are trimmed')
})

test('ordering is stable: reversing the upstream array yields an identical catalog', () => {
  const models = [
    { modelId: 'gemini-4-hydrogen-medium', remainingFraction: 0.5 },
    { modelId: 'gemini-3-flash', remainingFraction: 0.5 },
    { modelId: 'gemma-3-27b', remainingFraction: 0.5 },
  ]
  const forward = describeAccountModels(makeAccount({ quotas: { google: { models, updatedAt: 1 } } }))
  const backward = describeAccountModels(
    makeAccount({ quotas: { google: { models: [...models].reverse(), updatedAt: 1 } } }),
  )

  assert.deepEqual(backward, forward)
  // And it is sorted ascending, not just equal to itself, with families in contract order.
  assert.deepEqual(modelsOf(forward, 'google'), ['gemini-3-flash', 'gemini-4-hydrogen-medium', 'gemma-3-27b'])
  assert.deepEqual(familiesOf(forward), [...MODEL_FAMILY_ORDER])
})

test('refreshedAt is null when no family carries an updatedAt, and ignores non-family quota keys', () => {
  const withStray = makeAccount({
    quotas: {
      google: { models: [{ modelId: 'gemini-3-flash' }], updatedAt: 1_000 },
      // A key that is not a model family has no place in the response, so its timestamp is
      // not a family refresh time either.
      someLegacyKey: { models: [{ modelId: 'claude-sonnet-4-5-20250929' }], updatedAt: 99_000 },
    } as ManagedAccount['quotas'],
  })
  const catalog = describeAccountModels(withStray)

  assert.equal(catalog.refreshedAt, 1_000)
  assert.deepEqual(modelsOf(catalog, 'anthropic'), ['claude-sonnet-4-5-20250929'])
  assert.equal(catalog.total, 2)

  const noTimestamps = describeAccountModels(
    makeAccount({ quotas: { google: { models: [{ modelId: 'gemini-3-flash' }] } } }),
  )
  assert.equal(noTimestamps.refreshedAt, null)
  assert.equal(noTimestamps.known, true)
})

test('the account is read-only: no mutation, and no returned object aliases the account', () => {
  const account = makeAccount({
    email: 'someone@example.com',
    quotas: {
      google: {
        remainingFraction: 0.5,
        updatedAt: 42,
        models: [{ modelId: 'gemini-3-flash', displayName: 'Gemini 3 Flash', remainingFraction: 0.5 }],
      },
    },
  })
  const before = structuredClone(account)
  const catalog = describeAccountModels(account)

  assert.deepEqual(account, before, 'describeAccountModels must not write to its input')

  const family = catalog.familyModels.find((f) => f.family === 'google')
  const source = account.quotas.google
  assert.ok(family && source)
  assert.notStrictEqual(family.models, source.models, 'the models array must be a fresh copy')
  assert.notStrictEqual(family.models[0], source.models?.[0], 'entries must be freshly built objects')
  assert.notStrictEqual(family.quota, source, 'the quota summary must be a fresh copy')
  assert.deepEqual(family.quota, { remainingFraction: 0.5, updatedAt: 42 })
  // description is an internal tooltip field and is not part of the public contract.
  assert.equal('description' in (family.quota ?? {}), false)
})
