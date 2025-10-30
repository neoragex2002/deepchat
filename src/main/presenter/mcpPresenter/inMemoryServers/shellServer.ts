import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Schema for the shell tool, aligned with shell_v3 design
const ShellArgsSchema = z.object({
  command: z.array(z.string()).min(1, 'command argv is required'),
  workdir: z.string().min(1, 'workdir is required and must not be empty'),
  timeout_ms: z.number().int().positive().optional().default(10_000),
  with_escalated_permissions: z.boolean().optional().default(false),
  justification: z.string().optional(),
  stream: z.boolean().optional().default(false)
})

// Note: we rely on Zod validation; inferred type is not used directly

// Default model-friendly formatting budgets (can be overridden via env)
const DEFAULT_MAX_BYTES = 10 * 1024 // 10 KiB
const DEFAULT_MAX_LINES = 256

interface Budgets {
  maxBytes: number
  maxLines: number
  headLines: number // tailLines = maxLines - headLines
}

// Helper: minimal/env whitelist similar to Codex Core policy
function buildMinimalEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Allow core variables; include Windows specifics (case-insensitive)
  const allowUpper = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SHELL',
    'USER',
    'USERNAME',
    // Windows common envs
    'PATH', // cover 'Path'
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC'
  ])
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(source)) {
    if (!v) continue
    const upper = k.toUpperCase()
    // Default excludes: *KEY*, *SECRET*, *TOKEN*
    if (upper.includes('KEY') || upper.includes('SECRET') || upper.includes('TOKEN')) continue
    if (allowUpper.has(upper)) out[k] = v
  }
  return out
}

// Helper: ensure we cut at a UTF-8 character boundary when slicing by bytes
function takeUtf8Prefix(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, 'utf8')
  if (buf.length <= maxBytes) return input
  let end = Math.max(0, Math.min(maxBytes, buf.length))
  // backtrack to char boundary: ensure last included byte is not a continuation (10xxxxxx)
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end--
  return buf.toString('utf8', 0, end)
}

function takeUtf8Suffix(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, 'utf8')
  if (buf.length <= maxBytes) return input
  let start = Math.max(0, buf.length - maxBytes)
  // advance to char boundary
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.toString('utf8', start)
}

function formatAggregatedOutput(
  body: string,
  budgets: Budgets
): { text: string; truncated: boolean; lineCount: number } {
  const { maxBytes, maxLines, headLines } = budgets
  const lines = body.split('\n')
  const totalLines = lines.length
  let truncated = false

  if (totalLines > maxLines) {
    const headTake = headLines
    const tailTake = Math.max(0, maxLines - headTake)
    const head = lines.slice(0, headTake).join('\n')
    const tail = lines.slice(totalLines - tailTake).join('\n')
    const omitted = totalLines - headTake - tailTake
    const marker = `\n[... omitted ${omitted} of ${totalLines} lines ...]\n\n`

    // 保证 marker 一定完整输出：为 marker 预留字节，再在剩余字节中平均分配给 head/tail
    const markerBytes = Buffer.byteLength(marker, 'utf8')
    if (markerBytes >= maxBytes) {
      // 预算极小的极端情形：只能返回被截断的 marker 本身
      return { text: takeUtf8Prefix(marker, maxBytes), truncated: true, lineCount: totalLines }
    }
    const budgetForContent = Math.max(0, maxBytes - markerBytes)
    const headBudget = Math.floor(budgetForContent / 2)
    const tailBudget = budgetForContent - headBudget
    const headPart = takeUtf8Prefix(head, headBudget)
    const tailPart = takeUtf8Suffix(tail, tailBudget)
    const result = headPart + marker + tailPart
    truncated = true
    return { text: result, truncated, lineCount: totalLines }
  }

  // Within line budget, enforce byte cap
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    // 同样保证 marker 完整：预留 marker 字节后再分配 head/tail
    const marker = '\n[... omitted due to size ...]\n\n'
    const markerBytes = Buffer.byteLength(marker, 'utf8')
    if (markerBytes >= maxBytes) {
      return { text: takeUtf8Prefix(marker, maxBytes), truncated: true, lineCount: totalLines }
    }
    const budgetForContent = Math.max(0, maxBytes - markerBytes)
    const headBytes = Math.floor(budgetForContent / 2)
    const tailBytes = budgetForContent - headBytes
    const head = takeUtf8Prefix(body, headBytes)
    const tail = takeUtf8Suffix(body, tailBytes)
    const combined = head + marker + tail
    truncated = true
    return { text: combined, truncated, lineCount: totalLines }
  }

  return { text: body, truncated: false, lineCount: totalLines }
}

// Robust path-inside check (handles symlinks via realpath pre-processing by caller)
function isPathInside(root: string, target: string): boolean {
  try {
    const rDomain = classifyPathDomain(root)
    const tDomain = classifyPathDomain(target)
    if (rDomain === 'posix' && tDomain === 'posix') {
      const rel = path.posix.relative(root, target)
      return rel === '' || (!rel.startsWith('..') && !path.posix.isAbsolute(rel))
    }
    const rel = path.relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  } catch {
    return false
  }
}

export class ShellServer {
  private server: Server
  // Simple approval policy toggle; v1: deny escalations unless on-request is explicitly enabled via env
  private approvalPolicy: 'never' | 'on-request' = 'never'
  private allowedDirs: string[] = []
  private budgets: Budgets
  private capabilities: {
    has_wsl: boolean
    has_powershell: boolean
    has_cmd: boolean
    has_bash: boolean
  } = { has_wsl: false, has_powershell: false, has_cmd: false, has_bash: false }
  private platformMode: 'windows' | 'wsl' | 'posix' = 'posix'

  constructor(env?: Record<string, unknown>) {
    if (
      env &&
      (env['APPROVAL_POLICY'] === 'on-request' || env['approvalPolicy'] === 'on-request')
    ) {
      this.approvalPolicy = 'on-request'
    }

    // Configurable budgets via env
    const maxBytes = parseInt(String(env?.['SHELL_MAX_BYTES'] ?? ''), 10)
    const maxLines = parseInt(String(env?.['SHELL_MAX_LINES'] ?? ''), 10)
    const headLines = parseInt(String(env?.['SHELL_HEAD_LINES'] ?? ''), 10)
    const mb = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES
    const ml = Number.isFinite(maxLines) && maxLines > 0 ? maxLines : DEFAULT_MAX_LINES
    const hlRaw =
      Number.isFinite(headLines) && headLines >= 0 && headLines <= ml
        ? headLines
        : Math.floor(ml / 2)
    this.budgets = { maxBytes: mb, maxLines: ml, headLines: hlRaw }

    // Allowed CWD roots (whitelist). Accept JSON array string or PATH-like string.
    const allowedRaw = env?.['SHELL_ALLOWED_DIRS'] as unknown
    let dirs: string[] = []
    if (Array.isArray(allowedRaw)) {
      dirs = allowedRaw.map((s) => String(s))
    } else if (typeof allowedRaw === 'string' && allowedRaw) {
      try {
        const parsed = JSON.parse(allowedRaw)
        if (Array.isArray(parsed)) dirs = parsed.map(String)
        else {
          const sep = process.platform === 'win32' ? ';' : ':'
          dirs = allowedRaw
            .split(sep)
            .map((s) => s.trim())
            .filter(Boolean)
        }
      } catch {
        const sep = process.platform === 'win32' ? ';' : ':'
        dirs = allowedRaw
          .split(sep)
          .map((s) => s.trim())
          .filter(Boolean)
      }
    }
    if (dirs.length === 0) {
      dirs = [process.cwd()]
    }
    // Normalize to real paths when possible, while preserving POSIX style for POSIX entries
    this.allowedDirs = dirs.map((p) => {
      try {
        const real = fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p)
        // Preserve slash style according to domain
        return classifyPathDomain(real) === 'posix'
          ? path.posix.normalize(real)
          : path.normalize(real)
      } catch {
        try {
          // 提示：允许目录未能解析为真实路径（可能不存在或无权限）。
          console.warn(`[shell-server] allowed root not resolved via realpath: ${p}`)
        } catch {}
        // If POSIX-style path was provided (e.g. /mnt/c/...), keep POSIX style on Windows
        if (classifyPathDomain(p) === 'posix') {
          return path.posix.normalize(p)
        }
        // Otherwise, fall back to normalized absolute path
        return path.normalize(path.resolve(p))
      }
    })

    // Determine platform capabilities
    this.capabilities = detectCapabilities()

    // Classify allowed roots by domain; actual filtering is enforced by platform mode below
    // Classify domains if needed later (currently filtered by platform mode)

    // Enforce explicit platform mode if provided via env SHELL_PLATFORM
    const pmRaw = String(env?.['SHELL_PLATFORM'] ?? '').toLowerCase()
    if (pmRaw === 'windows' || pmRaw === 'wsl' || pmRaw === 'posix') {
      this.platformMode = pmRaw
    } else {
      const host = detectPlatform()
      this.platformMode = host.os === 'windows' ? 'windows' : 'posix'
    }
    // Filter allowed roots to match platform mode domain strictly
    {
      // Filter by domain based on execution mode
      const currentDomains = this.allowedDirs.map(classifyPathDomain)
      if (this.platformMode === 'windows') {
        this.allowedDirs = this.allowedDirs.filter((_, i) => currentDomains[i] === 'windows')
      } else {
        // posix or wsl
        this.allowedDirs = this.allowedDirs.filter((_, i) => currentDomains[i] === 'posix')
      }
      // filtered counts removed from external API; internal stats not tracked
    }

    this.server = new Server(
      { name: 'deepchat-inmemory/shell-server', version: '0.1.0' },
      { capabilities: { tools: {} } }
    )
    this.setupHandlers()
  }

  public startServer(transport: Transport) {
    this.server.connect(transport)
  }

  private setupHandlers() {
    // tools/list
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const caps = {
        max_bytes: this.budgets.maxBytes,
        max_lines: this.budgets.maxLines,
        head_lines: this.budgets.headLines,
        default_timeout_ms: 10_000,
        allowed_roots_count: this.allowedDirs.length
      }
      const plat = detectPlatform()
      const sampleRoots = this.allowedDirs.slice(0, 5)
      const rootsLine = sampleRoots.length
        ? `Allowed roots (sample ${sampleRoots.length}/${this.allowedDirs.length}): ${sampleRoots.join(' | ')}`
        : `Allowed roots: (default) app cwd only`
      const shells = this.capabilities
      const reqStyle = this.platformMode === 'windows' ? 'windows' : 'posix'
      const guidance =
        `Output limits: max_bytes=${caps.max_bytes}, max_lines=${caps.max_lines}, head_lines=${caps.head_lines}. ` +
        `For large output, split into chunks (e.g. sed -n start,endp file, or tail -n +N | head -n K).` +
        ` Use stream=true for realtime output if needed. ` +
        `Host: os=${plat.os}, wsl_available=${shells.has_wsl}. Run mode=${this.platformMode}. Required path style=${reqStyle}. ` +
        `Runtimes: powershell=${shells.has_powershell}, cmd=${shells.has_cmd}, wsl=${shells.has_wsl}. ${rootsLine}. ` +
        `workdir is REQUIRED on every call and must be inside an allowed root with the required path style. Do not mix POSIX and Windows path styles. ` +
        (process.platform === 'win32'
          ? this.platformMode === 'wsl'
            ? `On Windows run mode 'wsl': use ['wsl','bash','-lc', ...] for Linux commands and POSIX paths (e.g. /mnt/c/...). `
            : `On Windows run mode 'windows': WSL commands are only available if the server is started with SHELL_PLATFORM=wsl. In the current 'windows' mode, only Windows-native commands are allowed (PowerShell/CMD). For CMD built-ins (dir/del/ren/etc) use ['cmd','/c','<command> ...']. `
          : `On Linux/macOS: prefer ['/bin/bash','-lc', ...] for shell features.`) +
        ` Call 'shell_info' and cache its immutable result for precise planning.`
      return {
        tools: [
          {
            name: 'shell',
            description:
              'Execute local commands via argv. workdir is REQUIRED and must be inside an allowed root. Use ["/bin/bash","-lc",...] for shell features. ' +
              guidance,
            inputSchema: zodToJsonSchema(ShellArgsSchema)
          },
          {
            name: 'shell_info',
            description:
              'Return configuration for planning: execution_mode, host, available_runtimes, required_path_style, limits, allowed_roots, current_workdir_host.',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      }
    })

    // tools/call
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params
      if (name === 'shell_info') {
        const plat = detectPlatform()
        const required_path_style = this.platformMode === 'windows' ? 'windows' : 'posix'
        const info = {
          execution_mode: this.platformMode, // windows | wsl | posix
          host: { os: plat.os, has_wsl: this.capabilities.has_wsl },
          available_runtimes: {
            powershell: this.capabilities.has_powershell,
            cmd: this.capabilities.has_cmd,
            wsl: this.capabilities.has_wsl
          },
          required_path_style, // windows | posix
          limits: {
            max_bytes: this.budgets.maxBytes,
            max_lines: this.budgets.maxLines,
            head_lines: this.budgets.headLines,
            default_timeout_ms: 10_000
          },
          allowed_roots: this.allowedDirs,
          current_workdir_host: process.cwd()
        }
        const text = JSON.stringify(info)
        return {
          content: [{ type: 'text', text }],
          structured_content: {
            exit_code: 0,
            duration_seconds: 0,
            timed_out: false,
            line_count: 1,
            truncated: false
          },
          is_error: false,
          isError: false
        }
      }
      if (name !== 'shell') {
        throw new Error(`Unsupported tool: ${name}`)
      }
      const parsed = ShellArgsSchema.safeParse(rawArgs)
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error}`)
      }
      const args = parsed.data

      // Approval logic: deny escalations unless policy is on-request (v1: immediate deny; future: pop UI)
      if (args.with_escalated_permissions && this.approvalPolicy !== 'on-request') {
        return {
          content: [
            {
              type: 'text',
              text: `approval policy is ${this.approvalPolicy}; reject command — do not request escalated permissions under this policy.`
            }
          ],
          structured_content: {
            exit_code: 1,
            duration_seconds: 0,
            timed_out: false,
            line_count: 0,
            truncated: false
          },
          is_error: true
        }
      }

      // workdir 由 Zod Schema 强制必填，无需手动重复校验

      // Resolve and validate CWD (host) when not in WSL mode
      const requestedCwd = args.workdir
      let cwd = path.resolve(requestedCwd)
      try {
        if (this.platformMode !== 'wsl') {
          cwd = fs.realpathSync.native ? fs.realpathSync.native(cwd) : fs.realpathSync(cwd)
        } else {
          // In wsl mode, do not attempt to realpath() POSIX workdir on Windows host.
          // Host cwd will remain process.cwd(); POSIX workdir is enforced separately.
          cwd = process.cwd()
        }
      } catch {
        // If path does not exist, validate its parent directory
        const parent = path.dirname(cwd)
        try {
          const realParent = fs.realpathSync.native
            ? fs.realpathSync.native(parent)
            : fs.realpathSync(parent)
          const ok = this.allowedDirs.some((root) => isPathInside(root, realParent))
          if (!ok) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Access denied: parent directory outside allowed roots. requested=${requestedCwd}`
                }
              ],
              structured_content: {
                exit_code: 1,
                duration_seconds: 0,
                timed_out: false,
                line_count: 0,
                truncated: false
              },
              is_error: true
            }
          }
        } catch {
          return {
            content: [
              { type: 'text', text: `Access denied: invalid working directory ${requestedCwd}` }
            ],
            structured_content: {
              exit_code: 1,
              duration_seconds: 0,
              timed_out: false,
              line_count: 0,
              truncated: false
            },
            is_error: true
          }
        }
      }
      // Validate workdir based on execution_mode rules.
      if (this.platformMode === 'wsl') {
        // Require POSIX style and enforce allowed roots.
        if (args.workdir) {
          const wd = args.workdir
          const wdDomain = classifyPathDomain(wd)
          if (wdDomain !== 'posix') {
            return {
              content: [
                {
                  type: 'text',
                  text: `Access denied: workdir must be POSIX path in execution_mode=wsl (e.g. /mnt/c/...)`
                }
              ],
              structured_content: {
                exit_code: 1,
                duration_seconds: 0,
                timed_out: false,
                line_count: 0,
                truncated: false
              },
              is_error: true
            }
          }
          const allowedWsl = this.allowedDirs.some((root) => isPathInside(root, wd))
          if (!allowedWsl) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Access denied: workdir outside allowed roots (execution_mode=wsl). workdir=${wd}`
                }
              ],
              structured_content: {
                exit_code: 1,
                duration_seconds: 0,
                timed_out: false,
                line_count: 0,
                truncated: false
              },
              is_error: true
            }
          }
        }
        // Do not enforce host cwd domain/containment for WSL mode.
      } else {
        // For windows/posix modes, enforce host cwd domain and allowed roots containment.
        const cwdDomain = classifyPathDomain(cwd)
        const mustDomain = this.platformMode === 'windows' ? 'windows' : 'posix'
        if (cwdDomain !== mustDomain) {
          return {
            content: [
              {
                type: 'text',
                text: `Access denied: host working directory must be ${mustDomain} style in execution_mode=${this.platformMode}`
              }
            ],
            structured_content: {
              exit_code: 1,
              duration_seconds: 0,
              timed_out: false,
              line_count: 0,
              truncated: false
            },
            is_error: true
          }
        }
        const allowed = this.allowedDirs.some((root) => isPathInside(root, cwd))
        if (!allowed) {
          return {
            content: [
              { type: 'text', text: `Access denied: workdir outside allowed roots. cwd=${cwd}` }
            ],
            structured_content: {
              exit_code: 1,
              duration_seconds: 0,
              timed_out: false,
              line_count: 0,
              truncated: false
            },
            is_error: true
          }
        }
      }
      const env = buildMinimalEnv(process.env)

      const start = Date.now()
      let timedOut = false
      let exitCode: number | null = null
      let spawnError: Error | null = null

      // Enforce platform mode on command wrapper
      const firstArg = (args.command[0] || '').toLowerCase()
      if (this.platformMode === 'windows') {
        if (firstArg === 'wsl' || firstArg === 'bash' || firstArg === '/bin/bash') {
          return {
            content: [
              {
                type: 'text',
                text: `Command not allowed in platform mode ${this.platformMode}. Use PowerShell or CMD wrappers instead.`
              }
            ],
            structured_content: {
              exit_code: 1,
              duration_seconds: 0,
              timed_out: false,
              line_count: 0,
              truncated: false
            },
            is_error: true
          }
        }
      } else if (this.platformMode === 'wsl') {
        if (firstArg !== 'wsl') {
          return {
            content: [
              {
                type: 'text',
                text: `Command must start with 'wsl' in platform mode ${this.platformMode}.`
              }
            ],
            structured_content: {
              exit_code: 1,
              duration_seconds: 0,
              timed_out: false,
              line_count: 0,
              truncated: false
            },
            is_error: true
          }
        }
        // 在 WSL 模式下，始终确保通过 bash -lc 并注入 POSIX workdir
        const wd = args.workdir
        const wdEsc = wd.replace(/'/g, `'"'"'`)
        const isBashLc = args.command[1]?.toLowerCase() === 'bash' && args.command[2] === '-lc'
        if (isBashLc && typeof args.command[3] === 'string') {
          // 已是 bash -lc，直接在脚本前注入 cd 守卫
          args.command[3] = `cd -- '${wdEsc}' || { echo 'ERROR: workdir not found or not accessible: ${wd}'; exit 2; }; ${args.command[3]}`
        } else {
          // 不是 bash -lc，则尝试包装。但如果存在 WSL 选项（如 -d/-u/--cd 等），为避免语义改变，直接提示使用 bash -lc。
          const rest = args.command.slice(1)
          if (rest.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Invalid command: 'wsl' requires a subcommand. In execution_mode=wsl, prefer ['wsl','bash','-lc', '<script>'].`
                }
              ],
              structured_content: {
                exit_code: 1,
                duration_seconds: 0,
                timed_out: false,
                line_count: 0,
                truncated: false
              },
              is_error: true
            }
          }
          const hasWslFlags = rest.some((t) => t.startsWith('-'))
          if (hasWslFlags) {
            return {
              content: [
                {
                  type: 'text',
                  text: `In execution_mode=wsl, when using WSL options (e.g. -d/-u/--cd), please format as ['wsl','bash','-lc', '<script>'] so workdir can be enforced.`
                }
              ],
              structured_content: {
                exit_code: 1,
                duration_seconds: 0,
                timed_out: false,
                line_count: 0,
                truncated: false
              },
              is_error: true
            }
          }
          // 安全包装：将原始子命令拼成脚本
          const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`
          const cmdStr = rest.map(quote).join(' ')
          const script = `cd -- '${wdEsc}' || { echo 'ERROR: workdir not found or not accessible: ${wd}'; exit 2; }; ${cmdStr}`
          args.command = ['wsl', 'bash', '-lc', script]
        }
      } else if (this.platformMode === 'posix') {
        if (firstArg === 'wsl') {
          return {
            content: [
              {
                type: 'text',
                text: `Command 'wsl' is not allowed in platform mode ${this.platformMode}.`
              }
            ],
            structured_content: {
              exit_code: 1,
              duration_seconds: 0,
              timed_out: false,
              line_count: 0,
              truncated: false
            },
            is_error: true
          }
        }
      }

      // Choose spawn CWD based on execution mode
      const spawnCwd = this.platformMode === 'wsl' ? process.cwd() : cwd
      const child = spawn(args.command[0], args.command.slice(1), {
        cwd: spawnCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })

      const aggregated: Buffer[] = []

      const onStdout = (chunk: Buffer) => {
        aggregated.push(Buffer.from(chunk))
        if (args.stream) {
          try {
            // Optional stream notifications; ignore errors if client not listening
            // @ts-ignore - notification signature is dynamic
            this.server.notification({
              method: 'logging/message',
              params: { level: 'info', message: chunk.toString('utf8'), data: { stream: 'stdout' } }
            })
          } catch {}
        }
      }
      const onStderr = (chunk: Buffer) => {
        aggregated.push(Buffer.from(chunk))
        if (args.stream) {
          try {
            // @ts-ignore
            this.server.notification({
              method: 'logging/message',
              params: { level: 'info', message: chunk.toString('utf8'), data: { stream: 'stderr' } }
            })
          } catch {}
        }
      }

      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)

      const timeout = setTimeout(() => {
        if (!child.killed) {
          timedOut = true
          try {
            // Use default kill for cross-platform compatibility (Windows signals are limited)
            child.kill()
          } catch {}
        }
      }, args.timeout_ms)

      exitCode = await new Promise<number>((resolve) => {
        child.on('error', (err) => {
          spawnError = err instanceof Error ? err : new Error(String(err))
          try {
            const msg = (spawnError as Error).message || String(spawnError)
            aggregated.push(Buffer.from(`spawn error: ${msg}\n`))
          } catch {}
          resolve(127)
        })
        child.on('close', (code, signal) => {
          if (timedOut) return resolve(124) // conventional timeout code
          if (typeof code === 'number') return resolve(code)
          if (signal) {
            // 128 + signal (best-effort)
            return resolve(128)
          }
          resolve(1)
        })
      })

      clearTimeout(timeout)

      const durationSeconds = (Date.now() - start) / 1000
      if (timedOut) {
        try {
          aggregated.push(Buffer.from(`process timed out after ${args.timeout_ms} ms\n`))
        } catch {}
      }

      let textRaw = Buffer.concat(aggregated).toString('utf8')
      // If spawn failed due to command not found and platform suggests a more suitable wrapper, append guidance.
      if (spawnError && /ENOENT|not found/i.test((spawnError as Error).message || '')) {
        const plat = detectPlatform()
        if (plat.os === 'windows' && !plat.wsl) {
          const first = args.command[0].toLowerCase()
          if (first === 'bash' || first === '/bin/bash') {
            textRaw += `hint: On native Windows, bash is typically unavailable. Consider using ['wsl','bash','-lc', ...] or PowerShell.\n`
          }
          const CMD_BUILTINS = [
            'dir',
            'copy',
            'del',
            'erase',
            'type',
            'echo',
            'set',
            'cd',
            'cls',
            'move',
            'ren',
            'rename',
            'start',
            'call',
            'for',
            'if',
            'mkdir',
            'rmdir',
            'pause',
            'exit'
          ]
          if (CMD_BUILTINS.includes(first)) {
            const original = args.command.map((s) => (/\s/.test(s) ? `"${s}"` : s)).join(' ')
            textRaw += `hint: '${first}' is a CMD built-in. Wrap with ['cmd','/c', ${JSON.stringify(original)}].\n`
          }
        }
        if ((plat.os === 'linux' || plat.wsl) && args.command[0].toLowerCase() === 'powershell') {
          textRaw += `hint: PowerShell may not be installed on this Linux environment. Ensure 'powershell' exists or use ['/bin/bash','-lc', ...].\n`
        }
      }
      if (!textRaw) {
        // Provide a helpful summary when no stdout/stderr were captured
        const summaryParts = [] as string[]
        if (spawnError)
          summaryParts.push(`spawn error: ${(spawnError as Error).message || String(spawnError)}`)
        if (!spawnError && exitCode !== null) summaryParts.push(`exit code: ${exitCode}`)
        if (summaryParts.length === 0) summaryParts.push('no output captured')
        textRaw = summaryParts.join('\n') + '\n'
      }
      const { truncated, lineCount } = formatAggregatedOutput(textRaw, this.budgets)
      // 根据是否错误态决定首行文案：
      // 错误态使用 “Command failed. exit=X timed_out=Y duration=Zs” + 下一行统计
      // 成功态仅展示统计行。
      const isError = timedOut || (exitCode ?? 1) !== 0
      const failurePrefix = `Command failed. exit=${exitCode ?? 1} timed_out=${timedOut ? 'true' : 'false'} duration=${typeof durationSeconds === 'number' ? durationSeconds.toFixed(3) : String(durationSeconds)}s\n`
      const header = (isError ? failurePrefix : '') + `Total output lines: ${lineCount}\n\n`
      // 为避免“整体再截断”破坏 body 内部的省略标记，
      // 先为 header 预留字节，再用剩余字节预算对 body 调整截断。
      const headerBytes = Buffer.byteLength(header, 'utf8')
      let text: string
      let truncatedFinal = truncated
      if (headerBytes >= this.budgets.maxBytes) {
        // 极端场景：header 已超出预算，只返回 header 的安全前缀
        text = takeUtf8Prefix(header, this.budgets.maxBytes)
        truncatedFinal = true
      } else {
        const bodyBudget = this.budgets.maxBytes - headerBytes
        // 重新按照剩余字节预算对 body 进行智能截断，保持省略标记的完整性
        const adjusted = formatAggregatedOutput(textRaw, {
          maxBytes: bodyBudget,
          maxLines: this.budgets.maxLines,
          headLines: this.budgets.headLines
        })
        text = header + adjusted.text
        truncatedFinal = truncated || adjusted.truncated
      }

      const plat = detectPlatform()
      return {
        content: [{ type: 'text', text }],
        structured_content: {
          exit_code: exitCode ?? 1,
          duration_seconds: durationSeconds,
          timed_out: timedOut,
          line_count: lineCount,
          truncated: truncatedFinal,
          budgets: this.budgets,
          platform: { os: plat.os, wsl: plat.wsl },
          effective_arguments: {
            command: args.command,
            workdir: args.workdir,
            timeout_ms: args.timeout_ms,
            with_escalated_permissions: args.with_escalated_permissions,
            stream: args.stream
          }
        },
        is_error: isError,
        // For clients expecting camelCase
        isError
      }
    })
  }
}

function detectPlatform(): { os: 'windows' | 'linux' | 'mac'; wsl: boolean } {
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'
  const rel = os.release().toLowerCase()
  const env = process.env
  const isWSL =
    isLinux && (rel.includes('microsoft') || 'WSL_INTEROP' in env || 'WSL_DISTRO_NAME' in env)
  return { os: isWin ? 'windows' : isMac ? 'mac' : 'linux', wsl: isWSL }
}

function detectCapabilities(): {
  has_wsl: boolean
  has_powershell: boolean
  has_cmd: boolean
  has_bash: boolean
} {
  const plat = detectPlatform()
  const isWin = plat.os === 'windows'
  const hasOnPath = (candidates: string[]): boolean => {
    const pathVar = Object.keys(process.env).find((k) => k.toLowerCase() === 'path')
    const PATH = pathVar ? String(process.env[pathVar]) : ''
    const parts = PATH.split(path.delimiter).filter(Boolean)
    for (const dir of parts) {
      for (const name of candidates) {
        const full = path.join(dir, name)
        if (fs.existsSync(full)) return true
      }
    }
    return false
  }
  const has_cmd =
    isWin && (hasOnPath(['cmd.exe', 'cmd']) || fs.existsSync('C\\\\Windows\\\\System32\\\\cmd.exe'))
  const has_powershell = isWin
    ? hasOnPath(['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell']) ||
      fs.existsSync('C\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe')
    : hasOnPath(['pwsh', 'powershell'])
  const has_wsl =
    isWin && (hasOnPath(['wsl.exe', 'wsl']) || fs.existsSync('C\\\\Windows\\\\System32\\\\wsl.exe'))
  const has_bash = plat.os !== 'windows' ? hasOnPath(['bash']) : false
  return { has_wsl, has_powershell, has_cmd, has_bash }
}

function classifyPathDomain(p: string): 'windows' | 'posix' | 'unknown' {
  if (!p) return 'unknown'
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) return 'windows'
  if (p.startsWith('/')) return 'posix'
  return 'unknown'
}
