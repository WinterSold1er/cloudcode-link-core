/**
 * Alignment tests for packages/core/src/models.ts against the real Antigravity CLI
 * (agy 1.3.5).
 *
 * Evidence sources used by these tests — the only two places an expected value may come from:
 *  - test/fixtures/fetch-available-models.json — captured FetchAvailableModelsResponse
 *    (map key = wire model id, ModelDetails.model / field 15 = the exa.codeium_common_pb.Model
 *    value the server issues for that exact variant).
 *  - ops/relink/t2-model-enum-evidence.md — the pairs this repo measured in agy's own
 *    conversations DBs, read back out of that file at test time (see evidencePairsFromFile).
 *  - ops/relink/t2-traffic-findings.md:57/65/121 — captured agy agent request:
 *    body model = gemini-4-hydrogen-medium, labels.model_enum = MODEL_PLACEHOLDER_M526.
 * No expected value is copied out of src/models.ts. Restating the table in a test only proves
 * the implementation equals itself; every pair below is sourced from a capture or from the
 * evidence document that records where it was measured.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { antigravityRequestEnvelope } from '../src/client.ts'
import {
  AGY_MODEL_ENUM_BY_WIRE_ID,
  ANTIGRAVITY_MODEL_ENUM,
  ANTIGRAVITY_ROUTING,
  deriveEffortsForModel,
  foldEfforts,
  getAntigravityRequestModelId,
  isInternalModel,
  lookupModelEnum,
  parseModelsOutput,
} from '../src/models.ts'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

interface FixtureModelDetails {
  model?: string
  displayName?: string
  disabled?: boolean
}

function fixtureModels(): Record<string, FixtureModelDetails> {
  const raw = readFileSync(join(__dirname, 'fixtures', 'fetch-available-models.json'), 'utf-8')
  const parsed = JSON.parse(raw) as { models?: Record<string, FixtureModelDetails> }
  const models = parsed.models
  if (!models || typeof models !== 'object') {
    throw new Error('fixture fetch-available-models.json has no models map')
  }
  return models
}

/**
 * The pairs this repo confirmed outside the response capture, read out of the evidence document
 * that records where they were measured. That document lives in the parent checkout
 * (ops/relink/…); a standalone clone of the core package must ship it beside the sources for
 * these expectations to be sourceable at all.
 */
const EVIDENCE_DOC_CANDIDATES = [
  join(__dirname, '..', '..', '..', 'ops', 'relink', 't2-model-enum-evidence.md'),
  join(__dirname, '..', '..', 'ops', 'relink', 't2-model-enum-evidence.md'),
]

function evidencePairsFromFile(): Record<string, string> {
  const docPath = EVIDENCE_DOC_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!docPath) {
    throw new Error(
      `no enum evidence document reachable (${EVIDENCE_DOC_CANDIDATES.join(' , ')}): the rows the ` +
        'fixture does not carry would have no expectation sourced outside src/models.ts',
    )
  }
  const doc = readFileSync(docPath, 'utf-8')
  if (!doc.includes('| row in `packages/core/src/models.ts` | status |')) {
    throw new Error(`${docPath} no longer carries the evidence table these expectations come from`)
  }
  const pairs: Record<string, string> = {}
  for (const match of doc.matchAll(/^\|\s*`([a-z0-9._-]+)`\s*->\s*`(MODEL_[A-Z0-9_]+)`/gm)) {
    const wireId = match[1]
    const enumName = match[2]
    if (!wireId || !enumName) continue
    pairs[wireId] = enumName
  }
  if (Object.keys(pairs).length < 3) {
    throw new Error(
      `${docPath} records ${Object.keys(pairs).length} wire-id -> enum pairs; the three family/trial ` +
        'rows the fixture does not cover need their own recorded evidence',
    )
  }
  return pairs
}

const EVIDENCE_DOC_PAIRS = evidencePairsFromFile()

/** Expectation for one wire id, taken from the evidence document — never from the implementation. */
function evidencePair(wireId: string): string {
  const enumName = EVIDENCE_DOC_PAIRS[wireId]
  if (enumName === undefined) {
    throw new Error(`the evidence document records no enum for ${wireId}`)
  }
  return enumName
}

// Family rows: agy's own conversations db pairs, also the fallback for unlisted variants.
const HYDROGEN_FAMILY_ENUM = evidencePair('gemini-4-hydrogen')
const ARGON_FAMILY_ENUM = evidencePair('gemini-4-argon')

test('1. lookupModelEnum returns the per-variant enum the captured response issues (gemini-4)', () => {
  // Variant-exact: ModelDetails.model of the real FetchAvailableModelsResponse. The -medium
  // rows are also the pair seen in live agy traffic (M526 / M418), so exact wins everywhere.
  assert.equal(lookupModelEnum('gemini-4-hydrogen-high'), 'MODEL_PLACEHOLDER_M525')
  assert.equal(lookupModelEnum('gemini-4-hydrogen-medium'), HYDROGEN_FAMILY_ENUM)
  assert.equal(lookupModelEnum('gemini-4-hydrogen-low'), 'MODEL_PLACEHOLDER_M527')
  assert.equal(lookupModelEnum('gemini-4-hydrogen-xhigh'), 'MODEL_PLACEHOLDER_M528')
  assert.equal(lookupModelEnum('gemini-4-hydrogen'), HYDROGEN_FAMILY_ENUM)

  assert.equal(lookupModelEnum('gemini-4-argon-high'), 'MODEL_PLACEHOLDER_M417')
  assert.equal(lookupModelEnum('gemini-4-argon-medium'), ARGON_FAMILY_ENUM)
  assert.equal(lookupModelEnum('gemini-4-argon-low'), 'MODEL_PLACEHOLDER_M419')
  assert.equal(lookupModelEnum('gemini-4-argon'), ARGON_FAMILY_ENUM)

  // Internal variants keep their own measured enum even though they are not selectable.
  assert.equal(lookupModelEnum('gemini-4-hydrogen-tiered-high'), 'MODEL_PLACEHOLDER_M530')
  assert.equal(lookupModelEnum('gemini-4-hydrogen-tiered-xhigh'), 'MODEL_PLACEHOLDER_M531')
  assert.equal(lookupModelEnum('gemini-4-hydrogen-sonar'), 'MODEL_PLACEHOLDER_M578')
  assert.equal(lookupModelEnum('gemini-4-carbon-disabled'), 'MODEL_PLACEHOLDER_M670')
})

test('2. a variant the capture does not list falls back to its family row', () => {
  const models = fixtureModels()
  assert.equal(lookupModelEnum('gemini-4-hydrogen-tiered-low'), HYDROGEN_FAMILY_ENUM)
  assert.equal(lookupModelEnum('gemini-4-hydrogen-tiered-medium'), HYDROGEN_FAMILY_ENUM)
  assert.equal(lookupModelEnum('gemini-4-hydrogen-minimal'), HYDROGEN_FAMILY_ENUM)
  assert.equal(lookupModelEnum('gemini-4-argon-xhigh'), ARGON_FAMILY_ENUM)
  assert.equal(lookupModelEnum('gemini-4-argon-minimal'), ARGON_FAMILY_ENUM)
  assert.equal(lookupModelEnum('gemini-4-argon-trial'), evidencePair('gemini-4-argon-trial'))

  // Exact rows win before suffix peeling, shown with ids the capture measured as such: -high has
  // its own enum and must not be folded onto the family row taken from -medium.
  assert.equal(lookupModelEnum('gemini-4-hydrogen-high'), models['gemini-4-hydrogen-high']?.model)
  assert.notEqual(
    lookupModelEnum('gemini-4-hydrogen-high'),
    HYDROGEN_FAMILY_ENUM,
    'a measured variant was overwritten by its family row',
  )
  assert.equal(lookupModelEnum('gemini-4-argon-low'), models['gemini-4-argon-low']?.model)
  assert.notEqual(
    lookupModelEnum('gemini-4-argon-low'),
    ARGON_FAMILY_ENUM,
    'a measured variant was overwritten by its family row',
  )

  // Case / whitespace tolerant; a dangling separator invents nothing.
  assert.equal(lookupModelEnum('  Gemini-4-Hydrogen-XHIGH '), models['gemini-4-hydrogen-xhigh']?.model)
  assert.equal(lookupModelEnum('gemini-4-hydrogen-'), undefined)
})

test('3. lookupModelEnum returns undefined instead of guessing an enum value', () => {
  // No measured pair, and no family row to fall back to: never back-computed from 1000 + n.
  assert.equal(lookupModelEnum('gemini-4-carbon-high'), undefined)
  assert.equal(lookupModelEnum('gemini-4-carbon'), undefined)
  assert.equal(lookupModelEnum('claude-opus-4-8'), undefined)
  assert.equal(lookupModelEnum('claude-haiku-4-5'), undefined)
  // gemini-3.5-flash is only known through its own measured rows, so a sibling effort of the
  // gemini-3.5-flash now has no row at all (its two former rows had no recorded pairing, see
  // test 3b), so no effort of that family may be folded onto some other model's enum.
  assert.equal(lookupModelEnum('gemini-3.5-flash-medium'), undefined)
  assert.equal(lookupModelEnum('gemini-3.5-flash'), undefined)
  assert.equal(lookupModelEnum('gemini-9-ultra-max'), undefined)
  assert.equal(lookupModelEnum(''), undefined)
  assert.equal(lookupModelEnum('   '), undefined)
})

// Reviewer2 finding B3. These five pairs sat in the table as "confirmed" with nothing in this
// repo backing the pairing: no entry in the captured fixture, no entry in the evidence document,
// and /usr/bin/agy contains the wire ids (1-3 occurrences) and placeholder names such as
// MODEL_PLACEHOLDER_M187 (3 occurrences) without ever pairing one name to one wire id. They are
// deleted; an id with no measured enum resolves to undefined.
const UNSOURCED_PAIRS: readonly string[] = [
  'gemini-3.5-flash-extra-low',
  'gemini-3.5-flash-low',
  'gemini-3-flash-agent',
  'gemini-3.1-pro-low',
  'gemini-pro-agent',
]

test('3b. the five pairs with no recorded evidence are gone and never reach the wire', () => {
  const models = fixtureModels()
  for (const wireId of UNSOURCED_PAIRS) {
    assert.equal(models[wireId]?.model, undefined, `${wireId} is in the capture after all - re-measure it`)
    assert.equal(
      EVIDENCE_DOC_PAIRS[wireId],
      undefined,
      `${wireId} is recorded in the evidence document after all - re-measure it`,
    )
    assert.equal(AGY_MODEL_ENUM_BY_WIRE_ID[wireId], undefined, `${wireId} must carry no enum row`)
    assert.equal(ANTIGRAVITY_MODEL_ENUM[wireId], undefined, `${wireId} must not survive in the alias`)
    assert.equal(lookupModelEnum(wireId), undefined, `${wireId} has no measured enum; guessing is forbidden`)
    // The wire ids stay real - ANTIGRAVITY_ROUTING issues them - so the request must simply
    // leave model_enum out, exactly as the captured label spec words it ("when known").
    const envelope = antigravityRequestEnvelope(wireId, false, { trajectoryId: 'trace-unsourced-enum' })
    assert.equal('model_enum' in envelope.labels, false, `${wireId} put an unmeasured model_enum on the wire`)
  }
  // The routing table still issues these ids, so the deletion is about the enum, not about the
  // models: a routing target that lost its row must still be a target the client can request.
  const routingTargets = new Set<string>()
  for (const row of Object.values(ANTIGRAVITY_ROUTING)) {
    for (const target of [...Object.values(row.routing ?? {}), row.off, row.defaultRequestId]) {
      if (target !== undefined) routingTargets.add(target)
    }
  }
  for (const wireId of UNSOURCED_PAIRS) {
    assert.ok(routingTargets.has(wireId), `${wireId} is still a routing target this client issues`)
  }
})

test('4. the table is exactly the captured pairs plus the pairs the evidence document records', () => {
  const models = fixtureModels()

  // (a) Every row is grounded and matches what the server said about that very wire id.
  for (const [wireId, enumName] of Object.entries(AGY_MODEL_ENUM_BY_WIRE_ID)) {
    assert.match(enumName, /^MODEL_[A-Z0-9_]+$/, `${wireId} has a malformed enum name`)
    if (enumName.startsWith('MODEL_PLACEHOLDER_')) {
      assert.match(enumName, /^MODEL_PLACEHOLDER_M\d+$/, `${wireId} has a malformed placeholder enum`)
    }

    const reported = models[wireId]?.model
    if (reported !== undefined) {
      assert.equal(enumName, reported, `table disagrees with the captured fixture for ${wireId}`)
      continue
    }
    const documented = EVIDENCE_DOC_PAIRS[wireId]
    if (documented !== undefined) {
      assert.equal(enumName, documented, `${wireId} changed a pair the evidence document records`)
      continue
    }
    // Remaining rows are family rows: they must equal the enum captured for a variant of them.
    const variantOfFamily = Object.entries(models).find(
      ([id, details]) => id.startsWith(`${wireId}-`) && details.model === enumName,
    )
    assert.ok(
      variantOfFamily,
      `${wireId} -> ${enumName} is backed by neither the fixture, a fixture variant of the family, ` +
        'nor a pair recorded in ops/relink/t2-model-enum-evidence.md',
    )
  }

  // (b) Completeness: the capture issues an enum for every entry it serves, so the table must
  // carry that exact pair. A missing row is a silent model_enum miss at request time.
  const served = Object.entries(models)
  assert.ok(served.length >= 34, `fixture only serves ${served.length} entries`)
  for (const [wireId, details] of served) {
    assert.equal(
      AGY_MODEL_ENUM_BY_WIRE_ID[wireId],
      details.model,
      `fixture issues ${details.model} for ${wireId}; the table has no matching row`,
    )
    assert.equal(lookupModelEnum(wireId), details.model, `lookupModelEnum misses ${wireId}`)
  }

  // (c) The fixture never contradicts a pair measured in agy's db / captured traffic.
  for (const [wireId, enumName] of Object.entries(EVIDENCE_DOC_PAIRS)) {
    if (models[wireId]?.model !== undefined) {
      assert.equal(models[wireId]?.model, enumName, `fixture contradicts ${wireId}`)
    }
  }
})

test('5. family rows equal the captured -medium enum, which is the live traffic pair', () => {
  const models = fixtureModels()
  assert.equal(models['gemini-4-hydrogen-medium']?.model, HYDROGEN_FAMILY_ENUM)
  assert.equal(models['gemini-4-argon-medium']?.model, ARGON_FAMILY_ENUM)

  // The other variants carry their own enum, so a family fallback can only be used for a
  // variant the capture does not list — never to overwrite a measured one.
  for (const [variant, expected] of [
    ['gemini-4-hydrogen-high', 'MODEL_PLACEHOLDER_M525'],
    ['gemini-4-hydrogen-low', 'MODEL_PLACEHOLDER_M527'],
    ['gemini-4-hydrogen-xhigh', 'MODEL_PLACEHOLDER_M528'],
    ['gemini-4-argon-high', 'MODEL_PLACEHOLDER_M417'],
    ['gemini-4-argon-low', 'MODEL_PLACEHOLDER_M419'],
  ] as const) {
    assert.equal(models[variant]?.model, expected, `fixture value for ${variant}`)
    assert.equal(lookupModelEnum(variant), expected)
    assert.notEqual(lookupModelEnum(variant), models['gemini-4-hydrogen-medium']?.model)
  }

  // And the fallback itself resolves to the family row.
  assert.equal(lookupModelEnum('gemini-4-hydrogen-tiered-low'), HYDROGEN_FAMILY_ENUM)
})

test('6. ANTIGRAVITY_ROUTING covers the confirmed gemini-4 families and efforts', () => {
  const hydrogen = ANTIGRAVITY_ROUTING['gemini-4-hydrogen']
  assert.ok(hydrogen, 'gemini-4-hydrogen routing row is required')
  assert.equal(hydrogen.routing?.low, 'gemini-4-hydrogen-low')
  assert.equal(hydrogen.routing?.medium, 'gemini-4-hydrogen-medium')
  assert.equal(hydrogen.routing?.high, 'gemini-4-hydrogen-high')
  assert.equal(hydrogen.routing?.xhigh, 'gemini-4-hydrogen-xhigh')
  assert.equal(hydrogen.off, 'gemini-4-hydrogen-medium')
  assert.equal(hydrogen.defaultRequestId, 'gemini-4-hydrogen-medium')

  const argon = ANTIGRAVITY_ROUTING['gemini-4-argon']
  assert.ok(argon, 'gemini-4-argon routing row is required')
  assert.equal(argon.routing?.low, 'gemini-4-argon-low')
  assert.equal(argon.routing?.medium, 'gemini-4-argon-medium')
  assert.equal(argon.routing?.high, 'gemini-4-argon-high')

  // Confirmed Claude families are present and never carry an effort suffix.
  for (const family of ['claude-haiku-4-5', 'claude-opus-4-8']) {
    const row = ANTIGRAVITY_ROUTING[family]
    assert.ok(row, `${family} routing row is required`)
    const targets = new Set(Object.values(row.routing ?? {}))
    targets.add(row.off ?? row.defaultRequestId ?? '')
    for (const target of targets) {
      assert.ok(target.length > 0)
      if (family === 'claude-haiku-4-5') {
        assert.equal(target, 'claude-haiku-4-5', 'Claude must not gain an effort suffix')
      }
    }
  }
})

test('7. routing table and deriveEffortsForModel agree on the gemini-4 effort ladder', () => {
  for (const family of ['gemini-4-hydrogen', 'gemini-4-argon']) {
    const row = ANTIGRAVITY_ROUTING[family]
    assert.ok(row, `${family} routing row is required`)
    const efforts = deriveEffortsForModel(family)
    assert.ok(efforts, `${family} must expose selectable efforts`)

    for (const effort of efforts) {
      assert.equal(
        getAntigravityRequestModelId(family, effort),
        `${family}-${effort}`,
        `${family} + ${effort} must route to its own wire id`,
      )
      // Every routed effort must have its own measured enum, not the family fallback.
      const enumForEffort = lookupModelEnum(`${family}-${effort}`)
      assert.ok(enumForEffort, `${family}-${effort} has no enum row`)
      assert.equal(enumForEffort, AGY_MODEL_ENUM_BY_WIRE_ID[`${family}-${effort}`])
    }

    // hydrogen: the hardcoded low|medium|high|xhigh ladder; argon: low|medium|high.
    if (family === 'gemini-4-hydrogen') {
      assert.deepEqual(efforts, ['low', 'medium', 'high', 'xhigh'])
    } else {
      assert.deepEqual(efforts, ['low', 'medium', 'high'])
      assert.equal(getAntigravityRequestModelId(family, 'xhigh'), 'gemini-4-argon-high')
    }

    // No effort requested / effort off -> the family default, never a bare slug.
    assert.equal(getAntigravityRequestModelId(family), `${family}-medium`)
    assert.equal(getAntigravityRequestModelId(family, 'off'), `${family}-medium`)
    assert.equal(row.routing?.minimal, `${family}-low`)
  }
})

test('8. every gemini-4 routing target is a wire id agy really served in the fixture', () => {
  const served = new Set(Object.keys(fixtureModels()))
  for (const family of ['gemini-4-hydrogen', 'gemini-4-argon']) {
    const row = ANTIGRAVITY_ROUTING[family]
    assert.ok(row, `${family} routing row is required`)
    const targets = new Set([...Object.values(row.routing ?? {}), row.off, row.defaultRequestId])
    for (const target of targets) {
      if (target === undefined) continue
      assert.ok(served.has(target), `${family} routes to ${target}, which agy never advertised`)
    }
  }
})

test('9. catalog visibility: gemini-4 effort variants stay selectable, internal ones do not', () => {
  assert.equal(isInternalModel('gemini-4-hydrogen-high'), false)
  assert.equal(isInternalModel('gemini-4-hydrogen-medium'), false)
  assert.equal(isInternalModel('gemini-4-hydrogen'), false)
  assert.equal(isInternalModel('gemini-4-argon-high'), false)

  assert.equal(isInternalModel('gemini-4-hydrogen-sonar'), true)
  assert.equal(isInternalModel('gemini-4-hydrogen-tiered-high'), true)
  assert.equal(isInternalModel('gemini-4-hydrogen-tiered-xhigh'), true)
  assert.equal(isInternalModel('gemini-4-carbon-disabled'), true)
})

test('10. foldEfforts folds the real fixture into one gemini-4-hydrogen entry with 4 efforts', () => {
  const raw = parseModelsOutput(readFileSync(join(__dirname, 'fixtures', 'fetch-available-models.json'), 'utf-8'))
  const catalog = foldEfforts(raw)
  const ids = catalog.map((e) => e.id)

  assert.ok(!ids.includes('gemini-4-hydrogen-high'), 'variants must fold, not appear verbatim')
  assert.ok(!ids.some((id) => id.includes('tiered') || id.includes('sonar') || id.includes('disabled')),
    'internal variants must not reach the catalog')

  const hydrogen = catalog.find((e) => e.id === 'gemini-4-hydrogen')
  assert.ok(hydrogen, 'gemini-4-hydrogen base entry must exist')
  assert.deepEqual(hydrogen.efforts, ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(hydrogen.inputModalities, ['text', 'image'])

  const argon = catalog.find((e) => e.id === 'gemini-4-argon')
  assert.ok(argon, 'gemini-4-argon base entry must exist')
  assert.deepEqual(argon.efforts, ['low', 'medium', 'high'])

  // The catalog exposes the family id, and each of its efforts resolves to its own enum.
  assert.equal(lookupModelEnum(hydrogen.id), HYDROGEN_FAMILY_ENUM)
  assert.equal(lookupModelEnum(argon.id), ARGON_FAMILY_ENUM)
  for (const effort of hydrogen.efforts ?? []) {
    assert.equal(
      lookupModelEnum(`${hydrogen.id}-${effort}`),
      fixtureModels()[`${hydrogen.id}-${effort}`]?.model,
    )
  }
})

test('11. foldEfforts keeps a lone suffixed variant verbatim instead of inventing a base', () => {
  const catalog = foldEfforts([{ slug: 'gemini-9-nova-high', label: 'Gemini 9 Nova (High)' }])
  assert.deepEqual(catalog.map((e) => e.id), ['gemini-9-nova-high'])
  assert.equal(catalog[0]?.efforts, null)
  assert.equal(lookupModelEnum('gemini-9-nova-high'), undefined)
})

test('12. ANTIGRAVITY_MODEL_ENUM stays importable, derives from the table, and keeps no unrecorded pair', () => {
  const models = fixtureModels()
  // The alias is a copy of the source-of-truth table: it cannot hold a pair the table does not
  // have, and the resolver cannot disagree with it on a wire id that has its own row.
  for (const [wireId, enumName] of Object.entries(AGY_MODEL_ENUM_BY_WIRE_ID)) {
    assert.equal(ANTIGRAVITY_MODEL_ENUM[wireId], enumName, `${wireId} drifted from the table it derives from`)
    assert.equal(lookupModelEnum(wireId), enumName, `${wireId} resolved to something other than its own row`)
  }
  for (const wireId of Object.keys(ANTIGRAVITY_MODEL_ENUM)) {
    assert.ok(AGY_MODEL_ENUM_BY_WIRE_ID[wireId] !== undefined, `${wireId} lives only in the legacy alias`)
  }
  // The pairs reviewer2 could not source left the alias with the table (test 3b covers the table;
  // this proves the alias did not keep a copy of its own).
  for (const wireId of UNSOURCED_PAIRS) {
    assert.equal(ANTIGRAVITY_MODEL_ENUM[wireId], undefined, `${wireId} survived in the legacy alias`)
  }
  // What the alias must still answer is taken from the capture, not restated here. The alias is
  // exact-match only, which is why the resolver peels a suffixed id onto its family row instead.
  assert.equal(ANTIGRAVITY_MODEL_ENUM['gemini-4-hydrogen-high'], models['gemini-4-hydrogen-high']?.model)
  assert.equal(lookupModelEnum('gemini-4-hydrogen-tiered-low'), HYDROGEN_FAMILY_ENUM)
})

test('13. every routing target the capture serves resolves to its measured enum', () => {
  const models = fixtureModels()
  let checked = 0
  for (const row of Object.values(ANTIGRAVITY_ROUTING)) {
    const targets = [...Object.values(row.routing ?? {}), row.off, row.defaultRequestId]
    for (const target of targets) {
      if (target === undefined || models[target]?.model === undefined) continue
      checked += 1
      assert.equal(
        lookupModelEnum(target),
        models[target]?.model,
        `routing target ${target} has no row matching the captured enum`,
      )
    }
  }
  assert.ok(checked >= 10, `only ${checked} routing targets are covered by the capture`)

  // The gaps stay gaps: families with no measured pair must resolve to undefined, so nobody
  // mistakes a guess for evidence later.
  for (const unmeasured of [
    'claude-opus-4-6-thinking',
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-haiku-4-5',
    'gemini-3.7-flash-high',
    'gemini-3.6-flash-medium',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
    'gemini-4-carbon',
  ]) {
    assert.equal(lookupModelEnum(unmeasured), undefined, `${unmeasured} must not be guessed`)
  }
})

test('14. the everyday request paths are covered: gemini-3.8 ladder and Claude 5.5 rows', () => {
  const models = fixtureModels()

  // getAntigravityRequestModelId('gemini-3.8-flash', ...) emits these exact wire ids, and each
  // of them now carries the enum the capture measured for it.
  assert.equal(getAntigravityRequestModelId('gemini-3.8-flash', 'low'), 'gemini-3.8-flash-low')
  assert.equal(getAntigravityRequestModelId('gemini-3.8-flash', 'medium'), 'gemini-3.8-flash-medium')
  assert.equal(getAntigravityRequestModelId('gemini-3.8-flash', 'high'), 'gemini-3.8-flash-high')
  assert.equal(getAntigravityRequestModelId('gemini-3.8-flash', 'xhigh'), 'gemini-3.8-flash-high')
  assert.equal(getAntigravityRequestModelId('gemini-3.8-flash', 'off'), 'gemini-3.8-flash-low')
  for (const wireId of ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high']) {
    assert.equal(lookupModelEnum(wireId), models[wireId]?.model, `${wireId} enum`)
  }
  assert.equal(lookupModelEnum('gemini-3.8-flash-tiered'), 'MODEL_PLACEHOLDER_M322')
  assert.equal(lookupModelEnum('gpt-oss-120b-medium'), 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM')

  // Claude 5.5 as the capture names it; the 4.x Claude families agy requests have no enum yet.
  assert.equal(lookupModelEnum('claude-opus-5-5-high'), 'MODEL_PLACEHOLDER_M402')
  assert.equal(lookupModelEnum('claude-opus-5-5-medium'), 'MODEL_PLACEHOLDER_M401')
  assert.equal(lookupModelEnum('claude-opus-5-5-low'), 'MODEL_PLACEHOLDER_M400')
  assert.equal(lookupModelEnum('claude-sonnet-5-5-high'), 'MODEL_PLACEHOLDER_M405')
  assert.equal(lookupModelEnum('claude-sonnet-5-5-medium'), 'MODEL_PLACEHOLDER_M404')
  assert.equal(lookupModelEnum('claude-sonnet-5-5-low'), 'MODEL_PLACEHOLDER_M403')
  assert.equal(ANTIGRAVITY_MODEL_ENUM['claude-opus-5-5-high'], 'MODEL_PLACEHOLDER_M402')
})
