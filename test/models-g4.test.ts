import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isGemini4Model,
  isDailyEndpointModel,
  EFFORT_SUFFIXES,
  isInternalModel,
  getAntigravityRequestModelId,
} from '../src/models.ts'
import { getEndpointCandidatesForModel, DEFAULT_ENDPOINT, ENDPOINT_FALLBACKS } from '../src/client.ts'

test('1. isGemini4Model correctly detects all Gemini 4 family variants and rejects non-G4 models', () => {
  // Required true cases
  assert.equal(isGemini4Model('gemini-4-argon'), true)
  assert.equal(isGemini4Model('gemini-4-hydrogen'), true)
  assert.equal(isGemini4Model('gemini-4-hydrogen-high'), true)
  assert.equal(isGemini4Model('gemini-4-hydrogen-sonar'), true)
  assert.equal(isGemini4Model('gemini-4-neon'), true)
  assert.equal(isGemini4Model('gemini-4-carbon'), true)

  // Additional variants, casing, and whitespace robustness
  assert.equal(isGemini4Model('gemini-4-hydrogen-xhigh'), true)
  assert.equal(isGemini4Model('GEMINI-4-HYDROGEN'), true)
  assert.equal(isGemini4Model('  gemini-4-argon  '), true)
  assert.equal(isGemini4Model('Gemini-4-Neon'), true)
  assert.equal(isGemini4Model('gemini-4-carbon-preview'), true)

  // Required false cases
  assert.equal(isGemini4Model('gemini-2.5-flash'), false)
  assert.equal(isGemini4Model('gemini-3.7-flash'), false)
  assert.equal(isGemini4Model('claude-3-5-sonnet'), false)

  // Edge cases: empty string, whitespace, non-gemini models, legacy geminis
  assert.equal(isGemini4Model(''), false)
  assert.equal(isGemini4Model('   '), false)
  assert.equal(isGemini4Model('gpt-4o'), false)
  assert.equal(isGemini4Model('deepseek-r1'), false)
  assert.equal(isGemini4Model('gemini-1.5-pro'), false)
  assert.equal(isGemini4Model('gemini-1.5-flash'), false)
})

test('2. isDailyEndpointModel prioritizes daily endpoints for all Gemini 4 models and rejects others', () => {
  // All G4 models must be daily-first
  assert.equal(isDailyEndpointModel('gemini-4-hydrogen'), true)
  assert.equal(isDailyEndpointModel('gemini-4-hydrogen-sonar'), true)
  assert.equal(isDailyEndpointModel('gemini-4-argon'), true)
  assert.equal(isDailyEndpointModel('gemini-4-argon-low'), true)
  assert.equal(isDailyEndpointModel('gemini-4-neon'), true)
  assert.equal(isDailyEndpointModel('gemini-4-carbon'), true)
  assert.equal(isDailyEndpointModel('gemini-4-hydrogen-high'), true)
  assert.equal(isDailyEndpointModel('gemini-4-hydrogen-xhigh'), true)

  // Non-G4 models must return false
  assert.equal(isDailyEndpointModel('gemini-2.5-flash'), false)
  assert.equal(isDailyEndpointModel('gemini-3.7-flash'), false)
  assert.equal(isDailyEndpointModel('claude-3-5-sonnet'), false)
  assert.equal(isDailyEndpointModel('gpt-4o'), false)
  assert.equal(isDailyEndpointModel(''), false)
})

test('3. EFFORT_SUFFIXES contains xhigh and maintains correct ordering', () => {
  // Contains xhigh
  assert.ok(EFFORT_SUFFIXES.includes('xhigh' as any))

  // Exact sequential order: ['low', 'medium', 'high', 'xhigh']
  assert.deepEqual([...EFFORT_SUFFIXES], ['low', 'medium', 'high', 'xhigh'])
  assert.equal(EFFORT_SUFFIXES.length, 4)
  assert.equal(EFFORT_SUFFIXES[0], 'low')
  assert.equal(EFFORT_SUFFIXES[1], 'medium')
  assert.equal(EFFORT_SUFFIXES[2], 'high')
  assert.equal(EFFORT_SUFFIXES[3], 'xhigh')
})

test('4. isInternalModel correctly filters -disabled and internal models without filtering servable G4 models', () => {
  // Models ending in -disabled or containing -disabled- must be filtered
  assert.equal(isInternalModel('gemini-4-carbon-disabled'), true)
  assert.equal(isInternalModel('gemini-4-argon-disabled'), true)
  assert.equal(isInternalModel('gemini-4-hydrogen-disabled'), true)
  assert.equal(isInternalModel('gemini-4-disabled-preview'), true)
  assert.equal(isInternalModel('gemini-4-argon-disabled-v2'), true)
  assert.equal(isInternalModel('model-disabled'), true)

  // Internal chat / tab / preview / tiered models must be filtered
  assert.equal(isInternalModel('chat_20240101'), true)
  assert.equal(isInternalModel('chat_999'), true)
  assert.equal(isInternalModel('tab_suggest'), true)
  assert.equal(isInternalModel('tab-completion'), true)
  assert.equal(isInternalModel('gemini_preview'), true)
  assert.equal(isInternalModel('gemini-preview'), true)
  assert.equal(isInternalModel('gemini-4-hydrogen-tiered-high'), true)

  // Normal servable G4 models must NOT be filtered
  assert.equal(isInternalModel('gemini-4-hydrogen'), false)
  assert.equal(isInternalModel('gemini-4-hydrogen-sonar'), false)
  assert.equal(isInternalModel('gemini-4-argon'), false)
  assert.equal(isInternalModel('gemini-4-neon'), false)
  assert.equal(isInternalModel('gemini-4-carbon'), false)
  assert.equal(isInternalModel('gemini-2.5-flash'), false)
})

test('5. getAntigravityRequestModelId correctly generates effort variants, defaults, and prevents degrading', () => {
  // When effort is 'xhigh', correctly generate ${base}-xhigh, strictly NOT downgraded to high
  const xhighResult = getAntigravityRequestModelId('gemini-4-hydrogen', 'xhigh')
  assert.equal(xhighResult, 'gemini-4-hydrogen-xhigh')
  assert.notEqual(xhighResult, 'gemini-4-hydrogen-high')

  // Case-insensitivity for xhigh
  const xhighUpper = getAntigravityRequestModelId('gemini-4-hydrogen', 'XHIGH')
  assert.equal(xhighUpper, 'gemini-4-hydrogen-xhigh')

  // When effort is 'high', returns gemini-4-hydrogen-high
  const highResult = getAntigravityRequestModelId('gemini-4-hydrogen', 'high')
  assert.equal(highResult, 'gemini-4-hydrogen-high')
  const highUpper = getAntigravityRequestModelId('gemini-4-hydrogen', 'HIGH')
  assert.equal(highUpper, 'gemini-4-hydrogen-high')

  // Medium and low effort
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen', 'medium'), 'gemini-4-hydrogen-medium')
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen', 'low'), 'gemini-4-hydrogen-low')

  // When unrouted G4 models have no effort, they default to ${base}-low
  assert.equal(getAntigravityRequestModelId('gemini-4-neon'), 'gemini-4-neon-low')
  assert.equal(getAntigravityRequestModelId('gemini-4-carbon'), 'gemini-4-carbon-low')
  assert.equal(getAntigravityRequestModelId('gemini-4-neon', ''), 'gemini-4-neon-low')
  assert.equal(getAntigravityRequestModelId('gemini-4-neon', 'xhigh'), 'gemini-4-neon-xhigh')
  assert.equal(getAntigravityRequestModelId('gemini-4-neon', 'high'), 'gemini-4-neon-high')

  // For gemini-4-hydrogen (which has explicit defaultRequestId), no effort maps to its configured default
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen'), 'gemini-4-hydrogen-medium')
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen', 'off'), 'gemini-4-hydrogen-medium')

  // Pre-attached wire models must preserve verbatim
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen-xhigh'), 'gemini-4-hydrogen-xhigh')
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen-high'), 'gemini-4-hydrogen-high')
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen-low'), 'gemini-4-hydrogen-low')

  // Special models like sonar stay untouched across all effort settings
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen-sonar'), 'gemini-4-hydrogen-sonar')
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen-sonar', 'high'), 'gemini-4-hydrogen-sonar')
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen-sonar', 'xhigh'), 'gemini-4-hydrogen-sonar')
  assert.equal(getAntigravityRequestModelId('gemini-4-hydrogen-sonar', 'low'), 'gemini-4-hydrogen-sonar')

  // Unknown non-gemini model returns verbatim
  assert.equal(getAntigravityRequestModelId('claude-3-5-sonnet'), 'claude-3-5-sonnet')
})

test('6. getEndpointCandidatesForModel routes Gemini 4 models to daily endpoints first', () => {
  // G4 models prioritize daily endpoints at indices 0 and 1
  const g4Hydrogen = getEndpointCandidatesForModel('gemini-4-hydrogen')
  assert.equal(g4Hydrogen[0], 'https://daily-cloudcode-pa.googleapis.com')
  assert.equal(g4Hydrogen[1], 'https://daily-cloudcode-pa.sandbox.googleapis.com')
  assert.equal(g4Hydrogen[2], DEFAULT_ENDPOINT)

  const g4Argon = getEndpointCandidatesForModel('gemini-4-argon')
  assert.equal(g4Argon[0], 'https://daily-cloudcode-pa.googleapis.com')
  assert.equal(g4Argon[1], 'https://daily-cloudcode-pa.sandbox.googleapis.com')

  const g4Sonar = getEndpointCandidatesForModel('gemini-4-hydrogen-sonar')
  assert.equal(g4Sonar[0], 'https://daily-cloudcode-pa.googleapis.com')
  assert.equal(g4Sonar[1], 'https://daily-cloudcode-pa.sandbox.googleapis.com')

  // Non-G4 models return standard ENDPOINT_FALLBACKS
  const nonG4Endpoints = getEndpointCandidatesForModel('gemini-2.5-flash')
  assert.deepEqual(nonG4Endpoints, [...ENDPOINT_FALLBACKS])

  const claudeEndpoints = getEndpointCandidatesForModel('claude-3-5-sonnet')
  assert.deepEqual(claudeEndpoints, [...ENDPOINT_FALLBACKS])

  // Custom base URL overrides everything including G4 daily routing
  const custom = getEndpointCandidatesForModel('gemini-4-hydrogen', 'https://custom-proxy.internal')
  assert.deepEqual(custom, ['https://custom-proxy.internal'])

  // Custom base URL with trailing slashes gets normalized
  const customTrailing = getEndpointCandidatesForModel('gemini-4-hydrogen', 'https://custom-proxy.internal///')
  assert.deepEqual(customTrailing, ['https://custom-proxy.internal'])

  // Environment variable ANTIGRAVITY_BASE_URL override
  const prevEnv = process.env.ANTIGRAVITY_BASE_URL
  try {
    process.env.ANTIGRAVITY_BASE_URL = 'https://env-proxy.internal'
    const fromEnv = getEndpointCandidatesForModel('gemini-4-hydrogen')
    assert.deepEqual(fromEnv, ['https://env-proxy.internal'])
  } finally {
    if (prevEnv === undefined) {
      delete process.env.ANTIGRAVITY_BASE_URL
    } else {
      process.env.ANTIGRAVITY_BASE_URL = prevEnv
    }
  }
})
