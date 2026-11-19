// HTTP/2 gRPC client for Google Gemini App (Robin / AGSA) service.

import http2 from 'node:http2'
import type { StreamChunk } from '../types/protocol.ts'
import {
  ROBIN_DEFAULT_ENDPOINT,
  ROBIN_FALLBACK_ENDPOINT,
  ROBIN_PROCESS_QUERY_METHOD,
  ROBIN_DEFAULT_USER_AGENT,
  ROBIN_API_CLIENT,
  type GeminiAppConfig,
  type ProcessQueryRequest,
  type ProcessQueryResponse,
} from './types.ts'
import {
  encodeProcessQueryRequest,
  decodeProcessQueryResponse,
  encodeGrpcFrame,
  decodeGrpcFrames,
} from './proto.ts'
import { parseRobinGrpcFramesToChunks } from './stream-mapper.ts'
import { resolveGeminiAppToken, formatGeminiAppAuthGuidance } from './auth.ts'

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

export class GeminiAppError extends Error {
  public readonly code: string
  public readonly httpStatus?: number
  public readonly grpcStatus?: number

  constructor(
    message: string,
    code: string,
    httpStatus?: number,
    grpcStatus?: number,
  ) {
    super(message)
    this.name = 'GeminiAppError'
    this.code = code
    this.httpStatus = httpStatus
    this.grpcStatus = grpcStatus
  }
}

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

  constructor(config: GeminiAppConfig = {}, transport: GeminiAppTransport = defaultHttp2Transport) {
    this.config = config
    this.transport = transport
  }

  /**
   * Primary streaming method: executes ProcessQuery gRPC call and streams StreamChunks.
   */
  async *streamProcessQuery(
    request: ProcessQueryRequest,
    signal?: AbortSignal,
    onFirstEmit?: () => void,
  ): AsyncGenerator<StreamChunk, void, unknown> {
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

    const endpoint = this.config.endpoint || ROBIN_DEFAULT_ENDPOINT
    const requestProto = encodeProcessQueryRequest(request)
    const grpcFrame = encodeGrpcFrame(requestProto)

    const headers: Record<string, string> = {
      'content-type': 'application/grpc',
      te: 'trailers',
      authorization: `Bearer ${token}`,
      'user-agent': ROBIN_DEFAULT_USER_AGENT,
      'x-goog-api-client': ROBIN_API_CLIENT,
    }

    let transportResult: GeminiAppTransportResult
    try {
      transportResult = await this.transport(endpoint, headers, grpcFrame, signal)
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
