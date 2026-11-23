// Protocol definitions, request/response models, and configurations for Google Gemini App (Robin / AGSA).

export const GEMINI_APP_PROVIDER_ID = 'gemini-app'
export const ROBIN_DEFAULT_ENDPOINT = 'robinfrontend-pa.googleapis.com'
export const ROBIN_FALLBACK_ENDPOINT = 'webchannel-robinfrontend-pa.googleapis.com'
export const ROBIN_SERVICE = 'assistant.mobile.robin.RobinService'
export const ROBIN_PROCESS_QUERY_METHOD = '/assistant.mobile.robin.RobinService/ProcessQuery'
export const ROBIN_DEFAULT_USER_AGENT = 'grpc-java-cronet/1.62.0 (gzip)'
export const ROBIN_API_CLIENT = 'gl-android/35'

export const RobinStreamingState = {
  UNSPECIFIED: 0,
  IN_PROGRESS: 1,
  FINISHED: 2,
  ERROR: 3,
} as const
export type RobinStreamingState = (typeof RobinStreamingState)[keyof typeof RobinStreamingState]

export const RobinBardMode = {
  UNSPECIFIED: 0,
  STANDARD: 1,
  ADVANCED: 2,
} as const
export type RobinBardMode = (typeof RobinBardMode)[keyof typeof RobinBardMode]

export interface RobinAttachment {
  mimeType: string
  data: Uint8Array
  name?: string
}

export interface UiInteractionInput {
  eventType?: string
  interactionContext?: string
}

export interface SessionInput {
  textPrompt?: string
  attachments?: RobinAttachment[]
  uiInteraction?: UiInteractionInput
}

export interface DeviceContext {
  deviceModel?: string
  agsaVersion?: string
  locale?: string
  timeZone?: string
}

export interface RobinBardModeConfig {
  modeId: RobinBardMode
  bardModeName?: string
}

export interface ProcessQueryRequest {
  sessionInput?: SessionInput
  deviceContext?: DeviceContext
  modeConfig?: RobinBardModeConfig
}

export interface ChatHistoryOutput {
  deltaText?: string
  fullText?: string
  candidateId?: string
  thoughtsText?: string
  conversationId?: string
  responseId?: string
}

export interface RobinPunt {
  actionType?: string
  payload?: string
}

export interface RobinError {
  code: number
  message: string
}

export interface ProcessQueryResponse {
  chatHistoryOutput?: ChatHistoryOutput
  streamingState?: RobinStreamingState
  punt?: RobinPunt
  error?: RobinError
  conversationId?: string
  responseId?: string
}

export interface GeminiAppConfig {
  enabled?: boolean
  endpoint?: string
  fallbackEndpoint?: string
  token?: string
  timeoutMs?: number
  proxyUrl?: string
  deviceModel?: string
  agsaVersion?: string
  locale?: string
  timeZone?: string
  defaultModel?: string
}
