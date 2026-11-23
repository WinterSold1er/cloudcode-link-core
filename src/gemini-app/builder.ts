// Request builder for Google Gemini App (Robin / AGSA).

import type { GenerateOptions, Message, ContentBlock, ImageBlock } from '../types/protocol.ts'
import {
  RobinBardMode,
  type ProcessQueryRequest,
  type SessionInput,
  type RobinAttachment,
  type GeminiAppConfig,
} from './types.ts'

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      const txt = typeof block.text === 'string' ? block.text : String(block.text ?? '')
      parts.push(txt)
    } else if (block.type === 'reasoning') {
      // Prior reasoning is context
      const txt = typeof block.text === 'string' ? block.text : String(block.text ?? '')
      parts.push(`[Thinking: ${txt}]`)
    } else if (block.type === 'tool-call' || block.type === 'tool_call') {
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
      parts.push(`[Action: ${block.name ?? 'unknown'}(${args})]`)
    } else if (block.type === 'tool_result' || block.type === 'tool-result') {
      const res = typeof block.result === 'string' ? block.result : JSON.stringify(block.result ?? block.content ?? {})
      parts.push(`[Action Result: ${res}]`)
    }
  }
  return parts.join('\n')
}

function extractAttachmentsFromBlocks(blocks: ContentBlock[]): RobinAttachment[] {
  const attachments: RobinAttachment[] = []
  for (const block of blocks) {
    if (block.type === 'image') {
      const img = block as ImageBlock
      if (img.offloaded) continue
      let data: Uint8Array | undefined
      if (img.data) {
        if (typeof img.data === 'string') {
          const base64Str = img.data.includes(',') ? img.data.split(',')[1] : img.data
          data = new Uint8Array(Buffer.from(base64Str ?? '', 'base64'))
        } else if (img.data instanceof Uint8Array) {
          data = img.data
        } else if (Buffer.isBuffer(img.data)) {
          data = new Uint8Array(img.data)
        }
      }
      if (data && data.length > 0) {
        attachments.push({
          mimeType: img.mimeType || 'image/jpeg',
          data,
          name: img.attachment?.id || `image_${attachments.length + 1}`,
        })
      }
    }
  }
  return attachments
}

export function formatMessagesToPrompt(
  messages: Message[],
  systemPrompt?: string,
): {
  promptText: string
  attachments: RobinAttachment[]
} {
  const allAttachments: RobinAttachment[] = []
  const systemLines: string[] = []
  if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
    systemLines.push(systemPrompt.trim())
  }
  const conversationLines: string[] = []

  for (const msg of messages) {
    let text = ''
    let atts: RobinAttachment[] = []

    if (typeof msg.content === 'string') {
      text = msg.content
    } else if (Array.isArray(msg.content)) {
      text = extractTextFromBlocks(msg.content)
      atts = extractAttachmentsFromBlocks(msg.content)
      allAttachments.push(...atts)
    }

    if (msg.role === 'system' || msg.role === 'developer') {
      if (text.trim()) systemLines.push(text.trim())
    } else if (msg.role === 'user') {
      if (text.trim()) conversationLines.push(`User: ${text.trim()}`)
    } else if (msg.role === 'assistant') {
      if (text.trim()) conversationLines.push(`Model: ${text.trim()}`)
    } else if (msg.role === 'tool') {
      if (text.trim()) conversationLines.push(`Tool Output: ${text.trim()}`)
    }
  }

  // If there's only a single user message without system prompt or prior turns, send it directly
  if (
    systemLines.length === 0 &&
    conversationLines.length === 1 &&
    conversationLines[0]?.startsWith('User: ')
  ) {
    return {
      promptText: conversationLines[0].substring('User: '.length),
      attachments: allAttachments,
    }
  }

  const sections: string[] = []
  if (systemLines.length > 0) {
    sections.push(`[System Instructions]\n${systemLines.join('\n\n')}`)
  }
  if (conversationLines.length > 0) {
    sections.push(conversationLines.join('\n\n'))
  }

  return {
    promptText: sections.join('\n\n'),
    attachments: allAttachments,
  }
}

export function buildProcessQueryRequest(
  options: GenerateOptions,
  config?: GeminiAppConfig,
): ProcessQueryRequest {
  const { promptText, attachments } = formatMessagesToPrompt(options.messages, options.system)

  const sessionInput: SessionInput = {
    textPrompt: promptText,
    ...(attachments.length > 0 ? { attachments } : {}),
  }

  const isAdvanced =
    (options.model && (options.model.includes('advanced') || options.model.includes('pro'))) ||
    false

  return {
    sessionInput,
    deviceContext: {
      deviceModel: config?.deviceModel || 'OnePlus PJZ110',
      agsaVersion: config?.agsaVersion || '15.42.34.28.arm64',
      locale: config?.locale || 'zh-CN',
      timeZone: config?.timeZone || 'Asia/Shanghai',
    },
    modeConfig: {
      modeId: isAdvanced ? RobinBardMode.ADVANCED : RobinBardMode.STANDARD,
      bardModeName: isAdvanced ? 'Advanced' : 'Standard',
    },
  }
}
