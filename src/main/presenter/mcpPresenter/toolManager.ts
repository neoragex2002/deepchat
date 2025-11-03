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
  // 一次性授权：仅针对某个 toolCallId + 权限，在本次调用中放行
  private tempApprovals: Map<string, 'read' | 'write'> = new Map()
  // 一次性授权（补充）：针对 server + 权限 的单次放行，用于权限授予后重新发起导致 toolCallId 变化的场景
  private tempApprovalsByServer: Map<string, 'read' | 'write'> = new Map()

  constructor(configPresenter: IConfigPresenter, serverManager: ServerManager) {
    this.configPresenter = configPresenter
    this.serverManager = serverManager
    eventBus.on(MCP_EVENTS.CLIENT_LIST_UPDATED, this.handleServerListUpdate)
    eventBus.on(MCP_EVENTS.CONFIG_CHANGED, this.handleConfigChange)
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
    serverName: string,
    autoApprove: string[],
    parsedArgs?: Record<string, unknown> | null
  ): boolean {
    console.log(
      `[ToolManager] Checking permissions for tool '${originalToolName}' on server '${serverName}' with autoApprove:`,
      autoApprove
    )

    // 如果有 'all' 权限，则允许所有操作
    if (autoApprove.includes('all')) {
      console.log(`[ToolManager] Permission granted: server '${serverName}' has 'all' permissions`)
      return true
    }

    const permissionType = this.determinePermissionType(originalToolName, parsedArgs)
    console.log(`[ToolManager] Tool '${originalToolName}' requires '${permissionType}' permission`)

    // Check if the specific permission type is approved
    if (autoApprove.includes(permissionType)) {
      console.log(
        `[ToolManager] Permission granted: server '${serverName}' has '${permissionType}' permission`
      )
      return true
    }

    console.log(
      `[ToolManager] Permission required for tool '${originalToolName}' on server '${serverName}'.`
    )
    return false
  }

  async callTool(toolCall: MCPToolCall): Promise<MCPToolResponse> {
    try {
      const finalName = toolCall.function.name
      const argsString = toolCall.function.arguments

      console.log(`[ToolManager] Calling tool:`, {
        requestedName: finalName,
        originalName: finalName,
        serverName: toolCall.server?.name || 'unknown',
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

      // Log the call details including original name
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
      console.log(
        `Checking permissions for tool '${originalName}' on server '${toolServerName}' with autoApprove:`,
        autoApprove
      )
      // 先计算本次调用的 Required（结合显式 required_permission 与启发式）
      const requiredPermission = this.determinePermissionType(originalName, args)
      // 一次性授权：若命中 tempApprovals 且权限匹配，则消费并放行
      let hasPermission = false
      const tempKey = toolCall.id
      if (this.tempApprovals.has(tempKey)) {
        const granted = this.tempApprovals.get(tempKey)
        if (granted === 'write' || granted === requiredPermission) {
          hasPermission = true
          this.tempApprovals.delete(tempKey)
          console.log(`[ToolManager] One-time permission consumed for ${tempKey}: ${granted}`)
        }
      }
      // 补充：如果 toolCallId 已变更，则使用 server+permission 的一次性授权键
      if (!hasPermission) {
        const serverKey = `${toolServerName}:${requiredPermission}`
        if (this.tempApprovalsByServer.has(serverKey)) {
          const granted = this.tempApprovalsByServer.get(serverKey)
          if (granted === 'write' || granted === requiredPermission) {
            hasPermission = true
            this.tempApprovalsByServer.delete(serverKey)
            console.log(`[ToolManager] One-time permission consumed for ${serverKey}: ${granted}`)
          }
        }
      }
      if (!hasPermission) {
        // Use originalName and toolServerName for permission check
        hasPermission = this.checkToolPermission(originalName, toolServerName, autoApprove, args)
      }

      if (!hasPermission) {
        console.warn(
          `Permission required for tool '${originalName}' on server '${toolServerName}'.`
        )

        const permissionType = requiredPermission

        // Return permission request instead of error
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
        isError: result.isError
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
    toolCallId?: string
  ): Promise<void> {
    console.log(
      `[ToolManager] Granting permission: ${permissionType} for server: ${serverName}, remember: ${remember}`
    )

    if (remember) {
      // Persist to configuration
      await this.updateServerPermissions(serverName, permissionType)
    } else {
      // One-time permission: toolCallId-scoped（若存在）与 server-scoped（兜底）
      const effective: 'read' | 'write' = permissionType === 'all' ? 'write' : permissionType
      if (toolCallId) {
        this.tempApprovals.set(toolCallId, effective)
        console.log(`[ToolManager] Temporary permission granted for ${toolCallId}`)
      }
      const serverKey = `${serverName}:${effective}`
      this.tempApprovalsByServer.set(serverKey, effective)
      console.log(`[ToolManager] Temporary server-level permission granted for ${serverKey}`)
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
