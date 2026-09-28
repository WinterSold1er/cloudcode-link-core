/**
 * DSH conversation -> Google CloudCode request projection.
 *
 * DSH (dsh-llm >= 0.1.7 / session format v4) delivers every model-visible role
 * and leaves provider-specific wire translation to the adapter:
 *
 *   system / developer -> Gemini `systemInstruction`
 *   user               -> `user` contents
 *   assistant          -> `model` contents
 *   tool               -> `functionResponse` inside a `user` turn
 *
 * The projection is TOTAL and EXPLICIT. Every role and every content block has
 * a defined mapping; anything unmapped is degraded to something the model can
 * still read and is reported through `WireProjection.warnings`. Nothing is
 * dropped silently, and no synthetic tool output is ever invented: a tool call
 * with no recorded result is answered through the wire's error channel, which
 * is what it is.
 */

import type {
  ContentBlock,
  ImageAttachmentRef,
  ImageBlock,
  ImageReader,
  Message,
  ReasoningBlock,
  TextBlock,
  ToolCallBlock,
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

/** Text used when a model turn survives conversion with no readable part. */
const OMITTED_PLACEHOLDER = '(thought omitted)'
/** Text that closes a trailing model turn which requested no tool call. */
const CONTINUE_TEXT = 'Continue.'
/** Error-channel text for a tool call the harness never produced a result for. */
const NO_RESULT_NOTICE = 'No result was recorded for this tool call: the harness did not execute it in this request.'

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

/** Options for one DSH -> CloudCode projection. */
export interface ConvertOptions {
  readImage?: ImageReader
  /** Wire model id, used only for diagnostics today. */
  runtimeModel?: string
  /** One-shot system prompt (`GenerateOptions.system`); loop requests carry theirs as a system message. */
  system?: string
}

/** The CloudCode request shape derived from one DSH message list. */
export interface WireProjection {
  contents: GeminiContent[]
  systemInstruction?: { parts: GeminiTextPart[] }
  /** Every input that could not be represented exactly, in encounter order. */
  warnings: string[]
}

type LooseRecord = Record<string, unknown>

function asRecord(value: unknown): LooseRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as LooseRecord) : undefined
}

function messageRole(message: unknown): string {
  return String(asRecord(message)?.role ?? '')
}

/** Normalized content blocks of one message: string shorthand becomes one text block. */
function rawBlocks(message: unknown): LooseRecord[] {
  const content = asRecord(message)?.content
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return content === undefined || content === null ? [] : [{ type: 'text', text: String(content) }]
  const blocks: LooseRecord[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record) blocks.push(record)
  }
  return blocks
}

function blockType(block: LooseRecord): string {
  return String(block.type ?? '')
}

function isToolCallBlock(block: LooseRecord): boolean {
  const type = blockType(block)
  return type === 'tool-call' || type === 'tool_call'
}

function isToolResultBlock(block: LooseRecord): boolean {
  const type = blockType(block)
  return type === 'tool_result' || type === 'tool-result'
}

/** Provider-issued Gemini signature, read tolerantly across the spellings seen on the wire. */
function readSignature(block: LooseRecord): string | undefined {
  for (const key of ['thoughtSignature', 'thought_signature', 'textSignature', 'thinkingSignature']) {
    const value = block[key]
    if (isValidThoughtSignature(value as string | undefined)) return value as string
  }
  return undefined
}

/** Best-effort readable text of a block this adapter has no mapping for. */
function unknownBlockText(block: LooseRecord): string | undefined {
  if (typeof block.text === 'string' && block.text.length > 0) return block.text
  if (typeof block.content === 'string' && block.content.length > 0) return block.content
  return undefined
}

function parseJsonArguments(raw: unknown, warnings: string[]): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'string') {
    warnings.push(`tool-call arguments of unsupported type "${typeof raw}" were sent as {}`)
    return {}
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    warnings.push(`tool-call arguments are JSON but not an object ("${trimmed.slice(0, 40)}"); sent as {}`)
    return {}
  } catch {
    warnings.push(`tool-call arguments are not valid JSON ("${trimmed.slice(0, 40)}"); sent as {}`)
    return {}
  }
}

function textOfBlocks(blocks: LooseRecord[]): string {
  const texts: string[] = []
  for (const block of blocks) {
    if (blockType(block) === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n')
}

/** Legacy `{result}` / `{content}` payload of a tool_result block, as text. */
function legacyResultText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    const blocks: LooseRecord[] = []
    for (const entry of raw) {
      const record = asRecord(entry)
      if (record) blocks.push(record)
    }
    return textOfBlocks(blocks)
  }
  if (raw === undefined || raw === null) return ''
  return JSON.stringify(raw)
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

async function inlineImagePart(
  block: LooseRecord,
  readImage: ImageReader | undefined,
  warnings: string[],
  context: string,
): Promise<GeminiInlineDataPart | undefined> {
  const data = block.data
  if (data !== undefined && data !== null) {
    const buf = Buffer.isBuffer(data)
      ? data
      : typeof data === 'string'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data as ArrayBuffer)
    if (buf.length === 0) {
      warnings.push(`${context}: image block carried no bytes; dropped`)
      return undefined
    }
    const mimeType = typeof block.mimeType === 'string' && block.mimeType ? block.mimeType : detectImageMimeType(buf)
    return { inlineData: { mimeType, data: buf.toString('base64') } }
  }

  const attachment = asRecord(block.attachment)
  if (!attachment) {
    warnings.push(`${context}: image block has neither inline bytes nor an attachment; dropped`)
    return undefined
  }
  if (block.offloaded === true) {
    // DSH offloaded the bytes and sent placeholder text in their place; sending
    // a second representation would duplicate the image in the request.
    warnings.push(`${context}: offloaded image skipped (the placeholder text already represents it)`)
    return undefined
  }
  if (!readImage) {
    warnings.push(`${context}: image attachment present but no image reader is configured; dropped`)
    return undefined
  }
  try {
    const bytes = await readImage(attachment as ImageAttachmentRef)
    if (!bytes || bytes.length === 0) {
      warnings.push(`${context}: image attachment could not be read; dropped`)
      return undefined
    }
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const mimeType =
      typeof attachment.mimeType === 'string' && attachment.mimeType ? attachment.mimeType : detectImageMimeType(buf)
    return { inlineData: { mimeType, data: buf.toString('base64') } }
  } catch (error) {
    warnings.push(`${context}: image attachment read failed (${String(error)}); dropped`)
    return undefined
  }
}

async function imageParts(
  blocks: LooseRecord[],
  readImage: ImageReader | undefined,
  warnings: string[],
  context: string,
): Promise<GeminiInlineDataPart[]> {
  const parts: GeminiInlineDataPart[] = []
  for (const block of blocks) {
    if (blockType(block) !== 'image') continue
    const part = await inlineImagePart(block, readImage, warnings, context)
    if (part) parts.push(part)
  }
  return parts
}

/** A model turn that requested tools, remembered until its results arrive. */
interface PendingCall {
  id?: string
  name: string
}

interface ClaimContext {
  pending: PendingCall[]
  toolNameByCallId: Map<string, string>
  answeredIds: Set<string>
  warnings: string[]
}

type ClaimResult =
  | { kind: 'matched'; call: PendingCall; responseId?: string }
  | { kind: 'duplicate'; callId: string }
  | { kind: 'ambiguous'; candidates: number }
  | { kind: 'unmatched'; callId?: string }

/**
 * Attribute one tool result to the call it answers.
 *
 * A provider-issued `toolCallId` is authoritative. Without one, a unique
 * unanswered call in the immediately preceding model turn is used; anything
 * less certain is reported instead of guessed.
 */
function claimCall(context: ClaimContext, rawCallId: unknown): ClaimResult {
  const callId = typeof rawCallId === 'string' && rawCallId.length > 0 ? rawCallId : undefined

  if (callId && context.answeredIds.has(callId)) return { kind: 'duplicate', callId }
  if (callId) {
    const index = context.pending.findIndex((call) => call.id === callId)
    if (index >= 0) {
      const [call] = context.pending.splice(index, 1)
      context.answeredIds.add(callId)
      return { kind: 'matched', call: call!, responseId: callId }
    }
    return { kind: 'unmatched', callId }
  }
  if (context.pending.length === 1) {
    const [call] = context.pending.splice(0, 1)
    if (call?.id) context.answeredIds.add(call.id)
    return { kind: 'matched', call: call! }
  }
  return context.pending.length > 1 ? { kind: 'ambiguous', candidates: context.pending.length } : { kind: 'unmatched' }
}

function functionResponsePart(
  name: string,
  responseId: string | undefined,
  text: string,
  isError: boolean,
): GeminiFunctionResponsePart {
  return {
    functionResponse: {
      name,
      ...(responseId ? { id: responseId } : {}),
      response: isError ? { error: text || 'Tool error' } : { output: text },
    },
  }
}

/** Observation text used when a result cannot be attached to a call. */
function observationText(name: unknown, text: string): string {
  return `[Observation from \`${String(name ?? 'tool')}\`:\n${text}]`
}

interface ResultPayload {
  text: string
  isError: boolean
  callId: unknown
  toolName?: string
  images: GeminiInlineDataPart[]
}

/**
 * Shared handler for DSH v4 `role:'tool'` messages and legacy `tool_result`
 * blocks: always produces readable parts, never a fabricated output.
 */
function buildResultParts(payload: ResultPayload, context: ClaimContext): GeminiPart[] {
  const claim = claimCall(context, payload.callId)
  const knownName = typeof payload.callId === 'string' ? context.toolNameByCallId.get(payload.callId) : undefined
  const name = payload.toolName || knownName || (claim.kind === 'matched' ? claim.call.name : undefined)

  switch (claim.kind) {
    case 'matched':
      return [functionResponsePart(claim.call.name, claim.responseId ?? claim.call.id, payload.text, payload.isError), ...payload.images]
    case 'duplicate':
      context.warnings.push(`duplicate tool result for call "${claim.callId}"; forwarded as an observation instead of a second functionResponse`)
      return [{ text: observationText(name, payload.text) }, ...payload.images]
    case 'ambiguous':
      context.warnings.push(
        `ambiguous tool result: ${claim.candidates} unanswered calls and no toolCallId; forwarded as an observation`,
      )
      return [{ text: observationText(name, payload.text) }, ...payload.images]
    case 'unmatched': {
      const label = claim.callId
        ? `tool result for unknown call "${claim.callId}" has no matching call in the preceding model turn; forwarded as an observation`
        : 'tool result has no matching tool call; forwarded as an observation'
      context.warnings.push(label)
      return [{ text: observationText(name, payload.text) }, ...payload.images]
    }
  }
}

async function convertToolMessage(
  message: unknown,
  context: ClaimContext,
  readImage: ImageReader | undefined,
): Promise<GeminiPart[]> {
  const record = asRecord(message) ?? {}
  const blocks = rawBlocks(message)
  const text = textOfBlocks(blocks)
  const images = await imageParts(blocks, readImage, context.warnings, 'tool result')
  return buildResultParts(
    { text, isError: record.isError === true, callId: record.toolCallId, images },
    context,
  )
}

async function convertUserBlocks(
  blocks: LooseRecord[],
  context: ClaimContext,
  readImage: ImageReader | undefined,
): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = []
  for (const block of blocks) {
    switch (blockType(block)) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : ''
        if (text) parts.push({ text: sanitizeText(text) })
        break
      }
      case 'tool_result':
      case 'tool-result': {
        const callId = block.toolCallId ?? block.id
        const legacyImages = await imageParts(
          Array.isArray(block.content)
            ? block.content.flatMap((entry) => {
                const record = asRecord(entry)
                return record ? [record] : []
              })
            : [],
          readImage,
          context.warnings,
          'tool result',
        )
        const text = block.content !== undefined ? legacyResultText(block.content) : legacyResultText(block.result)
        parts.push(
          ...buildResultParts(
            {
              text,
              isError: block.isError === true,
              callId,
              toolName: typeof block.toolName === 'string' ? block.toolName : undefined,
              images: legacyImages,
            },
            context,
          ),
        )
        break
      }
      case 'image': {
        const part = await inlineImagePart(block, readImage, context.warnings, 'user')
        if (part) parts.push(part)
        break
      }
      default: {
        const text = unknownBlockText(block)
        context.warnings.push(
          `user block "${blockType(block)}" has no mapping${text ? '; its text was forwarded' : ' and no readable text; dropped'}`,
        )
        if (text) parts.push({ text: sanitizeText(text) })
      }
    }
  }
  return parts
}

async function convertAssistantBlocks(
  blocks: LooseRecord[],
  readImage: ImageReader | undefined,
  warnings: string[],
): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = []
  let turnSignature: string | undefined
  for (const block of blocks) {
    const signature = readSignature(block)
    if (signature) {
      turnSignature = signature
      break
    }
  }

  for (const block of blocks) {
    switch (blockType(block)) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : ''
        if (!text) break
        const signature = readSignature(block)
        parts.push({ text: sanitizeText(text), ...(signature ? { thoughtSignature: signature } : {}) })
        break
      }
      case 'reasoning': {
        const text = typeof block.text === 'string' ? block.text : ''
        if (!text) break
        const signature = readSignature(block)
        if (signature) parts.push({ thought: true, text: sanitizeText(text), thoughtSignature: signature })
        else warnings.push('reasoning block without a valid thoughtSignature was dropped (Gemini 3 requires signed thoughts)')
        break
      }
      case 'tool-call':
      case 'tool_call': {
        const name = typeof block.name === 'string' ? block.name : ''
        if (!name) {
          warnings.push('tool-call block without a name was dropped')
          break
        }
        const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : undefined
        const signature = readSignature(block) ?? turnSignature
        const functionCall: GeminiFunctionCallPart['functionCall'] = {
          name,
          args: parseJsonArguments(block.arguments, warnings),
          ...(id ? { id } : {}),
        }
        parts.push({ functionCall, ...(signature ? { thoughtSignature: signature } : {}) })
        break
      }
      case 'image': {
        const part = await inlineImagePart(block, readImage, warnings, 'assistant')
        if (part) parts.push(part)
        break
      }
      default: {
        const text = unknownBlockText(block)
        warnings.push(
          `assistant block "${blockType(block)}" has no mapping${text ? '; its text was forwarded' : ' and no readable text; dropped'}`,
        )
        if (text) parts.push({ text: sanitizeText(text) })
      }
    }
  }
  return parts
}

/** Fold a system/developer message into the Gemini system instruction. */
function collectSystemBlocks(
  role: string,
  blocks: LooseRecord[],
  systemTexts: string[],
  warnings: string[],
): void {
  for (const block of blocks) {
    const type = blockType(block)
    switch (type) {
      case 'text': {
        const text = typeof block.text === 'string' ? block.text : ''
        if (text) systemTexts.push(sanitizeText(text))
        break
      }
      case 'tool-addition':
      case 'tool-removal':
        warnings.push(
          `${role} message carries a ${type} block ("${String(block.toolName ?? '?')}") that cannot be represented: this adapter always declares the complete tool list`,
        )
        break
      default: {
        const text = unknownBlockText(block)
        warnings.push(
          `${role} block "${type}" has no mapping${text ? '; its text was moved into the system instruction' : ' and no readable text; dropped'}`,
        )
        if (text) systemTexts.push(sanitizeText(text))
      }
    }
  }
}

/**
 * Project one DSH message list into the CloudCode request shape.
 *
 * @param messages - DSH `RequestMessage[]` (roles system/developer/user/assistant/tool).
 * @param options - Image reader, wire model id, and any one-shot system prompt.
 * @returns Contents, the system instruction, and every mapping loss observed.
 */
export async function convertRequest(
  messages: readonly unknown[],
  options: ConvertOptions = {},
): Promise<WireProjection> {
  const warnings: string[] = []
  const contents: GeminiContent[] = []
  const systemTexts: string[] = []
  const readImage = options.readImage
  const list = Array.isArray(messages) ? messages : []

  if (typeof options.system === 'string' && options.system.length > 0) systemTexts.push(sanitizeText(options.system))

  // Provider-issued call ids are stable across a session, so a result can still
  // be named when the call it answers fell outside the retained history window.
  const toolNameByCallId = new Map<string, string>()
  for (const message of list) {
    if (messageRole(message) !== 'assistant') continue
    for (const block of rawBlocks(message)) {
      if (!isToolCallBlock(block)) continue
      const id = typeof block.id === 'string' ? block.id : ''
      const name = typeof block.name === 'string' ? block.name : ''
      if (id && name) toolNameByCallId.set(id, name)
    }
  }

  const context: ClaimContext = { pending: [], toolNameByCallId, answeredIds: new Set(), warnings }

  for (const message of list) {
    const role = messageRole(message)
    const blocks = rawBlocks(message)

    if (role === 'system' || role === 'developer') {
      collectSystemBlocks(role, blocks, systemTexts, warnings)
      continue
    }

    if (role === 'assistant') {
      const parts = await convertAssistantBlocks(blocks, readImage, warnings)
      context.pending = parts.flatMap((part) =>
        'functionCall' in part ? [{ id: part.functionCall.id, name: part.functionCall.name }] : [],
      )
      appendTurn(contents, 'model', parts.length ? parts : [{ text: OMITTED_PLACEHOLDER }])
      continue
    }

    if (role === 'tool') {
      appendTurn(contents, 'user', await convertToolMessage(message, context, readImage))
      continue
    }

    if (role === 'user') {
      appendTurn(contents, 'user', await convertUserBlocks(blocks, context, readImage))
      continue
    }

    warnings.push(`unmapped message role "${role}"; its content was forwarded as a user turn`)
    appendTurn(contents, 'user', await convertUserBlocks(blocks, context, readImage))
  }

  return {
    contents: sanitizeTopology(contents, warnings),
    ...(systemTexts.length ? { systemInstruction: { parts: systemTexts.map((text) => ({ text })) } } : {}),
    warnings: aggregateWarnings(warnings),
  }
}

/** Collapse identical losses into one counted line, preserving first-seen order. */
function aggregateWarnings(warnings: readonly string[]): string[] {
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const warning of warnings) {
    if (!counts.has(warning)) order.push(warning)
    counts.set(warning, (counts.get(warning) ?? 0) + 1)
  }
  return order.map((warning) => {
    const count = counts.get(warning) ?? 1
    return count > 1 ? `${warning} (x${count})` : warning
  })
}

/**
 * Compatibility wrapper returning only contents.
 *
 * @param messages - DSH message list.
 * @param readImage - Attachment reader for image blocks.
 * @param runtimeModel - Wire model id (diagnostics only).
 * @returns CloudCode contents with every topology invariant enforced.
 */
export async function convertMessages(
  messages: readonly unknown[],
  readImage?: ImageReader,
  runtimeModel = 'gemini-3.7-flash',
): Promise<GeminiContent[]> {
  return (await convertRequest(messages, { readImage, runtimeModel })).contents
}

function hasMatchingFunctionCall(
  modelTurn: GeminiContent | undefined,
  fr: GeminiFunctionResponsePart['functionResponse'],
): boolean {
  if (!modelTurn || modelTurn.role !== 'model') return false
  return modelTurn.parts.some((p) => {
    if (!('functionCall' in p) || !p.functionCall) return false
    const fc = p.functionCall
    if (fr.id && fc.id) return fc.id === fr.id
    return fc.name === fr.name
  })
}

/**
 * Enforce every CloudCode topology invariant on already-built contents:
 *
 * 1. Model turns keep only signed thoughts; an empty model turn keeps a
 *    placeholder so the turn itself survives.
 * 2. A `functionResponse` is kept only when the preceding model turn has the
 *    matching call; a duplicate is dropped; anything unmatched degrades to a
 *    text observation so its content stays visible.
 * 3. Contents start with a `user` turn.
 * 4. Contents end with a `user` turn. A trailing model turn that requested
 *    tools is closed with `functionResponse` error notices (never a fabricated
 *    successful output); a trailing model turn without calls gets `Continue.`.
 *
 * @param contents - Projected contents, mutated into a repaired copy.
 * @param warnings - Optional sink for every repair that lost or rewrote input.
 * @returns Repaired contents.
 */
export function sanitizeTopology(contents: GeminiContent[], warnings: string[] = []): GeminiContent[] {
  const result: GeminiContent[] = []

  for (const turn of contents) {
    if (turn.role === 'model') {
      const cleanParts: GeminiPart[] = []
      for (const part of turn.parts) {
        if ('thought' in part && part.thought) {
          if (isValidThoughtSignature(part.thoughtSignature)) cleanParts.push(part)
          else warnings.push('thought part without a valid signature was dropped')
        } else {
          cleanParts.push(part)
        }
      }
      if (cleanParts.length === 0) cleanParts.push({ text: OMITTED_PLACEHOLDER })
      result.push({ role: 'model', parts: cleanParts })
      continue
    }

    const prevTurn = result[result.length - 1]
    const cleanParts: GeminiPart[] = []
    const answered = new Set<string>()
    for (const part of turn.parts) {
      if (!('functionResponse' in part) || !part.functionResponse) {
        cleanParts.push(part)
        continue
      }
      const fr = part.functionResponse
      const label = `${fr.name}"${fr.id ? ` (id ${fr.id})` : ''}`
      if (!hasMatchingFunctionCall(prevTurn, fr)) {
        warnings.push(`functionResponse for "${label} has no matching call in the preceding model turn; degraded to a text observation`)
        const output =
          typeof fr.response === 'object' && fr.response !== null
            ? 'output' in fr.response && typeof (fr.response as { output?: unknown }).output === 'string'
              ? (fr.response as { output: string }).output
              : 'error' in fr.response && typeof (fr.response as { error?: unknown }).error === 'string'
                ? (fr.response as { error: string }).error
                : JSON.stringify(fr.response)
            : String(fr.response ?? '')
        cleanParts.push({ text: observationText(fr.name, output) })
        continue
      }
      const key = fr.id ?? fr.name
      if (answered.has(key)) {
        warnings.push(`duplicate functionResponse for "${label}; dropped`)
        continue
      }
      answered.add(key)
      cleanParts.push(part)
    }

    if (cleanParts.length > 0) result.push({ role: 'user', parts: cleanParts })
  }

  // CloudCode requires the first turn to be 'user'.
  if (result.length > 0 && result[0]?.role === 'model') {
    result.unshift({ role: 'user', parts: [{ text: 'Hello' }] })
  }

  // Gemini pairs EVERY functionCall with a functionResponse in the immediately
  // following turn. A call without a recorded result cannot be answered with
  // invented output, so it is closed through the error channel; that keeps the
  // protocol valid and tells the model the truth about what it never received.
  for (let index = 0; index < result.length; index++) {
    const turn = result[index]!
    if (turn.role !== 'model') continue
    const calls = turn.parts.flatMap((part) => ('functionCall' in part ? [part.functionCall] : []))
    if (calls.length === 0) continue

    const next = result[index + 1]
    const existing =
      next?.role === 'user'
        ? next.parts.flatMap((part) => ('functionResponse' in part ? [part.functionResponse] : []))
        : []
    const missing = calls.filter((call) => !answeredByAny(call, existing))
    if (missing.length === 0) continue

    const notices: GeminiPart[] = missing.map((call) => {
      warnings.push(`tool call "${call.name}"${call.id ? ` (id ${call.id})` : ''} has no recorded result; closed with an error notice`)
      return {
        functionResponse: {
          name: call.name,
          ...(call.id ? { id: call.id } : {}),
          response: { error: NO_RESULT_NOTICE },
        },
      } satisfies GeminiFunctionResponsePart
    })

    if (next?.role === 'user') next.parts.push(...notices)
    else result.splice(index + 1, 0, { role: 'user', parts: notices })
  }

  // CloudCode rejects any request whose contents end with a model turn.
  if (result[result.length - 1]?.role === 'model') {
    result.push({ role: 'user', parts: [{ text: CONTINUE_TEXT }] })
  }

  return result
}

/** True when some response answers this exact call (id match wins, else name). */
function answeredByAny(
  call: GeminiFunctionCallPart['functionCall'],
  responses: readonly GeminiFunctionResponsePart['functionResponse'][],
): boolean {
  return responses.some((fr) => (fr.id && call.id ? fr.id === call.id : fr.name === call.name))
}
