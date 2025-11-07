import fs from 'fs'
import path from 'path'

export type TraceToolCall = {
  id: string
  name: string
  arguments: string
}

export class LLMTraceWriter {
  private baseDir: string
  private convId?: string
  private eventId: string
  private phaseIndex: number
  private providerId: string
  private modelId: string
  private sseRaw: string[] = []
  private frames: any[] = []
  private reconstructed = {
    role: 'assistant' as const,
    content: '',
    tool_calls: [] as Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>,
    stop_reason: '' as string | undefined,
    usage: undefined as any
  }
  // Cache for this phase
  private cachedRequest: any | null = null
  private plannedToolCalls: Array<{ id: string; name: string; arguments: string }> | undefined
  private errorMessage: string | undefined
  private userStopFlag: boolean | undefined
  private phaseWritten = false

  constructor(opts: {
    baseDir?: string
    conversationId?: string
    eventId: string
    phaseIndex: number
    providerId: string
    modelId: string
  }) {
    // Use 'llm-trace' folder to match project documentation
    this.baseDir = opts.baseDir || path.resolve(process.cwd(), 'logs', 'llm-trace')
    this.convId = opts.conversationId
    this.eventId = opts.eventId
    this.phaseIndex = opts.phaseIndex
    this.providerId = opts.providerId
    this.modelId = opts.modelId
    this.ensureDir()
  }

  private ensureDir() {
    try {
      fs.mkdirSync(this.baseDir, { recursive: true })
    } catch {}
  }

  private aggregateFile(): string {
    return path.join(this.baseDir, `${this.eventId}.json`)
  }

  writeRequest(body: any) {
    // Cache request; actual write occurs when we write the aggregated phase record
    const meta = {
      conversationId: this.convId || null,
      eventId: this.eventId,
      phaseIndex: this.phaseIndex,
      providerId: this.providerId,
      modelId: this.modelId,
      timestamp: Date.now()
    }
    this.cachedRequest = { meta, body }
  }

  addRawSse(line: string) {
    this.sseRaw.push(line)
  }

  addFrame(frame: any) {
    this.frames.push(frame)
  }

  appendTextDelta(text: string) {
    if (!text) return
    this.reconstructed.content += text
  }

  setStopReason(reason?: string) {
    if (reason) this.reconstructed.stop_reason = reason
  }

  addToolCall(id: string, name: string, args: string) {
    // push/replace by id to ensure latest args kept
    const idx = this.reconstructed.tool_calls.findIndex((t) => t.id === id)
    const item = { id, type: 'function' as const, function: { name, arguments: args } }
    if (idx >= 0) this.reconstructed.tool_calls[idx] = item
    else this.reconstructed.tool_calls.push(item)
  }

  setUsage(usage: any) {
    this.reconstructed.usage = usage
  }

  markError(error: unknown) {
    try {
      this.errorMessage = error instanceof Error ? error.message : String(error)
    } catch {
      this.errorMessage = 'Unknown error'
    }
  }

  setUserStop(stopped: boolean) {
    this.userStopFlag = stopped
  }

  setPlannedToolCalls(planned?: Array<{ id: string; name: string; arguments: string }>) {
    this.plannedToolCalls = planned && planned.length > 0 ? planned : undefined
  }

  hasWritten(): boolean {
    return this.phaseWritten
  }

  writeResponse() {
    if (this.phaseWritten) return
    const meta = {
      conversationId: this.convId || null,
      eventId: this.eventId,
      phaseIndex: this.phaseIndex,
      providerId: this.providerId,
      modelId: this.modelId,
      stop: this.reconstructed.stop_reason || null,
      timestamp: Date.now(),
      userStop: this.userStopFlag === true
    }
    const status: 'ok' | 'error' | 'aborted' = this.errorMessage
      ? 'error'
      : this.userStopFlag
        ? 'aborted'
        : 'ok'
    const response: any = { meta, status, reconstructed: this.reconstructed }
    if (this.errorMessage) response.error = this.errorMessage
    if (this.plannedToolCalls) response.planned_tool_calls = this.plannedToolCalls
    if (this.sseRaw.length > 0) response.sseRaw = this.sseRaw
    if (this.frames.length > 0) response.frames = this.frames

    const entry = {
      phaseIndex: this.phaseIndex,
      request: this.cachedRequest || {
        meta: {
          conversationId: this.convId || null,
          eventId: this.eventId,
          phaseIndex: this.phaseIndex,
          providerId: this.providerId,
          modelId: this.modelId,
          timestamp: Date.now()
        },
        body: null
      },
      response
    }

    let arr: any[] = []
    try {
      if (fs.existsSync(this.aggregateFile())) {
        try {
          const raw = fs.readFileSync(this.aggregateFile(), 'utf8')
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) arr = parsed
        } catch {
          arr = []
        }
      }
    } catch {
      arr = []
    }
    arr.push(entry)
    try {
      fs.writeFileSync(this.aggregateFile(), JSON.stringify(arr, null, 2), 'utf8')
      this.phaseWritten = true
    } catch (e) {
      console.error('[LLMTrace] Failed to write aggregated trace log:', e)
      // Keep phaseWritten = false so callers may retry once in a later path (e.g., finally)
    }
  }
}
