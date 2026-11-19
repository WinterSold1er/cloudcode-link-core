// Authentication and credential resolution for Google Gemini App (Robin / AGSA).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { GeminiAppConfig } from './types.ts'

export const GEMINI_APP_DIR = join(homedir(), '.dsh', 'gemini-app')
export const GEMINI_APP_TOKEN_FILE = join(GEMINI_APP_DIR, 'token')

/**
 * Resolves the OAuth2 bearer token for Gemini App in priority order:
 * 1. Explicitly supplied in config.token
 * 2. Environment variables: DSH_GEMINI_APP_TOKEN or GEMINI_APP_TOKEN
 * 3. Stored token file: ~/.dsh/gemini-app/token
 */
export async function resolveGeminiAppToken(config?: GeminiAppConfig): Promise<string | null> {
  if (config?.token && config.token.trim()) {
    return config.token.trim()
  }

  const envToken = process.env.DSH_GEMINI_APP_TOKEN?.trim() || process.env.GEMINI_APP_TOKEN?.trim()
  if (envToken) {
    return envToken
  }

  if (existsSync(GEMINI_APP_TOKEN_FILE)) {
    try {
      const content = readFileSync(GEMINI_APP_TOKEN_FILE, 'utf-8').trim()
      if (content) return content
    } catch (err) {
      // File unreadable or permission issue
      return null
    }
  }

  return null
}

/**
 * Persists an OAuth2 token to ~/.dsh/gemini-app/token.
 */
export function saveGeminiAppToken(token: string): void {
  mkdirSync(GEMINI_APP_DIR, { recursive: true })
  writeFileSync(GEMINI_APP_TOKEN_FILE, token.trim(), { encoding: 'utf-8', mode: 0o600 })
}

/**
 * Returns human-actionable re-authentication guidance.
 */
export function formatGeminiAppAuthGuidance(): string {
  return (
    'Gemini App authentication token is missing or expired. ' +
    'Please configure a valid Google OAuth bearer token with the assistant scope via:\n' +
    '  - Setting environment variable DSH_GEMINI_APP_TOKEN="ya29..."\n' +
    '  - Or saving the token to ~/.dsh/gemini-app/token\n' +
    '  - Or running /ccl gemini-token <token> in DSH chat'
  )
}
