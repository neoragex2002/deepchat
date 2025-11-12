import fs from 'fs'
import path from 'path'
import { LOG_AUDIT, LOG_AUDIT_CONSOLE } from './config'

function ensureDir(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
}

function auditDir(): string {
  return path.resolve(process.cwd(), 'logs', 'audit')
}

export function writeAudit(
  eventId: string,
  kind: string,
  action: string,
  extras?: Record<string, unknown>
) {
  if (!LOG_AUDIT) return
  const dir = auditDir()
  ensureDir(dir)
  const record: Record<string, unknown> = {
    ts: Date.now(),
    eventId,
    kind,
    action,
    ...(extras || {})
  }
  try {
    fs.appendFileSync(path.join(dir, `${eventId}.jsonl`), JSON.stringify(record) + '\n', 'utf8')
  } catch {}
  if (LOG_AUDIT_CONSOLE === 'summary') {
    try {
      const kvs: string[] = []
      // Always start with event id
      kvs.push(`ev=${eventId}`)
      const mapKey = (k: string): string => {
        if (k === 'sseqLast') return 'sseq'
        if (k === 'waitedMs') return 'wait'
        if (k === 'durationMs') return 'ms'
        return k
      }
      const toShort = (v: unknown): string => {
        try {
          if (typeof v === 'boolean') return v ? '1' : '0'
          if (typeof v === 'number') return String(v)
          if (typeof v === 'string') {
            return v.length > 60 ? v.slice(0, 60) + '...' : v
          }
          if (Array.isArray(v)) return `[${v.length}]`
          if (v && typeof v === 'object') {
            const anyV = v as Record<string, unknown>
            if (typeof anyV.id === 'string') return `{id:${(anyV.id as string).slice(0, 8)}}`
            if (typeof anyV.name === 'string') return `{name:${(anyV.name as string).slice(0, 16)}}`
            return '{…}'
          }
          if (v === null || v === undefined) return ''
          return String(v)
        } catch {
          return '{…}'
        }
      }
      if (extras) {
        for (const [k, v] of Object.entries(extras)) {
          const key = mapKey(k)
          const val = toShort(v)
          if (val !== '') kvs.push(`${key}=${val}`)
        }
      }
      // eslint-disable-next-line no-console
      console.log(`AUD|${kind}|${action} ${kvs.join(' ')}`)
    } catch {}
  }
}
