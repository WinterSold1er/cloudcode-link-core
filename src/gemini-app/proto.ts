// Zero-dependency pure TypeScript Protobuf Wire Format and gRPC Frame Codec for Gemini App (Robin).

import {
  RobinStreamingState,
  RobinBardMode,
  type ProcessQueryRequest,
  type ProcessQueryResponse,
  type SessionInput,
  type RobinAttachment,
  type UiInteractionInput,
  type DeviceContext,
  type RobinBardModeConfig,
  type ChatHistoryOutput,
  type RobinPunt,
  type RobinError,
} from './types.ts'

export const WIRE_TYPE_VARINT = 0
export const WIRE_TYPE_64BIT = 1
export const WIRE_TYPE_LENGTH_DELIMITED = 2
export const WIRE_TYPE_32BIT = 5

export class ProtobufWriter {
  private chunks: Uint8Array[] = []
  private totalLength = 0

  writeTag(fieldNumber: number, wireType: number): this {
    const tag = (fieldNumber << 3) | (wireType & 0x07)
    this.writeVarint(tag)
    return this
  }

  writeVarint(value: number | bigint): this {
    let v = typeof value === 'number' ? BigInt(Math.floor(value)) : value
    if (v < 0n) {
      // 64-bit two's complement for negative integers
      v = BigInt.asUintN(64, v)
    }
    const bytes: number[] = []
    while (v >= 0x80n) {
      bytes.push(Number((v & 0x7fn) | 0x80n))
      v >>= 7n
    }
    bytes.push(Number(v & 0x7fn))
    const buf = new Uint8Array(bytes)
    this.chunks.push(buf)
    this.totalLength += buf.length
    return this
  }

  writeInt32(fieldNumber: number, value: number): this {
    if (value === 0) return this // Protobuf default
    this.writeTag(fieldNumber, WIRE_TYPE_VARINT)
    this.writeVarint(value)
    return this
  }

  writeInt64(fieldNumber: number, value: number | bigint): this {
    if (value === 0 || value === 0n) return this
    this.writeTag(fieldNumber, WIRE_TYPE_VARINT)
    this.writeVarint(value)
    return this
  }

  writeFixed32(fieldNumber: number, value: number): this {
    this.writeTag(fieldNumber, WIRE_TYPE_32BIT)
    const buf = new Uint8Array(4)
    buf[0] = value & 0xff
    buf[1] = (value >>> 8) & 0xff
    buf[2] = (value >>> 16) & 0xff
    buf[3] = (value >>> 24) & 0xff
    this.chunks.push(buf)
    this.totalLength += 4
    return this
  }

  writeFixed64(fieldNumber: number, value: bigint): this {
    this.writeTag(fieldNumber, WIRE_TYPE_64BIT)
    const buf = new Uint8Array(8)
    let v = value
    for (let i = 0; i < 8; i++) {
      buf[i] = Number(v & 0xffn)
      v >>= 8n
    }
    this.chunks.push(buf)
    this.totalLength += 8
    return this
  }

  writeString(fieldNumber: number, str: string | undefined): this {
    if (!str || str.length === 0) return this
    const encoded = new TextEncoder().encode(str)
    this.writeTag(fieldNumber, WIRE_TYPE_LENGTH_DELIMITED)
    this.writeVarint(encoded.length)
    this.chunks.push(encoded)
    this.totalLength += encoded.length
    return this
  }

  writeBytes(fieldNumber: number, bytes: Uint8Array | undefined): this {
    if (!bytes || bytes.length === 0) return this
    this.writeTag(fieldNumber, WIRE_TYPE_LENGTH_DELIMITED)
    this.writeVarint(bytes.length)
    this.chunks.push(bytes)
    this.totalLength += bytes.length
    return this
  }

  writeMessage(fieldNumber: number, msgBytes: Uint8Array | undefined): this {
    if (!msgBytes || msgBytes.length === 0) return this
    this.writeTag(fieldNumber, WIRE_TYPE_LENGTH_DELIMITED)
    this.writeVarint(msgBytes.length)
    this.chunks.push(msgBytes)
    this.totalLength += msgBytes.length
    return this
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.totalLength)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

export class ProtobufReader {
  private readonly buffer: Uint8Array
  private pos = 0
  private readonly end: number
  private readonly view: DataView

  constructor(buffer: Uint8Array, start = 0, length?: number) {
    this.buffer = buffer
    this.pos = start
    this.end = length !== undefined ? start + length : buffer.length
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }

  isAtEnd(): boolean {
    return this.pos >= this.end
  }

  readTag(): { fieldNumber: number; wireType: number } | null {
    if (this.isAtEnd()) return null
    const tag = Number(this.readVarint())
    const fieldNumber = tag >>> 3
    const wireType = tag & 0x07
    return { fieldNumber, wireType }
  }

  readVarint(): bigint {
    let result = 0n
    let shift = 0n
    while (this.pos < this.end) {
      const byte = this.buffer[this.pos++]
      if (byte === undefined) {
        throw new Error('Unexpected end of buffer while reading varint')
      }
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) {
        return result
      }
      shift += 7n
      if (shift >= 64n) {
        throw new Error('Protobuf varint exceeds 64 bits')
      }
    }
    throw new Error('Unexpected end of buffer while reading varint')
  }

  readInt32(): number {
    const v = Number(this.readVarint())
    return v | 0
  }

  readString(): string {
    const len = Number(this.readVarint())
    if (this.pos + len > this.end) {
      throw new Error(`Protobuf string length ${len} exceeds available bytes (${this.end - this.pos})`)
    }
    const slice = this.buffer.subarray(this.pos, this.pos + len)
    this.pos += len
    return new TextDecoder('utf-8', { fatal: false }).decode(slice)
  }

  readBytes(): Uint8Array {
    const len = Number(this.readVarint())
    if (this.pos + len > this.end) {
      throw new Error(`Protobuf bytes length ${len} exceeds available bytes (${this.end - this.pos})`)
    }
    const slice = this.buffer.subarray(this.pos, this.pos + len)
    this.pos += len
    return new Uint8Array(slice)
  }

  readSubReader(): ProtobufReader {
    const len = Number(this.readVarint())
    if (this.pos + len > this.end) {
      throw new Error(`Protobuf submessage length ${len} exceeds available bytes (${this.end - this.pos})`)
    }
    const reader = new ProtobufReader(this.buffer, this.pos, len)
    this.pos += len
    return reader
  }

  skipField(wireType: number): void {
    switch (wireType) {
      case WIRE_TYPE_VARINT:
        this.readVarint()
        break
      case WIRE_TYPE_64BIT:
        if (this.pos + 8 > this.end) throw new Error('Unexpected EOF reading 64-bit field')
        this.pos += 8
        break
      case WIRE_TYPE_LENGTH_DELIMITED: {
        const len = Number(this.readVarint())
        if (this.pos + len > this.end) throw new Error('Unexpected EOF skipping length-delimited field')
        this.pos += len
        break
      }
      case WIRE_TYPE_32BIT:
        if (this.pos + 4 > this.end) throw new Error('Unexpected EOF reading 32-bit field')
        this.pos += 4
        break
      case 3: // Start group (deprecated in proto3, supported for robustness)
        while (true) {
          const t = this.readTag()
          if (!t || t.wireType === 4) break
          this.skipField(t.wireType)
        }
        break
      case 4: // End group
        break
      default:
        throw new Error(`Unsupported wire type: ${wireType}`)
    }
  }
}

// ---- gRPC Length-Prefixed Frame Encoding / Decoding ----

/**
 * Packs payload into a gRPC length-prefixed frame.
 * Header: 1-byte compression flag (0 = uncompressed) + 4-byte big-endian payload length.
 */
export function encodeGrpcFrame(payload: Uint8Array, compressed = false): Uint8Array {
  const frame = new Uint8Array(5 + payload.length)
  frame[0] = compressed ? 1 : 0
  const len = payload.length
  frame[1] = (len >>> 24) & 0xff
  frame[2] = (len >>> 16) & 0xff
  frame[3] = (len >>> 8) & 0xff
  frame[4] = len & 0xff
  frame.set(payload, 5)
  return frame
}

/**
 * Extracts all complete gRPC length-prefixed frames from buffer.
 * Returns decoded frames and remaining partial buffer.
 */
export function decodeGrpcFrames(buffer: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  const frames: Uint8Array[] = []
  let offset = 0
  while (offset + 5 <= buffer.length) {
    const b0 = buffer[offset]
    const b1 = buffer[offset + 1]
    const b2 = buffer[offset + 2]
    const b3 = buffer[offset + 3]
    const b4 = buffer[offset + 4]
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined || b4 === undefined) {
      break
    }
    const compressed = b0 !== 0
    const len = ((b1 << 24) >>> 0) + (b2 << 16) + (b3 << 8) + b4

    if (offset + 5 + len > buffer.length) {
      // Incomplete frame; wait for more data
      break
    }
    const frameData = buffer.subarray(offset + 5, offset + 5 + len)
    if (compressed) {
      throw new Error('Compressed gRPC frames are not supported in uncompressed mode')
    }
    frames.push(new Uint8Array(frameData))
    offset += 5 + len
  }
  const rest = buffer.subarray(offset)
  return { frames, rest: new Uint8Array(rest) }
}

// ---- Protobuf ProcessQueryRequest Encoders ----

function encodeRobinAttachment(att: RobinAttachment): Uint8Array {
  const writer = new ProtobufWriter()
  writer.writeString(1, att.mimeType)
  writer.writeBytes(2, att.data)
  if (att.name) writer.writeString(3, att.name)
  return writer.toUint8Array()
}

function encodeUiInteraction(ui: UiInteractionInput): Uint8Array {
  const writer = new ProtobufWriter()
  if (ui.eventType) writer.writeString(1, ui.eventType)
  if (ui.interactionContext) writer.writeString(2, ui.interactionContext)
  return writer.toUint8Array()
}

function encodeSessionInput(input: SessionInput): Uint8Array {
  const writer = new ProtobufWriter()
  if (input.textPrompt) {
    writer.writeString(1, input.textPrompt)
  }
  if (input.attachments && input.attachments.length > 0) {
    for (const att of input.attachments) {
      writer.writeMessage(2, encodeRobinAttachment(att))
    }
  }
  if (input.uiInteraction) {
    writer.writeMessage(3, encodeUiInteraction(input.uiInteraction))
  }
  return writer.toUint8Array()
}

function encodeDeviceContext(ctx: DeviceContext): Uint8Array {
  const writer = new ProtobufWriter()
  if (ctx.deviceModel) writer.writeString(1, ctx.deviceModel)
  if (ctx.agsaVersion) writer.writeString(2, ctx.agsaVersion)
  if (ctx.locale) writer.writeString(3, ctx.locale)
  if (ctx.timeZone) writer.writeString(4, ctx.timeZone)
  return writer.toUint8Array()
}

function encodeRobinBardModeConfig(cfg: RobinBardModeConfig): Uint8Array {
  const writer = new ProtobufWriter()
  writer.writeInt32(1, cfg.modeId)
  if (cfg.bardModeName) writer.writeString(2, cfg.bardModeName)
  return writer.toUint8Array()
}

export function encodeProcessQueryRequest(req: ProcessQueryRequest): Uint8Array {
  const writer = new ProtobufWriter()
  if (req.sessionInput) {
    writer.writeMessage(1, encodeSessionInput(req.sessionInput))
  }
  if (req.deviceContext) {
    writer.writeMessage(2, encodeDeviceContext(req.deviceContext))
  }
  if (req.modeConfig) {
    writer.writeMessage(3, encodeRobinBardModeConfig(req.modeConfig))
  }
  return writer.toUint8Array()
}

// ---- Protobuf ProcessQueryResponse Decoders ----

function decodeChatHistoryOutput(reader: ProtobufReader): ChatHistoryOutput {
  const output: ChatHistoryOutput = {}
  while (!reader.isAtEnd()) {
    const tag = reader.readTag()
    if (!tag) break
    switch (tag.fieldNumber) {
      case 1:
        output.deltaText = reader.readString()
        break
      case 2:
        output.fullText = reader.readString()
        break
      case 3:
        output.candidateId = reader.readString()
        break
      case 4:
        output.thoughtsText = reader.readString()
        break
      default:
        reader.skipField(tag.wireType)
        break
    }
  }
  return output
}

function decodeRobinPunt(reader: ProtobufReader): RobinPunt {
  const punt: RobinPunt = {}
  while (!reader.isAtEnd()) {
    const tag = reader.readTag()
    if (!tag) break
    switch (tag.fieldNumber) {
      case 1:
        punt.actionType = reader.readString()
        break
      case 2:
        punt.payload = reader.readString()
        break
      default:
        reader.skipField(tag.wireType)
        break
    }
  }
  return punt
}

function decodeRobinError(reader: ProtobufReader): RobinError {
  let code = 0
  let message = ''
  while (!reader.isAtEnd()) {
    const tag = reader.readTag()
    if (!tag) break
    switch (tag.fieldNumber) {
      case 1:
        code = reader.readInt32()
        break
      case 2:
        message = reader.readString()
        break
      default:
        reader.skipField(tag.wireType)
        break
    }
  }
  return { code, message }
}

export function decodeProcessQueryResponse(data: Uint8Array): ProcessQueryResponse {
  const reader = new ProtobufReader(data)
  const resp: ProcessQueryResponse = {}

  while (!reader.isAtEnd()) {
    const tag = reader.readTag()
    if (!tag) break
    switch (tag.fieldNumber) {
      case 1:
        resp.chatHistoryOutput = decodeChatHistoryOutput(reader.readSubReader())
        break
      case 2:
        resp.streamingState = reader.readInt32() as RobinStreamingState
        break
      case 3:
        resp.punt = decodeRobinPunt(reader.readSubReader())
        break
      case 4:
        resp.error = decodeRobinError(reader.readSubReader())
        break
      default:
        reader.skipField(tag.wireType)
        break
    }
  }
  return resp
}
