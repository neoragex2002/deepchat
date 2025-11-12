import fs from 'fs'
import path from 'path'
import { LOG_IO, LOG_IO_DETAIL } from './config'

function ensureDir(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
}

function detailDir(): string {
  return path.resolve(process.cwd(), 'logs', 'io-detail')
}

export function writeIODetail(eventId: string, type: string, payload?: Record<string, unknown>) {
  if (!LOG_IO || !LOG_IO_DETAIL) return
  const dir = detailDir()
  ensureDir(dir)
  const record: Record<string, unknown> = {
    ts: Date.now(),
    eventId,
    type,
    ...(payload || {})
  }
  try {
    fs.appendFileSync(path.join(dir, `${eventId}.jsonl`), JSON.stringify(record) + '\n', 'utf8')
  } catch {}
}
