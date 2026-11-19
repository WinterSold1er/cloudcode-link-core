// Stream chunk mapper for Google Gemini App (Robin / AGSA) responses.

import type { ContentBlock, StreamChunk, FinishReason } from '../types/protocol.ts'
import {
  RobinStreamingState,
  type ProcessQueryResponse,
} from './types.ts'
import { decodeProcessQueryResponse } from './proto.ts'

interface ActiveBlock {
  index: number
  type: 'text' | 'reasoning'
  text: string
}

export async function* mapRobinResponsesToChunks(
  responses: AsyncIterable<ProcessQueryResponse>,
  signal?: AbortSignal,
  onFirstEmit?: () => void,
): AsyncGenerator<StreamChunk, void, unknown> {
  let blockIndex = 0
  let currentBlock: ActiveBlock | null = null
  let firstChunkEmitted = false
  let accumulatedChars = 0

  const notifyFirstEmit = () => {
    if (!firstChunkEmitted) {
      firstChunkEmitted = true
      if (onFirstEmit) onFirstEmit()
    }
  }

  const closeCurrentBlock = (): StreamChunk | null => {
    if (!currentBlock) return null
    const chunk: StreamChunk = {
      type: 'block-end',
      index: currentBlock.index,
      block: {
        type: currentBlock.type,
        text: currentBlock.text,
      } as ContentBlock,
    }
    currentBlock = null
    return chunk
  }

  try {
    for await (const resp of responses) {
      if (signal?.aborted) {
        const end = closeCurrentBlock()
        if (end) yield end
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: { message: 'Gemini App request was aborted', code: 'ABORTED' },
          },
        }
        return
      }

      // 1. Check for upstream reported errors
      if (resp.error && resp.error.code !== 0) {
        const end = closeCurrentBlock()
        if (end) yield end
        notifyFirstEmit()
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: `ROBIN_ERROR_${resp.error.code}`,
              message: resp.error.message || `Upstream Robin service reported error code ${resp.error.code}`,
            },
          },
        }
        return
      }

      // 2. Chat history output (text and reasoning)
      if (resp.chatHistoryOutput) {
        const { deltaText, thoughtsText, fullText } = resp.chatHistoryOutput

        // Thinking / Reasoning
        if (thoughtsText && thoughtsText.length > 0) {
          notifyFirstEmit()
          if (currentBlock?.type !== 'reasoning') {
            const end = closeCurrentBlock()
            if (end) yield end
            const idx = blockIndex++
            currentBlock = { index: idx, type: 'reasoning', text: '' }
            yield {
              type: 'block-start',
              index: idx,
              blockType: 'reasoning',
            }
          }
          currentBlock.text += thoughtsText
          accumulatedChars += thoughtsText.length
          yield {
            type: 'reasoning-delta',
            index: currentBlock.index,
            text: thoughtsText,
          }
        }

        // Output Text
        let textToEmit = deltaText
        if (!textToEmit && fullText && currentBlock?.type === 'text') {
          if (fullText.length > currentBlock.text.length) {
            textToEmit = fullText.slice(currentBlock.text.length)
          }
        }

        if (textToEmit && textToEmit.length > 0) {
          notifyFirstEmit()
          if (currentBlock?.type !== 'text') {
            const end = closeCurrentBlock()
            if (end) yield end
            const idx = blockIndex++
            currentBlock = { index: idx, type: 'text', text: '' }
            yield {
              type: 'block-start',
              index: idx,
              blockType: 'text',
            }
          }
          currentBlock.text += textToEmit
          accumulatedChars += textToEmit.length
          yield {
            type: 'text-delta',
            index: currentBlock.index,
            text: textToEmit,
          }
        }
      }

      // 3. Streaming state transitions
      if (resp.streamingState === RobinStreamingState.FINISHED) {
        const end = closeCurrentBlock()
        if (end) yield end
        notifyFirstEmit()

        // Yield estimated usage based on tokens
        const estOutputTokens = Math.max(1, Math.ceil(accumulatedChars / 4))
        yield {
          type: 'usage',
          usage: {
            inputTokens: 0,
            outputTokens: estOutputTokens,
          },
        }

        yield {
          type: 'finish',
          reason: { kind: 'stop' },
        }
        return
      }

      if (resp.streamingState === RobinStreamingState.ERROR) {
        const end = closeCurrentBlock()
        if (end) yield end
        notifyFirstEmit()
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'ROBIN_STREAM_ERROR',
              message: 'Gemini App stream encountered an unexpected server error state',
            },
          },
        }
        return
      }
    }

    // Stream ended normally without explicit FINISHED state
    if (signal?.aborted) {
      const end = closeCurrentBlock()
      if (end) yield end
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: { message: 'Gemini App request was aborted', code: 'ABORTED' },
        },
      }
      return
    }

    const end = closeCurrentBlock()
    if (end) yield end
    notifyFirstEmit()
    const estOutputTokens = Math.max(1, Math.ceil(accumulatedChars / 4))
    yield {
      type: 'usage',
      usage: {
        inputTokens: 0,
        outputTokens: estOutputTokens,
      },
    }
    yield {
      type: 'finish',
      reason: { kind: 'stop' },
    }
  } catch (err) {
    const end = closeCurrentBlock()
    if (end) yield end
    notifyFirstEmit()
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'ROBIN_MAPPING_EXCEPTION',
          message: err instanceof Error ? err.message : String(err),
        },
      },
    }
  }
}

/**
 * Parses incoming raw Protobuf frames from gRPC length-prefixed stream and maps them to StreamChunks.
 */
export async function* parseRobinGrpcFramesToChunks(
  frames: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
  onFirstEmit?: () => void,
): AsyncGenerator<StreamChunk, void, unknown> {
  async function* decodeFrames(): AsyncGenerator<ProcessQueryResponse, void, unknown> {
    for await (const frame of frames) {
      if (signal?.aborted) return
      try {
        const decoded = decodeProcessQueryResponse(frame)
        yield decoded
      } catch (err) {
        throw new Error(
          `Failed to decode Gemini App Protobuf frame: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  yield* mapRobinResponsesToChunks(decodeFrames(), signal, onFirstEmit)
}
