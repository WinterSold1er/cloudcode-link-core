// HTTP/2 gRPC client for Google Gemini App (Robin / AGSA) service.

import http2 from 'node:http2'
import type { StreamChunk } from '../types/protocol.ts'
import {
  ROBIN_DEFAULT_ENDPOINT,
  ROBIN_FALLBACK_ENDPOINT,
  ROBIN_PROCESS_QUERY_METHOD,
  ROBIN_DEFAULT_USER_AGENT,
  ROBIN_API_CLIENT,
  GeminiAppError,
  type GeminiAppAccount,
  type GeminiAppConfig,
  type ProcessQueryRequest,
  type ProcessQueryResponse,
} from './types.ts'
import {
  encodeProcessQueryFrames,
  decodeProcessQueryResponse,
  encodeGrpcFrame,
  decodeGrpcFrames,
} from './proto.ts'
import { parseRobinGrpcFramesToChunks } from './stream-mapper.ts'
import { resolveGeminiAppToken, formatGeminiAppAuthGuidance } from './auth.ts'
import type { GeminiAppPoolManager } from './pool.ts'

export { GeminiAppError } from './types.ts'

export interface GeminiAppTransportResult {
  frames: AsyncIterable<Uint8Array>
  getTrailers?: () => Record<string, string | number | undefined>
}

export type GeminiAppTransport = (
  endpoint: string,
  headers: Record<string, string>,
  body: Uint8Array,
  signal?: AbortSignal,
) => Promise<GeminiAppTransportResult>

/**
 * Standard HTTP/2 gRPC transport connecting to robinfrontend-pa.googleapis.com.
 */
export async function defaultHttp2Transport(
  endpoint: string,
  headers: Record<string, string>,
  body: Uint8Array,
  signal?: AbortSignal,
): Promise<GeminiAppTransportResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new GeminiAppError('Request was aborted before connecting', 'ABORTED'))
    }

    let client: http2.ClientHttp2Session | null = null
    try {
      client = http2.connect(`https://${endpoint}:443`)
    } catch (err) {
      return reject(
        new GeminiAppError(
          `Failed to establish HTTP/2 connection to ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
          'CONNECTION_FAILED',
        ),
      )
    }

    client.on('error', (err) => {
      reject(
        new GeminiAppError(
          `HTTP/2 session error with ${endpoint}: ${err.message}`,
          'SESSION_ERROR',
        ),
      )
    })

    const req = client.request({
      ':method': 'POST',
      ':path': ROBIN_PROCESS_QUERY_METHOD,
      ':scheme': 'https',
      ':authority': endpoint,
      ...headers,
    })

    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
    const frameQueue: Uint8Array[] = []
    let notifyFrame: (() => void) | null = null
    let isStreamEnded = false
    let streamError: Error | null = null
    const trailers: Record<string, string | number | undefined> = {}

    const onAbort = () => {
      req.close(http2.constants.NGHTTP2_CANCEL)
      client?.close()
      streamError = new GeminiAppError('Request was aborted', 'ABORTED')
      if (notifyFrame) notifyFrame()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    req.on('response', (headers) => {
      const status = Number(headers[':status'] || 200)
      if (status !== 200) {
        let code = 'HTTP_ERROR'
        if (status === 401 || status === 403) code = 'AUTH_ERROR'
        else if (status === 429) code = 'RATE_LIMIT'
        streamError = new GeminiAppError(
          `Robin gRPC endpoint returned HTTP status ${status}`,
          code,
          status,
        )
        if (notifyFrame) notifyFrame()
      }
    })

    req.on('data', (chunk: Buffer) => {
      const chunkBytes = new Uint8Array(chunk)
      const combined = new Uint8Array(buffer.length + chunkBytes.length)
      combined.set(buffer, 0)
      combined.set(chunkBytes, buffer.length)

      try {
        const { frames, rest } = decodeGrpcFrames(combined)
        buffer = rest
        for (const frame of frames) {
          frameQueue.push(frame)
        }
        if (notifyFrame) {
          const fn = notifyFrame
          notifyFrame = null
          fn()
        }
      } catch (err) {
        streamError = err instanceof Error ? err : new Error(String(err))
        if (notifyFrame) notifyFrame()
      }
    })

    req.on('trailers', (hdrs) => {
      const grpcStatus = hdrs['grpc-status']
      const grpcMessage = hdrs['grpc-message']
      trailers['grpc-status'] = grpcStatus !== undefined ? Number(grpcStatus) : undefined
      trailers['grpc-message'] = typeof grpcMessage === 'string' ? grpcMessage : undefined

      if (grpcStatus !== undefined && Number(grpcStatus) !== 0) {
        const statusCode = Number(grpcStatus)
        let code = 'GRPC_ERROR'
        if (statusCode === 16) code = 'UNAUTHENTICATED'
        else if (statusCode === 8) code = 'RESOURCE_EXHAUSTED'
        else if (statusCode === 4) code = 'DEADLINE_EXCEEDED'
        streamError = new GeminiAppError(
          `gRPC error (status ${statusCode}): ${grpcMessage || 'unknown error'}`,
          code,
          undefined,
          statusCode,
        )
        if (notifyFrame) notifyFrame()
      }
    })

    req.on('end', () => {
      isStreamEnded = true
      client?.close()
      signal?.removeEventListener('abort', onAbort)
      if (notifyFrame) {
        const fn = notifyFrame
        notifyFrame = null
        fn()
      }
    })

    req.on('error', (err) => {
      streamError = err
      client?.close()
      signal?.removeEventListener('abort', onAbort)
      if (notifyFrame) {
        const fn = notifyFrame
        notifyFrame = null
        fn()
      }
    })

    // Write body frame and end request stream
    req.write(body)
    req.end()

    async function* frameGenerator(): AsyncGenerator<Uint8Array, void, unknown> {
      while (true) {
        while (frameQueue.length > 0) {
          yield frameQueue.shift()!
        }
        if (streamError) {
          throw streamError
        }
        if (isStreamEnded) {
          break
        }
        await new Promise<void>((r) => {
          notifyFrame = r
        })
      }
    }

    resolve({
      frames: frameGenerator(),
      getTrailers: () => trailers,
    })
  })
}

export class GeminiAppClient {
  private readonly config: GeminiAppConfig
  private readonly transport: GeminiAppTransport
  private readonly pool?: GeminiAppPoolManager

  constructor(
    config: GeminiAppConfig = {},
    transport: GeminiAppTransport = defaultHttp2Transport,
    pool?: GeminiAppPoolManager,
  ) {
    this.config = config
    this.transport = transport
    this.pool = pool
  }

  private buildGrpcPayload(request: ProcessQueryRequest): Uint8Array {
    const requestFrames = encodeProcessQueryFrames(request).map((frame) => encodeGrpcFrame(frame))
    const totalLen = requestFrames.reduce((sum, f) => sum + f.length, 0)
    const grpcPayload = new Uint8Array(totalLen)
    let offset = 0
    for (const f of requestFrames) {
      grpcPayload.set(f, offset)
      offset += f.length
    }
    return grpcPayload
  }

  private async *executeWithToken(
    token: string,
    endpoint: string,
    grpcPayload: Uint8Array,
    signal?: AbortSignal,
    onFirstEmit?: () => void,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/grpc',
      'grpc-accept-encoding': 'gzip',
      te: 'trailers',
      authorization: `Bearer ${token}`,
      'user-agent': ROBIN_DEFAULT_USER_AGENT,
      'x-goog-api-client': ROBIN_API_CLIENT,
    }

    let transportResult: GeminiAppTransportResult
    try {
      transportResult = await this.transport(endpoint, headers, grpcPayload, signal)
    } catch (err) {
      const isAbort = signal?.aborted
      yield {
        type: 'finish',
        reason: {
          kind: isAbort ? 'aborted' : 'error',
          failure: {
            code: err instanceof GeminiAppError ? err.code : 'CONNECTION_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        },
      }
      return
    }

    yield* parseRobinGrpcFramesToChunks(transportResult.frames, signal, onFirstEmit)
  }

  /**
   * Primary streaming method: executes ProcessQuery gRPC call and streams StreamChunks.
   */
  async *streamProcessQuery(
    request: ProcessQueryRequest,
    signal?: AbortSignal,
    onFirstEmit?: () => void,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const endpoint = this.config.endpoint || ROBIN_DEFAULT_ENDPOINT
    const grpcPayload = this.buildGrpcPayload(request)

    if (this.pool && this.pool.listAccounts().length > 0) {
      const totalAccounts = this.pool.listAccounts().length
      const triedIds = new Set<string>()
      let lastFailure: { code: string; message: string } | null = null

      while (triedIds.size < totalAccounts) {
        const selected = this.pool.selectAccount()
        if (!selected || triedIds.has(selected.id)) {
          break
        }
        triedIds.add(selected.id)

        let account: GeminiAppAccount
        try {
          account = await this.pool.ensureValidToken(selected)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const code = err instanceof GeminiAppError ? err.code : 'AUTH_REQUIRED'
          if (code === 'AUTH_REQUIRED') {
            this.pool.markAuthRequired(selected.id, message)
          } else {
            this.pool.markCooldown(selected.id, message)
          }
          lastFailure = { code, message }
          continue
        }

        let refreshedOnce = false
        while (true) {
          let hasEmittedContent = false
          let retrySameAccount = false
          let switchNextAccount = false

          for await (const chunk of this.executeWithToken(
            account.accessToken,
            endpoint,
            grpcPayload,
            signal,
            onFirstEmit,
          )) {
            if (chunk.type === 'content-block-start' || chunk.type === 'content-block-delta') {
              hasEmittedContent = true
              yield chunk
              continue
            }

            if (chunk.type === 'finish') {
              const reason = (chunk as {
                reason?: { kind?: string; failure?: { message?: string; code?: string } }
              }).reason
              if (reason?.kind === 'stop') {
                this.pool.markSuccess(account.id)
                yield chunk
                return
              }
              if (reason?.kind === 'aborted') {
                yield chunk
                return
              }
              if (reason?.kind === 'error') {
                const code = reason.failure?.code || 'UNKNOWN_ERROR'
                const message = reason.failure?.message || 'Gemini App request failed'

                if (!hasEmittedContent && code === 'RATE_LIMIT') {
                  this.pool.markCooldown(account.id, message)
                  lastFailure = { code, message }
                  switchNextAccount = true
                  break
                }

                if (!hasEmittedContent && code === 'AUTH_REQUIRED') {
                  if (!refreshedOnce && account.masterToken) {
                    refreshedOnce = true
                    try {
                      account = await this.pool.forceRefreshAccount(account.id)
                      retrySameAccount = true
                      break
                    } catch (refreshErr) {
                      const refreshMsg =
                        refreshErr instanceof Error ? refreshErr.message : String(refreshErr)
                      lastFailure = { code: 'AUTH_REQUIRED', message: refreshMsg }
                      switchNextAccount = true
                      break
                    }
                  }
                  this.pool.markAuthRequired(account.id, message)
                  lastFailure = { code, message }
                  switchNextAccount = true
                  break
                }

                yield chunk
                return
              }
            }

            yield chunk
          }

          if (retrySameAccount) {
            continue
          }
          if (switchNextAccount) {
            break
          }
          return
        }
      }

      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: lastFailure ?? {
            code: 'RATE_LIMIT',
            message: 'All Gemini App pool accounts are unavailable (cooldown or auth_required).',
          },
        },
      }
      return
    }

    const token = await resolveGeminiAppToken(this.config)
    if (!token) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'AUTH_REQUIRED',
            message: formatGeminiAppAuthGuidance(),
          },
        },
      }
      return
    }

    yield* this.executeWithToken(token, endpoint, grpcPayload, signal, onFirstEmit)
  }

  /**
   * Non-streaming convenience method: gathers all stream chunks and returns accumulated text.
   */
  async processQuery(
    request: ProcessQueryRequest,
    signal?: AbortSignal,
  ): Promise<{ text: string; response: ProcessQueryResponse }> {
    let accumulatedText = ''
    let lastError: Error | null = null

    for await (const chunk of this.streamProcessQuery(request, signal)) {
      if (chunk.type === 'text-delta') {
        accumulatedText += chunk.text
      } else if (chunk.type === 'finish') {
        const finish = chunk as { reason?: { kind?: string; failure?: { message?: string; code?: string } } }
        if (finish.reason?.kind === 'error') {
          lastError = new GeminiAppError(
            finish.reason.failure?.message || 'Gemini App request failed',
            finish.reason.failure?.code || 'UNKNOWN_ERROR',
          )
        }
      }
    }

    if (lastError) {
      throw lastError
    }

    return {
      text: accumulatedText,
      response: {
        chatHistoryOutput: {
          fullText: accumulatedText,
          deltaText: '',
        },
      },
    }
  }
}
