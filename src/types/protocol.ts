/**
 * Model-facing message contract as DSH (dsh-llm >= 0.1.7, session format v4)
 * hands it to a provider adapter, kept permissive enough to also accept the
 * legacy Anthropic-style shapes this plugin supported before v4.
 *
 * Roles: `system`, `developer`, `user`, `assistant`, `tool`. Tool results are
 * their OWN `role: 'tool'` message carrying `toolCallId` / `isError` / content;
 * the legacy `{type:'tool_result'}` block inside a user message is still read.
 *
 * Content blocks are merge-extensible in DSH, so an adapter must handle
 * unknown `type`s explicitly instead of ignoring them.
 */

export type CallId = string

/** Message roles DSH can deliver, plus unknown/legacy strings an adapter must survive. */
export type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
  /**
   * Provider-issued Gemini thinking signature. Declared here (and read
   * tolerantly from the wire) because Gemini 3 rejects history whose
   * functionCall parts lost the signature they were produced with.
   */
  thoughtSignature?: string
}

export interface ToolCallBlock {
  /** DSH spells it `tool-call`; the legacy alias is still accepted. */
  type: 'tool-call' | 'tool_call'
  /** Provider-issued call id; correlates with the matching tool result. */
  id?: CallId
  name: string
  /** Raw JSON string as produced by DSH v4; legacy callers pass an object. */
  arguments: string | Record<string, unknown>
  thoughtSignature?: string
}

/**
 * Legacy Anthropic-style tool result carried inside a user message.
 * DSH v4 no longer emits this; it stays supported for older hosts.
 */
export interface ToolResultBlock {
  type: 'tool_result' | 'tool-result'
  id?: CallId
  toolCallId?: CallId
  toolName?: string
  result?: unknown
  content?: unknown
  isError?: boolean
}

export interface ImageAttachment {
  id?: string
  /** DSH `ImageAttachmentRef` fields an adapter may read. */
  attachmentId?: string
  mimeType?: string
  [key: string]: unknown
}

export interface ImageBlock {
  type: 'image'
  mimeType?: string
  data?: Uint8Array | Buffer | string
  attachment?: ImageAttachment
  /** DSH already replaced the bytes with placeholder text; send no inline data. */
  offloaded?: true
}

export interface FileBlock {
  type: 'file'
  attachment?: ImageAttachment
}

/** Developer-message block activating a deferred tool declaration. */
export interface ToolAdditionBlock {
  type: 'tool-addition'
  toolName: string
}

/** Developer-message block deactivating a tool declaration. */
export interface ToolRemovalBlock {
  type: 'tool-removal'
  toolName: string
}

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ToolCallBlock
  | ToolResultBlock
  | ImageBlock
  | FileBlock
  | ToolAdditionBlock
  | ToolRemovalBlock
  | { type: string; [key: string]: unknown }

/** A conversation message whose content the model reads. */
export interface Message {
  id?: string
  role: MessageRole | (string & {})
  content: string | ContentBlock[]
  source?: unknown
  [key: string]: unknown
}

/** A DSH v4 tool result: its own message role, correlated by `toolCallId`. */
export interface ToolResultMessage extends Message {
  role: 'tool'
  toolCallId: CallId
  isError?: boolean
}

export interface ToolSchema {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  [key: string]: unknown
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cachedPromptTokens?: number
}

export interface FinishReason {
  kind: 'stop' | 'length' | 'tool_call' | 'tool-calls' | 'error' | 'max-tokens' | 'aborted' | 'other' | string
  failure?: { message: string; code?: string }
  details?: unknown
}

export type StreamChunk =
  | { type: 'text-delta'; text: string; index: number }
  | { type: 'reasoning-delta'; text: string; index: number }
  | { type: 'tool-call-delta'; id: CallId; name?: string; argumentsDelta?: string; index: number }
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'block-end'; index: number; block?: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; finishReason?: FinishReason }
  | { type: string; [key: string]: unknown }

export interface GenerateOptions {
  provider?: string
  model: string
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  reasoningEffort?: string
  sessionId?: string
  signal?: AbortSignal
  maxTokens?: number
  [key: string]: unknown
}

export type ModelModality = 'text' | 'image'

export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  inputModalities?: readonly ModelModality[]
}

export interface LlmResolvedModelInfo {
  provider: string
  id: string
  name: string
  inputModalities?: readonly ModelModality[]
  context: { contextWindow: number }
  defaultMaxTokens: number
  reasoning?: {
    efforts: Array<{ id: string; name: string }>
    defaultEffort?: string
  }
}

export type ImageAttachmentRef = ImageBlock['attachment']
export type ImageReader = (ref: ImageAttachmentRef) => Promise<Uint8Array | Buffer | null>
