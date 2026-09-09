import type {
  ContentBlock,
  ImageAttachmentRef,
  ImageBlock,
  ImageReader,
  Message,
  ReasoningBlock,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
} from './types/protocol.ts'
import type {
  GeminiContent,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
  GeminiInlineDataPart,
  GeminiPart,
  GeminiTextPart,
} from './client.ts'

export type { ImageAttachmentRef, ImageReader }

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/
export function isValidThoughtSignature(signature?: string): boolean {
  if (!signature || typeof signature !== 'string' || signature.length === 0) return false
  if (signature.length % 4 !== 0) return false
  return base64SignaturePattern.test(signature)
}

function detectImageMimeType(bytes: Uint8Array | Buffer): string {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return 'image/webp'
    }
  }
  return 'image/png'
}

export function sanitizeText(text: unknown): string {
  return String(text ?? '').replace(/[\uD800-\uDFFF]/g, '\uFFFD')
}

function appendTurn(contents: GeminiContent[], role: 'user' | 'model', parts: GeminiPart[]): void {
  if (!parts.length) return
  const last = contents[contents.length - 1]
  if (last && last.role === role) {
    last.parts.push(...parts)
  } else {
    contents.push({ role, parts })
  }
}

function parseJsonArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // fallback
    }
  }
  return {}
}

function extractToolResultText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return String(blocks ?? '')
  const texts: string[] = []
  for (const b of blocks) {
    if (b && typeof b === 'object' && 'type' in b && b.type === 'text') {
      texts.push(String((b as TextBlock).text ?? ''))
    }
  }
  return texts.join('\n')
}

/**
 * Maps conversation messages into Google CloudCode GeminiContent turns.
 */
export async function convertMessages(
  messages: any[],
  readImage?: ImageReader,
  runtimeModel = 'gemini-3.7-flash',
): Promise<GeminiContent[]> {
  const contents: GeminiContent[] = []
  const toolNameByCallId = new Map<string, string>()

  // Pass 1: index all toolCall names
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_call' || block.type === 'tool-call') {
          const tc = block as ToolCallBlock
          if (tc.id && tc.name) {
            toolNameByCallId.set(tc.id, tc.name)
          }
        }
      }
    }
  }

  // Pass 2: convert messages
  for (const msg of messages) {
    if (msg.role === 'user') {
      const parts: GeminiPart[] = []
      const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || [])
      for (const block of blocks) {
        if (block.type === 'text') {
          const text = (block as TextBlock).text
          if (text) parts.push({ text: sanitizeText(text) })
        } else if (block.type === 'image') {
          const imgBlock = block as ImageBlock
          if (imgBlock.data) {
            const buf = Buffer.isBuffer(imgBlock.data)
              ? imgBlock.data
              : typeof imgBlock.data === 'string'
                ? Buffer.from(imgBlock.data, 'base64')
                : Buffer.from(imgBlock.data)
            parts.push({
              inlineData: {
                mimeType: imgBlock.mimeType || detectImageMimeType(buf),
                data: buf.toString('base64'),
              },
            })
          } else if (readImage && imgBlock.attachment) {
            try {
              const bytes = await readImage(imgBlock.attachment)
              if (bytes && bytes.length > 0) {
                const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
                const mimeType = (imgBlock.attachment as { mimeType?: string }).mimeType || detectImageMimeType(buf)
                parts.push({
                  inlineData: {
                    mimeType,
                    data: buf.toString('base64'),
                  },
                })
              }
            } catch {
              // skip failed image
            }
          }
        } else if (block.type === 'tool_result' || block.type === 'tool-result') {
          const tr = block as unknown as { id?: string; toolCallId?: string; toolName?: string; result?: unknown; content?: unknown; isError?: boolean }
          const callId = tr.id || tr.toolCallId || ''
          const toolName = tr.toolName || toolNameByCallId.get(callId) || 'tool'
          const rawContent = tr.content ?? tr.result
          const resultText = extractToolResultText(rawContent)
          const resp = tr.isError
            ? { error: resultText || 'Tool error' }
            : { output: resultText || '' }
          parts.push({
            functionResponse: {
              name: toolName,
              response: resp,
              ...(callId ? { id: callId } : {}),
            },
          })
          if (readImage && Array.isArray(rawContent)) {
            for (const sub of rawContent) {
              if (sub.type === 'image') {
                const subImg = sub as ImageBlock
                if (subImg.attachment) {
                  try {
                    const bytes = await readImage(subImg.attachment)
                    if (bytes && bytes.length > 0) {
                      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
                      const mimeType = detectImageMimeType(buf)
                      parts.push({
                        inlineData: { mimeType, data: buf.toString('base64') },
                      })
                    }
                  } catch {
                    // skip
                  }
                }
              }
            }
          }
        }
      }
      appendTurn(contents, 'user', parts)
    } else if (msg.role === 'assistant') {
      const parts: GeminiPart[] = []
      const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || [])

      let turnThoughtSignature: string | undefined
      for (const b of blocks) {
        const sig =
          (b as unknown as { thoughtSignature?: string; thought_signature?: string }).thoughtSignature ||
          (b as unknown as { thoughtSignature?: string; thought_signature?: string }).thought_signature ||
          (b as unknown as { textSignature?: string }).textSignature ||
          (b as unknown as { thinkingSignature?: string }).thinkingSignature
        if (isValidThoughtSignature(sig)) {
          turnThoughtSignature = sig
          break
        }
      }

      for (const block of blocks) {
        if (block.type === 'text') {
          const text = (block as TextBlock).text
          const sig =
            (block as unknown as { thoughtSignature?: string; thought_signature?: string }).thoughtSignature ||
            (block as unknown as { thoughtSignature?: string; thought_signature?: string }).thought_signature ||
            (block as unknown as { textSignature?: string }).textSignature
          if (text) {
            parts.push({
              text: sanitizeText(text),
              ...(isValidThoughtSignature(sig) ? { thoughtSignature: sig } : {}),
            })
          }
        } else if (block.type === 'reasoning') {
          const reasoning = (block as ReasoningBlock).text
          const sig =
            (block as unknown as { thoughtSignature?: string; thought_signature?: string }).thoughtSignature ||
            (block as unknown as { thoughtSignature?: string; thought_signature?: string }).thought_signature ||
            (block as unknown as { thinkingSignature?: string }).thinkingSignature
          if (reasoning) {
            if (isValidThoughtSignature(sig)) {
              parts.push({
                thought: true,
                text: sanitizeText(reasoning),
                thoughtSignature: sig,
              })
            }
          }
        } else if (block.type === 'tool_call' || block.type === 'tool-call') {
          const tc = block as unknown as { id?: string; name: string; arguments: unknown }
          const sig =
            (block as unknown as { thoughtSignature?: string; thought_signature?: string }).thoughtSignature ||
            (block as unknown as { thoughtSignature?: string; thought_signature?: string }).thought_signature ||
            turnThoughtSignature
          const functionCall: GeminiFunctionCallPart['functionCall'] = {
            name: tc.name,
            args: parseJsonArguments(tc.arguments),
            ...(tc.id ? { id: tc.id } : {}),
          }
          parts.push({
            functionCall,
            ...(isValidThoughtSignature(sig) ? { thoughtSignature: sig } : {}),
          })
        }
      }
      if (parts.length === 0) {
        parts.push({ text: '(thought omitted)' })
      }
      appendTurn(contents, 'model', parts)
    }
  }

  // Google CloudCode requires first turn to be 'user'
  if (contents.length > 0 && contents[0]?.role === 'model') {
    contents.unshift({
      role: 'user',
      parts: [{ text: 'Hello' }],
    })
  }

  return sanitizeTopology(contents)
}

function hasMatchingFunctionCall(
  modelTurn: GeminiContent | undefined,
  fr: GeminiFunctionResponsePart['functionResponse'],
): boolean {
  if (!modelTurn || modelTurn.role !== 'model') return false
  return modelTurn.parts.some((p) => {
    if (!('functionCall' in p) || !p.functionCall) return false
    const fc = p.functionCall
    if (fr.id && fc.id) {
      return fc.id === fr.id
    }
    return fc.name === fr.name
  })
}

/**
 * Topologically sanitizes conversation turns:
 * 1. History model messages: strip thought:true if signature is missing or invalid.
 *    If all thoughts in a model turn are stripped, insert placeholder '(thought omitted)'.
 * 2. Unpaired / orphan functionResponse: only retain structured functionResponse if preceding
 *    turn is 'model' with matching functionCall; otherwise degrade to text observation block.
 */
export function sanitizeTopology(contents: GeminiContent[]): GeminiContent[] {
  const result: GeminiContent[] = []

  for (let i = 0; i < contents.length; i++) {
    const turn = contents[i]!

    if (turn.role === 'model') {
      const cleanParts: GeminiPart[] = []
      for (const part of turn.parts) {
        if ('thought' in part && part.thought) {
          if (isValidThoughtSignature(part.thoughtSignature)) {
            cleanParts.push(part)
          }
        } else {
          cleanParts.push(part)
        }
      }
      if (cleanParts.length === 0) {
        cleanParts.push({ text: '(thought omitted)' })
      }
      result.push({ role: 'model', parts: cleanParts })
    } else {
      // User turn
      const prevTurn = result[result.length - 1]
      const cleanParts: GeminiPart[] = []
      for (const part of turn.parts) {
        if ('functionResponse' in part && part.functionResponse) {
          const fr = part.functionResponse
          if (hasMatchingFunctionCall(prevTurn, fr)) {
            cleanParts.push(part)
          } else {
            const output =
              typeof fr.response === 'object' && fr.response !== null
                ? ('output' in fr.response && typeof (fr.response as { output?: unknown }).output === 'string'
                    ? (fr.response as { output: string }).output
                    : 'error' in fr.response && typeof (fr.response as { error?: unknown }).error === 'string'
                      ? (fr.response as { error: string }).error
                      : JSON.stringify(fr.response))
                : String(fr.response ?? '')
            cleanParts.push({
              text: `[Observation from \`${fr.name}\`:\n${output}]`,
            })
          }
        } else {
          cleanParts.push(part)
        }
      }

      if (cleanParts.length > 0) {
        result.push({ role: 'user', parts: cleanParts })
      }
    }
  }

  // Ensure conversation starts with 'user'
  if (result.length > 0 && result[0]?.role === 'model') {
    result.unshift({
      role: 'user',
      parts: [{ text: 'Hello' }],
    })
  }

  return result
}
