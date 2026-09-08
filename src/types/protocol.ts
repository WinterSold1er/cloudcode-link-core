// Headless protocol types compatible with modern LLM harnesses

export type CallId = string

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
  thoughtSignature?: string
}

export interface ToolCallBlock {
  type: 'tool_call'
  id: CallId
  name: string
  arguments: Record<string, unknown>
  thoughtSignature?: string
}

export interface ToolResultBlock {
  type: 'tool_result'
  id: CallId
  result: unknown
}

export interface ImageAttachment {
  id: string
  [key: string]: unknown
}

export interface ImageBlock {
  type: 'image'
  mimeType: string
  data?: Uint8Array | Buffer | string
  attachment?: ImageAttachment
}

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ToolCallBlock
  | ToolResultBlock
  | ImageBlock
  | { type: string; [key: string]: unknown }

export interface Message {
  id?: string
  role: 'system' | 'user' | 'assistant' | string
  content: string | ContentBlock[]
  [key: string]: unknown
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

export interface LlmModelInfo {
  provider: string
  id: string
  name: string
}

export interface LlmResolvedModelInfo {
  provider: string
  id: string
  name: string
  context: { contextWindow: number }
  defaultMaxTokens: number
  reasoning?: {
    efforts: Array<{ id: string; name: string }>
    defaultEffort?: string
  }
}

export type ImageAttachmentRef = ImageBlock['attachment']
export type ImageReader = (ref: ImageAttachmentRef) => Promise<Uint8Array | Buffer | null>
