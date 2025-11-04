import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  LoggingMessageNotificationSchema
} from '@modelcontextprotocol/sdk/types.js'
import { eventBus, SendTarget } from '@/eventbus'
import { MCP_EVENTS } from '@/events'
import path from 'path'
import { presenter } from '@/presenter'
import { app } from 'electron'
import fs from 'fs'
import { spawn } from 'child_process'
// import { NO_PROXY, proxyConfig } from '@/presenter/proxyConfig'
import { getInMemoryServer } from './inMemoryServers/builder'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  PromptListEntry,
  ToolCallResult,
  Tool,
  Prompt,
  ResourceListEntry,
  Resource
} from '@shared/presenter'

// TODO: resources 和 prompts 的类型,Notifactions 的类型 https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/examples/client/simpleStreamableHttp.ts
// Simple OAuth provider for handling Bearer Token
class SimpleOAuthProvider {
  private token: string | null = null

  constructor(authHeader: string | undefined) {
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      this.token = authHeader.substring(7) // Remove 'Bearer ' prefix
    }
  }

  async tokens(): Promise<{ access_token: string } | null> {
    if (this.token) {
      return { access_token: this.token }
    }
    return null
  }
}

// No additional typing shim needed; use MCP_EVENTS.SERVER_STATUS_CHANGED directly

// Session management related types
interface SessionError extends Error {
  httpStatus?: number
  isSessionExpired?: boolean
}

// Helper function to check if error is session-related
function isSessionError(error: unknown): error is SessionError {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()

    // Check for specific MCP Streamable HTTP session error patterns
    const sessionErrorPatterns = [
      'no valid session',
      'session expired',
      'session not found',
      'invalid session',
      'session id',
      'mcp-session-id'
    ]

    const httpErrorPatterns = ['http 400', 'http 404', 'bad request', 'not found']

    // Check for session-specific errors first (high confidence)
    const hasSessionPattern = sessionErrorPatterns.some((pattern) => message.includes(pattern))
    if (hasSessionPattern) {
      return true
    }

    // Check for HTTP errors that might be session-related (lower confidence)
    // Only treat as session error if it's an HTTP transport
    const hasHttpPattern = httpErrorPatterns.some((pattern) => message.includes(pattern))
    if (hasHttpPattern && (message.includes('posting') || message.includes('endpoint'))) {
      return true
    }
  }
  return false
}

// Define command categories for stdio transport
type StdioCommandCategory = 'WSL' | 'AppBundledRuntime' | 'GenericSystem'

// MCP client class
export class McpClient {
  private client: Client | null = null
  private transport: Transport | null = null
  public serverName: string
  public serverConfig: Record<string, unknown>
  private isConnected: boolean = false
  private connectionTimeout: NodeJS.Timeout | null = null
  private npmRegistry: string | null = null
  private uvRegistry: string | null = null
  private connectingPromise: Promise<void> | null = null

  // Session management
  private isRecovering: boolean = false
  private hasRestarted: boolean = false

  // Cache
  private cachedTools: Tool[] | null = null
  private cachedPrompts: PromptListEntry[] | null = null
  private cachedResources: ResourceListEntry[] | null = null

  // Track cleanup state to avoid race when connect() times out but underlying promise resolves later
  private isCleaningUp: boolean = false
  // Keep a reference to stderr listener to remove it on cleanup
  private stderrListener: ((data: Buffer) => void) | null = null
  // Track stdio child process and its listeners for lifecycle handling
  private stdioProcess: any | null = null
  private stdioProcessListeners: { [event: string]: (...args: any[]) => void } | null = null

  constructor(
    serverName: string,
    serverConfig: Record<string, unknown>,
    npmRegistry: string | null = null,
    uvRegistry: string | null = null
  ) {
    this.serverName = serverName
    this.serverConfig = serverConfig
    this.npmRegistry = npmRegistry
    this.uvRegistry = uvRegistry

    const runtimeBasePath = path
      .join(app.getAppPath(), 'runtime')
      .replace('app.asar', 'app.asar.unpacked')
    console.info('runtimeBasePath', runtimeBasePath)
  }

  // Connect to MCP server
  async connect(): Promise<void> {
    if (this.isConnected && this.client) {
      console.info(`MCP server ${this.serverName} is already running`)
      return
    }

    if (this.connectingPromise) {
      return this.connectingPromise
    }

    this.connectingPromise = (async (): Promise<void> => {
      try {
        // reset cleanup race flag before starting a new connection attempt
        this.isCleaningUp = false

        try {
          console.info(`Starting MCP server ${this.serverName}...`, this.serverConfig)

          // Create transport using the new private helper method
          this.transport = await this._createTransport()

          // 创建 MCP 客户端
          this.client = new Client(
            { name: 'DeepChat', version: app.getVersion() },
            {
              capabilities: {
                resources: {},
                tools: {},
                prompts: {}
              }
            }
          )

          // 设置通知处理器
          this.registerNotificationHandlers()

          // 设置连接超时
          let timedOut = false
          const timeoutPromise = new Promise<void>((_, reject) => {
            this.connectionTimeout = setTimeout(
              () => {
                console.error(`Connection to MCP server ${this.serverName} timed out`)
                timedOut = true
                reject(new Error(`Connection to MCP server ${this.serverName} timed out`))
              },
              5 * 60 * 1000
            ) // 5分钟
          })

          // 连接到服务器
          const connectPromise = this.client
            .connect(this.transport)
            .then(() => {
              // 先清理连接超时句柄，避免悬挂计时器
              if (this.connectionTimeout) {
                clearTimeout(this.connectionTimeout)
                this.connectionTimeout = null
              }

              // 如果在超时清理后才成功，这里直接忽略，避免状态错乱
              if (this.isCleaningUp || timedOut) {
                return
              }

              this.isConnected = true
              this.hasRestarted = false // FIX: Reset restart flag on successful connection
              console.info(`MCP server ${this.serverName} connected successfully`)

              // 触发服务器状态变更事件
              eventBus.send(MCP_EVENTS.SERVER_STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
                name: this.serverName,
                status: 'running'
              })
            })
            .catch((error) => {
              console.error(`Failed to connect to MCP server ${this.serverName}:`, error)
              throw error
            })

          // 等待连接完成或超时
          await Promise.race([connectPromise, timeoutPromise])
        } catch (error) {
          // 清除超时
          if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout)
            this.connectionTimeout = null
          }

          // 清理资源
          await this.cleanupResources()

          console.error(`Failed to connect to MCP server ${this.serverName}:`, error)

          // 触发服务器状态变更事件
          eventBus.send(MCP_EVENTS.SERVER_STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
            name: this.serverName,
            status: 'stopped'
          })

          throw error
        }
      } finally {
        this.connectingPromise = null
      }
    })()

    return this.connectingPromise
  }

  // 断开与 MCP 服务器的连接
  async disconnect(): Promise<void> {
    await this.internalDisconnect('manual disconnect')
  }

  // 清理资源
  private async cleanupResources(): Promise<void> {
    this.isCleaningUp = true

    // 清理超时定时器
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout)
      this.connectionTimeout = null
    }

    // 下面这段清理逻辑应始终执行（不要放进上面的 if 里）
    try {
      if (this.stderrListener) {
        ;(this.transport as any)?.stderr?.removeListener?.('data', this.stderrListener)
      }
    } catch {}
    this.stderrListener = null

    // 移除并清空 stdio 进程生命周期监听器
    try {
      if (this.stdioProcess && this.stdioProcessListeners) {
        for (const [evt, fn] of Object.entries(this.stdioProcessListeners)) {
          this.stdioProcess.removeListener?.(evt, fn)
        }
      }
    } catch {}
    this.stdioProcess = null
    this.stdioProcessListeners = null

    try {
      await (this.client as any)?.close?.()
    } catch (e) {
      console.warn('close client failed', e)
    }
    try {
      this.transport?.close?.()
    } catch (e) {
      console.error('close transport failed', e)
    }

    this.client = null
    this.transport = null
    this.isConnected = false
    this.cachedTools = null
    this.cachedPrompts = null
    this.cachedResources = null

    // 标记清理结束，避免后续流程被永久挡住
    this.isCleaningUp = false
  }

  // Register notification handlers
  private registerNotificationHandlers(): void {
    if (!this.client) {
      return
    }

    // Tool list changed notification - clear tool cache and actively refresh
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      console.info(`[MCP] Tools list changed for server: ${this.serverName}`)
      this.cachedTools = null
      // Actively refresh tool list
      try {
        await this.listTools()
      } catch (error) {
        console.warn(`[MCP] Failed to refresh tools after notification:`, error)
      }
    })

    // Prompt list changed notification - clear prompt cache and actively refresh
    this.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      console.info(`[MCP] Prompts list changed for server: ${this.serverName}`)
      this.cachedPrompts = null
      // Actively refresh prompt list
      try {
        await this.listPrompts()
      } catch (error) {
        console.warn(`[MCP] Failed to refresh prompts after notification:`, error)
      }
    })

    // Resource list changed notification - clear resource cache and actively refresh
    this.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      console.info(`[MCP] Resources list changed for server: ${this.serverName}`)
      this.cachedResources = null
      // Actively refresh resource list
      try {
        await this.listResources()
      } catch (error) {
        console.warn(`[MCP] Failed to refresh resources after notification:`, error)
      }
    })

    // Resource updated notification - clear resource cache and actively refresh
    this.client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (params) => {
      console.info(`[MCP] Resource updated for server: ${this.serverName}`, params)
      this.cachedResources = null
      // Actively refresh resource list
      try {
        await this.listResources()
      } catch (error) {
        console.warn(`[MCP] Failed to refresh resources after update notification:`, error)
      }
    })

    // Logging message notification - just log the message
    this.client.setNotificationHandler(LoggingMessageNotificationSchema, async (params) => {
      console.info(`[MCP] Log message from server ${this.serverName}:`, params)
    })
  }

  // 检查服务器是否正在运行
  isServerRunning(): boolean {
    return this.isConnected && !!this.client
  }

  // Check and handle session errors by restarting the service
  private async checkAndHandleSessionError(error: unknown): Promise<void> {
    if (isSessionError(error) && !this.isRecovering) {
      // If already restarted once and still getting session errors, stop the service
      if (this.hasRestarted) {
        console.error(
          `Session error persists after restart for server ${this.serverName}, stopping service...`,
          error
        )
        await this.stopService()
        throw new Error(
          `MCP service ${this.serverName} still has session errors after restart, service has been stopped`
        )
      }

      console.warn(
        `Session error detected for server ${this.serverName}, restarting service...`,
        error
      )

      this.isRecovering = true

      try {
        // Clean up current connection
        await this.cleanupResources()

        // Clear all caches to ensure fresh data after reconnection
        this.cachedTools = null
        this.cachedPrompts = null
        this.cachedResources = null

        // Mark as restarted
        this.hasRestarted = true

        console.info(`Service ${this.serverName} cleaned up due to session error`)
      } catch (restartError) {
        console.error(`Failed to restart service ${this.serverName}:`, restartError)
      } finally {
        this.isRecovering = false
      }
    }
  }

  // Stop the service completely due to persistent session errors
  private async stopService(): Promise<void> {
    try {
      // Use the same disconnect logic but with different reason
      await this.internalDisconnect('persistent session errors')
    } catch (error) {
      console.error(`Failed to stop service ${this.serverName}:`, error)
    }
  }

  // Internal disconnect with custom reason
  private async internalDisconnect(reason?: string): Promise<void> {
    // Clean up all resources
    await this.cleanupResources()

    const logMessage = reason
      ? `MCP service ${this.serverName} has been stopped due to ${reason}`
      : `Disconnected from MCP server: ${this.serverName}`

    console.log(logMessage)

    // Trigger server status changed event to notify the system
    eventBus.send(MCP_EVENTS.SERVER_STATUS_CHANGED, SendTarget.ALL_WINDOWS, {
      name: this.serverName,
      status: 'stopped'
    })
  }

  // 调用 MCP 工具
  async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    try {
      if (!this.isConnected) {
        await this.connect()
      }

      if (!this.client) {
        throw new Error(`MCP client ${this.serverName} not initialized`)
      }

      // 调用工具（起始日志在 ToolManager 层统一输出，这里不再重复）
      const result = (await this.client.callTool({
        name: toolName,
        arguments: args
      })) as ToolCallResult

      // 成功调用后重置重启标志
      this.hasRestarted = false

      // 检查结果
      if (result.isError) {
        const errorText =
          result.content && result.content[0] ? result.content[0].text : 'Unknown error'
        // 如果调用失败，清空工具缓存，以便下次重新获取
        this.cachedTools = null
        return {
          isError: true,
          content: [{ type: 'error', text: errorText }]
        }
      }
      // 结果摘要由 ToolManager 层统一输出，这里不再重复
      return result
    } catch (error) {
      // 检查并处理session错误
      await this.checkAndHandleSessionError(error)

      console.error(`Failed to call MCP tool ${toolName}:`, error)
      // 调用失败，清空工具缓存
      this.cachedTools = null
      throw error
    }
  }

  // 列出可用工具
  async listTools(): Promise<Tool[]> {
    // 检查缓存
    if (this.cachedTools !== null) {
      return this.cachedTools
    }

    try {
      if (!this.isConnected) {
        await this.connect()
      }

      if (!this.client) {
        throw new Error(`MCP client ${this.serverName} not initialized`)
      }

      const response = await this.client.listTools()
      // 成功调用后重置重启标志
      this.hasRestarted = false

      // 检查响应格式
      if (response && typeof response === 'object' && 'tools' in response) {
        const toolsArray = response.tools
        if (Array.isArray(toolsArray)) {
          // 缓存结果
          this.cachedTools = toolsArray as Tool[]
          return this.cachedTools
        }
      }
      throw new Error('Invalid tool response format')
    } catch (error) {
      // 检查并处理session错误
      await this.checkAndHandleSessionError(error)

      // 尝试从错误对象中提取更多信息
      const errorMessage = error instanceof Error ? error.message : String(error)
      // 如果错误表明不支持，则缓存空数组
      if (errorMessage.includes('Method not found') || errorMessage.includes('not supported')) {
        console.warn(`Server ${this.serverName} does not support listTools`)
        this.cachedTools = []
        return this.cachedTools
      } else {
        console.error(`Failed to list MCP tools:`, error)
        // 发生其他错误，不清空缓存（保持null），以便下次重试
        throw error
      }
    }
  }

  // 列出可用提示
  async listPrompts(): Promise<PromptListEntry[]> {
    // 检查缓存
    if (this.cachedPrompts !== null) {
      return this.cachedPrompts
    }

    try {
      if (!this.isConnected) {
        await this.connect()
      }

      if (!this.client) {
        throw new Error(`MCP client ${this.serverName} not initialized`)
      }

      // SDK可能没有 listPrompts 方法，需要使用通用的 request
      const response = await this.client.listPrompts()

      // 成功调用后重置重启标志
      this.hasRestarted = false

      // 检查响应格式
      if (response && typeof response === 'object' && 'prompts' in response) {
        const promptsArray = (response as { prompts: unknown }).prompts
        // console.log('promptsArray', JSON.stringify(promptsArray, null, 2))
        if (Array.isArray(promptsArray)) {
          // 需要确保每个元素都符合 Prompt 接口
          const validPrompts = promptsArray.map((p) => ({
            name: typeof p === 'object' && p !== null && 'name' in p ? String(p.name) : 'unknown',
            description:
              typeof p === 'object' && p !== null && 'description' in p
                ? String(p.description)
                : undefined,
            arguments:
              typeof p === 'object' && p !== null && 'arguments' in p ? p.arguments : undefined,
            files: typeof p === 'object' && p !== null && 'files' in p ? p.files : undefined
          })) as PromptListEntry[]
          // 缓存结果
          this.cachedPrompts = validPrompts
          return this.cachedPrompts
        }
      }
      throw new Error('Invalid prompt response format')
    } catch (error) {
      // 检查并处理session错误
      await this.checkAndHandleSessionError(error)

      // 尝试从错误对象中提取更多信息
      const errorMessage = error instanceof Error ? error.message : String(error)
      // 如果错误表明不支持，则缓存空数组
      if (errorMessage.includes('Method not found') || errorMessage.includes('not supported')) {
        console.warn(`Server ${this.serverName} does not support listPrompts`)
        this.cachedPrompts = []
        return this.cachedPrompts
      } else {
        console.error(`Failed to list MCP prompts:`, error)
        // 发生其他错误，不清空缓存（保持null），以便下次重试
        throw error
      }
    }
  }

  // 获取指定提示
  async getPrompt(name: string, args?: Record<string, unknown>): Promise<Prompt> {
    try {
      if (!this.isConnected) {
        await this.connect()
      }

      if (!this.client) {
        throw new Error(`MCP client ${this.serverName} not initialized`)
      }

      const response = await this.client.getPrompt({
        name,
        arguments: (args as Record<string, string>) || {}
      })

      // 成功调用后重置重启标志
      this.hasRestarted = false

      // 检查响应格式并转换为 Prompt 类型
      if (
        response &&
        typeof response === 'object' &&
        'messages' in response &&
        Array.isArray(response.messages)
      ) {
        return {
          id: name,
          name: name, // 从请求参数中获取 name
          description: response.description || '',
          messages: response.messages as Array<{ role: string; content: { text: string } }>
        }
      }
      throw new Error('Invalid get prompt response format')
    } catch (error) {
      // 检查并处理session错误
      await this.checkAndHandleSessionError(error)

      console.error(`Failed to get MCP prompt ${name}:`, error)
      // 获取失败，清空提示缓存
      this.cachedPrompts = null
      throw error
    }
  }

  // 列出可用资源
  async listResources(): Promise<ResourceListEntry[]> {
    // 检查缓存
    if (this.cachedResources !== null) {
      return this.cachedResources
    }

    try {
      if (!this.isConnected) {
        await this.connect()
      }

      if (!this.client) {
        throw new Error(`MCP client ${this.serverName} not initialized`)
      }

      // SDK可能没有 listResources 方法，需要使用通用的 request
      const response = await this.client.listResources()

      // 成功调用后重置重启标志
      this.hasRestarted = false

      // 检查响应格式
      if (response && typeof response === 'object' && 'resources' in response) {
        const resourcesArray = (response as { resources: unknown }).resources
        if (Array.isArray(resourcesArray)) {
          // 需要确保每个元素都符合 ResourceListEntry 接口
          const validResources = resourcesArray.map((r) => ({
            uri: typeof r === 'object' && r !== null && 'uri' in r ? String(r.uri) : 'unknown',
            name: typeof r === 'object' && r !== null && 'name' in r ? String(r.name) : undefined
          })) as ResourceListEntry[]
          // 缓存结果
          this.cachedResources = validResources
          return this.cachedResources
        }
      }
      throw new Error('Invalid resource list response format')
    } catch (error) {
      // 检查并处理session错误
      await this.checkAndHandleSessionError(error)

      // 尝试从错误对象中提取更多信息
      const errorMessage = error instanceof Error ? error.message : String(error)
      // 如果错误表明不支持，则缓存空数组
      if (errorMessage.includes('Method not found') || errorMessage.includes('not supported')) {
        console.warn(`Server ${this.serverName} does not support listResources`)
        this.cachedResources = []
        return this.cachedResources
      } else {
        console.error(`Failed to list MCP resources:`, error)
        // 发生其他错误，不清空缓存（保持null），以便下次重试
        throw error
      }
    }
  }

  // 读取资源
  async readResource(resourceUri: string): Promise<Resource> {
    try {
      if (!this.isConnected) {
        await this.connect()
      }

      if (!this.client) {
        throw new Error(`MCP client ${this.serverName} not initialized`)
      }

      // 使用 unknown 作为中间类型进行转换
      const rawResource = await this.client.readResource({ uri: resourceUri })

      // 成功调用后重置重启标志
      this.hasRestarted = false

      // 手动构造 Resource 对象
      const resource: Resource = {
        uri: resourceUri,
        text:
          typeof rawResource === 'object' && rawResource !== null && 'text' in rawResource
            ? String(rawResource['text'])
            : JSON.stringify(rawResource)
      }

      return resource
    } catch (error) {
      // 检查并处理session错误
      await this.checkAndHandleSessionError(error)

      console.error(`Failed to read MCP resource ${resourceUri}:`, error)
      // 读取失败，清空资源缓存
      this.cachedResources = null
      throw error
    }
  }

  // =================================================================
  // Refactored private methods for transport creation
  // =================================================================

  /**
   * Helper class to build stdio command, args and env in a cross-platform, cautious way.
   * Embedded here to avoid new files while keeping concerns separated from McpClient.
   */
  private StdioCommandBuilder = class StdioCommandBuilder {
    private readonly serverConfig: Record<string, unknown>
    private readonly npmRegistry: string | null
    private readonly uvRegistry: string | null
    private static loginShellEnvPromise: Promise<Record<string, string>> | null = null
    private readonly runtimeBasePath: string

    constructor(
      serverConfig: Record<string, unknown>,
      npmRegistry: string | null,
      uvRegistry: string | null
    ) {
      this.serverConfig = serverConfig
      this.npmRegistry = npmRegistry
      this.uvRegistry = uvRegistry
      this.runtimeBasePath = path
        .join(app.getAppPath(), 'runtime')
        .replace('app.asar', 'app.asar.unpacked')
    }

    async build(): Promise<{
      command: string
      args: string[]
      env: Record<string, string>
      category: StdioCommandCategory
      cwd?: string
    }> {
      const rawCommand = String(this.serverConfig.command || '')
      const rawArgs = Array.isArray(this.serverConfig.args)
        ? (this.serverConfig.args as string[])
        : []
      const cwd = (this.serverConfig as any).cwd as string | undefined

      const category = this.categorize(rawCommand)
      console.debug(`[MCP][Stdio] category=${category} command=${rawCommand}`)

      const expandedCommand = this.expandPath(rawCommand)
      const expandedArgs = category === 'WSL' ? rawArgs : rawArgs.map((a) => this.expandPath(a))

      const processed = await this.processCommandWithArgs(expandedCommand, expandedArgs, category)
      console.debug(
        `[MCP][Stdio] processed command=${processed.command} args=${JSON.stringify(processed.args)}`
      )

      let env: Record<string, string>
      if (category === 'WSL') {
        // Use host environment as base to avoid losing essential vars
        env = {}
        Object.entries(process.env).forEach(([k, v]) => {
          if (typeof v === 'string') env[k] = v
        })

        // Pass through only necessary registry variables to WSL using WSLENV
        const wslNames: string[] = []
        if (this.npmRegistry) {
          env['NPM_CONFIG_REGISTRY'] = this.npmRegistry
          wslNames.push('NPM_CONFIG_REGISTRY')
        }
        if (this.uvRegistry) {
          env['UV_DEFAULT_INDEX'] = this.uvRegistry
          env['PIP_INDEX_URL'] = this.uvRegistry
          wslNames.push('UV_DEFAULT_INDEX', 'PIP_INDEX_URL')
        }
        if (wslNames.length > 0) {
          const existing = env['WSLENV'] || ''
          const merged = existing ? `${existing}:${wslNames.join(':')}` : wslNames.join(':')
          env['WSLENV'] = merged
        }
        // Merge user-provided env last (explicit override)
        if (this.serverConfig.env) {
          Object.entries(this.serverConfig.env as Record<string, string>).forEach(([k, v]) => {
            if (v !== undefined) env[k] = v
          })
        }
      } else {
        env = await this.getLoginShellEnv()
        // Merge server-provided env, expanding PATH with prepend semantics for runtime dirs
        if (this.serverConfig.env) {
          Object.entries(this.serverConfig.env as Record<string, string>).forEach(([k, v]) => {
            if (v === undefined) return
            if (['PATH', 'Path', 'path'].includes(k)) {
              const isWin = process.platform === 'win32'
              const sep = isWin ? ';' : ':'
              // find the real path key present in env (case-insensitive)
              const realPathKey =
                Object.keys(env).find((p) => p.toLowerCase() === 'path') ||
                (isWin ? 'Path' : 'PATH')
              const prev = env[realPathKey] || ''
              env[realPathKey] = v ? `${v}${prev ? sep : ''}${prev}` : prev
              if (!isWin) env.PATH = env[realPathKey]
            } else {
              env[k] = v
            }
          })
        }
        // Conditionally inject registries only for bundled runtimes
        if (category === 'AppBundledRuntime') {
          if (this.npmRegistry) env['npm_config_registry'] = this.npmRegistry
          if (this.uvRegistry) {
            env['UV_DEFAULT_INDEX'] = this.uvRegistry
            env['PIP_INDEX_URL'] = this.uvRegistry
          }
        }
      }

      /*
      // Conservative: if final command is bun, strip proxy vars to avoid known bun proxy issues
      // 说明：bun与proxy环境变量存在一致性/兼容性BUG，可删除环境变量规避，但会影响其网络请求，暂时注释掉。需使用者自行慎重处理
      // 如一定要为bun启用proxy：
      //   1. 脚本中显式用 fetch(url, { proxy: 'http(s)://...' })，不能只依赖环境变量
      //   2. 确保NO_PROXY 写成纯逗号分隔、无空格
      //   3. 包安装问题优先用 bunfig.toml 配镜像/私有源
      const base = this.stripExeCmdExt(processed.command)
      if (base === 'bun') {
        const proxyKeys = [
          'HTTP_PROXY',
          'HTTPS_PROXY',
          'ALL_PROXY',
          'NO_PROXY',
          'http_proxy',
          'https_proxy',
          'all_proxy',
          'no_proxy'
        ]
        let removed = 0
        for (const k of proxyKeys) {
          if (k in env) {
            delete env[k]
            removed++
          }
        }
        if (removed > 0) {
          console.debug(`[MCP][Stdio] removed ${removed} proxy env(s) for bun`)
        }
      }
      */

      console.debug(
        `[MCP][Stdio] final profile: cmd=${processed.command} cwd=${cwd || ''} env.keys=${Object.keys(env).length}`
      )

      return {
        command: processed.command,
        args: processed.args,
        env,
        category,
        cwd
      }
    }

    private stripExeCmdExt(name: string): string {
      const b = path.basename(name).toLowerCase()
      return b.replace(/\.(exe|cmd|bat)$/, '')
    }

    private expandPath(inputPath: string): string {
      let expandedPath = inputPath

      if (expandedPath.startsWith('~/') || expandedPath === '~') {
        const homeDir = app.getPath('home')
        expandedPath = expandedPath.replace('~', homeDir)
      }

      const getEnvVar = (name: string): string | undefined => {
        const direct = process.env[name]
        if (direct !== undefined) return direct
        if (process.platform === 'win32') {
          const upper = process.env[name.toUpperCase()]
          if (upper !== undefined) return upper
          const lower = process.env[name.toLowerCase()]
          if (lower !== undefined) return lower
        }
        return undefined
      }

      expandedPath = expandedPath.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        const v = getEnvVar(varName)
        return v !== undefined ? v : match
      })

      expandedPath = expandedPath.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, varName) => {
        const v = getEnvVar(varName)
        return v !== undefined ? v : match
      })

      if (process.platform === 'win32') {
        expandedPath = expandedPath.replace(/%([^%]+)%/g, (match, varName) => {
          const v = getEnvVar(varName)
          return v !== undefined ? v : match
        })
      }

      return expandedPath
    }

    private categorize(command: string): StdioCommandCategory {
      const base = this.stripExeCmdExt(command)
      if (base === 'wsl') return 'WSL'
      if (['node', 'npm', 'npx', 'bun', 'uv', 'uvx'].includes(base)) return 'AppBundledRuntime'
      return 'GenericSystem'
    }

    private async processCommandWithArgs(
      command: string,
      args: string[],
      category: StdioCommandCategory
    ): Promise<{ command: string; args: string[] }> {
      const base = this.stripExeCmdExt(command)

      if (category === 'WSL') {
        return { command, args }
      }

      // npx handling
      if (base === 'npx') {
        if (process.platform === 'win32') {
          const npxCmd = await this.getBinaryPath('npx')
          if (fs.existsSync(npxCmd)) {
            console.debug('[MCP][Stdio] resolve npx -> npx.cmd')
            return { command: npxCmd, args }
          }
          // fallback: node.exe + npx-cli.js
          const nodeExe = await this.getBinaryPath('node')
          const npxCli = path.join(
            this.runtimeBasePath,
            'node',
            'node_modules',
            'npm',
            'bin',
            'npx-cli.js'
          )
          if (fs.existsSync(nodeExe) && fs.existsSync(npxCli)) {
            console.debug('[MCP][Stdio] resolve npx -> node + npx-cli.js')
            return { command: nodeExe, args: [npxCli, ...args] }
          }
          return { command, args }
        } else {
          const bunBin = await this.getBinaryPath('bun')
          if (fs.existsSync(bunBin)) {
            console.debug('[MCP][Stdio] map npx -> bun x')
            return { command: bunBin, args: ['x', ...args] }
          }
          const npxBin = await this.getBinaryPath('npx')
          return { command: npxBin, args }
        }
      }

      // npm cautious mapping
      if (base === 'npm') {
        if (process.platform !== 'win32') {
          const bunBin = await this.getBinaryPath('bun')
          const npmFirst = args[0] && !args[0].startsWith('-') ? String(args[0]) : ''
          const bunEquivalents = new Set(['install', 'i', 'ci', 'run', 'update', 'rebuild'])
          if (fs.existsSync(bunBin) && npmFirst) {
            if (bunEquivalents.has(npmFirst)) {
              console.debug(`[MCP][Stdio] map npm ${npmFirst} -> bun ${npmFirst}`)
              return { command: bunBin, args }
            }
            // If it's a script name (not known builtin), npm <script> -> bun run <script>
            const npmBuiltins = new Set(['install', 'i', 'ci', 'run', 'update', 'rebuild'])
            if (!npmBuiltins.has(npmFirst)) {
              console.debug('[MCP][Stdio] map npm <script> -> bun run <script>')
              return { command: bunBin, args: ['run', ...args] }
            }
          }
          const npmBin = await this.getBinaryPath('npm')
          return { command: npmBin, args }
        } else {
          const npmCmd = await this.getBinaryPath('npm')
          if (fs.existsSync(npmCmd)) {
            console.debug('[MCP][Stdio] resolve npm -> npm.cmd')
            return { command: npmCmd, args }
          }
          const nodeExe = await this.getBinaryPath('node')
          const npmCli = path.join(
            this.runtimeBasePath,
            'node',
            'node_modules',
            'npm',
            'bin',
            'npm-cli.js'
          )
          if (fs.existsSync(nodeExe) && fs.existsSync(npmCli)) {
            console.debug('[MCP][Stdio] resolve npm -> node + npm-cli.js')
            return { command: nodeExe, args: [npmCli, ...args] }
          }
          return { command, args }
        }
      }

      // node/bun/uv/uvx direct resolution (no semantic change)
      if (['node', 'bun', 'uv', 'uvx'].includes(base)) {
        const bin = await this.getBinaryPath(base)
        return { command: bin, args }
      }

      // default: do not modify (generic system command)
      return { command, args }
    }

    private async getBinaryPath(name: string): Promise<string> {
      const isWin = process.platform === 'win32'
      const sub = (n: string) => {
        switch (n) {
          case 'bun':
            return isWin ? path.join('bun', 'bun.exe') : path.join('bun', 'bun')
          case 'node':
            return isWin ? path.join('node', 'node.exe') : path.join('node', 'bin', 'node')
          case 'npm':
            return isWin ? path.join('node', 'npm.cmd') : path.join('node', 'bin', 'npm')
          case 'npx':
            return isWin ? path.join('node', 'npx.cmd') : path.join('node', 'bin', 'npx')
          case 'uv':
            return isWin ? path.join('uv', 'uv.exe') : path.join('uv', 'uv')
          case 'uvx':
            return isWin ? path.join('uv', 'uvx.exe') : path.join('uv', 'uvx')
          default:
            return n
        }
      }
      const candidate = path.join(this.runtimeBasePath, sub(name))
      if (name === 'npx') {
        // npx.cmd may not exist in some bundles; caller will fallback if needed
        if (fs.existsSync(candidate)) return candidate
        return name
      }
      return fs.existsSync(candidate) ? candidate : name
    }

    // 遗留问题：一次性获取，永久缓存。缺乏对环境变化的响应能力（用户更改了 shell 配置后无法反映）
    private async getLoginShellEnv(): Promise<Record<string, string>> {
      if (StdioCommandBuilder.loginShellEnvPromise) return StdioCommandBuilder.loginShellEnvPromise

      StdioCommandBuilder.loginShellEnvPromise = new Promise<Record<string, string>>((resolve) => {
        // Choose shell and args based on platform
        let shellPath = process.env.SHELL
        let args: string[]
        const home = app.getPath('home')

        if (process.platform === 'win32') {
          shellPath = process.env.COMSPEC || 'cmd.exe'
          args = ['/c', 'set']
        } else {
          if (!shellPath) {
            shellPath = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
          }
          args = ['-ilc', 'env']
        }

        const child = spawn(shellPath, args, {
          cwd: home,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false
        })

        let output = ''
        let errorOutput = ''
        const timeout = setTimeout(() => {
          child.kill()
        }, 15000)

        child.stdout.on('data', (d) => (output += d.toString()))
        child.stderr.on('data', (d) => (errorOutput += d.toString()))
        child.on('error', () => {
          clearTimeout(timeout)
          // Fallback to process.env on error
          const env: Record<string, string> = {}
          Object.entries(process.env).forEach(([k, v]) => {
            if (v !== undefined) env[k] = v
          })
          this.appendRuntimeDirsToPath(env)
          resolve(env)
        })
        child.on('close', () => {
          clearTimeout(timeout)
          const env: Record<string, string> = {}
          // Parse KEY=VALUE lines
          output.split(/\r?\n/).forEach((line) => {
            const idx = line.indexOf('=')
            if (idx > 0) {
              const k = line.substring(0, idx)
              const v = line.substring(idx + 1)
              env[k] = v
            }
          })
          if (Object.keys(env).length === 0) {
            // Fallback if parsing failed
            Object.entries(process.env).forEach(([k, v]) => {
              if (v !== undefined) env[k] = v
            })
          }
          this.appendRuntimeDirsToPath(env)
          resolve(env)
        })
      })

      return StdioCommandBuilder.loginShellEnvPromise
    }

    private appendRuntimeDirsToPath(env: Record<string, string>): void {
      const isWin = process.platform === 'win32'
      const sep = isWin ? ';' : ':'
      const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
      const canonicalPathKey = pathKeys[0] || (isWin ? 'Path' : 'PATH')
      const existing = env[canonicalPathKey] || env.PATH || ''

      const normalize = (p: string) => {
        let s = path.normalize(p).trim()
        if (isWin) s = s.replace(/[\\\/]+$/, '').toLowerCase()
        else s = s.replace(/[\\\/]+$/, '')
        return s
      }

      const seen = new Set<string>()
      const parts = existing
        .split(sep)
        .map((s) => s.trim())
        .filter(Boolean)
      const unique: string[] = []
      for (const p of parts) {
        const n = normalize(p)
        if (!n) continue
        if (!seen.has(n)) {
          seen.add(n)
          unique.push(p)
        }
      }

      // Determine runtime dirs to prepend
      const dirs: string[] = []
      const bunDir = path.join(this.runtimeBasePath, 'bun')
      const nodeDir = isWin
        ? path.join(this.runtimeBasePath, 'node')
        : path.join(this.runtimeBasePath, 'node', 'bin')
      const uvDir = path.join(this.runtimeBasePath, 'uv')

      // Prepend by priority
      if (fs.existsSync(bunDir)) dirs.push(bunDir)
      if (fs.existsSync(nodeDir)) dirs.push(nodeDir)
      if (fs.existsSync(uvDir)) dirs.push(uvDir)

      // Prepend runtime dirs (keeping original values)
      const finalParts = [...dirs, ...unique]
      const updated = finalParts.join(sep)

      if (pathKeys.length > 0) {
        pathKeys.forEach((k) => (env[k] = updated))
      } else {
        env[canonicalPathKey] = updated
      }
      if (!isWin) {
        env.PATH = updated
      }
    }
  }

  /**
   * Main dispatcher for creating the correct transport based on server config.
   */
  private async _createTransport(): Promise<Transport> {
    // Handle customHeaders and AuthProvider (common for HTTP-based transports)
    let authProvider: SimpleOAuthProvider | null = null
    const customHeaders = this.serverConfig.customHeaders
      ? { ...(this.serverConfig.customHeaders as Record<string, string>) }
      : {}
    const __authKey = Object.keys(customHeaders).find((k) => k.toLowerCase() === 'authorization')
    if (__authKey) {
      const __authVal = customHeaders[__authKey]
      authProvider = new SimpleOAuthProvider(
        typeof __authVal === 'string' ? __authVal : String(__authVal)
      )
      delete customHeaders[__authKey]
    }

    const type = this.serverConfig.type
    switch (type) {
      case 'inmemory': {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        const _args = Array.isArray(this.serverConfig.args) ? this.serverConfig.args : []
        const _env = this.serverConfig.env ? (this.serverConfig.env as Record<string, string>) : {}
        const _server = getInMemoryServer(this.serverName, _args, _env)
        _server.startServer(serverTransport)
        return clientTransport
      }
      case 'stdio':
        return await this._createStdioTransport()
      case 'sse':
        if (!this.serverConfig.baseUrl) throw new Error('SSE transport requires a baseUrl')
        return new SSEClientTransport(new URL(this.serverConfig.baseUrl as string), {
          requestInit: { headers: customHeaders },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          authProvider: (authProvider ?? undefined) as any
        })
      case 'http':
        if (!this.serverConfig.baseUrl) throw new Error('HTTP transport requires a baseUrl')
        return new StreamableHTTPClientTransport(new URL(this.serverConfig.baseUrl as string), {
          requestInit: { headers: customHeaders },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          authProvider: (authProvider ?? undefined) as any
        })
      default:
        throw new Error(`Unsupported transport type: ${type}`)
    }
  }

  /**
   * Creates a StdioClientTransport after determining the correct command, args, and environment.
   */
  private async _createStdioTransport(): Promise<StdioClientTransport> {
    const builder = new this.StdioCommandBuilder(
      this.serverConfig,
      this.npmRegistry,
      this.uvRegistry
    )
    const profile = await builder.build()

    const transport = new StdioClientTransport({
      command: profile.command,
      args: profile.args,
      env: profile.env,
      cwd: profile.cwd,
      stderr: 'pipe'
    })

    this.stderrListener = (data: Buffer) => {
      console.warn('MCP StdioClientTransport stderr: ', this.serverName, '-', data.toString())
    }
    transport.stderr?.on('data', this.stderrListener)

    // 监听 stdio 子进程生命周期事件，确保异常退出时能正确下线与广播状态
    const child: any = (transport as any).process ?? null
    this.stdioProcess = child
    if (child) {
      const handleTerminate = async (reason: string) => {
        // 避免重复清理/竞态
        if (this.isCleaningUp) return
        try {
          await this.internalDisconnect(reason)
        } catch (e) {
          console.error(`[MCP][Stdio] error during terminate handling (${reason}):`, e)
        }
      }
      const onExit = (code?: number, signal?: string) => {
        console.warn(
          `[MCP][Stdio] process exit for ${this.serverName}: code=${code} signal=${signal}`
        )
        void handleTerminate('stdio process exited')
      }
      const onClose = (code?: number, signal?: string) => {
        console.warn(
          `[MCP][Stdio] process close for ${this.serverName}: code=${code} signal=${signal}`
        )
        void handleTerminate('stdio process closed')
      }
      const onError = (err: unknown) => {
        console.error(`[MCP][Stdio] process error for ${this.serverName}:`, err)
        void handleTerminate('stdio process error')
      }

      child.on?.('exit', onExit)
      child.on?.('close', onClose)
      child.on?.('error', onError)
      this.stdioProcessListeners = { exit: onExit, close: onClose, error: onError }
    }
    return transport
  }
}

// 工厂函数，用于创建 MCP 客户端
export async function createMcpClient(serverName: string): Promise<McpClient> {
  // 从configPresenter获取MCP服务器配置
  const servers = await presenter.configPresenter.getMcpServers()

  // 获取服务器配置
  const serverConfig = servers[serverName]
  if (!serverConfig) {
    throw new Error(`MCP server ${serverName} not found in configuration`)
  }

  // 创建并返回 MCP 客户端，传入null作为npmRegistry
  // 注意：这个函数应该只用于直接创建客户端实例的情况
  // 正常情况下应该通过ServerManager创建，以便使用测试后的npm registry
  return new McpClient(serverName, serverConfig as unknown as Record<string, unknown>, null)
}
