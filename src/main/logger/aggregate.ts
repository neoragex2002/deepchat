import fs from 'fs'
import path from 'path'
import { LOG_IO } from './config'

function aggDir(): string {
  return path.resolve(process.cwd(), 'logs', 'io')
}

function ensureDir(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
}

export function appendIoAggregate(eventId: string, entry: Record<string, unknown>) {
  if (!LOG_IO) return
  const dir = aggDir()
  ensureDir(dir)
  const file = path.join(dir, `${eventId}.json`)
  let arr: any[] = []
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) arr = parsed
    }
  } catch {
    arr = []
  }
  arr.push(entry)
  try {
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8')
  } catch {}
}
