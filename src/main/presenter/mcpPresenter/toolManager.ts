import { eventBus, SendTarget } from '@/eventbus'
import { MCP_EVENTS, NOTIFICATION_EVENTS } from '@/events'
import {
  MCPToolCall,
  MCPToolDefinition,
  MCPToolResponse,
  MCPContentItem,
  MCPTextContent,
  IConfigPresenter,
  Resource
} from '@shared/presenter'
import { ServerManager } from './serverManager'
import { McpClient } from './mcpClient'
import { jsonrepair } from 'jsonrepair'
import { getErrorMessageLabels } from '@shared/i18n'

export class ToolManager {
  private configPresenter: IConfigPresenter
  private serverManager: ServerManager
  private cachedToolDefinitions: MCPToolDefinition[] | null = null
  private toolNameToTargetMap: Map<string, { client: McpClient; originalName: string }> | null =
    null
  // 一次性授权：server|tool -> 'read'|'write'（消费即失效）
  private oneTimeGrantsByServerTool: Map<string, 'read' | 'write'> = new Map()

  private covers(granted: 'read' | 'write', required: 'read' | 'write' | 'all'): boolean {
    const req = required === 'all' ? 'write' : required
    return granted === 'write' || granted === req
  }

  private coversList(list: string[] | undefined, required: 'read' | 'write' | 'all'): boolean {
    if (!list || list.length === 0) return false
    if (list.includes('all')) return true
    const req = required === 'all' ? 'write' : required
    return list.includes('write') || list.includes(req)
  }

  constructor(configPresenter: IConfigPresenter, serverManager: ServerManager) {
    this.configPresenter = configPresenter
    this.serverManager = serverManager
    eventBus.on(MCP_EVENTS.CLIENT_LIST_UPDATED, this.handleServerListUpdate)
    eventBus.on(MCP_EVENTS.CONFIG_CHANGED, this.handleConfigChange)
  }

  // Lightweight Auth Decider within ToolManager
  // Priority: LLM suggested permission (args.required_permission/required_privilege) -> toolsAutoApprove (server+tool) -> server.autoApprove -> heuristic fallback
  public async decidePermission(
    serverName: string,
    toolName: string,
    argsString?: string | null
  ): Promise<{
    decision: 'AUTO_GRANT' | 'AUTO_DENY' | 'REQUIRE_USER_PERMISSION'
    required: 'read' | 'write' | 'all'
  }> {
    // Parse args safely
    let args: Record<string, unknown> | null = null
    if (argsString && typeof argsString === 'string') {
      try {
        args = JSON.parse(argsString)
      } catch {
        try {
          args = JSON.parse(jsonrepair(argsString))
        } catch {
          args = null
        }
      }
    }

    // 1) LLM-suggested permission
    const rawReq = (args &&
      ((args as any)['required_permission'] || (args as any)['required_privilege'])) as
      | 'read'
      | 'write'
      | 'all'
      | undefined
    const required: 'read' | 'write' | 'all' =
      rawReq === 'read' || rawReq === 'write' || rawReq === 'all'
        ? rawReq
        : this.determinePermissionType(toolName, args)

    // 2) toolsAutoApprove (server + tool) or server.autoApprove
    try {
      const servers = await this.configPresenter.getMcpServers()
      const serverCfg = servers[serverName]
      const toolsAutoApprove = (serverCfg as any)?.toolsAutoApprove as
        | Record<string, Array<'read' | 'write' | 'all'>>
        | undefined
      const taa = toolsAutoApprove && toolsAutoApprove[toolName]
      const perToolCovers = this.coversList(taa, required)
      const serverAuto = serverCfg?.autoApprove || []
      const serverCovers = this.coversList(serverAuto, required)

      console.log('[ToolManager/AuthDecider]', {
        server: serverName,
        tool: toolName,
        required,
        perToolCovers,
        serverCovers
      })

      if (perToolCovers || serverCovers) {
        return { decision: 'AUTO_GRANT', required }
      }
    } catch {}

    // 3) Heuristic fallback: be conservative — require user permission
    console.log('[ToolManager/AuthDecider] Require user permission', {
      server: serverName,
      tool: toolName,
      required
    })
    return { decision: 'REQUIRE_USER_PERMISSION', required }
  }

  private handleServerListUpdate = (): void => {
    console.info('MCP client list updated, clearing tool definitions cache and target map.')
    this.cachedToolDefinitions = null
    this.toolNameToTargetMap = null
  }

  private handleConfigChange = (): void => {
    console.info('MCP configuration changed, clearing cached data.')
    this.cachedToolDefinitions = null
    this.toolNameToTargetMap = null
  }

  public async getRunningClients(): Promise<McpClient[]> {
    return this.serverManager.getRunningClients()
  }
  // Get all tool definitions
  public async getAllToolDefinitions(enabledTools?: string[]): Promise<MCPToolDefinition[]> {
    if (this.cachedToolDefinitions !== null && this.cachedToolDefinitions.length > 0) {
      if (enabledTools) {
        const enabledSet = new Set(enabledTools)
        return this.cachedToolDefinitions.filter((toolDef) => {
          const finalName = toolDef.function.name
          const originalName = this.toolNameToTargetMap?.get(finalName)?.originalName || finalName
          return enabledSet.has(finalName) || enabledSet.has(originalName)
        })
      }
      return this.cachedToolDefinitions
    }

    console.info('Fetching/refreshing tool definitions and target map...')
    const clients = await this.serverManager.getRunningClients()
    const results: MCPToolDefinition[] = []
    // Initialize/clear the map before processing
    if (this.toolNameToTargetMap) {
      this.toolNameToTargetMap.clear() // Clear existing map
    } else {
      this.toolNameToTargetMap = new Map() // Initialize if null
    }

    if (!clients || clients.length === 0) {
      console.warn('No running MCP clients found.')
      this.cachedToolDefinitions = []
      // Map is already cleared or initialized as empty
      return this.cachedToolDefinitions
    }

    const toolNameToServerMap: Map<string, string> = new Map()
    const toolsToRename: Map<string, Set<string>> = new Map()

    // Pass 1: Detect conflicts
    for (const client of clients) {
      try {
        const clientTools = await client.listTools()
        if (!clientTools) continue

        const currentServerRenames: Set<string> = toolsToRename.get(client.serverName) || new Set()

        for (const tool of clientTools) {
          if (toolNameToServerMap.has(tool.name)) {
            const originalServerName = toolNameToServerMap.get(tool.name)!
            if (originalServerName !== client.serverName) {
              console.warn(
                `Conflict detected for tool '${tool.name}' between server '${originalServerName}' and '${client.serverName}'. Marking for rename.`
              )
              // Mark original tool for rename
              const originalServerRenames = toolsToRename.get(originalServerName) || new Set()
              originalServerRenames.add(tool.name)
              toolsToRename.set(originalServerName, originalServerRenames)
              // Mark current tool for rename
              currentServerRenames.add(tool.name)
            }
          } else {
            toolNameToServerMap.set(tool.name, client.serverName)
          }
        }
        if (currentServerRenames.size > 0) {
          toolsToRename.set(client.serverName, currentServerRenames)
        }
      } catch (error: unknown) {
        // Log error and notify, but continue conflict detection with other clients
        const errorMessage = error instanceof Error ? error.message : String(error)
        const serverName = client.serverName || 'Unknown server'
        console.error(
          `Pass 1 Error: Failed to get tool list from server '${serverName}':`,
          errorMessage
        )
        // Send notification (existing logic from previous commit)
        const locale = this.configPresenter.getLanguage?.() || 'zh-CN'
        const errorMessages = getErrorMessageLabels(locale)
        const formattedMessage =
          errorMessages.getMcpToolListErrorMessage
            ?.replace('{serverName}', serverName)
            .replace('{errorMessage}', errorMessage) ||
          `Failed to get tool list from server '${serverName}': ${errorMessage}`
        eventBus.sendToRenderer(NOTIFICATION_EVENTS.SHOW_ERROR, SendTarget.ALL_WINDOWS, {
          title: errorMessages.getMcpToolListErrorTitle || 'Failed to get tool definitions',
          message: formattedMessage,
          id: `mcp-error-pass1-${serverName}-${Date.now()}`,
          type: 'error'
        })
        continue // Continue to next client
      }
    }

    // Pass 2: Build results with renaming AND populate the target map
    for (const client of clients) {
      try {
        const clientTools = await client.listTools()
        if (!clientTools) continue

        const renamesForThisServer = toolsToRename.get(client.serverName) || new Set()

        for (const tool of clientTools) {
          let finalName = tool.name
          let finalDescription = tool.description
          const originalName = tool.name

          if (renamesForThisServer.has(originalName)) {
            finalName = `${client.serverName}_${originalName}`
            finalDescription = `[${client.serverName}] ${tool.description}`
          }

          // Validate the final name against the allowed pattern
          const namePattern = /^[a-zA-Z0-9_-]+$/
          if (!namePattern.test(finalName)) {
            console.error(
              `Generated tool name '${finalName}' is invalid. Skipping tool '${originalName}' from server '${client.serverName}'. Please ensure the tool name matches the allowed pattern: /^[a-zA-Z0-9_-]+$/`
            )
            continue // Skip adding this tool
          }

          const properties = tool.inputSchema.properties || {}
          const toolProperties = { ...properties }
          for (const key in toolProperties) {
            if (!toolProperties[key].description) {
              toolProperties[key].description = 'Params of ' + key
            }
          }

          results.push({
            type: 'function',
            function: {
              name: finalName,
              description: finalDescription,
              parameters: {
                type: 'object',
                properties: toolProperties,
                required: Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []
              }
            },
            server: {
              name: client.serverName,
              icons: client.serverConfig.icons as string,
              description: client.serverConfig.descriptions as string
            }
          })

          // Populate the target map
          if (this.toolNameToTargetMap) {
            this.toolNameToTargetMap.set(finalName, { client: client, originalName: originalName })
          }
        }
      } catch (error: unknown) {
        // Log error but continue building results from other clients
        const errorMessage = error instanceof Error ? error.message : String(error)
        const serverName = client.serverName || 'Unknown server'
        console.error(
          `Pass 2 Error: Error processing tools from server '${serverName}':`,
          errorMessage
        )
        // Maybe skip adding tools from this client if listTools fails here again,
        // though it succeeded in Pass 1. Or rely on the notification from Pass 1.
        continue // Continue to next client
      }
    }

    // Cache results and return
    this.cachedToolDefinitions = results
    console.info(`Cached ${results.length} final tool definitions and populated target map.`)

    if (enabledTools && enabledTools.length > 0) {
      const enabledSet = new Set(enabledTools)
      return this.cachedToolDefinitions.filter((toolDef) => {
        const finalName = toolDef.function.name
        const originalName = this.toolNameToTargetMap?.get(finalName)?.originalName || finalName
        return enabledSet.has(finalName) || enabledSet.has(originalName)
      })
    }

    return this.cachedToolDefinitions
  }

  // 确定权限类型的新方法
  private determinePermissionType(
    toolName: string,
    parsedArgs?: Record<string, unknown> | null
  ): 'read' | 'write' | 'all' {
    const lowerToolName = toolName.toLowerCase()
    // 1) If explicit required_permission is provided, honor it directly (no max)
    const v = parsedArgs?.['required_permission']
    if (v === 'write') return 'write'
    if (v === 'read') return 'read'

    // 2) Otherwise, use heuristic H(toolName,args)
    if (lowerToolName === 'shell' && parsedArgs && parsedArgs['command']) {
      try {
        const cmd = parsedArgs['command'] as unknown
        const argv = Array.isArray(cmd) ? (cmd as unknown[]).map(String) : []
        const joined = argv.join(' ')
        const lowerJoined = joined.toLowerCase()
        const hasRedirect = />|>>|2>|1>|\s>\s|\s>>\s|\|\s*tee\b|sed\s+-i\b|perl\s+-pi?\b/.test(
          lowerJoined
        )
        const psWritePattern =
          /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Item|Clear-Content|Set-Acl|New-ItemProperty|Set-ItemProperty|Remove-ItemProperty)\b/i
        const cmdWritePattern =
          /\b(del|erase|ren|rename|copy|move|md|rd|mkdir|rmdir|xcopy|robocopy|mklink|attrib|icacls|takeown|ftype|assoc)\b/i
        const tarExtractPattern = /\btar\b.*\b(-x|--extract)\b/
        const unzipPattern = /\b(unzip|7z|7za|unrar|gunzip|bunzip2|xz)\b/
        const first = argv[0]?.toLowerCase?.() || ''
        const writeVerbs = [
          'rm',
          'mv',
          'cp',
          'install',
          'chmod',
          'chown',
          'mkdir',
          'rmdir',
          'truncate',
          'dd',
          'ln',
          'touch',
          'vi',
          'vim',
          'nvim',
          'nano',
          'emacs',
          'ed',
          'ex',
          'curl',
          'wget',
          'aria2c',
          'tar',
          'bsdtar',
          'unzip',
          'gunzip',
          'bunzip2',
          'xz',
          '7z',
          '7za',
          'unrar',
          'rsync',
          'scp',
          'sftp',
          'git',
          'hg',
          'svn',
          'make',
          'cmake',
          'ninja',
          'apt',
          'apt-get',
          'yum',
          'dnf',
          'pacman',
          'apk',
          'brew',
          'pip',
          'pip3',
          'pipx',
          'conda',
          'gem',
          'cargo',
          'go',
          'rustup',
          'npm',
          'pnpm',
          'yarn',
          'docker',
          'podman',
          'kubectl',
          'helm',
          'compose',
          'docker-compose',
          'del',
          'erase',
          'ren',
          'rename',
          'copy',
          'move',
          'md',
          'rd',
          'xcopy',
          'robocopy',
          'mklink',
          'attrib',
          'icacls',
          'takeown',
          'ftype',
          'assoc',
          'reg',
          'powershell',
          'pwsh'
        ]
        const isWriteVerb = writeVerbs.some((w) => first === w || lowerJoined.startsWith(w + ' '))
        const hasPsWrite =
          (first === 'powershell' || first === 'pwsh') && psWritePattern.test(joined)
        const hasCmdWrite =
          (first === 'cmd' || first === 'cmd.exe') && cmdWritePattern.test(lowerJoined)
        const hasExtract = tarExtractPattern.test(lowerJoined) || unzipPattern.test(lowerJoined)
        return hasRedirect || isWriteVerb || hasPsWrite || hasCmdWrite || hasExtract
          ? 'write'
          : 'read'
      } catch {
        return 'write'
      }
    }

    // Name-based heuristic for all other tools
    if (
      lowerToolName.includes('read') ||
      lowerToolName.includes('list') ||
      lowerToolName.includes('get') ||
      lowerToolName.includes('show') ||
      lowerToolName.includes('view') ||
      lowerToolName.includes('fetch') ||
      lowerToolName.includes('search') ||
      lowerToolName.includes('find') ||
      lowerToolName.includes('query') ||
      lowerToolName.includes('tree') ||
      lowerToolName.includes('info') // treat *_info and similar as read-only
    ) {
      return 'read'
    }
    if (
      lowerToolName.includes('write') ||
      lowerToolName.includes('create') ||
      lowerToolName.includes('update') ||
      lowerToolName.includes('delete') ||
      lowerToolName.includes('modify') ||
      lowerToolName.includes('edit') ||
      lowerToolName.includes('remove') ||
      lowerToolName.includes('add') ||
      lowerToolName.includes('insert') ||
      lowerToolName.includes('save') ||
      lowerToolName.includes('execute') ||
      lowerToolName.includes('run') ||
      lowerToolName.includes('call') ||
      lowerToolName.includes('move') ||
      lowerToolName.includes('copy') ||
      lowerToolName.includes('mkdir') ||
      lowerToolName.includes('rmdir')
    ) {
      return 'write'
    }
    return 'write'
  }

  // 检查工具调用权限
  private checkToolPermission(
    originalToolName: string,
    autoApprove: string[],
    parsedArgs?: Record<string, unknown> | null
  ): boolean {
    // If server has 'all', allow
    if (autoApprove.includes('all')) return true

    const permissionType = this.determinePermissionType(originalToolName, parsedArgs)
    // If specific permission approved, allow
    if (autoApprove.includes(permissionType)) return true
    return false
  }

  async callTool(toolCall: MCPToolCall): Promise<MCPToolResponse> {
    try {
      const finalName = toolCall.function.name
      const argsString = toolCall.function.arguments

      // Full arguments logging (debug)
      console.info('[MCP] Call', {
        toolCallId: toolCall.id,
        tool: finalName,
        server: toolCall.server?.name || 'unknown',
        rawArguments: argsString
      })

      // Ensure definitions and map are loaded/cached
      await this.getAllToolDefinitions()

      if (!this.toolNameToTargetMap) {
        console.error('Tool target map is not available.')
        return {
          toolCallId: toolCall.id,
          content: `Error: Internal error - tool information not available.`,
          isError: true
        }
      }

      const targetInfo = this.toolNameToTargetMap.get(finalName)

      if (!targetInfo) {
        console.error(`Tool '${finalName}' not found in the target map.`)
        return {
          toolCallId: toolCall.id,
          content: `Error: Tool '${finalName}' not found or server not running.`,
          isError: true
        }
      }

      const { client: targetClient, originalName } = targetInfo
      const toolServerName = targetClient.serverName

      // Log the call details including original name (full)
      console.info('[MCP] ToolManager calling tool', {
        requestedName: finalName,
        originalName: originalName,
        serverName: toolServerName,
        rawArguments: argsString
      })

      // Parse arguments
      let args: Record<string, unknown> | null = null
      try {
        args = JSON.parse(argsString)
      } catch (error: unknown) {
        console.warn(
          'Error parsing tool call arguments with JSON.parse, trying jsonrepair:',
          error instanceof Error ? error.message : String(error)
        )
        try {
          args = JSON.parse(jsonrepair(argsString))
        } catch (e: unknown) {
          console.error('Error parsing tool call arguments even after jsonrepair:', argsString, e)
          // Decide how to handle: return error or proceed with empty args?
          // Let's proceed with empty args for now, mirroring previous behavior.
          args = {}
        }
      }

      // Get server configuration
      const servers = await this.configPresenter.getMcpServers()
      const serverConfig = servers[toolServerName]
      if (!serverConfig) {
        console.error(`Configuration for server '${toolServerName}' not found.`)
        return {
          toolCallId: toolCall.id,
          content: `Error: Configuration missing for server '${toolServerName}'.`,
          isError: true
        }
      }
      const autoApprove = serverConfig?.autoApprove || []
      // 先计算本次调用的 Required（结合显式 required_permission 与启发式）
      const requiredPermission = this.determinePermissionType(originalName, args)
      // 一次性授权：server|tool 维度消费
      let hasPermission = false
      const otKey = `${toolServerName}|${originalName}`
      const oneTime = this.oneTimeGrantsByServerTool.get(otKey)
      if (oneTime && this.covers(oneTime, requiredPermission)) {
        hasPermission = true
        this.oneTimeGrantsByServerTool.delete(otKey)
        console.log('[ToolManager] One-time grant consumed (server/tool).')
      }
      if (!hasPermission) {
        // Use originalName for permission check (silent)
        hasPermission = this.checkToolPermission(originalName, autoApprove, args)
      }

      if (!hasPermission) {
        // Single, concise permission-required log
        const permissionType = requiredPermission

        // Return permission request instead of error
        try {
          const previewArgs = (() => {
            try {
              return JSON.stringify(args)?.slice(0, 500)
            } catch {
              return String(args).slice(0, 500)
            }
          })()
          console.info('[MCP] Perm.require', {
            toolCallId: toolCall.id,
            tool: originalName,
            server: toolServerName,
            permissionType,
            argsPreview: previewArgs
          })
        } catch {}
        return {
          toolCallId: toolCall.id,
          content: `components.messageBlockPermissionRequest.description.${permissionType}`,
          isError: false,
          requiresPermission: true,
          permissionRequest: {
            toolName: originalName,
            serverName: toolServerName,
            permissionType,
            description: `Allow ${originalName} to perform ${permissionType} operations on ${toolServerName}?`
          }
        }
      }

      // Call the tool on the target client using the ORIGINAL name
      const result = await targetClient.callTool(originalName, args || {})
      const anyRes = result as unknown as { structured_content?: any }
      const exitCode = (() => {
        try {
          return anyRes &&
            anyRes.structured_content &&
            typeof anyRes.structured_content.exit_code === 'number'
            ? (anyRes.structured_content.exit_code as number)
            : undefined
        } catch {
          return undefined
        }
      })()

      // Format response
      let formattedContent: string | MCPContentItem[] = ''
      if (typeof result.content === 'string') {
        formattedContent = result.content
      } else if (Array.isArray(result.content)) {
        formattedContent = result.content.map((item): MCPContentItem => {
          if (typeof item === 'string') {
            return { type: 'text', text: item } as MCPTextContent
          }
          if (item.type === 'text' || item.type === 'image' || item.type === 'resource') {
            return item as MCPContentItem
          }
          if (item.type && item.text) {
            return { type: 'text', text: item.text } as MCPTextContent
          }
          return { type: 'text', text: JSON.stringify(item) } as MCPTextContent
        })
      } else if (result.content) {
        formattedContent = JSON.stringify(result.content)
      }

      const response: MCPToolResponse = {
        toolCallId: toolCall.id,
        content: formattedContent,
        isError: result.isError || (typeof exitCode === 'number' && exitCode !== 0)
      }

      // Log tool result with full content for debugging
      try {
        try {
          console.info('[MCP] Tool full result', JSON.stringify(result, null, 2))
        } catch {
          console.info('[MCP] Tool full result (raw object printed next):')
          // eslint-disable-next-line no-console
          console.info(result)
        }
        const MAX_LOG_CHARS = 1000
        const summarizeArrayContent = (items: unknown[]): unknown => {
          // Only log types and short previews to avoid huge dumps
          return items.slice(0, 5).map((it) => {
            if (typeof it === 'string')
              return { type: 'text', preview: JSON.stringify(it).slice(0, 200) }
            const anyItem = it as {
              type?: string
              text?: string
              mimeType?: string
              resource?: unknown
            }
            if (anyItem && anyItem.type === 'text' && typeof anyItem.text === 'string') {
              return { type: 'text', preview: JSON.stringify(anyItem.text).slice(0, 200) }
            }
            if (anyItem && anyItem.type === 'image') {
              return { type: 'image', mimeType: anyItem.mimeType || 'unknown' }
            }
            if (anyItem && anyItem.type === 'resource') {
              return { type: 'resource' }
            }
            return { type: typeof it }
          })
        }
        const contentSummary = (() => {
          if (typeof result.content === 'string') {
            const s = JSON.stringify(result.content)
            return { kind: 'string', length: s.length, preview: s.slice(0, MAX_LOG_CHARS) }
          }
          if (Array.isArray(result.content)) {
            return {
              kind: 'array',
              length: result.content.length,
              items: summarizeArrayContent(result.content)
            }
          }
          return { kind: typeof result.content }
        })()
        const structuredSummary = (() => {
          const anyRes = result as unknown as { structured_content?: any }
          if (!anyRes || !anyRes.structured_content) return undefined
          const sc = anyRes.structured_content
          const keys = [
            'exit_code',
            'duration_seconds',
            'timed_out',
            'line_count',
            'truncated',
            'budgets',
            'effective_arguments'
          ]
          const out: Record<string, unknown> = {}
          for (const k of keys) if (k in sc) out[k] = sc[k]
          return out
        })()
        console.info('[MCP] Tool result', {
          toolCallId: toolCall.id,
          tool: originalName,
          server: toolServerName,
          isError: result.isError,
          content: contentSummary,
          structured: structuredSummary
        })
      } catch (e) {
        console.warn('[MCP] Failed to log tool result preview:', e)
      }

      // Trigger event
      eventBus.send(MCP_EVENTS.TOOL_CALL_RESULT, SendTarget.ALL_WINDOWS, response)

      return response
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('Unhandled error during tool call:', error)
      return {
        toolCallId: toolCall.id,
        content: `Error: Failed to execute tool '${toolCall.function.name}': ${errorMessage}`,
        isError: true
      }
    }
  }

  // 根据客户端名称获取提示模板内容
  async getPromptByClient(
    clientName: string,
    promptName: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    try {
      const clients = await this.getRunningClients()

      // 查找指定的客户端
      const client = clients.find((c) => c.serverName === clientName)
      if (!client) {
        throw new Error(`MCP client not found: ${clientName}`)
      }

      if (typeof client.getPrompt !== 'function') {
        throw new Error(`MCP client ${clientName} does not support getting prompt templates`)
      }

      return await client.getPrompt(promptName, params)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('Failed to get prompt template:', errorMessage)
      throw new Error(`Failed to get prompt template: ${errorMessage}`)
    }
  }

  // 根据客户端名称读取资源内容
  async readResourceByClient(clientName: string, resourceUri: string): Promise<Resource> {
    try {
      const clients = await this.getRunningClients()

      // 查找指定的客户端
      const client = clients.find((c) => c.serverName === clientName)
      if (!client) {
        throw new Error(`MCP client not found: ${clientName}`)
      }

      if (typeof client.readResource !== 'function') {
        throw new Error(`MCP client ${clientName} does not support reading resources`)
      }

      return await client.readResource(resourceUri)
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('Failed to read resource:', errorMessage)
      throw new Error(`Failed to read resource: ${errorMessage}`)
    }
  }

  // 权限管理方法
  async grantPermission(
    serverName: string,
    permissionType: 'read' | 'write' | 'all',
    remember: boolean = true,
    toolName?: string
  ): Promise<void> {
    console.log(
      `[ToolManager] Granting permission: ${permissionType} for server: ${serverName}, remember: ${remember}`
    )

    if (remember) {
      // Persist to configuration (prefer server+tool granularity if toolName provided)
      try {
        const servers = await this.configPresenter.getMcpServers()
        const serverConfig = servers[serverName]
        if (!serverConfig) throw new Error(`Server config not found: ${serverName}`)

        if (toolName && toolName.trim()) {
          const cfg: any = { ...serverConfig }
          const taa: Record<string, Array<'read' | 'write' | 'all'>> = cfg.toolsAutoApprove || {}
          const list = taa[toolName] || []
          const eff = permissionType === 'all' ? 'all' : permissionType
          if (!list.includes(eff)) list.push(eff)
          taa[toolName] = list
          cfg.toolsAutoApprove = taa
          await this.configPresenter.updateMcpServer(serverName, cfg)
          console.log(`[ToolManager] Updated toolsAutoApprove for ${serverName}/${toolName}:`, list)
        } else {
          await this.updateServerPermissions(serverName, permissionType)
        }
      } catch (e) {
        console.warn('[ToolManager] Persist permission failed, fallback to server-level:', e)
        await this.updateServerPermissions(serverName, permissionType)
      }
    } else {
      // One-time permission: in-memory server|tool grant
      const effective: 'read' | 'write' = permissionType === 'all' ? 'write' : permissionType
      if (toolName) {
        let resolvedToolName = toolName
        try {
          await this.getAllToolDefinitions()
          const entry = this.toolNameToTargetMap?.get(toolName)
          if (entry?.originalName) resolvedToolName = entry.originalName
        } catch {}
        const key = `${serverName}|${resolvedToolName}`
        this.oneTimeGrantsByServerTool.set(key, effective)
        console.log('[ToolManager] Temporary one-time grant recorded (server/tool).')
      }
    }
  }

  private async updateServerPermissions(
    serverName: string,
    permissionType: 'read' | 'write' | 'all'
  ): Promise<void> {
    try {
      console.log(`[ToolManager] Updating server ${serverName} permissions: ${permissionType}`)
      const servers = await this.configPresenter.getMcpServers()
      const serverConfig = servers[serverName]

      if (serverConfig) {
        let autoApprove = [...(serverConfig.autoApprove || [])]

        // If 'all' permission already exists, no need to add specific permissions
        if (autoApprove.includes('all')) {
          console.log(`Server ${serverName} already has 'all' permissions`)
          return
        }

        // If requesting 'all' permission, remove specific permissions and add 'all'
        if (permissionType === 'all') {
          autoApprove = autoApprove.filter((p) => p !== 'read' && p !== 'write')
          autoApprove.push('all')
        } else {
          // Add the specific permission if not already present
          if (!autoApprove.includes(permissionType)) {
            autoApprove.push(permissionType)
          }
        }

        console.log(
          `[ToolManager] Before update - Server ${serverName} permissions:`,
          serverConfig.autoApprove || []
        )
        console.log(`[ToolManager] After update - Server ${serverName} permissions:`, autoApprove)

        // Update server configuration
        await this.configPresenter.updateMcpServer(serverName, {
          ...serverConfig,
          autoApprove
        })

        console.log(
          `[ToolManager] Successfully updated server ${serverName} permissions to:`,
          autoApprove
        )

        // Verify the update by reading back
        const updatedServers = await this.configPresenter.getMcpServers()
        const updatedConfig = updatedServers[serverName]
        console.log(
          `[ToolManager] Verification - Server ${serverName} current permissions:`,
          updatedConfig?.autoApprove || []
        )
      } else {
        console.error(`[ToolManager] Server configuration not found for: ${serverName}`)
      }
    } catch (error) {
      console.error('[ToolManager] Failed to update server permissions:', error)
    }
  }

  public destroy(): void {
    eventBus.off(MCP_EVENTS.CLIENT_LIST_UPDATED, this.handleServerListUpdate)
    eventBus.off(MCP_EVENTS.CONFIG_CHANGED, this.handleConfigChange)
  }
}
