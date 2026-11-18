/**
 * Exposure tests for gemini-4-hydrogen-sonar as an independent, optional model.
 *
 * Evidence (captured FetchAvailableModels response, test/fixtures/fetch-available-models.json):
 * the entry carries its own quotaInfo (remainingFraction ~1 plus a resetTime), maxOutputTokens
 * 65536, thinkingLevel 1, supportsThinking true, recommended true, its own wire enum
 * MODEL_PLACEHOLDER_M578 - and no displayName, no `disabled`, no `beta`, no `isInternal`. It is
 * absent from agentModelSorts, from tieredModelIds and from defaultAgentModelId, which is only why
 * agy's own picker never shows it: live generateContent calls against it answer HTTP 200 with SSE
 * text and modelVersion "gemini-4-hydrogen-sonar" (measured on three accounts, free tier included).
 *
 * So the model must be exposed, must stay its own base (a sonar-only account must not be judged
 * entitled to gemini-4-hydrogen-*), and must be sent under its own wire id at every effort level.
 *
 * Tests 7-8 generalise the last point: they scan the whole fixture catalog and forbid any entry from
 * being requested under a wire id nothing sanctions. sonar was the first model that needed such a row;
 * the legacy slugs (gemini-3-flash, gemini-3.5-flash-lite, gemini-3.1-flash-image,
 * gemini-3.1-flash-lite) are the second, and the gate is what keeps a third from slipping in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANTIGRAVITY_MODEL_ENUM, ANTIGRAVITY_ROUTING, buildFallbackCatalog, foldEfforts, getMaxOutputTokens, getAntigravityRequestModelId, lookupModelEnum, parseModelsOutput } from '../src/models.ts'
import { DEFAULT_FALLBACK_MODELS } from '../src/types/config-types.ts'
import type { CatalogEntry } from '../src/models.ts'
import { AccountPoolManager, isServableModelId, modelBaseOf, modelEntitlementOf } from '../src/pool.ts'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SONAR = 'gemini-4-hydrogen-sonar'

function fixtureCatalog() {
  return foldEfforts(parseModelsOutput(readFileSync(join(__dirname, 'fixtures', 'fetch-available-models.json'), 'utf8')))
}

test('1. sonar is servable, the server-refused -disabled id is not', () => {
  assert.equal(isServableModelId(SONAR), true, 'sonar generates live: it is not an unservable marker')
  assert.equal(isServableModelId('gemini-4-hydrogen-disabled'), false, '-disabled stays a refusal marker')
  assert.equal(isServableModelId('gemini-4-hydrogen-high'), true)
})

test('2. sonar keeps its own base: it is not a rung of the hydrogen effort ladder', () => {
  assert.equal(modelBaseOf(SONAR), SONAR)
  assert.notEqual(modelBaseOf(SONAR), 'gemini-4-hydrogen')
  // The ladder model still folds to the family base, which is what the two ids must not be merged into.
  assert.equal(modelBaseOf('gemini-4-hydrogen-high'), 'gemini-4-hydrogen')
})

test('3. entitlement: a sonar-only account is entitled to sonar and NOT to gemini-4-hydrogen-medium', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-sonar-entitlement-'))
  const pool = new AccountPoolManager(dir)
  const account = pool.createAccountSlot('Sonar only')
  // Every account in this pool lists sonar and nothing else, the way the measured accounts do.
  const sonarOnly = { remainingFraction: 0.99, models: [{ modelId: SONAR }] }
  pool.updateAccountQuotas(account.id, { google: sonarOnly })
  for (const other of pool.getAccounts()) {
    if (other.id !== account.id) pool.updateAccountQuotas(other.id, { google: sonarOnly })
  }
  const live = pool.getAccount(account.id)!

  assert.equal(modelEntitlementOf(live, 'google', SONAR).supported, true)
  // Folding sonar into the family would report true here and every hydrogen request would answer 403,
  // escalating that account into a 5 -> 30 min quarantine.
  assert.equal(modelEntitlementOf(live, 'google', 'gemini-4-hydrogen-medium').supported, false)
  assert.equal(modelEntitlementOf(live, 'google', 'gemini-4-hydrogen-high').supported, false)
  assert.equal(pool.selectAccount('google', 'gemini-4-hydrogen-high'), null)
  assert.equal(pool.selectAccount('google', 'gemini-4-hydrogen-medium'), null)
  const chosen = pool.selectAccount('google', SONAR)
  assert.ok(chosen, 'a sonar-only pool must still serve sonar')
  assert.equal(modelEntitlementOf(chosen!, 'google', SONAR).supported, true)
})

test('4. discovery: the real capture exposes sonar as one nameable entry with no effort ladder', () => {
  const catalog = fixtureCatalog()
  const sonar = catalog.find((entry) => entry.id === SONAR)
  assert.ok(sonar, 'gemini-4-hydrogen-sonar must appear in the models catalog')
  // No displayName on the server side; the name follows the sibling shape the capture itself uses
  // for the same family ("Gemini 4 Hydrogen (High)" / "(XHigh)").
  assert.equal(sonar.name, 'Gemini 4 Hydrogen (Sonar)')
  assert.equal(sonar.efforts, null, 'sonar has no effort ladder to offer')

  const ids = catalog.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'catalog ids must stay unique')
  assert.ok(!ids.some((id) => id.includes('-disabled') || id.includes('-tiered')),
    '-disabled and -tiered ids must not reach the catalog')
})

test('5. routing: every effort level sends the bare wire id, never an invented variant', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'off', undefined]) {
    assert.equal(
      getAntigravityRequestModelId(SONAR, effort),
      SONAR,
      `sonar + ${String(effort)} must keep its own wire id`,
    )
  }
  // The wire id maps to the enum the capture reports for this model.
  assert.equal(lookupModelEnum(SONAR), 'MODEL_PLACEHOLDER_M578')
  // The family ladder is untouched by the sonar row.
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen', 'high'), 'gemini-4-hydrogen-high')
})

test('6. token ceiling comes from the gemini default, matching the capture (65536)', () => {
  assert.equal(getMaxOutputTokens(SONAR, SONAR), 65536)
})

// ---------------------------------------------------------------------------
// 7-8. the generic gate behind F-06, written so it cannot be satisfied by one model's row.
//
// A catalog entry may only be requested under a wire id that something real sanctions: the entry's
// own slug, an effort rung the entry itself advertises, or a target the routing table declares.
// Anything else is an id agy has never advertised; it reaches upstream as a request string with no
// enum row of its own, answers 400/403, and quarantines the account for 5-30 min.
// Checking the enum alone is NOT enough: lookupModelEnum() peels an effort suffix onto the family
// row (lookupModelEnum('gemini-3-flash-low') === MODEL_PLACEHOLDER_M18), so an invented variant
// still reports the family enum. The id shape has to be checked directly, which is what test 7 does;
// test 8 then pins the pairing with the exact-match alias, which peels nothing.
// ---------------------------------------------------------------------------

const EFFORT_PROBE: readonly (string | undefined)[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'off', undefined]

function sanctionedWireIds(entry: CatalogEntry, effort: string | undefined): Set<string> {
  const sanctioned = new Set<string>([entry.id])
  const row = ANTIGRAVITY_ROUTING[entry.id]
  for (const target of [...Object.values(row?.routing ?? {}), row?.off, row?.defaultRequestId]) {
    if (target !== undefined) sanctioned.add(target)
  }
  // A rung the server itself advertised sanctions exactly one spelling for that effort.
  if (entry.efforts !== null && effort !== undefined && effort !== 'off') sanctioned.add(`${entry.id}-${effort}`)
  return sanctioned
}

test('7. wire-id integrity: every catalog entry x every probed effort emits a sanctioned wire id', () => {
  // Both routes into the same routing code are scanned: the discovered catalog (server signal union)
  // and the built-in fallback catalog. A model can only be requested under an id something sanctions.
  const scanned = [
    { label: 'discovered', entries: fixtureCatalog() },
    { label: 'fallback', entries: buildFallbackCatalog(DEFAULT_FALLBACK_MODELS) },
  ]
  let ladderFree = 0
  let ladderBearing = 0

  for (const { label, entries } of scanned) {
    for (const entry of entries) {
      if (entry.efforts === null) ladderFree += 1
      else ladderBearing += 1

      for (const effort of EFFORT_PROBE) {
        const wire = getAntigravityRequestModelId(entry.id, effort)
        assert.ok(
          sanctionedWireIds(entry, effort).has(wire),
          `${label}/${entry.id} + ${String(effort)} sends "${wire}": neither the entry itself, nor an ` +
            'advertised effort rung, nor a target declared in ANTIGRAVITY_ROUTING',
        )
        if (entry.efforts === null) {
          assert.equal(
            wire,
            entry.id,
            `${label}/${entry.id} advertises no effort ladder, so ${String(effort)} must not invent a suffix`,
          )
        }
      }
    }
  }

  // Both arms of the rule must be exercised or the scan above is vacuous. The floors are what the
  // measured capture contributes (10 ladder-free ids: the legacy gemini-2.5/gemini-3 slugs, the
  // -low|-medium|-high Claude pairs and gpt-oss-120b-medium; 3 ladder families).
  assert.ok(ladderFree >= 8, `only ${ladderFree} ladder-free entries reached the catalogs`)
  assert.ok(ladderBearing >= 3, `only ${ladderBearing} ladder entries reached the catalogs`)
})

test('8. the request string keeps the enum pairing of the catalog entry at every effort level', () => {
  const scanned = [
    { label: 'discovered', entries: fixtureCatalog() },
    { label: 'fallback', entries: buildFallbackCatalog(DEFAULT_FALLBACK_MODELS) },
  ]
  let measured = 0

  for (const { label, entries } of scanned) {
    for (const entry of entries) {
      if (entry.efforts !== null) continue
      // ANTIGRAVITY_MODEL_ENUM is exact-match only: it answers for ids the capture really names and
      // answers nothing for a variant nobody published. An entry with no row is an unsourced pair the
      // client must send with no model_enum label, so both sides undefined is a legal pairing here.
      const entryEnum = ANTIGRAVITY_MODEL_ENUM[entry.id]
      for (const effort of EFFORT_PROBE) {
        const wire = getAntigravityRequestModelId(entry.id, effort)
        assert.equal(
          ANTIGRAVITY_MODEL_ENUM[wire],
          entryEnum,
          `${label}/${entry.id} + ${String(effort)} sends "${wire}", whose enum row differs from the ` +
            `entry's own (${String(entryEnum)})`,
        )
        if (entryEnum !== undefined) measured += 1
      }
    }
  }

  assert.ok(measured >= 8 * EFFORT_PROBE.length, `only ${measured} requests carried a measured enum pairing`)
})
