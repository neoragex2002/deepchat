import {
  IThreadPresenter,
  CONVERSATION,
  CONVERSATION_SETTINGS,
  MESSAGE_ROLE,
  MESSAGE_STATUS,
  MESSAGE_METADATA,
  SearchResult,
  MODEL_META,
  ISQLitePresenter,
  IConfigPresenter,
  ILlmProviderPresenter,
  ChatMessage,
  ChatMessageContent,
  LLMAgentEventData
} from '../../../shared/presenter'
import { presenter } from '@/presenter'
import { MessageManager } from './messageManager'
import { eventBus, SendTarget } from '@/eventbus'
import {
  AssistantMessage,
  Message,
  AssistantMessageBlock,
  SearchEngineTemplate,
  UserMessage,
  MessageFile,
  UserMessageContent,
  UserMessageTextBlock,
  UserMessageMentionBlock,
  UserMessageCodeBlock
} from '@shared/chat'
import { ModelType } from '@shared/model'
import { approximateTokenSize } from 'tokenx'
import { generateSearchPrompt, SearchManager } from './searchManager'
import { getFileContext } from './fileContext'
import { ContentEnricher } from './contentEnricher'
import { CONVERSATION_EVENTS, STREAM_EVENTS, TAB_EVENTS } from '@/events'
import { DEFAULT_SETTINGS } from './const'
import { DEBUG } from '@shared/debug'

interface GeneratingMessageState {
  message: AssistantMessage
  conversationId: string
  startTime: number
  firstTokenTime: number | null
  promptTokens: number
  reasoningStartTime: number | null
  reasoningEndTime: number | null
  lastReasoningTime: number | null
  isSearching?: boolean
  isCancelled?: boolean
  // 调试：实例标识，用于追踪同一 messageId 的状态对象更替
  __id?: number
  totalUsage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    context_length: number
  }
  // 统一的自适应内容处理
  adaptiveBuffer?: {
    content: string
    lastUpdateTime: number
    updateCount: number
    totalSize: number
    isLargeContent: boolean
    chunks?: string[]
    currentChunkIndex?: number
    // 精确追踪已发送内容的位置
    sentPosition: number // 已发送到渲染器的内容位置
    isProcessing?: boolean
  }
  flushTimeout?: NodeJS.Timeout
  throttleTimeout?: NodeJS.Timeout
  lastRendererUpdateTime?: number
  // 防止对同一消息启动并发的 continue 流
  continuationInProgress?: boolean
}

export class ThreadPresenter implements IThreadPresenter {
  private sqlitePresenter: ISQLitePresenter
  private messageManager: MessageManager
  private llmProviderPresenter: ILlmProviderPresenter
  private configPresenter: IConfigPresenter
  private searchManager: SearchManager
  private generatingMessages: Map<string, GeneratingMessageState> = new Map()
  public searchAssistantModel: MODEL_META | null = null
  public searchAssistantProviderId: string | null = null
  private searchingMessages: Set<string> = new Set()
  private activeConversationIds: Map<number, string> = new Map()
  private fetchThreadLength: number = 300
  // 调试：是否输出 Step/权限块摘要与内容快照
  private static readonly DEBUG_STEP_LOG = false
  // IO 日志：是否输出工具调用的完整请求与响应
  private static readonly DEBUG_TOOL_IO_LOG = true
  // 生成状态对象自增ID
  private genStateSeq: number = 0
  // 待执行的 continuation（单位排队，coalesce）
  private pendingContinuation: Set<string> = new Set()

  constructor(
    sqlitePresenter: ISQLitePresenter,
    llmProviderPresenter: ILlmProviderPresenter,
    configPresenter: IConfigPresenter
  ) {
    this.sqlitePresenter = sqlitePresenter
    this.messageManager = new MessageManager(sqlitePresenter)
    this.llmProviderPresenter = llmProviderPresenter
    this.searchManager = new SearchManager()
    this.configPresenter = configPresenter

    // 监听Tab关闭事件，清理绑定关系
    eventBus.on(TAB_EVENTS.CLOSED, (tabId: number) => {
      if (this.activeConversationIds.has(tabId)) {
        this.activeConversationIds.delete(tabId)
        console.log(`ThreadPresenter: Cleaned up conversation binding for closed tab ${tabId}.`)
      }
    })
    eventBus.on(TAB_EVENTS.RENDERER_TAB_READY, () => {
      this.broadcastThreadListUpdate()
    })

    // 初始化时处理所有未完成的消息
    this.messageManager.initializeUnfinishedMessages()
  }

  private audit(tag: string, msgId: string, where: string, extra?: Record<string, unknown>) {
    if (!DEBUG.TP_AUDIT_LOG) return
    try {
      const payload: Record<string, unknown> = { ts: Date.now(), tag, msgId, where }
      if (extra && typeof extra === 'object') {
        for (const [k, v] of Object.entries(extra)) payload[k] = v
      }
      console.log(JSON.stringify(payload))
    } catch {}
  }

  // 在错误落库前，先把内存中的部分生成内容持久化，避免丢失用户已看到的文本
  private async persistInMemoryContentBeforeError(messageId: string): Promise<void> {
    const st = this.generatingMessages.get(messageId)
    if (!st) return
    try {
      const { message, revision } = await this.messageManager.editMessageSilently(
        messageId,
        JSON.stringify(st.message.content)
      )
      this.emitMessageEdited(messageId, revision, message.parentId)
    } catch (e) {
      console.warn('[ErrorGuard] Failed to persist partial content before error:', e)
    }
  }

  private emitMessageEdited(messageId: string, revision: number, parentId?: string | null) {
    try {
      eventBus.sendToRenderer(CONVERSATION_EVENTS.MESSAGE_EDITED, SendTarget.ALL_WINDOWS, {
        messageId,
        revision
      })
      if (parentId) {
        eventBus.sendToRenderer(
          CONVERSATION_EVENTS.MESSAGE_EDITED,
          SendTarget.ALL_WINDOWS,
          parentId
        )
      }
      this.audit('ME.emit', messageId, 'TP', { rev: revision })
    } catch {}
  }

  /**
   * 新增：查找指定会话ID所在的Tab ID
   * @param conversationId 会话ID
   * @returns 如果找到，返回tabId，否则返回null
   */
  async findTabForConversation(conversationId: string): Promise<number | null> {
    for (const [tabId, activeId] of this.activeConversationIds.entries()) {
      if (activeId === conversationId) {
        // 验证该tab是否还真实存在
        const tabView = await presenter.tabPresenter.getTab(tabId)
        if (tabView && !tabView.webContents.isDestroyed()) {
          return tabId
        }
      }
    }
    return null
  }

  private async getTabWindowType(tabId: number): Promise<'floating' | 'main' | 'unknown'> {
    try {
      const tabView = await presenter.tabPresenter.getTab(tabId)
      if (!tabView) {
        return 'unknown'
      }
      const windowId = presenter.tabPresenter['tabWindowMap'].get(tabId)
      return windowId ? 'main' : 'floating'
    } catch (error) {
      console.error('Error determining tab window type:', error)
      return 'unknown'
    }
  }

  async handleLLMAgentError(msg: LLMAgentEventData) {
    const { eventId, error } = msg
    const state = this.generatingMessages.get(eventId)
    if (state) {
      // 刷新剩余缓冲内容
      if (state.adaptiveBuffer) {
        await this.flushAdaptiveBuffer(eventId)
      }

      // 清理缓冲相关资源
      this.cleanupContentBuffer(state)

      // 先持久化内存中的部分生成内容，避免错误覆盖掉用户已看到的文本
      await this.persistInMemoryContentBeforeError(eventId)

      try {
        const { message, revision } = await this.messageManager.handleMessageError(
          eventId,
          String(error)
        )
        this.emitMessageEdited(eventId, revision, message.parentId)
      } catch {}
      this.generatingMessages.delete(eventId)
    }
    eventBus.sendToRenderer(STREAM_EVENTS.ERROR, SendTarget.ALL_WINDOWS, msg)
    this.audit('ERR', eventId, 'S1')
  }

  async handleLLMAgentEnd(msg: LLMAgentEventData) {
    const { eventId, userStop } = msg
    const state = this.generatingMessages.get(eventId)
    if (state) {
      console.log(
        `[ThreadPresenter] Handling LLM agent end for message: ${eventId}, userStop: ${userStop}`
      )

      // 统一准则：以 DB 为准。先刷新当前助手消息的最新内容，避免使用过期的内存态覆盖最新内容
      try {
        /* no-op: keep in-memory content; do not refresh from DB at END */
      } catch (e) {
        console.warn('[ThreadPresenter] Failed to refresh latest message before END handling:', e)
      }

      // NEW (collect-only): If provider sent planned_tool_calls at END, create permission blocks once
      try {
        let planned = (
          msg as unknown as {
            planned_tool_calls?: { id: string; name: string; arguments: string }[]
          }
        ).planned_tool_calls
        if (planned && Array.isArray(planned) && planned.length > 0) {
          console.log(
            `[Permission] planned_tool_calls at END for message ${eventId}:`,
            planned.map((p) => p.name)
          )
          // 不做 planned 去重过滤，保持最小流程，交由后续授权/执行阶段自然处理
          // Resolve server info by tool name
          let toolDefs: Array<{
            function: { name: string }
            server: { name: string; icons: string; description: string }
          }> = []
          try {
            toolDefs = await presenter.mcpPresenter.getAllToolDefinitions()
          } catch (e) {
            console.warn(
              '[ThreadPresenter] Failed to fetch tool definitions for permission blocks:',
              e
            )
          }
          const defMap = new Map<
            string,
            { server: { name: string; icons: string; description: string } }
          >()
          for (const td of toolDefs) defMap.set(td.function.name, { server: td.server })

          const now = Date.now()
          let pendingCount = 0
          let grantedCount = 0
          let deniedCount = 0
          // 基于最新内容进行合并修改
          const content = state.message.content as AssistantMessageBlock[]
          for (const call of planned) {
            const serverInfo = defMap.get(call.name)?.server
            const serverName = serverInfo?.name || ''
            const serverIcons = serverInfo?.icons || ''
            const serverDescription = serverInfo?.description || ''
            // Pre-judge via ToolManager Auth Decider
            let decision: 'AUTO_GRANT' | 'AUTO_DENY' | 'REQUIRE_USER_PERMISSION' =
              'REQUIRE_USER_PERMISSION'
            let required: 'read' | 'write' | 'all' = 'write'
            try {
              const res = await (presenter.mcpPresenter as any).decideToolCallPermission(
                serverName,
                call.name,
                call.arguments
              )
              decision = res.decision
              required = res.required
            } catch (e) {
              console.warn('[ThreadPresenter] Auth decider failed, fallback to pending:', e)
            }

            const block: AssistantMessageBlock = {
              type: 'action',
              action_type: 'tool_call_permission',
              content: 'Permission required for this operation',
              status:
                decision === 'AUTO_GRANT'
                  ? 'granted'
                  : decision === 'AUTO_DENY'
                    ? 'denied'
                    : 'pending',
              timestamp: now,
              tool_call: {
                id: call.id,
                name: call.name,
                params: call.arguments,
                server_name: serverName,
                server_icons: serverIcons,
                server_description: serverDescription
              },
              extra: {
                permissionType: required,
                serverName,
                toolName: call.name,
                needsUserAction: decision === 'REQUIRE_USER_PERMISSION',
                permissionRequest: JSON.stringify({
                  toolName: call.name,
                  serverName,
                  permissionType: required,
                  description: 'Permission required for this operation'
                })
              }
            }
            content.push(block)
            if (block.status === 'pending') pendingCount++
            else if (block.status === 'granted') grantedCount++
            else if (block.status === 'denied') deniedCount++
          }
          {
            const { message, revision } = await this.messageManager.editMessageSilently(
              eventId,
              JSON.stringify(content)
            )
            this.emitMessageEdited(eventId, revision, message.parentId)
          }
          try {
            state.message.content = content
          } catch {}
          this.audit('ME', eventId, 'END.inject')
          this.logPermissionSummary(state.message.content, `END.inject`, eventId)
          console.log(
            `[Permission] Injected ${planned.length} blocks (pending=${pendingCount}, granted=${grantedCount}, denied=${deniedCount}) for message ${eventId}`
          )
          // Permission gating: if no pending items, act immediately
          if (pendingCount === 0) {
            if (grantedCount >= 1) {
              // 通知渲染层本轮 Provider 流已结束（确保 UI 刷新并展示已注入的块）
              eventBus.sendToRenderer(STREAM_EVENTS.END, SendTarget.ALL_WINDOWS, msg)
              this.audit('END', eventId, 'S1')
              await this.executeGrantedToolsAndContinue(eventId)
            } else {
              // 通知渲染层 END，再继续作答流程
              eventBus.sendToRenderer(STREAM_EVENTS.END, SendTarget.ALL_WINDOWS, msg)
              this.audit('END', eventId, 'S1')
              await this.continueAfterAllDenied(eventId)
            }
            return
          }
          // Otherwise keep message in generating state, waiting for user actions
          // 即便等待用户授权，也需要向渲染层发送 END，触发前端解除“生成中”并刷新消息内容
          eventBus.sendToRenderer(STREAM_EVENTS.END, SendTarget.ALL_WINDOWS, msg)
          this.audit('END', eventId, 'S1')
          return
        }
      } catch (e) {
        console.warn('[ThreadPresenter] Failed to handle planned_tool_calls at END:', e)
      }

      // 检查是否有未处理的权限请求
      // 基于最新 DB 刷新后的内容判断 pending
      const hasPendingPermissions = (state.message.content as AssistantMessageBlock[]).some(
        (block) =>
          block.type === 'action' &&
          block.action_type === 'tool_call_permission' &&
          block.status === 'pending'
      )

      if (hasPendingPermissions) {
        console.log(`[Permission] Pending permissions, keep generating (message ${eventId})`)
        // 保持消息在generating状态，等待权限响应
        // 但是要更新非权限块为success状态
        const content = state.message.content as AssistantMessageBlock[]
        content.forEach((block) => {
          if (
            !(block.type === 'action' && block.action_type === 'tool_call_permission') &&
            block.status === 'loading'
          ) {
            block.status = 'success'
          }
        })
        {
          const { message, revision } = await this.messageManager.editMessageSilently(
            eventId,
            JSON.stringify(content)
          )
          this.emitMessageEdited(eventId, revision, message.parentId)
        }
        try {
          state.message.content = content
        } catch {}
        this.logPermissionSummary(state.message.content, `END.pending`, eventId)
        // 处于 pending 状态同样需要向渲染层发送 END，让前端显示授权块并解除“生成中”
        eventBus.sendToRenderer(STREAM_EVENTS.END, SendTarget.ALL_WINDOWS, msg)
        return
      }

      console.log(`[Thread] Finalizing message ${eventId} - no pending permissions`)

      // 正常完成流程（无 pending 权限块）
      await this.finalizeMessage(state, eventId, userStop || false)
    }

    eventBus.sendToRenderer(STREAM_EVENTS.END, SendTarget.ALL_WINDOWS, msg)
    this.audit('END', eventId, 'S1')
  }

  // 清理所有缓冲相关资源
  private cleanupContentBuffer(state: GeneratingMessageState): void {
    if (state.flushTimeout) {
      clearTimeout(state.flushTimeout)
      state.flushTimeout = undefined
    }
    if (state.throttleTimeout) {
      clearTimeout(state.throttleTimeout)
      state.throttleTimeout = undefined
    }
    state.adaptiveBuffer = undefined
    state.lastRendererUpdateTime = undefined
  }

  // 完成消息的通用方法
  private async finalizeMessage(
    state: GeneratingMessageState,
    eventId: string,
    userStop: boolean
  ): Promise<void> {
    if (ThreadPresenter.DEBUG_STEP_LOG) {
      try {
        console.log('[Step/Finalize/Before]', {
          messageId: eventId,
          blocks: state.message.content?.length || 0
        })
      } catch {}
    }
    // 仅将内容类块设为 success；不触碰 tool_call 与权限块
    state.message.content.forEach((block) => {
      if (
        block.type === 'content' ||
        block.type === 'reasoning_content' ||
        block.type === 'image'
      ) {
        block.status = 'success'
      }
    })

    // 计算completion tokens
    let completionTokens = 0
    if (state.totalUsage) {
      completionTokens = state.totalUsage.completion_tokens
    } else {
      for (const block of state.message.content) {
        if (
          block.type === 'content' ||
          block.type === 'reasoning_content' ||
          block.type === 'tool_call'
        ) {
          completionTokens += approximateTokenSize(block.content)
        }
      }
    }

    // 检查是否有内容块
    const hasContentBlock = state.message.content.some(
      (block) =>
        block.type === 'content' ||
        block.type === 'reasoning_content' ||
        block.type === 'tool_call' ||
        block.type === 'image'
    )

    // 如果没有内容块，添加错误信息
    if (!hasContentBlock && !userStop) {
      state.message.content.push({
        type: 'error',
        content: 'common.error.noModelResponse',
        status: 'error',
        timestamp: Date.now()
      })
    }

    const totalTokens = state.promptTokens + completionTokens
    const generationTime = Date.now() - (state.firstTokenTime ?? state.startTime)
    const tokensPerSecond = completionTokens / (generationTime / 1000)
    const contextUsage = state?.totalUsage?.context_length
      ? (totalTokens / state.totalUsage.context_length) * 100
      : 0

    // 如果有reasoning_content，记录结束时间
    const metadata: Partial<MESSAGE_METADATA> = {
      totalTokens,
      inputTokens: state.promptTokens,
      outputTokens: completionTokens,
      generationTime,
      firstTokenTime: state.firstTokenTime ? state.firstTokenTime - state.startTime : 0,
      tokensPerSecond,
      contextUsage
    }

    if (state.reasoningStartTime !== null && state.lastReasoningTime !== null) {
      metadata.reasoningStartTime = state.reasoningStartTime - state.startTime
      metadata.reasoningEndTime = state.lastReasoningTime - state.startTime
    }

    // 刷新剩余缓冲内容
    if (state.adaptiveBuffer) {
      await this.flushAdaptiveBuffer(eventId)
    }

    // 清理缓冲相关资源
    this.cleanupContentBuffer(state)

    // 更新消息的usage信息
    await this.messageManager.updateMessageMetadata(eventId, metadata)
    await this.messageManager.updateMessageStatus(eventId, 'sent')
    try {
      const { message, revision } = await this.messageManager.editMessageSilently(
        eventId,
        JSON.stringify(state.message.content)
      )
      this.emitMessageEdited(eventId, revision, message.parentId)
      this.audit('ME', eventId, 'FINALIZE')
    } catch (e) {
      console.warn('[ThreadPresenter] SKIP.finalize: message not found, abort finalize', {
        messageId: eventId
      })
      this.generatingMessages.delete(eventId)
      return
    }
    this.generatingMessages.delete(eventId)

    if (ThreadPresenter.DEBUG_STEP_LOG) {
      try {
        console.log('[Step/Finalize/After]', {
          messageId: eventId,
          contentSnapshot: JSON.stringify(state.message.content).slice(0, 4000)
        })
      } catch {}
    }

    // 处理标题更新和会话更新
    await this.handleConversationUpdates(state)

    // 广播消息生成完成事件
    try {
      const finalMessage = await this.messageManager.getMessage(eventId)
      if (finalMessage) {
        eventBus.sendToMain(CONVERSATION_EVENTS.MESSAGE_GENERATED, {
          conversationId: finalMessage.conversationId,
          message: finalMessage
        })
      }
    } catch {
      // swallow missing message at broadcast stage
      this.audit('SKIP.broadcast', eventId, 'FINALIZE')
    }
  }

  // 处理会话更新和标题生成
  private async handleConversationUpdates(state: GeneratingMessageState): Promise<void> {
    const conversation = await this.sqlitePresenter.getConversation(state.conversationId)
    let titleUpdated = false

    if (conversation.is_new === 1) {
      try {
        this.summaryTitles(undefined, state.conversationId).then((title) => {
          if (title) {
            this.renameConversation(state.conversationId, title).then(() => {
              titleUpdated = true
            })
          }
        })
      } catch (e) {
        console.error('Failed to summarize title in main process:', e)
      }
    }

    if (!titleUpdated) {
      this.sqlitePresenter
        .updateConversation(state.conversationId, {
          updatedAt: Date.now()
        })
        .then(() => {
          // updated conv time (quiet)
        })
      await this.broadcastThreadListUpdate()
    }

    // 无跨会话去重签名清理（已移除去重机制）
  }

  // 释放缓冲的内容

  // 统一的自适应内容刷新
  private async flushAdaptiveBuffer(eventId: string): Promise<void> {
    const state = this.generatingMessages.get(eventId)
    if (!state?.adaptiveBuffer) return

    const buffer = state.adaptiveBuffer
    const now = Date.now()

    // 清理超时
    if (state.flushTimeout) {
      clearTimeout(state.flushTimeout)
      state.flushTimeout = undefined
    }

    // 处理缓冲的内容 - 只发送从 sentPosition 开始的新内容
    if (buffer.content && buffer.sentPosition < buffer.content.length) {
      const newContent = buffer.content.slice(buffer.sentPosition)
      if (newContent) {
        await this.processBufferedContent(eventId, newContent, now)
        // 更新已发送位置
        buffer.sentPosition = buffer.content.length
      }
    }

    // 清理缓冲
    state.adaptiveBuffer = undefined
  }

  // 优化的自适应内容处理 - 核心逻辑 (当前未使用)
  // private async addToAdaptiveBuffer(eventId: string, content: string): Promise<void> {
  //   // 方法保留以备将来使用
  // }

  // 分块大内容 - 使用更小的分块避免UI阻塞
  private splitLargeContent(content: string): string[] {
    const chunks: string[] = []
    let maxChunkSize = 4096 // 默认4KB

    // 对于图片base64内容，使用非常小的分块
    if (content.includes('data:image/')) {
      maxChunkSize = 512 // 图片内容使用512字节分块
    }

    // 对于超长内容，进一步减小分块
    if (content.length > 50000) {
      maxChunkSize = Math.min(maxChunkSize, 256)
    }

    for (let i = 0; i < content.length; i += maxChunkSize) {
      chunks.push(content.slice(i, i + maxChunkSize))
    }

    return chunks
  }

  // 智能判断是否需要分块处理 - 优化阈值判断
  private shouldSplitContent(content: string): boolean {
    const sizeThreshold = 8192 // 8KB - 适中的阈值
    const hasBase64Image = content.includes('data:image/') && content.includes('base64,')
    const hasLargeBase64 = hasBase64Image && content.length > 5120 // 图片内容超过5KB才分块

    return content.length > sizeThreshold || hasLargeBase64
  }

  // 处理缓冲的内容 - 优化异步处理
  private async processBufferedContent(
    eventId: string,
    content: string,
    currentTime: number
  ): Promise<void> {
    const state = this.generatingMessages.get(eventId)
    if (!state) return

    const buffer = state.adaptiveBuffer

    // 如果是大内容，使用分块处理
    if (buffer?.isLargeContent) {
      await this.processLargeContentAsynchronously(eventId, content, currentTime)
      return
    }

    // 正常内容处理
    await this.processNormalContent(eventId, content, currentTime)
  }

  // 异步处理大内容 - 避免阻塞主进程
  private async processLargeContentAsynchronously(
    eventId: string,
    content: string,
    currentTime: number
  ): Promise<void> {
    const state = this.generatingMessages.get(eventId)
    if (!state) return

    const buffer = state.adaptiveBuffer
    if (!buffer) return

    // 设置处理状态
    buffer.isProcessing = true

    try {
      // 动态分块 - 只处理传入的新增内容
      const chunks = this.splitLargeContent(content)
      const totalChunks = chunks.length

      console.log(
        `[ThreadPresenter] Processing ${totalChunks} chunks asynchronously for ${content.length} bytes`
      )

      // 初始化或获取内容块
      const lastBlock = state.message.content[state.message.content.length - 1]
      let contentBlock: any

      if (lastBlock && lastBlock.type === 'content') {
        contentBlock = lastBlock
      } else {
        this.finalizeLastBlock(state)
        contentBlock = {
          type: 'content',
          content: '',
          status: 'loading',
          timestamp: currentTime
        }
        state.message.content.push(contentBlock)
      }

      // 批量处理分块，每次处琅5个
      const batchSize = 5
      for (let batchStart = 0; batchStart < chunks.length; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, chunks.length)
        const batch = chunks.slice(batchStart, batchEnd)

        // 合并当前批次的内容
        const batchContent = batch.join('')
        contentBlock.content += batchContent

        // 更新数据库
        // 流式阶段不落库，仅通过 RESPONSE 提示 UI

        // 发送渲染器事件
        const eventData: any = {
          eventId,
          content: batchContent,
          chunkInfo: {
            current: batchEnd,
            total: totalChunks,
            isLargeContent: true,
            batchSize: batch.length
          }
        }

        eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, eventData)

        // 每批次之间的延迟，让出event loop
        if (batchEnd < chunks.length) {
          await new Promise((resolve) => setImmediate(resolve))
        }
      }

      console.log(`[ThreadPresenter] Completed processing ${totalChunks} chunks`)
    } catch (error) {
      console.error('[ThreadPresenter] Error in processLargeContentAsynchronously:', error)
    } finally {
      // 清理处理状态
      buffer.isProcessing = false
    }
  }

  // 处理普通内容
  private async processNormalContent(
    eventId: string,
    content: string,
    currentTime: number
  ): Promise<void> {
    const state = this.generatingMessages.get(eventId)
    if (!state) return

    const lastBlock = state.message.content[state.message.content.length - 1]

    if (lastBlock && lastBlock.type === 'content') {
      lastBlock.content += content
    } else {
      this.finalizeLastBlock(state)
      state.message.content.push({
        type: 'content',
        content: content,
        status: 'loading',
        timestamp: currentTime
      })
    }

    // 只更新数据库，不额外发送到渲染器（避免重复发送）
    // 流式阶段不落库，仅通过 RESPONSE 提示 UI
  }

  // 完成最后一个块的状态
  private finalizeLastBlock(state: GeneratingMessageState): void {
    const lastBlock =
      state.message.content.length > 0
        ? state.message.content[state.message.content.length - 1]
        : undefined

    if (lastBlock) {
      // 不自动修改权限请求块的状态；也不改进行中的工具块
      if (
        (lastBlock.type === 'action' && lastBlock.action_type === 'tool_call_permission') ||
        (lastBlock.type === 'tool_call' && lastBlock.status === 'loading')
      ) {
        return
      }
      lastBlock.status = 'success'
    }
  }

  // 统一的数据库和渲染器更新 (当前未使用)
  // private async updateMessageAndRenderer(eventId: string, content: string, currentTime: number, chunkInfo?: any): Promise<void> {
  //   // 方法保留以备将来使用
  // }

  async handleLLMAgentResponse(msg: LLMAgentEventData) {
    const currentTime = Date.now()
    const {
      eventId,
      content,
      reasoning_content,
      tool_call_id,
      tool_call_name,
      tool_call_params,
      maximum_tool_calls_reached,
      tool_call_server_name,
      tool_call_server_icons,
      tool_call_server_description,
      tool_call,
      totalUsage,
      image_data
    } = msg
    const state = this.generatingMessages.get(eventId)
    if (state) {
      // 使用保护逻辑：不触碰权限块；不触碰进行中的工具块
      const finalizeLastBlock = () => {
        const lastBlock =
          state.message.content.length > 0
            ? state.message.content[state.message.content.length - 1]
            : undefined
        if (!lastBlock) return
        // 永远不要在流式过程中修改权限块状态（pending/granted/denied 仅由用户/总闸驱动）
        if (lastBlock.type === 'action' && lastBlock.action_type === 'tool_call_permission') return
        // 不修改进行中的工具调用
        if (lastBlock.type === 'tool_call' && lastBlock.status === 'loading') return
        // 其他块可以安全标记为 success
        lastBlock.status = 'success'
      }

      // 记录第一个token的时间
      if (state.firstTokenTime === null && (content || reasoning_content)) {
        state.firstTokenTime = currentTime
        await this.messageManager.updateMessageMetadata(eventId, {
          firstTokenTime: currentTime - state.startTime
        })
      }
      if (totalUsage) {
        state.totalUsage = totalUsage
        state.promptTokens = totalUsage.prompt_tokens
      }

      // 处理工具调用达到最大次数的情况
      if (maximum_tool_calls_reached) {
        finalizeLastBlock() // 使用保护逻辑
        state.message.content.push({
          type: 'action',
          content: 'common.error.maximumToolCallsReached',
          status: 'success',
          timestamp: currentTime,
          action_type: 'maximum_tool_calls_reached',
          tool_call: {
            id: tool_call_id,
            name: tool_call_name,
            params: tool_call_params,
            server_name: tool_call_server_name,
            server_icons: tool_call_server_icons,
            server_description: tool_call_server_description
          },
          extra: {
            needContinue: true
          }
        })
        // 流式阶段不落库，仅通过 RESPONSE 提示 UI
        return
      }

      // 处理reasoning_content的时间戳
      if (reasoning_content) {
        if (state.reasoningStartTime === null) {
          state.reasoningStartTime = currentTime
          await this.messageManager.updateMessageMetadata(eventId, {
            reasoningStartTime: currentTime - state.startTime
          })
        }
        state.lastReasoningTime = currentTime
      }

      const lastBlock = state.message.content[state.message.content.length - 1]

      // Collect-only: ignore any tool_call_response_raw based search result injections during stream

      // 处理工具调用
      if (tool_call) {
        if (tool_call === 'start') {
          // 创建新的工具调用块
          finalizeLastBlock() // 使用保护逻辑
          state.message.content.push({
            type: 'tool_call',
            content: '',
            status: 'loading',
            timestamp: currentTime,
            tool_call: {
              id: tool_call_id,
              name: tool_call_name,
              params: tool_call_params || '',
              server_name: tool_call_server_name,
              server_icons: tool_call_server_icons,
              server_description: tool_call_server_description
            }
          })
        } else if (tool_call === 'update') {
          // 更新工具调用参数
          const toolCallBlock = state.message.content.find(
            (block) =>
              block.type === 'tool_call' &&
              block.tool_call?.id === tool_call_id &&
              block.status === 'loading'
          )

          if (toolCallBlock && toolCallBlock.type === 'tool_call' && toolCallBlock.tool_call) {
            toolCallBlock.tool_call.params = tool_call_params || ''
          }
        } else if (tool_call === 'running') {
          // 工具调用正在执行
          const toolCallBlock = state.message.content.find(
            (block) =>
              block.type === 'tool_call' &&
              block.tool_call?.id === tool_call_id &&
              block.status === 'loading'
          )

          if (toolCallBlock && toolCallBlock.type === 'tool_call') {
            // 保持 loading 状态，但更新工具信息
            if (toolCallBlock.tool_call) {
              toolCallBlock.tool_call.params = tool_call_params || ''
              toolCallBlock.tool_call.server_name = tool_call_server_name
              toolCallBlock.tool_call.server_icons = tool_call_server_icons
              toolCallBlock.tool_call.server_description = tool_call_server_description
            }
          }
        } else if (tool_call === 'end' || tool_call === 'error') {
          // 查找对应的工具调用块（严格按 id 匹配，避免 name 兜底导致错配）
          const toolCallBlock = state.message.content.find(
            (block) =>
              block.type === 'tool_call' &&
              tool_call_id &&
              block.tool_call?.id === tool_call_id &&
              block.status === 'loading'
          )

          if (toolCallBlock && toolCallBlock.type === 'tool_call') {
            // Collect-only: mark parsing lifecycle for UI hints only, do not attach execution results
            toolCallBlock.status = tool_call === 'error' ? 'error' : 'success'
          }
        }
      } else if (image_data) {
        // 处理图像数据
        finalizeLastBlock() // 使用保护逻辑
        state.message.content.push({
          type: 'image',
          content: 'image',
          status: 'success',
          timestamp: currentTime,
          image_data: image_data
        })
      } else if (content) {
        // 简化的直接内容处理
        await this.processContentDirectly(state.message.id, content, currentTime)
      }

      // 处理推理内容
      if (reasoning_content) {
        if (lastBlock && lastBlock.type === 'reasoning_content') {
          lastBlock.content += reasoning_content
          if (lastBlock.reasoning_time) {
            lastBlock.reasoning_time.end = currentTime
          }
        } else {
          finalizeLastBlock() // 使用保护逻辑
          state.message.content.push({
            type: 'reasoning_content',
            content: reasoning_content,
            status: 'loading',
            reasoning_time: {
              start: currentTime,
              end: currentTime
            },
            timestamp: currentTime
          })
        }
      }

      // 更新消息内容
      // 流式阶段不落库，仅通过 RESPONSE 提示 UI
      if (ThreadPresenter.DEBUG_STEP_LOG && tool_call) {
        this.logPermissionSummary(state.message.content, `STREAM.${tool_call}`, eventId)
      }
    }
    eventBus.sendToRenderer(STREAM_EVENTS.RESPONSE, SendTarget.ALL_WINDOWS, msg)
  }

  setSearchAssistantModel(model: MODEL_META, providerId: string) {
    this.searchAssistantModel = model
    this.searchAssistantProviderId = providerId
  }
  async getSearchEngines(): Promise<SearchEngineTemplate[]> {
    return this.searchManager.getEngines()
  }
  async getActiveSearchEngine(): Promise<SearchEngineTemplate> {
    return this.searchManager.getActiveEngine()
  }
  async setActiveSearchEngine(engineId: string): Promise<void> {
    await this.searchManager.setActiveEngine(engineId)
  }

  /**
   * 测试当前选择的搜索引擎
   * @param query 测试搜索的关键词，默认为"天气"
   * @returns 测试是否成功打开窗口
   */
  async testSearchEngine(query: string = '天气'): Promise<boolean> {
    return await this.searchManager.testSearch(query)
  }

  /**
   * 设置搜索引擎
   * @param engineId 搜索引擎ID
   * @returns 是否设置成功
   */
  async setSearchEngine(engineId: string): Promise<boolean> {
    try {
      return await this.searchManager.setActiveEngine(engineId)
    } catch (error) {
      console.error('设置搜索引擎失败:', error)
      return false
    }
  }

  async renameConversation(conversationId: string, title: string): Promise<CONVERSATION> {
    await this.sqlitePresenter.renameConversation(conversationId, title)
    await this.broadcastThreadListUpdate() // 必须广播

    const conversation = await this.getConversation(conversationId)

    // 新增：找到与此 conversationId 关联的 tabId
    let tabId: number | undefined
    for (const [key, value] of this.activeConversationIds.entries()) {
      if (value === conversationId) {
        tabId = key
        break
      }
    }

    // 新增：发出事件通知UI更新标题
    if (tabId !== undefined) {
      const windowId = presenter.tabPresenter['tabWindowMap'].get(tabId)
      eventBus.sendToRenderer(TAB_EVENTS.TITLE_UPDATED, SendTarget.ALL_WINDOWS, {
        tabId,
        conversationId,
        title: conversation.title,
        windowId // 附带 windowId
      })
    }

    return conversation
  }
  async createConversation(
    title: string,
    settings: Partial<CONVERSATION_SETTINGS> = {},
    tabId: number,
    options: { forceNewAndActivate?: boolean } = {} // 新增参数，允许强制创建新会话
  ): Promise<string> {
    console.log('createConversation', title, settings)

    const latestConversation = await this.getLatestConversation()

    // 只有在非强制模式下，才执行空会话的单例检查
    if (!options.forceNewAndActivate) {
      if (latestConversation) {
        const { list: messages } = await this.getMessages(latestConversation.id, 1, 1)
        if (messages.length === 0) {
          await this.setActiveConversation(latestConversation.id, tabId)
          return latestConversation.id
        }
      }
    }

    let defaultSettings = DEFAULT_SETTINGS
    if (latestConversation?.settings) {
      defaultSettings = { ...latestConversation.settings }
      defaultSettings.systemPrompt = ''
      defaultSettings.reasoningEffort = undefined
      defaultSettings.enableSearch = undefined
      defaultSettings.forcedSearch = undefined
      defaultSettings.searchStrategy = undefined
    }
    Object.keys(settings).forEach((key) => {
      if (settings[key] === undefined || settings[key] === null || settings[key] === '') {
        delete settings[key]
      }
    })
    const mergedSettings = { ...defaultSettings, ...settings }
    const defaultModelsSettings = this.configPresenter.getModelConfig(
      mergedSettings.modelId,
      mergedSettings.providerId
    )
    if (defaultModelsSettings) {
      mergedSettings.maxTokens = defaultModelsSettings.maxTokens
      mergedSettings.contextLength = defaultModelsSettings.contextLength
      mergedSettings.temperature = defaultModelsSettings.temperature ?? 0.7
      if (settings.thinkingBudget === undefined) {
        mergedSettings.thinkingBudget = defaultModelsSettings.thinkingBudget
      }
    }
    if (settings.artifacts) {
      mergedSettings.artifacts = settings.artifacts
    }
    if (settings.maxTokens) {
      mergedSettings.maxTokens = settings.maxTokens
    }
    if (settings.temperature !== undefined && settings.temperature !== null) {
      mergedSettings.temperature = settings.temperature
    }
    if (settings.contextLength) {
      mergedSettings.contextLength = settings.contextLength
    }
    if (settings.systemPrompt) {
      mergedSettings.systemPrompt = settings.systemPrompt
    }
    const conversationId = await this.sqlitePresenter.createConversation(title, mergedSettings)

    // 根据 forceNewAndActivate 标志决定激活行为
    if (options.forceNewAndActivate) {
      // 强制模式：直接为当前 tabId 激活新会话，不进行任何检查
      this.activeConversationIds.set(tabId, conversationId)
      eventBus.sendToRenderer(CONVERSATION_EVENTS.ACTIVATED, SendTarget.ALL_WINDOWS, {
        conversationId,
        tabId
      })
    } else {
      // 默认模式：保持原有的、防止重复打开的激活逻辑
      await this.setActiveConversation(conversationId, tabId)
    }

    await this.broadcastThreadListUpdate() // 必须广播
    return conversationId
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.sqlitePresenter.deleteConversation(conversationId)

    // 作为兜底，确保所有与此会话相关的绑定都被移除
    for (const [tabId, activeId] of this.activeConversationIds.entries()) {
      if (activeId === conversationId) {
        this.activeConversationIds.delete(tabId)
      }
    }

    await this.broadcastThreadListUpdate() // 必须广播
  }

  async getConversation(conversationId: string): Promise<CONVERSATION> {
    return await this.sqlitePresenter.getConversation(conversationId)
  }

  async toggleConversationPinned(conversationId: string, pinned: boolean): Promise<void> {
    await this.sqlitePresenter.updateConversation(conversationId, { is_pinned: pinned ? 1 : 0 })
    await this.broadcastThreadListUpdate() // 必须广播
  }

  async updateConversationTitle(conversationId: string, title: string): Promise<void> {
    await this.sqlitePresenter.updateConversation(conversationId, { title })
    await this.broadcastThreadListUpdate() // 必须广播
  }

  async updateConversationSettings(
    conversationId: string,
    settings: Partial<CONVERSATION_SETTINGS>
  ): Promise<void> {
    const conversation = await this.getConversation(conversationId)
    const mergedSettings = { ...conversation.settings }
    for (const key in settings) {
      if (settings[key] !== undefined) {
        mergedSettings[key] = settings[key]
      }
    }
    console.log('updateConversationSettings', mergedSettings)
    // 检查是否有 modelId 的变化
    if (settings.modelId && settings.modelId !== conversation.settings.modelId) {
      // 获取模型配置
      const modelConfig = this.configPresenter.getModelConfig(
        mergedSettings.modelId,
        mergedSettings.providerId
      )
      console.log('check model default config', modelConfig)
      if (modelConfig) {
        // 如果当前设置小于推荐值，则使用推荐值
        mergedSettings.maxTokens = modelConfig.maxTokens
        mergedSettings.contextLength = modelConfig.contextLength
      }
    }

    await this.sqlitePresenter.updateConversation(conversationId, { settings: mergedSettings })
    await this.broadcastThreadListUpdate() // 必须广播
  }

  async getConversationList(
    page: number,
    pageSize: number
  ): Promise<{ total: number; list: CONVERSATION[] }> {
    return await this.sqlitePresenter.getConversationList(page, pageSize)
  }

  async loadMoreThreads(): Promise<{ hasMore: boolean; total: number }> {
    // 获取会话总数
    const total = await this.sqlitePresenter.getConversationCount()

    // 检查是否还有更多会话可以加载
    const hasMore = this.fetchThreadLength < total

    if (hasMore) {
      // 增加 fetchThreadLength，每次增加 500
      this.fetchThreadLength = Math.min(this.fetchThreadLength + 300, total)

      // 广播更新的会话列表
      await this.broadcastThreadListUpdate()
    }

    return { hasMore: this.fetchThreadLength < total, total }
  }

  async setActiveConversation(conversationId: string, tabId: number): Promise<void> {
    // 【核心修正】由主进程负责全部决策（防重和自动切换逻辑）
    const existingTabId = await this.findTabForConversation(conversationId)

    // 如果会话已在其他Tab打开，并且不是当前Tab，则切换到那个Tab
    if (existingTabId !== null && existingTabId !== tabId) {
      console.log(
        `Conversation ${conversationId} is already open in tab ${existingTabId}. Switching to it.`
      )
      // 命令TabPresenter切换到已存在的Tab
      const currentTabType = await this.getTabWindowType(tabId)
      const existingTabType = await this.getTabWindowType(existingTabId)
      if (currentTabType !== existingTabType) {
        this.activeConversationIds.delete(existingTabId)
        eventBus.sendToRenderer(CONVERSATION_EVENTS.DEACTIVATED, SendTarget.ALL_WINDOWS, {
          tabId: existingTabId
        })
        this.activeConversationIds.set(tabId, conversationId)
        eventBus.sendToRenderer(CONVERSATION_EVENTS.ACTIVATED, SendTarget.ALL_WINDOWS, {
          conversationId,
          tabId
        })
        return
      } else {
        await presenter.tabPresenter.switchTab(existingTabId)
        // 注意：这里不应该再为 requesting tab (即 tabId) 设置 activeConversationId
        // 也不需要发送ACTIVATED事件，因为tab-session的绑定关系没有改变。
        // switchTab 自身会处理UI的激活。
        return
      }
    }

    // 如果会话未在其他Tab打开，或者是请求激活当前Tab已绑定的会话，则正常执行绑定
    const conversation = await this.getConversation(conversationId)
    if (conversation) {
      // 检查当前Tab是否已经绑定了这个会话，避免不必要的事件广播
      if (this.activeConversationIds.get(tabId) === conversationId) {
        return // 状态未改变，无需操作
      }

      this.activeConversationIds.set(tabId, conversationId)
      // 广播事件，通知所有渲染进程UI更新
      eventBus.sendToRenderer(CONVERSATION_EVENTS.ACTIVATED, SendTarget.ALL_WINDOWS, {
        conversationId,
        tabId
      })
    } else {
      throw new Error(`Conversation ${conversationId} not found`)
    }
  }

  async getActiveConversation(tabId: number): Promise<CONVERSATION | null> {
    const conversationId = this.activeConversationIds.get(tabId)
    if (!conversationId) {
      return null
    }
    return this.getConversation(conversationId)
  }

  async getMessages(
    conversationId: string,
    page: number,
    pageSize: number
  ): Promise<{ total: number; list: Message[] }> {
    return await this.messageManager.getMessageThread(conversationId, page, pageSize)
  }

  async getContextMessages(conversationId: string): Promise<Message[]> {
    const conversation = await this.getConversation(conversationId)
    // 计算需要获取的消息数量（假设每条消息平均300字）
    let messageCount = Math.ceil(conversation.settings.contextLength / 300)
    if (messageCount < 2) {
      messageCount = 2
    }
    const messages = await this.messageManager.getContextMessages(conversationId, messageCount)

    // 确保消息列表以用户消息开始
    while (messages.length > 0 && messages[0].role !== 'user') {
      messages.shift()
    }

    return messages.map((msg) => {
      if (msg.role === 'user') {
        const newMsg = { ...msg }
        const msgContent = newMsg.content as UserMessageContent
        if (msgContent.content) {
          ;(newMsg.content as UserMessageContent).text = this.formatUserMessageContent(
            msgContent.content
          )
        }
        return newMsg
      } else {
        return msg
      }
    })
  }

  private formatUserMessageContent(
    msgContentBlock: (UserMessageTextBlock | UserMessageMentionBlock | UserMessageCodeBlock)[]
  ) {
    return msgContentBlock
      .map((block) => {
        if (block.type === 'mention') {
          if (block.category === 'resources') {
            return `@${block.content}`
          } else if (block.category === 'tools') {
            return `@${block.id}`
          } else if (block.category === 'files') {
            return `@${block.id}`
          } else if (block.category === 'prompts') {
            try {
              // 尝试解析prompt内容
              const promptData = JSON.parse(block.content)
              // 如果包含messages数组，尝试提取其中的文本内容
              if (promptData && Array.isArray(promptData.messages)) {
                const messageTexts = promptData.messages
                  .map((msg) => {
                    if (typeof msg.content === 'string') {
                      return msg.content
                    } else if (msg.content && msg.content.type === 'text') {
                      return msg.content.text
                    } else {
                      // 对于其他类型的内容（如图片等），返回空字符串或特定标记
                      return `[${msg.content?.type || 'content'}]`
                    }
                  })
                  .filter(Boolean)
                  .join('\n')
                return `@${block.id} <prompts>${messageTexts || block.content}</prompts>`
              }
            } catch (e) {
              // 如果解析失败，直接返回原始内容
              console.log('解析prompt内容失败:', e)
            }
            // 默认返回原内容
            return `@${block.id} <prompts>${block.content}</prompts>`
          }
          return `@${block.id}`
        } else if (block.type === 'text') {
          return block.content
        } else if (block.type === 'code') {
          return `\`\`\`${block.content}\`\`\``
        }
        return ''
      })
      .join('')
  }

  async clearContext(conversationId: string): Promise<void> {
    await this.sqlitePresenter.runTransaction(async () => {
      const conversation = await this.getConversation(conversationId)
      if (conversation) {
        await this.sqlitePresenter.deleteAllMessages()
      }
    })
  }
  /**
   *
   * @param conversationId
   * @param content
   * @param role
   * @returns 如果是user的消息，返回ai生成的message，否则返回空
   */
  async sendMessage(
    conversationId: string,
    content: string,
    role: MESSAGE_ROLE
  ): Promise<AssistantMessage | null> {
    const conversation = await this.getConversation(conversationId)
    const { providerId, modelId } = conversation.settings
    // sendMessage (quiet)
    const message = await this.messageManager.sendMessage(
      conversationId,
      content,
      role,
      '',
      false,
      {
        contextUsage: 0,
        totalTokens: 0,
        generationTime: 0,
        firstTokenTime: 0,
        tokensPerSecond: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: modelId,
        provider: providerId
      }
    )
    if (role === 'user') {
      const assistantMessage = await this.generateAIResponse(conversationId, message.id)
      this.generatingMessages.set(assistantMessage.id, {
        message: assistantMessage,
        conversationId,
        startTime: Date.now(),
        firstTokenTime: null,
        promptTokens: 0,
        reasoningStartTime: null,
        reasoningEndTime: null,
        lastReasoningTime: null,
        __id: ++this.genStateSeq
      })
      // state created (quiet)

      // 检查是否是新会话的第一条消息
      const { list: messages } = await this.getMessages(conversationId, 1, 2)
      if (messages.length === 1) {
        // 更新会话的 is_new 标志位
        await this.sqlitePresenter.updateConversation(conversationId, {
          is_new: 0,
          updatedAt: Date.now()
        })
      } else {
        await this.sqlitePresenter.updateConversation(conversationId, {
          updatedAt: Date.now()
        })
      }

      // 因为handleLLMAgentEnd会处理会话列表广播，所以此处不用广播

      return assistantMessage
    }

    return null
  }

  private async generateAIResponse(conversationId: string, userMessageId: string) {
    try {
      const triggerMessage = await this.messageManager.getMessage(userMessageId)
      if (!triggerMessage) {
        throw new Error('找不到触发消息')
      }

      await this.messageManager.updateMessageStatus(userMessageId, 'sent')

      const conversation = await this.getConversation(conversationId)
      const { providerId, modelId } = conversation.settings
      const assistantMessage = (await this.messageManager.sendMessage(
        conversationId,
        JSON.stringify([]),
        'assistant',
        userMessageId,
        false,
        {
          contextUsage: 0,
          totalTokens: 0,
          generationTime: 0,
          firstTokenTime: 0,
          tokensPerSecond: 0,
          inputTokens: 0,
          outputTokens: 0,
          model: modelId,
          provider: providerId
        }
      )) as AssistantMessage

      return assistantMessage
    } catch (error) {
      await this.messageManager.updateMessageStatus(userMessageId, 'error')
      console.error('生成 AI 响应失败:', error)
      throw error
    }
  }

  async getMessage(messageId: string): Promise<Message> {
    return await this.messageManager.getMessage(messageId)
  }

  /**
   * 获取指定消息之前的历史消息
   * @param messageId 消息ID
   * @param limit 限制返回的消息数量
   * @returns 历史消息列表，按时间正序排列
   */
  private async getMessageHistory(messageId: string, limit: number = 100): Promise<Message[]> {
    const message = await this.messageManager.getMessage(messageId)
    if (!message) {
      throw new Error('找不到指定的消息')
    }

    const { list: messages } = await this.messageManager.getMessageThread(
      message.conversationId,
      1,
      limit * 2
    )

    // 找到目标消息在列表中的位置
    const targetIndex = messages.findIndex((msg) => msg.id === messageId)
    if (targetIndex === -1) {
      return [message]
    }

    // 返回目标消息之前的消息（包括目标消息）
    return messages.slice(Math.max(0, targetIndex - limit + 1), targetIndex + 1)
  }

  private async rewriteUserSearchQuery(
    query: string,
    contextMessages: string,
    conversationId: string,
    searchEngine: string
  ): Promise<string> {
    const rewritePrompt = `
    你非常擅长于使用搜索引擎去获取最新的数据,你的目标是在充分理解用户的问题后，进行全面的网络搜索搜集必要的信息，首先你要提取并优化搜索的查询内容

    现在时间：${new Date().toISOString()}
    正在使用的搜索引擎：${searchEngine}

    请遵循以下规则重写搜索查询：
    1. 根据用户的问题和上下文，重写应该进行搜索的关键词
    2. 如果需要使用时间，则根据当前时间给出需要查询的具体时间日期信息
    3. 生成的查询关键词要选择合适的语言，考虑用户的问题类型使用最适合的语言进行搜索，例如某些问题应该保持用户的问题语言，而有一些则更适合翻译成英语或其他语言
    4. 保持查询简洁，通常不超过3个关键词, 最多不要超过5个关键词，参考当前搜索引擎的查询习惯重写关键字

    直接返回优化后的搜索词，不要有任何额外说明。
    如果你觉得用户的问题不需要进行搜索，请直接返回"无须搜索"。

    如下是之前对话的上下文：
    <context_messages>
    ${contextMessages}
    </context_messages>
    如下是用户的问题：
    <user_question>
    ${query}
    </user_question>
    `
    const conversation = await this.getConversation(conversationId)
    if (!conversation) {
      return query
    }
    console.log('rewriteUserSearchQuery', query, contextMessages, conversation.id)
    const { providerId, modelId } = conversation.settings
    try {
      const rewrittenQuery = await this.llmProviderPresenter.generateCompletion(
        this.searchAssistantProviderId || providerId,
        [
          {
            role: 'user',
            content: rewritePrompt
          }
        ],
        this.searchAssistantModel?.id || modelId
      )
      return rewrittenQuery.trim() || query
    } catch (error) {
      console.error('重写搜索查询失败:', error)
      return query
    }
  }

  /**
   * 检查消息是否已被取消
   * @param messageId 消息ID
   * @returns 是否已被取消
   */
  private isMessageCancelled(messageId: string): boolean {
    const state = this.generatingMessages.get(messageId)
    return !state || state.isCancelled === true
  }

  /**
   * 如果消息已被取消，则抛出错误
   * @param messageId 消息ID
   */
  private throwIfCancelled(messageId: string): void {
    if (this.isMessageCancelled(messageId)) {
      throw new Error('common.error.userCanceledGeneration')
    }
  }

  private async startStreamSearch(
    conversationId: string,
    messageId: string,
    query: string
  ): Promise<SearchResult[]> {
    const state = this.generatingMessages.get(messageId)
    if (!state) {
      throw new Error('找不到生成状态')
    }

    // 检查是否已被取消
    this.throwIfCancelled(messageId)

    // 添加搜索加载状态
    const searchBlock: AssistantMessageBlock = {
      type: 'search',
      content: '',
      status: 'loading',
      timestamp: Date.now(),
      extra: {
        total: 0
      }
    }
    state.message.content.unshift(searchBlock)
    {
      const { message, revision } = await this.messageManager.editMessageSilently(
        messageId,
        JSON.stringify(state.message.content)
      )
      this.emitMessageEdited(messageId, revision, message.parentId)
    }
    // 标记消息为搜索状态
    state.isSearching = true
    this.searchingMessages.add(messageId)
    try {
      // 获取历史消息用于上下文
      const contextMessages = await this.getContextMessages(conversationId)
      // 检查是否已被取消
      this.throwIfCancelled(messageId)

      const formattedContext = contextMessages
        .map((msg) => {
          if (msg.role === 'user') {
            const content = msg.content as UserMessageContent
            return `user: ${content.text}${getFileContext(content.files)}`
          } else if (msg.role === 'assistant') {
            let finalContent = 'assistant: '
            const content = msg.content as AssistantMessageBlock[]
            content.forEach((block) => {
              if (block.type === 'content') {
                finalContent += block.content + '\n'
              }
              if (block.type === 'search') {
                finalContent += `search-result: ${JSON.stringify(block.extra)}`
              }
              if (block.type === 'tool_call') {
                finalContent += `tool_call: ${JSON.stringify(block.tool_call)}`
              }
              if (block.type === 'image') {
                finalContent += `image: ${block.image_data?.data}`
              }
            })
            return finalContent
          } else {
            return JSON.stringify(msg.content)
          }
        })
        .join('\n')

      // 检查是否已被取消
      this.throwIfCancelled(messageId)

      // 重写搜索查询
      searchBlock.status = 'optimizing'
      {
        const { message, revision } = await this.messageManager.editMessageSilently(
          messageId,
          JSON.stringify(state.message.content)
        )
        this.emitMessageEdited(messageId, revision, message.parentId)
      }

      const optimizedQuery = await this.rewriteUserSearchQuery(
        query,
        formattedContext,
        conversationId,
        this.searchManager.getActiveEngine().name
      ).catch((err) => {
        console.error('重写搜索查询失败:', err)
        return query
      })

      // 如果不需要搜索，直接返回空结果
      if (optimizedQuery.includes('无须搜索')) {
        searchBlock.status = 'success'
        searchBlock.content = ''
        {
          const { message, revision } = await this.messageManager.editMessageSilently(
            messageId,
            JSON.stringify(state.message.content)
          )
          this.emitMessageEdited(messageId, revision, message.parentId)
        }
        state.isSearching = false
        this.searchingMessages.delete(messageId)
        return []
      }

      // 检查是否已被取消
      this.throwIfCancelled(messageId)

      // 更新搜索状态为阅读中
      searchBlock.status = 'reading'
      {
        const { message, revision } = await this.messageManager.editMessageSilently(
          messageId,
          JSON.stringify(state.message.content)
        )
        this.emitMessageEdited(messageId, revision, message.parentId)
      }

      // 开始搜索
      const results = await this.searchManager.search(conversationId, optimizedQuery)

      // 检查是否已被取消
      this.throwIfCancelled(messageId)

      searchBlock.status = 'loading'
      searchBlock.extra = {
        total: results.length
      }
      {
        const { message, revision } = await this.messageManager.editMessageSilently(
          messageId,
          JSON.stringify(state.message.content)
        )
        this.emitMessageEdited(messageId, revision, message.parentId)
      }

      // 保存搜索结果
      for (const result of results) {
        // 检查是否已被取消
        this.throwIfCancelled(messageId)

        await this.sqlitePresenter.addMessageAttachment(
          messageId,
          'search_result',
          JSON.stringify({
            title: result.title,
            url: result.url,
            content: result.content || '',
            description: result.description || '',
            icon: result.icon || ''
          })
        )
      }

      // 检查是否已被取消
      this.throwIfCancelled(messageId)

      // 更新搜索状态为成功
      searchBlock.status = 'success'
      {
        const { message, revision } = await this.messageManager.editMessageSilently(
          messageId,
          JSON.stringify(state.message.content)
        )
        this.emitMessageEdited(messageId, revision, message.parentId)
      }

      // 标记消息搜索完成
      state.isSearching = false
      this.searchingMessages.delete(messageId)

      return results
    } catch (error) {
      // 标记消息搜索完成
      state.isSearching = false
      this.searchingMessages.delete(messageId)

      // 更新搜索状态为错误
      searchBlock.status = 'error'
      searchBlock.content = String(error)
      {
        const { message, revision } = await this.messageManager.editMessageSilently(
          messageId,
          JSON.stringify(state.message.content)
        )
        this.emitMessageEdited(messageId, revision, message.parentId)
      }

      if (String(error).includes('userCanceledGeneration')) {
        // 如果是取消操作导致的错误，确保搜索窗口关闭
        this.searchManager.stopSearch(state.conversationId)
      }

      return []
    }
  }

  private async getLastUserMessage(conversationId: string): Promise<Message | null> {
    return await this.messageManager.getLastUserMessage(conversationId)
  }

  // 从数据库获取搜索结果
  async getSearchResults(messageId: string): Promise<SearchResult[]> {
    const results = await this.sqlitePresenter.getMessageAttachments(messageId, 'search_result')
    return results.map((result) => JSON.parse(result.content) as SearchResult) ?? []
  }

  async startStreamCompletion(
    conversationId: string,
    queryMsgId?: string,
    selectedVariantsMap?: Record<string, string>,
    contextMode?: 'msg_retry' | 'toolcall_continue'
  ) {
    const state = this.findGeneratingState(conversationId)
    if (!state) {
      console.warn('未找到状态，conversationId:', conversationId)
      return
    }
    try {
      // 设置消息未取消
      state.isCancelled = false

      // 1. 获取上下文信息
      const { conversation, userMessage, contextMessages } = await this.prepareConversationContext(
        conversationId,
        queryMsgId,
        selectedVariantsMap,
        contextMode
      )

      const { providerId, modelId } = conversation.settings
      const modelConfig = this.configPresenter.getModelConfig(modelId, providerId)
      const { vision } = modelConfig || {}
      // 检查是否已被取消
      this.throwIfCancelled(state.message.id)

      // 2. 处理用户消息内容
      const { userContent, urlResults, imageFiles } = await this.processUserMessageContent(
        userMessage as UserMessage
      )

      // 检查是否已被取消
      this.throwIfCancelled(state.message.id)

      // 3. 处理搜索（如果需要）
      let searchResults: SearchResult[] | null = null
      if ((userMessage.content as UserMessageContent).search) {
        try {
          searchResults = await this.startStreamSearch(
            conversationId,
            state.message.id,
            userContent
          )
          // 检查是否已被取消
          this.throwIfCancelled(state.message.id)
        } catch (error) {
          // 如果是用户取消导致的错误，不继续后续步骤
          if (String(error).includes('userCanceledGeneration')) {
            return
          }
          // 其他错误继续处理（搜索失败不应影响生成）
          console.error('搜索过程中出错:', error)
        }
      }

      // 检查是否已被取消
      this.throwIfCancelled(state.message.id)

      // 4. 准备提示内容
      const { finalContent, promptTokens } = await this.preparePromptContent(
        conversation,
        userContent,
        contextMessages,
        searchResults,
        urlResults,
        userMessage,
        vision,
        vision ? imageFiles : [],
        modelConfig.functionCall
      )

      // 检查是否已被取消
      this.throwIfCancelled(state.message.id)

      // 5. 更新生成状态
      await this.updateGenerationState(state, promptTokens)

      // 检查是否已被取消
      this.throwIfCancelled(state.message.id)
      // 6. 启动流式生成

      // 重新获取最新的会话设置，以防在之前的 await 期间发生变化
      const currentConversation = await this.getConversation(conversationId)
      const {
        providerId: currentProviderId,
        modelId: currentModelId,
        temperature: currentTemperature,
        maxTokens: currentMaxTokens,
        enabledMcpTools: currentEnabledMcpTools,
        thinkingBudget: currentThinkingBudget,
        reasoningEffort: currentReasoningEffort,
        verbosity: currentVerbosity,
        enableSearch: currentEnableSearch,
        forcedSearch: currentForcedSearch,
        searchStrategy: currentSearchStrategy
      } = currentConversation.settings
      const stream = this.llmProviderPresenter.startStreamCompletion(
        currentProviderId, // 使用最新的设置
        finalContent,
        currentModelId, // 使用最新的设置
        state.message.id,
        currentTemperature, // 使用最新的设置
        currentMaxTokens, // 使用最新的设置
        currentEnabledMcpTools,
        currentThinkingBudget,
        currentReasoningEffort,
        currentVerbosity,
        currentEnableSearch,
        currentForcedSearch,
        currentSearchStrategy
      )
      for await (const event of stream) {
        const msg = event.data
        if (event.type === 'response') {
          await this.handleLLMAgentResponse(msg)
        } else if (event.type === 'error') {
          await this.handleLLMAgentError(msg)
        } else if (event.type === 'end') {
          await this.handleLLMAgentEnd(msg)
        }
      }
    } catch (error) {
      // 检查是否是取消错误
      if (String(error).includes('userCanceledGeneration')) {
        console.log('消息生成已被用户取消')
        return
      }

      console.error('流式生成过程中出错:', error)
      // 先持久化内存中的部分生成内容
      await this.persistInMemoryContentBeforeError(state.message.id)
      try {
        const { message, revision } = await this.messageManager.handleMessageError(
          state.message.id,
          String(error)
        )
        this.emitMessageEdited(state.message.id, revision, message.parentId)
      } catch {}
      throw error
    }
  }
  async continueStreamCompletion(
    conversationId: string,
    queryMsgId: string,
    selectedVariantsMap?: Record<string, string>
  ) {
    const state = this.findGeneratingState(conversationId)
    if (!state) {
      console.warn('未找到状态，conversationId:', conversationId)
      return
    }

    try {
      // 设置消息未取消
      state.isCancelled = false

      // 1. 获取需要继续的消息
      const queryMessage = await this.messageManager.getMessage(queryMsgId)
      if (!queryMessage) {
        throw new Error('找不到指定的消息')
      }

      // 2. 解析最后一个 action block
      const content = queryMessage.content as AssistantMessageBlock[]
      const lastActionBlock = content.filter((block) => block.type === 'action').pop()

      if (!lastActionBlock || lastActionBlock.type !== 'action') {
        throw new Error('找不到最后的 action block')
      }

      // 3. 检查是否是 maximum_tool_calls_reached
      if (
        lastActionBlock.action_type === 'maximum_tool_calls_reached' &&
        lastActionBlock.tool_call
      ) {
        // 设置 needContinue 为 0（false）
        if (lastActionBlock.extra) {
          lastActionBlock.extra = {
            ...lastActionBlock.extra,
            needContinue: false
          }
        }
        {
          const { message, revision } = await this.messageManager.editMessageSilently(
            queryMsgId,
            JSON.stringify(content)
          )
          this.emitMessageEdited(queryMsgId, revision, message.parentId)
        }
      }

      // 检查是否已被取消
      this.throwIfCancelled(state.message.id)

      // 6. 获取上下文信息
      const { conversation, contextMessages, userMessage } = await this.prepareConversationContext(
        conversationId,
        state.message.id,
        selectedVariantsMap,
        'toolcall_continue'
      )

      // 检查是否已被取消
      this.throwIfCancelled(state.message.id)

      // 7. 准备提示内容
      const {
        providerId,
        modelId,
        temperature,
        maxTokens,
        enabledMcpTools,
        thinkingBudget,
        reasoningEffort,
        verbosity,
        enableSearch,
        forcedSearch,
        searchStrategy
      } = conversation.settings
      const modelConfig = this.configPresenter.getModelConfig(modelId, providerId)

      const { finalContent, promptTokens } = await this.preparePromptContent(
        conversation,
        'continue',
        contextMessages,
        null, // 不进行搜索
        [], // 没有 URL 结果
        userMessage,
        false,
        [], // 没有图片文件
        modelConfig.functionCall
      )

      // 8. 更新生成状态
      await this.updateGenerationState(state, promptTokens)

      // 9. 不再通过流事件回注工具执行结果（collect-only 模式）

      // 10. 启动流式生成
      const stream = this.llmProviderPresenter.startStreamCompletion(
        providerId,
        finalContent,
        modelId,
        state.message.id,
        temperature,
        maxTokens,
        enabledMcpTools,
        thinkingBudget,
        reasoningEffort,
        verbosity,
        enableSearch,
        forcedSearch,
        searchStrategy
      )
      for await (const event of stream) {
        const msg = event.data
        if (event.type === 'response') {
          await this.handleLLMAgentResponse(msg)
        } else if (event.type === 'error') {
          await this.handleLLMAgentError(msg)
        } else if (event.type === 'end') {
          await this.handleLLMAgentEnd(msg)
        }
      }
    } catch (error) {
      // 检查是否是取消错误
      if (String(error).includes('userCanceledGeneration')) {
        console.log('消息生成已被用户取消')
        return
      }

      console.error('继续生成过程中出错:', error)
      // 先持久化内存中的部分生成内容
      await this.persistInMemoryContentBeforeError(state.message.id)
      try {
        const { message, revision } = await this.messageManager.handleMessageError(
          state.message.id,
          String(error)
        )
        this.emitMessageEdited(state.message.id, revision, message.parentId)
      } catch {}
      throw error
    }
  }

  // 查找特定会话的生成状态
  private findGeneratingState(conversationId: string): GeneratingMessageState | null {
    return (
      Array.from(this.generatingMessages.values()).find(
        (state) => state.conversationId === conversationId
      ) || null
    )
  }

  // 准备会话上下文
  private async prepareConversationContext(
    conversationId: string,
    queryMsgId?: string,
    selectedVariantsMap?: Record<string, string>,
    contextMode?: 'msg_retry' | 'toolcall_continue'
  ): Promise<{
    conversation: CONVERSATION
    userMessage: Message
    contextMessages: Message[]
  }> {
    const conversation = await this.getConversation(conversationId)
    let contextMessages: Message[] = []
    let userMessage: Message | null = null
    let assistantMessageForR2: Message | null = null
    let retryAssistantId: string | null = null

    if (queryMsgId) {
      try {
        console.log('[Context/Mode]', { mode: contextMode || 'default' })
      } catch {}
      // 处理指定消息ID的情况
      const queryMessage = await this.getMessage(queryMsgId)
      if (!queryMessage) {
        throw new Error('找不到指定的消息')
      }

      // 修复：根据消息类型确定如何获取用户消息
      if (queryMessage.role === 'user') {
        // 如果 queryMessage 就是用户消息，直接使用
        userMessage = queryMessage
      } else if (queryMessage.role === 'assistant') {
        // 如果 queryMessage 是助手消息，获取它的 parentId（用户消息）
        if (!queryMessage.parentId) {
          throw new Error('助手消息缺少 parentId')
        }
        userMessage = await this.getMessage(queryMessage.parentId)
        if (!userMessage) {
          throw new Error('找不到触发消息')
        }
        // 标记当前助手消息（用于 R2 回放工具结果）
        // 注意：当 contextMode 为 msg_retry 时，不进行 R2 回放注入
        assistantMessageForR2 = contextMode === 'msg_retry' ? null : queryMessage
        // msg_retry 下记录被重试的助手消息ID，用于后续变体替换跳过
        if (contextMode === 'msg_retry') {
          retryAssistantId = queryMessage.id
        }
      } else {
        throw new Error('不支持的消息类型')
      }

      contextMessages = await this.getMessageHistory(
        userMessage.id,
        conversation.settings.contextLength
      )

      // R2 上下文选择范围（仅当上一条助手消息包含已完成的 tool_call 结果时，将其注入上下文用于回放）。
      try {
        console.log('[R2/ContextPick]', {
          queryMsgId,
          resolvedUserMsgId: userMessage.id,
          baseContextCount: contextMessages.length
        })
      } catch {}

      if (assistantMessageForR2 && Array.isArray(assistantMessageForR2.content)) {
        const blocks = assistantMessageForR2.content as AssistantMessageBlock[]
        // 判断是否存在可回放的 tool_call 结果：id/name/params 存在，且 response 非空或块状态为 success/error
        const hasRePlayableTool = blocks.some((b) => {
          if (b.type !== 'tool_call' || !b.tool_call) return false
          const idOk = Boolean(b.tool_call.id && String(b.tool_call.id).trim())
          const nameOk = Boolean(b.tool_call.name && String(b.tool_call.name).trim())
          const paramsOk = Boolean(b.tool_call.params && String(b.tool_call.params).trim())
          const respOk = Boolean(b.tool_call.response && String(b.tool_call.response).trim())
          const statusOk = b.status === 'success' || b.status === 'error'
          return idOk && nameOk && paramsOk && (respOk || statusOk)
        })

        if (hasRePlayableTool) {
          // 深拷贝注入，并强制标记为 sent 以避免被 selectContextMessages 过滤掉
          const injected = JSON.parse(JSON.stringify(assistantMessageForR2)) as Message
          ;(injected as any).status = 'sent'
          ;(injected as any).__r2Injected = true
          contextMessages.push(injected)
          try {
            const variant = (injected as any).is_variant ? 'variant' : 'main'
            console.log('[R2/UseCurrent]', {
              assistantId: injected.id,
              variant
            })
          } catch {}
          try {
            console.log('[R2/ContextPick] InjectedAssistantForReplay', {
              injectedId: injected.id,
              newContextCount: contextMessages.length
            })
          } catch {}
        } else {
          try {
            console.log('[R2/ContextPick] NoRePlayableToolInAssistant', {
              assistantId: assistantMessageForR2.id
            })
          } catch {}
        }
      }
    } else {
      // 获取最新的用户消息
      userMessage = await this.getLastUserMessage(conversationId)
      if (!userMessage) {
        throw new Error('找不到用户消息')
      }
      contextMessages = await this.getContextMessages(conversationId)
    }

    // 在获取原始 contextMessages 列表之后，但在将其传递给 LLM 上下文筛选和格式化函数之前，
    // 插入核心“变体内容和元数据替换”逻辑。
    // 变体替换：
    // - 允许在 msg_retry 下对“边界之前”的历史消息执行变体替换
    // - 但跳过：被重试的助手消息（retryAssistantId）与任何回放注入的消息（__r2Injected）
    if (selectedVariantsMap && Object.keys(selectedVariantsMap).length > 0) {
      contextMessages = contextMessages.map((msg) => {
        if ((msg as any).__r2Injected) return msg
        if (retryAssistantId && msg.id === retryAssistantId) return msg
        if (msg.role === 'assistant' && selectedVariantsMap[msg.id] && msg.variants) {
          const selectedVariantId = selectedVariantsMap[msg.id]
          const selectedVariant = msg.variants.find((v) => v.id === selectedVariantId)
          if (selectedVariant) {
            const newMsg = JSON.parse(JSON.stringify(msg))
            newMsg.content = selectedVariant.content
            newMsg.usage = selectedVariant.usage
            newMsg.model_id = selectedVariant.model_id
            newMsg.model_provider = selectedVariant.model_provider
            return newMsg
          }
        }
        return msg
      })
    }

    // 处理 UserMessageMentionBlock
    if (userMessage.role === 'user') {
      const msgContent = userMessage.content as UserMessageContent
      if (msgContent.content && !msgContent.text) {
        msgContent.text = this.formatUserMessageContent(msgContent.content)
      }
    }

    // 任何情况都使用最新配置
    const webSearchEnabled = this.configPresenter.getSetting('input_webSearch') as boolean
    const thinkEnabled = this.configPresenter.getSetting('input_deepThinking') as boolean
    ;(userMessage.content as UserMessageContent).search = webSearchEnabled
    ;(userMessage.content as UserMessageContent).think = thinkEnabled
    return { conversation, userMessage, contextMessages }
  }

  // 处理用户消息内容
  private async processUserMessageContent(userMessage: UserMessage): Promise<{
    userContent: string
    urlResults: SearchResult[]
    imageFiles: MessageFile[] // 图片文件列表
  }> {
    // 处理文本内容
    const userContent = `
      ${
        userMessage.content.content
          ? this.formatUserMessageContent(userMessage.content.content)
          : userMessage.content.text
      }
      ${getFileContext(userMessage.content.files)}
    `

    // 从用户消息中提取并丰富URL内容
    const urlResults = await ContentEnricher.extractAndEnrichUrls(userMessage.content.text)

    // 提取图片文件

    const imageFiles =
      userMessage.content.files?.filter((file) => {
        // 根据文件类型、MIME类型或扩展名过滤图片文件
        const isImage =
          file.mimeType.startsWith('data:image') ||
          /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(file.name || '')
        return isImage
      }) || []

    return { userContent, urlResults, imageFiles }
  }

  // 准备提示内容
  private async preparePromptContent(
    conversation: CONVERSATION,
    userContent: string,
    contextMessages: Message[],
    searchResults: SearchResult[] | null,
    urlResults: SearchResult[],
    userMessage: Message,
    vision: boolean,
    imageFiles: MessageFile[],
    supportsFunctionCall: boolean,
    modelType?: ModelType
  ): Promise<{
    finalContent: ChatMessage[]
    promptTokens: number
  }> {
    const { systemPrompt, contextLength, artifacts, enabledMcpTools } = conversation.settings

    // 判断是否为图片生成模型
    const isImageGeneration = modelType === ModelType.ImageGeneration

    // 图片生成模型不使用搜索、系统提示词和MCP工具
    const searchPrompt =
      !isImageGeneration && searchResults ? generateSearchPrompt(userContent, searchResults) : ''
    const enrichedUserMessage =
      !isImageGeneration && urlResults.length > 0
        ? '\n\n' + ContentEnricher.enrichUserMessageWithUrlContent(userContent, urlResults)
        : ''

    // 处理系统提示词，添加当前时间信息
    const finalSystemPrompt = this.enhanceSystemPromptWithDateTime(systemPrompt, isImageGeneration)

    // 计算token数量（使用处理后的系统提示词）
    const searchPromptTokens = searchPrompt ? approximateTokenSize(searchPrompt ?? '') : 0
    const systemPromptTokens =
      !isImageGeneration && finalSystemPrompt ? approximateTokenSize(finalSystemPrompt ?? '') : 0
    const userMessageTokens = approximateTokenSize(userContent + enrichedUserMessage)
    // 图片生成模型不使用MCP工具
    const mcpTools = !isImageGeneration
      ? await presenter.mcpPresenter.getAllToolDefinitions(enabledMcpTools)
      : []
    const mcpToolsTokens = mcpTools.reduce(
      (acc, tool) => acc + approximateTokenSize(JSON.stringify(tool)),
      0
    )
    // 计算剩余可用的上下文长度
    const reservedTokens =
      searchPromptTokens + systemPromptTokens + userMessageTokens + mcpToolsTokens
    const remainingContextLength = contextLength - reservedTokens

    // 选择合适的上下文消息
    const selectedContextMessages = this.selectContextMessages(
      contextMessages,
      userMessage,
      remainingContextLength
    )

    // 格式化消息
    const formattedMessages = this.formatMessagesForCompletion(
      selectedContextMessages,
      isImageGeneration ? '' : finalSystemPrompt, // 图片生成模型不使用系统提示词
      artifacts,
      searchPrompt,
      userContent,
      enrichedUserMessage,
      imageFiles,
      vision,
      supportsFunctionCall
    )

    // 合并连续的相同角色消息
    const mergedMessages = this.mergeConsecutiveMessages(formattedMessages)

    // 计算prompt tokens
    let promptTokens = 0
    for (const msg of mergedMessages) {
      if (typeof msg.content === 'string') {
        promptTokens += approximateTokenSize(msg.content)
      } else {
        promptTokens +=
          approximateTokenSize(msg.content?.map((item) => item.text).join('') || '') +
          imageFiles.reduce((acc, file) => acc + file.token, 0)
      }
    }
    // R1/R2 输入摘要（仅元信息，便于核对回放是否匹配规范）
    try {
      const toolCallIds: string[] = []
      const toolIds: string[] = []
      for (const m of mergedMessages) {
        if ((m as any).tool_calls && Array.isArray((m as any).tool_calls)) {
          for (const tc of (m as any).tool_calls) toolCallIds.push(tc.id)
        }
        if ((m as any).tool_call_id) toolIds.push((m as any).tool_call_id)
      }
      const missingPairs = toolCallIds.filter((id) => !toolIds.includes(id))
      console.log('[ContextSummary]', {
        supportsFunctionCall,
        assistantToolCalls: toolCallIds.map((s) => (s || '').slice(0, 8)),
        toolMessages: toolIds.map((s) => (s || '').slice(0, 8)),
        missingPairs: missingPairs.map((s) => (s || '').slice(0, 8)),
        totalMessages: mergedMessages.length,
        promptTokens
      })
    } catch {}

    // 为避免日志过长，默认不打印完整 ContextDump。需要时可临时恢复。
    return { finalContent: mergedMessages, promptTokens }
  }

  // 选择上下文消息
  private selectContextMessages(
    contextMessages: Message[],
    userMessage: Message,
    remainingContextLength: number
  ): Message[] {
    // R2 专用：如存在为回放注入的助手消息（携带工具结果），先从候选集中剔除，避免它参与预算筛选
    const injectedAssistant = contextMessages.find((msg) => (msg as any).__r2Injected === true)

    // 预算预留：为回放消息（injectedAssistant）预先扣减 token，确保稍后强制追加不会挤爆预算
    // 说明：工具结果的摘要/裁剪由 MCP 工具自行负责；此处只做预算预留，不做内容裁剪。
    let adjustedBudget = remainingContextLength
    if (injectedAssistant) {
      try {
        const injectedTokens = approximateTokenSize(
          JSON.stringify((injectedAssistant as any).content)
        )
        adjustedBudget = Math.max(0, remainingContextLength - injectedTokens)
        try {
          console.log('[R2/Budget]', {
            injectedTokens,
            remainingContextLength,
            adjustedBudget
          })
        } catch {}
      } catch {
        // 忽略个别 stringify 异常，保持原预算
      }
    }

    // 若总体预算不够，但存在必须回放的注入消息，仍然返回该注入消息，确保 R2 能看到工具结果
    if (adjustedBudget <= 0) {
      return injectedAssistant ? [injectedAssistant] : []
    }

    const messages = contextMessages
      .filter(
        (msg) =>
          msg.id !== userMessage?.id && (!injectedAssistant || msg.id !== injectedAssistant.id)
      )
      .reverse()

    let currentLength = 0
    const selectedMessages: Message[] = []

    for (const msg of messages) {
      if (msg.status !== 'sent') {
        continue
      }
      const msgContent = msg.role === 'user' ? (msg.content as UserMessageContent) : null
      const msgText = msgContent
        ? msgContent.text ||
          (msgContent.content ? this.formatUserMessageContent(msgContent.content) : '')
        : ''

      const msgTokens = approximateTokenSize(
        msg.role === 'user'
          ? `${msgText}${getFileContext(msgContent?.files || [])}`
          : JSON.stringify(msg.content)
      )

      if (currentLength + msgTokens <= adjustedBudget) {
        // 如果是用户消息且有 content 但没有 text，添加 text
        if (msg.role === 'user') {
          const userMsgContent = msg.content as UserMessageContent
          if (userMsgContent.content && !userMsgContent.text) {
            userMsgContent.text = this.formatUserMessageContent(userMsgContent.content)
          }
        }

        selectedMessages.unshift(msg)
        currentLength += msgTokens
      } else {
        break
      }
    }
    while (selectedMessages.length > 0 && selectedMessages[0].role !== 'user') {
      selectedMessages.shift()
    }

    // R2 专用：将为回放注入的助手消息追加到结果末尾
    // 备注：此处可能造成极小概率的 token 预算突破，但这是为了保证 R2 能完整回放上一条工具结果（对普通请求无影响）
    if (injectedAssistant) {
      selectedMessages.push(injectedAssistant)
      try {
        console.log('[R2/ContextPick/Final]', {
          injectedAssistantAppended: true,
          selectedCount: selectedMessages.length
        })
      } catch {}
    }
    return selectedMessages
  }

  // 格式化消息用于完成
  private formatMessagesForCompletion(
    contextMessages: Message[],
    systemPrompt: string,
    artifacts: number,
    searchPrompt: string,
    userContent: string,
    enrichedUserMessage: string,
    imageFiles: MessageFile[],
    vision: boolean,
    supportsFunctionCall: boolean
  ): ChatMessage[] {
    const formattedMessages: ChatMessage[] = []

    // 在存在回放注入（__r2Injected）时，确保顺序：system -> 历史(不含注入) -> user -> 回放(注入)
    const injected = contextMessages.find((m) => (m as any).__r2Injected === true)
    const nonInjected = injected
      ? contextMessages.filter((m) => !(m as any).__r2Injected)
      : contextMessages

    // 先追加历史（不含注入回放）
    formattedMessages.push(...this.addContextMessages(nonInjected, vision, supportsFunctionCall))

    // 添加系统提示
    if (systemPrompt) {
      // formattedMessages.push(...this.addSystemPrompt(formattedMessages, systemPrompt, artifacts))
      formattedMessages.unshift({
        role: 'system',
        content: systemPrompt
      })
      // console.log('-------------> system prompt \n', systemPrompt, artifacts, formattedMessages)
    }

    // 添加当前用户消息（放在回放注入之前）
    let finalContent = searchPrompt || userContent

    if (enrichedUserMessage) {
      finalContent += enrichedUserMessage
    }

    if (artifacts === 1) {
      // formattedMessages.push({
      //   role: 'user',
      //   content: ARTIFACTS_PROMPT
      // })
      console.log('artifacts目前由mcp提供，此处为兼容性保留')
    }
    // 没有 vision 就不用塞进去了
    if (vision && imageFiles.length > 0) {
      formattedMessages.push(this.addImageFiles(finalContent, imageFiles))
    } else {
      formattedMessages.push({
        role: 'user',
        content: finalContent.trim()
      })
    }

    // 如果存在回放注入，则最后追加回放（S1 文本 + 工具对）
    if (injected) {
      formattedMessages.push(...this.addContextMessages([injected], vision, supportsFunctionCall))
    }

    return formattedMessages
  }

  private addImageFiles(finalContent: string, imageFiles: MessageFile[]): ChatMessage {
    return {
      role: 'user',
      content: [
        ...imageFiles.map((file) => ({
          type: 'image_url' as const,
          image_url: { url: file.content, detail: 'auto' as const }
        })),
        { type: 'text' as const, text: finalContent.trim() }
      ]
    }
  }

  // 添加上下文消息
  private addContextMessages(
    contextMessages: Message[],
    vision: boolean,
    supportsFunctionCall: boolean
  ): ChatMessage[] {
    const resultMessages = [] as ChatMessage[]

    // 对于原生fc模型，支持正确的tool_call response history插入
    if (supportsFunctionCall) {
      contextMessages.forEach((msg) => {
        if (msg.role === 'user') {
          // 处理用户消息
          const msgContent = msg.content as UserMessageContent
          const msgText = msgContent.content
            ? this.formatUserMessageContent(msgContent.content)
            : msgContent.text
          const userContent = `${msgText}${getFileContext(msgContent.files)}`
          resultMessages.push({
            role: 'user',
            content: userContent
          })
        } else if (msg.role === 'assistant') {
          // 处理助手消息
          // 注入与否不改变回放顺序（均先文本、后工具对）
          let afterSearch = false
          const assistantBlocks = msg.content as AssistantMessageBlock[]
          for (const subMsg of assistantBlocks) {
            if (
              subMsg.type === 'tool_call' &&
              subMsg?.tool_call?.id?.trim() &&
              subMsg?.tool_call?.name?.trim() &&
              subMsg?.tool_call?.params?.trim() &&
              subMsg?.tool_call?.response?.trim()
            ) {
              try {
                const paramsLen = subMsg.tool_call?.params ? subMsg.tool_call.params.length : 0
                const respLen = subMsg.tool_call?.response ? subMsg.tool_call.response.length : 0
                console.log('[R2Context/SupportsFC/ReplayPair]', {
                  toolCallId: subMsg.tool_call?.id,
                  name: subMsg.tool_call?.name,
                  paramsLength: paramsLen,
                  responseLength: respLen
                })
              } catch {}
              resultMessages.push({
                role: 'assistant',
                tool_calls: [
                  {
                    id: subMsg.tool_call.id,
                    type: 'function',
                    function: {
                      name: subMsg.tool_call.name,
                      arguments: subMsg.tool_call.params
                    }
                  }
                ]
              })
              resultMessages.push({
                role: 'tool',
                tool_call_id: subMsg.tool_call.id,
                content: subMsg.tool_call.response
              })
            } else if (subMsg.type === 'tool_call') {
              try {
                const idOk = Boolean(subMsg.tool_call?.id && String(subMsg.tool_call?.id).trim())
                const nameOk = Boolean(
                  subMsg.tool_call?.name && String(subMsg.tool_call?.name).trim()
                )
                const paramsOk = Boolean(
                  subMsg.tool_call?.params && String(subMsg.tool_call?.params).trim()
                )
                const respOk = Boolean(
                  subMsg.tool_call?.response && String(subMsg.tool_call?.response).trim()
                )
                console.log('[R2Context/SupportsFC/SkipReason]', {
                  idOk,
                  nameOk,
                  paramsOk,
                  respOk
                })
              } catch {}
            } else if (subMsg.type === 'search') {
              // 删除强制搜索结果中遗留的[x]引文标记
              afterSearch = true
            } else if (subMsg.type === 'content') {
              // 原样回放 S1 文本（带清洗）
              let content = subMsg.content ?? ''
              if (afterSearch) content = content.replace(/\[\d+\]/g, '')
              resultMessages.push({
                role: 'assistant',
                content: content
              })
              afterSearch = false
            }
          }
        }
      })
      return resultMessages
    } else {
      // 对于非原生fc模型，支持规范化prompt实现
      contextMessages.forEach((msg) => {
        if (msg.role === 'user') {
          // 处理用户消息
          const msgContent = msg.content as UserMessageContent
          const msgText = msgContent.content
            ? this.formatUserMessageContent(msgContent.content)
            : msgContent.text
          const userContent = `${msgText}${getFileContext(msgContent.files)}`
          resultMessages.push({
            role: 'user',
            content: userContent
          })
        } else if (msg.role === 'assistant') {
          // 处理助手消息
          const assistantBlocks = msg.content as AssistantMessageBlock[]
          // 提取文本内容块，同时将工具调用的响应内容提取出来
          let afterSearch = false
          const textContent = assistantBlocks
            .filter(
              (block) =>
                block.type === 'content' || block.type === 'search' || block.type === 'tool_call'
            )
            .map((block) => {
              if (block.type === 'search') {
                // 删除强制搜索结果中遗留的[x]引文标记
                afterSearch = true
                return ''
              } else if (block.type === 'content') {
                // 删除强制搜索结果中遗留的[x]引文标记
                let content = block.content ?? ''
                if (afterSearch) content = content.replace(/\[\d+\]/g, '')
                afterSearch = false
                return content
              } else if (
                block.type === 'tool_call' &&
                block.tool_call?.response &&
                block.tool_call?.params
              ) {
                let parsedParams
                let parsedResponse

                try {
                  parsedParams = JSON.parse(block.tool_call.params)
                } catch {
                  parsedParams = block.tool_call.params // 保留原字符串
                }

                try {
                  parsedResponse = JSON.parse(block.tool_call.response)
                } catch {
                  parsedResponse = block.tool_call.response // 保留原字符串
                }

                return (
                  '<function_call>' +
                  JSON.stringify({
                    function_call_record: {
                      name: block.tool_call.name,
                      arguments: parsedParams,
                      response: parsedResponse
                    }
                  }) +
                  '</function_call>'
                )
              } else {
                return '' // 若 tool_call 或 response、params 是 undefined 返回。只是便于调试而已，可以为空。
              }
            })
            .join('\n')

          // 查找图像块
          const imageBlocks = assistantBlocks.filter(
            (block) => block.type === 'image' && block.image_data
          )

          // 如果没有任何内容，则跳过此消息
          if (!textContent && imageBlocks.length === 0) {
            return
          }

          // 如果有图像，则使用复合内容格式
          if (vision && imageBlocks.length > 0) {
            const content: ChatMessageContent[] = []

            // 添加图像内容
            imageBlocks.forEach((block) => {
              if (block.image_data) {
                content.push({
                  type: 'image_url',
                  image_url: {
                    url: block.image_data.data,
                    detail: 'auto'
                  }
                })
              }
            })

            // 添加文本内容
            if (textContent) {
              content.push({
                type: 'text',
                text: textContent
              })
            }

            resultMessages.push({
              role: 'assistant',
              content: content
            })
          } else {
            // 仅有文本内容
            resultMessages.push({
              role: 'assistant',
              content: textContent
            })
          }
        }
      })

      return resultMessages
    }
  }

  // 合并连续的相同角色的content，但注意assistant下content不能跟tool_calls合并
  private mergeConsecutiveMessages(messages: ChatMessage[]): ChatMessage[] {
    if (!messages || messages.length === 0) {
      return []
    }

    const mergedResult: ChatMessage[] = []
    // 为第一条消息创建一个深拷贝并添加到结果数组
    mergedResult.push(JSON.parse(JSON.stringify(messages[0])))

    for (let i = 1; i < messages.length; i++) {
      // 为当前消息创建一个深拷贝
      const currentMessage = JSON.parse(JSON.stringify(messages[i])) as ChatMessage
      const lastPushedMessage = mergedResult[mergedResult.length - 1]

      let allowMessagePropertiesMerge = false // 标志是否允许消息属性（如content）合并

      // 步骤 1: 判断消息本身是否允许合并（基于role和tool_calls）
      if (lastPushedMessage.role === currentMessage.role) {
        if (currentMessage.role === 'assistant') {
          // Assistant消息: 仅当两条消息都【不】包含tool_calls时，才允许合并
          if (!lastPushedMessage.tool_calls && !currentMessage.tool_calls) {
            allowMessagePropertiesMerge = true
          }
        } else {
          // 其他角色 (user, system): 如果role相同，则允许合并
          allowMessagePropertiesMerge = true
        }
      }

      if (allowMessagePropertiesMerge) {
        // 步骤 2: 如果消息允许合并，尝试合并其 content 字段
        const LMC = lastPushedMessage.content // 上一条已推送消息的内容
        const CMC = currentMessage.content // 当前待处理消息的内容

        let newCombinedContent: string | ChatMessageContent[] | undefined = undefined
        let contentTypesCompatibleForMerging = false

        if (LMC === undefined && CMC === undefined) {
          newCombinedContent = undefined
          contentTypesCompatibleForMerging = true
        } else if (typeof LMC === 'string' && (typeof CMC === 'string' || CMC === undefined)) {
          // LMC是string, CMC是string或undefined
          const sLMC = LMC || ''
          const sCMC = CMC || ''
          if (sLMC && sCMC) newCombinedContent = `${sLMC}\n${sCMC}`
          else newCombinedContent = sLMC || sCMC // 保留有内容的一方
          if (newCombinedContent === '') newCombinedContent = undefined // 空字符串视为undefined
          contentTypesCompatibleForMerging = true
        } else if (Array.isArray(LMC) && (Array.isArray(CMC) || CMC === undefined)) {
          // LMC是数组, CMC是数组或undefined
          const arrLMC = LMC
          const arrCMC = CMC || [] // 如果CMC是undefined, 视为空数组进行合并
          newCombinedContent = [...arrLMC, ...arrCMC]
          if (newCombinedContent.length === 0) newCombinedContent = undefined // 空数组视为undefined
          contentTypesCompatibleForMerging = true
        } else if (LMC === undefined && CMC !== undefined) {
          // LMC是undefined, CMC有值 (string或array)
          newCombinedContent = CMC
          contentTypesCompatibleForMerging = true
        } else if (LMC !== undefined && CMC === undefined) {
          // LMC有值, CMC是undefined -> content保持LMC的值，无需改变
          newCombinedContent = LMC
          contentTypesCompatibleForMerging = true // 视为成功合并（当前消息内容被"吸收"）
        }
        // 如果LMC和CMC的类型不兼容 (例如一个是string, 另一个是array)，
        // contentTypesCompatibleForMerging 将保持 false

        if (contentTypesCompatibleForMerging) {
          lastPushedMessage.content = newCombinedContent
          // currentMessage 被成功合并，不需单独push
        } else {
          // 角色和tool_calls条件允许合并，但内容类型不兼容
          // 因此，不合并消息，将 currentMessage 作为新消息加入
          mergedResult.push(currentMessage)
        }
      } else {
        // 角色不同，或者 assistant 消息因 tool_calls 而不允许合并
        // 将 currentMessage 作为新消息加入
        mergedResult.push(currentMessage)
      }
    }

    return mergedResult
  }

  // 更新生成状态
  private async updateGenerationState(
    state: GeneratingMessageState,
    promptTokens: number
  ): Promise<void> {
    // 原地更新，避免替换对象引用（防止 finally 清标志清到旧对象）
    const cur = this.generatingMessages.get(state.message.id)
    if (cur) {
      cur.startTime = Date.now()
      cur.firstTokenTime = null
      cur.promptTokens = promptTokens
      // 保持 __id 不变
      // state updated (quiet)
    } else {
      this.generatingMessages.set(state.message.id, {
        ...state,
        startTime: Date.now(),
        firstTokenTime: null,
        promptTokens,
        __id: state.__id ?? ++this.genStateSeq
      })
      // state initialized (quiet)
    }

    // 更新消息的usage信息
    await this.messageManager.updateMessageMetadata(state.message.id, {
      totalTokens: promptTokens,
      generationTime: 0,
      firstTokenTime: 0,
      tokensPerSecond: 0
    })
  }

  async editMessage(messageId: string, content: string): Promise<Message> {
    const { message, revision } = await this.messageManager.editMessageSilently(messageId, content)
    this.emitMessageEdited(messageId, revision, message.parentId)
    return message
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.messageManager.deleteMessage(messageId)
  }

  async retryMessage(messageId: string): Promise<AssistantMessage> {
    const message = await this.messageManager.getMessage(messageId)
    if (message.role !== 'assistant') {
      throw new Error('只能重试助手消息')
    }

    const userMessage = await this.messageManager.getMessage(message.parentId || '')
    if (!userMessage) {
      throw new Error('找不到对应的用户消息')
    }
    const conversation = await this.getConversation(message.conversationId)
    const { providerId, modelId } = conversation.settings
    const assistantMessage = await this.messageManager.retryMessage(messageId, {
      totalTokens: 0,
      generationTime: 0,
      firstTokenTime: 0,
      tokensPerSecond: 0,
      contextUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: modelId,
      provider: providerId
    })

    // 初始化生成状态
    this.generatingMessages.set(assistantMessage.id, {
      message: assistantMessage as AssistantMessage,
      conversationId: message.conversationId,
      startTime: Date.now(),
      firstTokenTime: null,
      promptTokens: 0,
      reasoningStartTime: null,
      reasoningEndTime: null,
      lastReasoningTime: null,
      __id: ++this.genStateSeq
    })
    // state created (quiet)

    return assistantMessage as AssistantMessage
  }

  async regenerateFromUserMessage(
    conversationId: string,
    userMessageId: string,
    selectedVariantsMap?: Record<string, string>
  ): Promise<AssistantMessage> {
    const userMessage = await this.messageManager.getMessage(userMessageId)
    if (!userMessage || userMessage.role !== 'user') {
      throw new Error('Can only regenerate based on user messages.')
    }

    const conversation = await this.getConversation(conversationId)
    const { providerId, modelId } = conversation.settings

    const assistantMessage = (await this.messageManager.sendMessage(
      conversationId,
      JSON.stringify([]),
      'assistant',
      userMessageId,
      false,
      {
        totalTokens: 0,
        generationTime: 0,
        firstTokenTime: 0,
        tokensPerSecond: 0,
        contextUsage: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: modelId,
        provider: providerId
      }
    )) as AssistantMessage

    this.generatingMessages.set(assistantMessage.id, {
      message: assistantMessage,
      conversationId,
      startTime: Date.now(),
      firstTokenTime: null,
      promptTokens: 0,
      reasoningStartTime: null,
      reasoningEndTime: null,
      lastReasoningTime: null,
      __id: ++this.genStateSeq
    })
    // state created (quiet)

    this.startStreamCompletion(
      conversationId,
      userMessageId,
      selectedVariantsMap,
      'msg_retry'
    ).catch((e) => {
      console.error('Failed to start regeneration from user message:', e)
    })

    return assistantMessage
  }

  async getMessageVariants(messageId: string): Promise<Message[]> {
    return await this.messageManager.getMessageVariants(messageId)
  }

  async updateMessageStatus(messageId: string, status: MESSAGE_STATUS): Promise<void> {
    await this.messageManager.updateMessageStatus(messageId, status)
  }

  async updateMessageMetadata(
    messageId: string,
    metadata: Partial<MESSAGE_METADATA>
  ): Promise<void> {
    await this.messageManager.updateMessageMetadata(messageId, metadata)
  }

  async markMessageAsContextEdge(messageId: string, isEdge: boolean): Promise<void> {
    await this.messageManager.markMessageAsContextEdge(messageId, isEdge)
  }

  async getActiveConversationId(tabId: number): Promise<string | null> {
    return this.activeConversationIds.get(tabId) || null
  }

  private async getLatestConversation(): Promise<CONVERSATION | null> {
    const result = await this.getConversationList(1, 1)
    return result.list[0] || null
  }

  getGeneratingMessageState(messageId: string): GeneratingMessageState | null {
    return this.generatingMessages.get(messageId) || null
  }

  getConversationGeneratingMessages(conversationId: string): AssistantMessage[] {
    return Array.from(this.generatingMessages.values())
      .filter((state) => state.conversationId === conversationId)
      .map((state) => state.message)
  }

  async stopMessageGeneration(messageId: string): Promise<void> {
    const state = this.generatingMessages.get(messageId)
    if (state) {
      // 设置统一的取消标志
      state.isCancelled = true

      // 刷新剩余缓冲内容
      if (state.adaptiveBuffer) {
        await this.flushAdaptiveBuffer(messageId)
      }

      // 清理缓冲相关资源
      this.cleanupContentBuffer(state)

      // 标记消息不再处于搜索状态
      if (state.isSearching) {
        this.searchingMessages.delete(messageId)

        // 停止搜索窗口
        await this.searchManager.stopSearch(state.conversationId)
      }

      // 添加用户取消的消息块
      state.message.content.forEach((block) => {
        if (
          block.status === 'loading' ||
          block.status === 'reading' ||
          block.status === 'optimizing'
        ) {
          block.status = 'success'
        }
      })
      state.message.content.push({
        type: 'error',
        content: 'common.error.userCanceledGeneration',
        status: 'cancel',
        timestamp: Date.now()
      })

      // 更新消息状态和内容
      await this.messageManager.updateMessageStatus(messageId, 'error')
      {
        const { message, revision } = await this.messageManager.editMessageSilently(
          messageId,
          JSON.stringify(state.message.content)
        )
        this.emitMessageEdited(messageId, revision, message.parentId)
      }

      // 停止流式生成
      await this.llmProviderPresenter.stopStream(messageId)

      // 清理生成状态
      this.generatingMessages.delete(messageId)
    }
  }

  async stopConversationGeneration(conversationId: string): Promise<void> {
    const messageIds = Array.from(this.generatingMessages.entries())
      .filter(([, state]) => state.conversationId === conversationId)
      .map(([messageId]) => messageId)

    await Promise.all(messageIds.map((messageId) => this.stopMessageGeneration(messageId)))
  }

  async summaryTitles(tabId?: number, conversationId?: string): Promise<string> {
    const targetConversationId =
      conversationId ?? (tabId !== undefined ? this.activeConversationIds.get(tabId) : undefined)
    if (!targetConversationId) {
      throw new Error('找不到当前对话')
    }
    const conversation = await this.getConversation(targetConversationId)
    if (!conversation) {
      throw new Error('找不到当前对话')
    }
    let summaryProviderId = conversation.settings.providerId
    const modelId = this.searchAssistantModel?.id
    summaryProviderId = this.searchAssistantProviderId || conversation.settings.providerId
    const messages = await this.getContextMessages(conversation.id)
    const selectedVariantsMap = conversation.settings.selectedVariantsMap || {}
    const variantAwareMessages = messages.map((msg) => {
      if (msg.role === 'assistant' && selectedVariantsMap[msg.id] && msg.variants) {
        const selectedVariantId = selectedVariantsMap[msg.id]
        const selectedVariant = msg.variants.find((v) => v.id === selectedVariantId)

        if (selectedVariant) {
          const newMsg = JSON.parse(JSON.stringify(msg))
          newMsg.content = selectedVariant.content
          newMsg.usage = selectedVariant.usage
          newMsg.model_id = selectedVariant.model_id
          newMsg.model_provider = selectedVariant.model_provider
          newMsg.model_name = selectedVariant.model_name
          return newMsg
        }
      }
      return msg
    })
    const messagesWithLength = variantAwareMessages
      .map((msg) => {
        if (msg.role === 'user') {
          return {
            message: msg,
            length: `${(msg.content as UserMessageContent).text}${getFileContext(
              (msg.content as UserMessageContent).files
            )}`.length,
            formattedMessage: {
              role: 'user' as const,
              content: `${(msg.content as UserMessageContent).text}${getFileContext(
                (msg.content as UserMessageContent).files
              )}`
            }
          }
        } else {
          const content = (msg.content as AssistantMessageBlock[])
            .filter((block) => block.type === 'content')
            .map((block) => block.content)
            .join('\n')
          return {
            message: msg,
            length: content.length,
            formattedMessage: {
              role: 'assistant' as const,
              content: content
            }
          }
        }
      })
      .filter((item) => item.formattedMessage.content.length > 0)
    const title = await this.llmProviderPresenter.summaryTitles(
      messagesWithLength.map((item) => item.formattedMessage),
      summaryProviderId || conversation.settings.providerId,
      modelId || conversation.settings.modelId
    )
    console.log('-------------> title \n', title)
    let cleanedTitle = title.replace(/<think>.*?<\/think>/g, '').trim()
    cleanedTitle = cleanedTitle.replace(/^<think>/, '').trim()
    console.log('-------------> cleanedTitle \n', cleanedTitle)
    return cleanedTitle
  }

  async clearActiveThread(tabId: number): Promise<void> {
    this.activeConversationIds.delete(tabId)
    eventBus.sendToRenderer(CONVERSATION_EVENTS.DEACTIVATED, SendTarget.ALL_WINDOWS, { tabId })
  }

  async clearAllMessages(conversationId: string): Promise<void> {
    await this.messageManager.clearAllMessages(conversationId)
    // 检查所有 tab 中的活跃会话
    for (const [, activeId] of this.activeConversationIds.entries()) {
      if (activeId === conversationId) {
        // 停止所有正在生成的消息
        await this.stopConversationGeneration(conversationId)
      }
    }
  }

  async getMessageExtraInfo(messageId: string, type: string): Promise<Record<string, unknown>[]> {
    const attachments = await this.sqlitePresenter.getMessageAttachments(messageId, type)
    return attachments.map((attachment) => JSON.parse(attachment.content))
  }

  async getMainMessageByParentId(
    conversationId: string,
    parentId: string
  ): Promise<Message | null> {
    const message = await this.messageManager.getMainMessageByParentId(conversationId, parentId)
    if (!message) {
      return null
    }
    return message
  }

  destroy() {
    this.searchManager.destroy()
  }

  /**
   * 创建会话的分支
   * @param targetConversationId 源会话ID
   * @param targetMessageId 目标消息ID（截止到该消息的所有消息将被复制）
   * @param newTitle 新会话标题
   * @param settings 新会话设置
   * @param selectedVariantsMap 选定的变体映射表 (可选)
   * @returns 新创建的会话ID
   */
  async forkConversation(
    targetConversationId: string,
    targetMessageId: string,
    newTitle: string,
    settings?: Partial<CONVERSATION_SETTINGS>,
    selectedVariantsMap?: Record<string, string>
  ): Promise<string> {
    try {
      // 1. 获取源会话信息
      const sourceConversation = await this.sqlitePresenter.getConversation(targetConversationId)
      if (!sourceConversation) {
        throw new Error('源会话不存在')
      }

      // 2. 创建新会话
      const newConversationId = await this.sqlitePresenter.createConversation(newTitle)

      const newSettings = { ...(settings || sourceConversation.settings) }
      newSettings.selectedVariantsMap = {} // 确保新会话不继承变体选择
      await this.updateConversationSettings(newConversationId, newSettings)

      await this.sqlitePresenter.updateConversation(newConversationId, { is_new: 0 })

      // 3.1. 获取完整的、未截断的会话历史（只包含主消息）
      const { list: fullHistory } = await this.messageManager.getMessageThread(
        targetConversationId,
        1,
        99999 // 使用一个足够大的数字确保获取全部历史
      )

      // 3.2. 获取用户点击的目标消息对象
      const targetMessage = await this.messageManager.getMessage(targetMessageId)
      if (!targetMessage) {
        throw new Error('目标消息不存在')
      }

      // 3.3. 确定目标消息所属的“主消息”ID
      let mainTargetId: string | null = null
      if (targetMessage.is_variant) {
        // 如果是变体，则通过其 parentId（指向用户消息）找到其主消息
        if (!targetMessage.parentId) {
          throw new Error('变体消息缺少 parentId，无法定位主消息')
        }
        const mainMessage = await this.messageManager.getMainMessageByParentId(
          targetConversationId,
          targetMessage.parentId
        )
        mainTargetId = mainMessage ? mainMessage.id : null
      } else {
        // 如果本身就是主消息
        mainTargetId = targetMessage.id
      }

      if (!mainTargetId) {
        throw new Error('无法确定用于分叉的历史记录目标主消息ID')
      }

      // 3.4. 在完整历史中找到主消息的索引
      const forkEndIndex = fullHistory.findIndex((msg) => msg.id === mainTargetId)
      if (forkEndIndex === -1) {
        throw new Error('目标主消息在会话历史中未找到，无法分叉。')
      }

      // 3.5. 截取从开始到目标主消息（包括）的正确历史记录
      const messageHistory = fullHistory.slice(0, forkEndIndex + 1)

      // 4. 创建消息ID映射表，用于维护父子关系
      const messageIdMap = new Map<string, string>() // 旧消息ID -> 新消息ID
      const messagesToProcess: Array<{ msg: any; orderSeq: number }> = []

      for (const msg of messageHistory) {
        if (msg.status !== 'sent') {
          continue
        }
        const orderSeq = (await this.sqlitePresenter.getMaxOrderSeq(newConversationId)) + 1
        messagesToProcess.push({ msg, orderSeq })
      }

      // 5. 按顺序插入所有消息，先不设置父ID
      for (const { msg, orderSeq } of messagesToProcess) {
        let finalMsg = msg
        // 当循环到我们关心的主消息时，检查 selectedVariantsMap
        if (msg.role === 'assistant' && selectedVariantsMap && selectedVariantsMap[msg.id]) {
          const selectedVariantId = selectedVariantsMap[msg.id]
          const variant = msg.variants?.find((v) => v.id === selectedVariantId)
          if (variant) {
            finalMsg = variant // 使用选定的变体对象进行复制
          }
        }

        const metadata: MESSAGE_METADATA = {
          totalTokens: finalMsg.usage?.total_tokens || 0,
          generationTime: 0,
          firstTokenTime: 0,
          tokensPerSecond: 0,
          contextUsage: 0,
          inputTokens: finalMsg.usage?.input_tokens || 0,
          outputTokens: finalMsg.usage?.output_tokens || 0,
          ...(finalMsg.model_id ? { model: finalMsg.model_id } : {}),
          ...(finalMsg.model_provider ? { provider: finalMsg.model_provider } : {})
        }

        const tokenCount = finalMsg.usage?.total_tokens || 0
        const content =
          typeof finalMsg.content === 'string' ? finalMsg.content : JSON.stringify(finalMsg.content)

        const newMessageId = await this.sqlitePresenter.insertMessage(
          newConversationId,
          content,
          finalMsg.role,
          '',
          JSON.stringify(metadata),
          orderSeq,
          tokenCount,
          'sent',
          0,
          0
        )
        messageIdMap.set(msg.id, newMessageId)
      }

      // 6. 更新所有消息的父ID，恢复正确的父子关系
      for (const { msg } of messagesToProcess) {
        if (msg.parentId && msg.parentId !== '') {
          const newMessageId = messageIdMap.get(msg.id)
          const newParentId = messageIdMap.get(msg.parentId)
          if (newMessageId && newParentId) {
            await this.sqlitePresenter.updateMessageParentId(newMessageId, newParentId)
          }
        }
      }

      // 7. 在所有数据库操作完成后，调用广播方法
      await this.broadcastThreadListUpdate()

      // 8. 触发会话创建事件
      return newConversationId
    } catch (error) {
      console.error('分支会话失败:', error)
      throw error
    }
  }

  // 翻译文本
  async translateText(text: string, tabId: number): Promise<string> {
    try {
      let conversation = await this.getActiveConversation(tabId)
      if (!conversation) {
        // 创建一个临时对话用于翻译
        const defaultProvider = this.configPresenter.getDefaultProviders()[0]
        const models = await this.llmProviderPresenter.getModelList(defaultProvider.id)
        const defaultModel = models[0]
        const conversationId = await this.createConversation(
          '临时翻译对话',
          {
            modelId: defaultModel.id,
            providerId: defaultProvider.id
          },
          tabId
        )
        conversation = await this.getConversation(conversationId)
      }

      const { providerId, modelId } = conversation.settings
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            '你是一个翻译助手。请将用户输入的文本翻译成中文。只返回翻译结果，不要添加任何其他内容。'
        },
        {
          role: 'user',
          content: text
        }
      ]

      let translatedText = ''
      const stream = this.llmProviderPresenter.startStreamCompletion(
        providerId,
        messages,
        modelId,
        'translate-' + Date.now(),
        0.3,
        1000
      )

      for await (const event of stream) {
        if (event.type === 'response') {
          const msg = event.data as LLMAgentEventData
          if (msg.content) {
            translatedText += msg.content
          }
        } else if (event.type === 'error') {
          const msg = event.data as { eventId: string; error: string }
          throw new Error(msg.error || '翻译失败')
        }
      }

      return translatedText.trim()
    } catch (error) {
      console.error('翻译失败:', error)
      throw error
    }
  }

  // AI询问
  async askAI(text: string, tabId: number): Promise<string> {
    try {
      let conversation = await this.getActiveConversation(tabId)
      if (!conversation) {
        // 创建一个临时对话用于AI询问
        const defaultProvider = this.configPresenter.getDefaultProviders()[0]
        const models = await this.llmProviderPresenter.getModelList(defaultProvider.id)
        const defaultModel = models[0]
        const conversationId = await this.createConversation(
          '临时AI对话',
          {
            modelId: defaultModel.id,
            providerId: defaultProvider.id
          },
          tabId
        )
        conversation = await this.getConversation(conversationId)
      }

      const { providerId, modelId } = conversation.settings
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: '你是一个AI助手。请简洁地回答用户的问题。'
        },
        {
          role: 'user',
          content: text
        }
      ]

      let aiAnswer = ''
      const stream = this.llmProviderPresenter.startStreamCompletion(
        providerId,
        messages,
        modelId,
        'ask-ai-' + Date.now(),
        0.7,
        1000
      )

      for await (const event of stream) {
        if (event.type === 'response') {
          const msg = event.data as LLMAgentEventData
          if (msg.content) {
            aiAnswer += msg.content
          }
        } else if (event.type === 'error') {
          const msg = event.data as { eventId: string; error: string }
          throw new Error(msg.error || 'AI回答失败')
        }
      }

      return aiAnswer.trim()
    } catch (error) {
      console.error('AI询问失败:', error)
      throw error
    }
  }

  private async broadcastThreadListUpdate(): Promise<void> {
    // 1. 获取所有会话 (假设9999足够大)
    const result = await this.sqlitePresenter.getConversationList(1, this.fetchThreadLength)

    // 2. 分离置顶和非置顶会话
    const pinnedConversations: CONVERSATION[] = []
    const normalConversations: CONVERSATION[] = []

    result.list.forEach((conv) => {
      if (conv.is_pinned === 1) {
        pinnedConversations.push(conv)
      } else {
        normalConversations.push(conv)
      }
    })

    // 3. 对置顶会话按更新时间排序
    pinnedConversations.sort((a, b) => b.updatedAt - a.updatedAt)

    // 4. 对普通会话按更新时间排序
    normalConversations.sort((a, b) => b.updatedAt - a.updatedAt)

    // 5. 按日期分组
    const groupedThreads: Map<string, CONVERSATION[]> = new Map()

    // 先添加置顶分组（如果有置顶会话）
    if (pinnedConversations.length > 0) {
      groupedThreads.set('Pinned', pinnedConversations)
    }

    // 再添加普通会话的日期分组
    normalConversations.forEach((conv) => {
      const date = new Date(conv.updatedAt).toISOString().split('T')[0]
      if (!groupedThreads.has(date)) {
        groupedThreads.set(date, [])
      }
      groupedThreads.get(date)!.push(conv)
    })

    const finalGroupedList = Array.from(groupedThreads.entries()).map(([dt, dtThreads]) => ({
      dt,
      dtThreads
    }))

    // 6. 广播这个格式化好的完整列表
    eventBus.sendToRenderer(
      CONVERSATION_EVENTS.LIST_UPDATED,
      SendTarget.ALL_WINDOWS,
      finalGroupedList
    )
  }

  /**
   * 导出会话内容
   * @param conversationId 会话ID
   * @param format 导出格式 ('markdown' | 'html' | 'txt')
   * @returns 包含文件名和内容的对象
   */
  async exportConversation(
    conversationId: string,
    format: 'markdown' | 'html' | 'txt' = 'markdown'
  ): Promise<{
    filename: string
    content: string
  }> {
    try {
      // 获取会话信息
      const conversation = await this.getConversation(conversationId)
      if (!conversation) {
        throw new Error('会话不存在')
      }

      // 获取所有消息
      const { list: messages } = await this.getMessages(conversationId, 1, 10000)

      // 过滤掉未发送成功的消息
      const validMessages = messages.filter((msg) => msg.status === 'sent')

      // 应用变体选择
      const selectedVariantsMap = conversation.settings.selectedVariantsMap || {}
      const variantAwareMessages = validMessages.map((msg) => {
        if (msg.role === 'assistant' && selectedVariantsMap[msg.id] && msg.variants) {
          const selectedVariantId = selectedVariantsMap[msg.id]
          const selectedVariant = msg.variants.find((v) => v.id === selectedVariantId)

          if (selectedVariant) {
            const newMsg = JSON.parse(JSON.stringify(msg))
            newMsg.content = selectedVariant.content
            newMsg.usage = selectedVariant.usage
            newMsg.model_id = selectedVariant.model_id
            newMsg.model_provider = selectedVariant.model_provider
            newMsg.model_name = selectedVariant.model_name
            return newMsg
          }
        }
        return msg
      })

      // 生成文件名 - 使用简化的时间戳格式
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .substring(0, 19)
      const extension = format === 'markdown' ? 'md' : format
      const filename = `export_deepchat_${timestamp}.${extension}`

      // 生成内容（在主进程中直接处理，避免Worker的复杂性）
      let content: string
      switch (format) {
        case 'markdown':
          content = this.exportToMarkdown(conversation, variantAwareMessages)
          break
        case 'html':
          content = this.exportToHtml(conversation, variantAwareMessages)
          break
        case 'txt':
          content = this.exportToText(conversation, variantAwareMessages)
          break
        default:
          throw new Error(`不支持的导出格式: ${format}`)
      }

      return { filename, content }
    } catch (error) {
      console.error('Failed to export conversation:', error)
      throw error
    }
  }

  /**
   * 导出为 Markdown 格式
   */
  private exportToMarkdown(conversation: CONVERSATION, messages: Message[]): string {
    const lines: string[] = []

    // 标题和元信息
    lines.push(`# ${conversation.title}`)
    lines.push('')
    lines.push(`**Export Time:** ${new Date().toLocaleString()}`)
    lines.push(`**Conversation ID:** ${conversation.id}`)
    lines.push(`**Message Count:** ${messages.length}`)
    if (conversation.settings.modelId) {
      lines.push(`**Model:** ${conversation.settings.modelId}`)
    }
    if (conversation.settings.providerId) {
      lines.push(`**Provider:** ${conversation.settings.providerId}`)
    }
    lines.push('')
    lines.push('---')
    lines.push('')

    // 处理每条消息
    for (const message of messages) {
      const messageTime = new Date(message.timestamp).toLocaleString()

      if (message.role === 'user') {
        lines.push(`## 👤 用户 (${messageTime})`)
        lines.push('')

        const userContent = message.content as UserMessageContent
        const messageText = userContent.content
          ? this.formatUserMessageContent(userContent.content)
          : userContent.text

        lines.push(messageText)

        // 处理文件附件
        if (userContent.files && userContent.files.length > 0) {
          lines.push('')
          lines.push('**附件:**')
          for (const file of userContent.files) {
            lines.push(`- ${file.name} (${file.mimeType})`)
          }
        }

        // 处理链接
        if (userContent.links && userContent.links.length > 0) {
          lines.push('')
          lines.push('**链接:**')
          for (const link of userContent.links) {
            lines.push(`- ${link}`)
          }
        }
      } else if (message.role === 'assistant') {
        lines.push(`## 🤖 助手 (${messageTime})`)
        lines.push('')

        const assistantBlocks = message.content as AssistantMessageBlock[]

        for (const block of assistantBlocks) {
          switch (block.type) {
            case 'content':
              if (block.content) {
                lines.push(block.content)
                lines.push('')
              }
              break

            case 'reasoning_content':
              if (block.content) {
                lines.push('### 🤔 思考过程')
                lines.push('')
                lines.push('```')
                lines.push(block.content)
                lines.push('```')
                lines.push('')
              }
              break

            case 'tool_call':
              if (block.tool_call) {
                lines.push(`### 🔧 工具调用: ${block.tool_call.name}`)
                lines.push('')
                if (block.tool_call.params) {
                  lines.push('**参数:**')
                  lines.push('```json')
                  try {
                    const params = JSON.parse(block.tool_call.params)
                    lines.push(JSON.stringify(params, null, 2))
                  } catch {
                    lines.push(block.tool_call.params)
                  }
                  lines.push('```')
                  lines.push('')
                }
                if (block.tool_call.response) {
                  lines.push('**响应:**')
                  lines.push('```')
                  lines.push(block.tool_call.response)
                  lines.push('```')
                  lines.push('')
                }
              }
              break

            case 'search':
              lines.push('### 🔍 网络搜索')
              if (block.extra?.total) {
                lines.push(`找到 ${block.extra.total} 个搜索结果`)
              }
              lines.push('')
              break

            case 'image':
              lines.push('### 🖼️ 图片')
              lines.push('*[图片内容]*')
              lines.push('')
              break

            case 'error':
              if (block.content) {
                lines.push(`### ❌ 错误`)
                lines.push('')
                lines.push(`\`${block.content}\``)
                lines.push('')
              }
              break

            case 'artifact-thinking':
              if (block.content) {
                lines.push('### 💭 创作思考')
                lines.push('')
                lines.push('```')
                lines.push(block.content)
                lines.push('```')
                lines.push('')
              }
              break
          }
        }
      }

      lines.push('---')
      lines.push('')
    }

    return lines.join('\n')
  }

  /**
   * 导出为 HTML 格式
   */
  private exportToHtml(conversation: CONVERSATION, messages: Message[]): string {
    const lines: string[] = []

    // HTML 头部
    lines.push('<!DOCTYPE html>')
    lines.push('<html lang="zh-CN">')
    lines.push('<head>')
    lines.push('  <meta charset="UTF-8">')
    lines.push('  <meta name="viewport" content="width=device-width, initial-scale=1.0">')
    lines.push(`  <title>${this.escapeHtml(conversation.title)}</title>`)
    lines.push('  <style>')
    lines.push('    @media (prefers-color-scheme: dark) {')
    lines.push('      body { background: #0f0f23; color: #e4e4e7; }')
    lines.push('      .header { border-bottom-color: #27272a; }')
    lines.push('      .message { border-left-color: #3f3f46; }')
    lines.push('      .user-message { border-left-color: #3b82f6; background: #1e293b; }')
    lines.push('      .assistant-message { border-left-color: #10b981; background: #064e3b; }')
    lines.push('      .tool-call { background: #1f2937; border-color: #374151; }')
    lines.push('      .search-block { background: #1e3a8a; border-color: #1d4ed8; }')
    lines.push('      .error-block { background: #7f1d1d; border-color: #dc2626; }')
    lines.push('      .reasoning-block { background: #581c87; border-color: #7c3aed; }')
    lines.push('      .code { background: #1f2937; border-color: #374151; color: #f3f4f6; }')
    lines.push('      .attachments { background: #78350f; border-color: #d97706; }')
    lines.push('    }')
    lines.push(
      '    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.7; max-width: 900px; margin: 0 auto; padding: 32px 24px; background: #ffffff; color: #1f2937; }'
    )
    lines.push(
      '    .header { border-bottom: 1px solid #e5e7eb; padding-bottom: 24px; margin-bottom: 32px; }'
    )
    lines.push(
      '    .header h1 { margin: 0 0 16px 0; font-size: 2rem; font-weight: 700; color: #111827; }'
    )
    lines.push('    .header p { margin: 4px 0; font-size: 0.875rem; color: #6b7280; }')
    lines.push(
      '    .message { margin-bottom: 32px; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1); }'
    )
    lines.push('    .user-message { background: #f8fafc; border-left: 4px solid #3b82f6; }')
    lines.push('    .assistant-message { background: #f0fdf4; border-left: 4px solid #10b981; }')
    lines.push(
      '    .message-header { font-weight: 600; margin-bottom: 12px; color: #374151; font-size: 1rem; }'
    )
    lines.push('    .message-time { font-size: 0.75rem; color: #9ca3af; font-weight: 400; }')
    lines.push(
      '    .tool-call { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 12px 0; }'
    )
    lines.push(
      '    .search-block { background: #eff6ff; border: 1px solid #dbeafe; border-radius: 8px; padding: 16px; margin: 12px 0; }'
    )
    lines.push(
      '    .error-block { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 12px 0; color: #dc2626; }'
    )
    lines.push(
      '    .reasoning-block { background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px; padding: 16px; margin: 12px 0; }'
    )
    lines.push(
      '    .code { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace; font-size: 0.875rem; white-space: pre-wrap; overflow-x: auto; color: #1e293b; }'
    )
    lines.push(
      '    .attachments { background: #fffbeb; border: 1px solid #fed7aa; border-radius: 8px; padding: 16px; margin: 12px 0; }'
    )
    lines.push('    .attachments ul { margin: 8px 0 0 0; padding-left: 20px; }')
    lines.push('    .attachments li { margin: 4px 0; }')
    lines.push('    a { color: #2563eb; text-decoration: none; }')
    lines.push('    a:hover { text-decoration: underline; }')
    lines.push('  </style>')
    lines.push('</head>')
    lines.push('<body>')

    // 标题和元信息
    lines.push('  <div class="header">')
    lines.push(`    <h1>${this.escapeHtml(conversation.title)}</h1>`)
    lines.push(`    <p><strong>导出时间:</strong> ${new Date().toLocaleString()}</p>`)
    lines.push(`    <p><strong>会话ID:</strong> ${conversation.id}</p>`)
    lines.push(`    <p><strong>消息数量:</strong> ${messages.length}</p>`)
    if (conversation.settings.modelId) {
      lines.push(
        `    <p><strong>模型:</strong> ${this.escapeHtml(conversation.settings.modelId)}</p>`
      )
    }
    if (conversation.settings.providerId) {
      lines.push(
        `    <p><strong>提供商:</strong> ${this.escapeHtml(conversation.settings.providerId)}</p>`
      )
    }
    lines.push('  </div>')

    // 处理每条消息
    for (const message of messages) {
      const messageTime = new Date(message.timestamp).toLocaleString()

      if (message.role === 'user') {
        lines.push(`  <div class="message user-message">`)
        lines.push(
          `    <div class="message-header">👤 用户 <span class="message-time">(${messageTime})</span></div>`
        )

        const userContent = message.content as UserMessageContent
        const messageText = userContent.content
          ? this.formatUserMessageContent(userContent.content)
          : userContent.text

        lines.push(`    <div>${this.escapeHtml(messageText).replace(/\n/g, '<br>')}</div>`)

        // 处理文件附件
        if (userContent.files && userContent.files.length > 0) {
          lines.push('    <div class="attachments">')
          lines.push('      <strong>附件:</strong>')
          lines.push('      <ul>')
          for (const file of userContent.files) {
            lines.push(
              `        <li>${this.escapeHtml(file.name)} (${this.escapeHtml(file.mimeType)})</li>`
            )
          }
          lines.push('      </ul>')
          lines.push('    </div>')
        }

        // 处理链接
        if (userContent.links && userContent.links.length > 0) {
          lines.push('    <div class="attachments">')
          lines.push('      <strong>链接:</strong>')
          lines.push('      <ul>')
          for (const link of userContent.links) {
            lines.push(
              `        <li><a href="${this.escapeHtml(link)}" target="_blank">${this.escapeHtml(link)}</a></li>`
            )
          }
          lines.push('      </ul>')
          lines.push('    </div>')
        }

        lines.push('  </div>')
      } else if (message.role === 'assistant') {
        lines.push(`  <div class="message assistant-message">`)
        lines.push(
          `    <div class="message-header">🤖 助手 <span class="message-time">(${messageTime})</span></div>`
        )

        const assistantBlocks = message.content as AssistantMessageBlock[]

        for (const block of assistantBlocks) {
          switch (block.type) {
            case 'content':
              if (block.content) {
                lines.push(
                  `    <div>${this.escapeHtml(block.content).replace(/\n/g, '<br>')}</div>`
                )
              }
              break

            case 'reasoning_content':
              if (block.content) {
                lines.push('    <div class="reasoning-block">')
                lines.push('      <strong>🤔 思考过程:</strong>')
                lines.push(`      <div class="code">${this.escapeHtml(block.content)}</div>`)
                lines.push('    </div>')
              }
              break

            case 'tool_call':
              if (block.tool_call) {
                lines.push('    <div class="tool-call">')
                lines.push(
                  `      <strong>🔧 工具调用: ${this.escapeHtml(block.tool_call.name || '')}</strong>`
                )
                if (block.tool_call.params) {
                  lines.push('      <div><strong>参数:</strong></div>')
                  lines.push(
                    `      <div class="code">${this.escapeHtml(block.tool_call.params)}</div>`
                  )
                }
                if (block.tool_call.response) {
                  lines.push('      <div><strong>响应:</strong></div>')
                  lines.push(
                    `      <div class="code">${this.escapeHtml(block.tool_call.response)}</div>`
                  )
                }
                lines.push('    </div>')
              }
              break

            case 'search':
              lines.push('    <div class="search-block">')
              lines.push('      <strong>🔍 网络搜索</strong>')
              if (block.extra?.total) {
                lines.push(`      <p>找到 ${block.extra.total} 个搜索结果</p>`)
              }
              lines.push('    </div>')
              break

            case 'image':
              lines.push('    <div class="tool-call">')
              lines.push('      <strong>🖼️ 图片</strong>')
              lines.push('      <p><em>[图片内容]</em></p>')
              lines.push('    </div>')
              break

            case 'error':
              if (block.content) {
                lines.push('    <div class="error-block">')
                lines.push('      <strong>❌ 错误</strong>')
                lines.push(`      <p><code>${this.escapeHtml(block.content)}</code></p>`)
                lines.push('    </div>')
              }
              break

            case 'artifact-thinking':
              if (block.content) {
                lines.push('    <div class="reasoning-block">')
                lines.push('      <strong>💭 创作思考:</strong>')
                lines.push(`      <div class="code">${this.escapeHtml(block.content)}</div>`)
                lines.push('    </div>')
              }
              break
          }
        }

        lines.push('  </div>')
      }
    }

    // HTML 尾部
    lines.push('</body>')
    lines.push('</html>')

    return lines.join('\n')
  }

  /**
   * 导出为纯文本格式
   */
  private exportToText(conversation: CONVERSATION, messages: Message[]): string {
    const lines: string[] = []

    // 标题和元信息
    lines.push(`${conversation.title}`)
    lines.push(''.padEnd(conversation.title.length, '='))
    lines.push('')
    lines.push(`导出时间: ${new Date().toLocaleString()}`)
    lines.push(`会话ID: ${conversation.id}`)
    lines.push(`消息数量: ${messages.length}`)
    if (conversation.settings.modelId) {
      lines.push(`模型: ${conversation.settings.modelId}`)
    }
    if (conversation.settings.providerId) {
      lines.push(`提供商: ${conversation.settings.providerId}`)
    }
    lines.push('')
    lines.push(''.padEnd(80, '-'))
    lines.push('')

    // 处理每条消息
    for (const message of messages) {
      const messageTime = new Date(message.timestamp).toLocaleString()

      if (message.role === 'user') {
        lines.push(`[用户] ${messageTime}`)
        lines.push('')

        const userContent = message.content as UserMessageContent
        const messageText = userContent.content
          ? this.formatUserMessageContent(userContent.content)
          : userContent.text

        lines.push(messageText)

        // 处理文件附件
        if (userContent.files && userContent.files.length > 0) {
          lines.push('')
          lines.push('附件:')
          for (const file of userContent.files) {
            lines.push(`- ${file.name} (${file.mimeType})`)
          }
        }

        // 处理链接
        if (userContent.links && userContent.links.length > 0) {
          lines.push('')
          lines.push('链接:')
          for (const link of userContent.links) {
            lines.push(`- ${link}`)
          }
        }
      } else if (message.role === 'assistant') {
        lines.push(`[助手] ${messageTime}`)
        lines.push('')

        const assistantBlocks = message.content as AssistantMessageBlock[]

        for (const block of assistantBlocks) {
          switch (block.type) {
            case 'content':
              if (block.content) {
                lines.push(block.content)
                lines.push('')
              }
              break

            case 'reasoning_content':
              if (block.content) {
                lines.push('[思考过程]')
                lines.push(block.content)
                lines.push('')
              }
              break

            case 'tool_call':
              if (block.tool_call) {
                lines.push(`[工具调用] ${block.tool_call.name}`)
                if (block.tool_call.params) {
                  lines.push('参数:')
                  lines.push(block.tool_call.params)
                }
                if (block.tool_call.response) {
                  lines.push('响应:')
                  lines.push(block.tool_call.response)
                }
                lines.push('')
              }
              break

            case 'search':
              lines.push('[网络搜索]')
              if (block.extra?.total) {
                lines.push(`找到 ${block.extra.total} 个搜索结果`)
              }
              lines.push('')
              break

            case 'image':
              lines.push('[图片内容]')
              lines.push('')
              break

            case 'error':
              if (block.content) {
                lines.push(`[错误] ${block.content}`)
                lines.push('')
              }
              break

            case 'artifact-thinking':
              if (block.content) {
                lines.push('[创作思考]')
                lines.push(block.content)
                lines.push('')
              }
              break
          }
        }
      }

      lines.push(''.padEnd(80, '-'))
      lines.push('')
    }

    return lines.join('\n')
  }

  /**
   * HTML 转义辅助函数
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  // 权限响应处理方法 - 重新设计为基于消息数据的流程
  async handlePermissionResponse(
    messageId: string,
    toolCallId: string,
    granted: boolean,
    permissionType: 'read' | 'write' | 'all',
    remember: boolean = true
  ): Promise<void> {
    console.log(`[Permission] Handling response`, {
      messageId,
      toolCallId,
      granted,
      permissionType,
      remember
    })

    try {
      // 1. 获取消息并更新权限块状态
      const message = await this.messageManager.getMessage(messageId)
      if (!message || message.role !== 'assistant') {
        const errorMsg = `Message not found or not an assistant message (messageId: ${messageId})`
        console.error(`[Permission] ${errorMsg}`)
        throw new Error(errorMsg)
      }

      const content = message.content as AssistantMessageBlock[]
      const permissionBlock = content.find(
        (block) =>
          block.type === 'action' &&
          block.action_type === 'tool_call_permission' &&
          block.tool_call?.id === toolCallId
      )

      if (!permissionBlock) {
        const errorMsg = `Permission block not found (messageId: ${messageId}, toolCallId: ${toolCallId})`
        console.error(`[Permission] ${errorMsg}`)
        console.error(
          `[Permission] Available blocks:`,
          content.map((block) => ({
            type: block.type,
            toolCallId: block.tool_call?.id
          }))
        )
        throw new Error(errorMsg)
      }

      console.log(`[Permission] Found block for tool: ${permissionBlock.tool_call?.name}`)

      // 2. 更新权限块状态
      permissionBlock.status = granted ? 'granted' : 'denied'
      if (permissionBlock.extra) {
        permissionBlock.extra.needsUserAction = false
        if (granted) {
          permissionBlock.extra.grantedPermissions = permissionType
        }
      }

      // 2.1 对于单个“拒绝”，同步生成/更新对应的 tool_call 错误结果块，保证每次 FC 都有配对结果
      if (!granted) {
        const tc = permissionBlock.tool_call
        if (tc) {
          let toolBlock = content.find((b) => b.type === 'tool_call' && b.tool_call?.id === tc.id)
          if (!toolBlock) {
            toolBlock = {
              type: 'tool_call',
              content: '',
              status: 'error',
              timestamp: Date.now(),
              tool_call: {
                id: tc.id,
                name: tc.name,
                params: tc.params || '',
                server_name: tc.server_name || (permissionBlock.extra?.serverName as string) || '',
                server_icons: tc.server_icons || '',
                server_description: tc.server_description || '',
                response: JSON.stringify({ ok: false, error: 'permission_denied' })
              }
            }
            content.push(toolBlock)
          } else {
            toolBlock.status = 'error'
            if (toolBlock.tool_call) {
              // 补齐元信息与错误响应
              toolBlock.tool_call.name = toolBlock.tool_call.name || tc.name
              toolBlock.tool_call.params = toolBlock.tool_call.params || tc.params || ''
              toolBlock.tool_call.server_name =
                toolBlock.tool_call.server_name ||
                tc.server_name ||
                (permissionBlock.extra?.serverName as string) ||
                ''
              toolBlock.tool_call.server_icons =
                toolBlock.tool_call.server_icons || tc.server_icons || ''
              toolBlock.tool_call.server_description =
                toolBlock.tool_call.server_description || tc.server_description || ''
              toolBlock.tool_call.response = JSON.stringify({
                ok: false,
                error: 'permission_denied'
              })
            }
          }
        }
      }

      // 3. 保存消息更新（以 DB 为准，合并写库）
      {
        const { message, revision } = await this.messageManager.editMessageSilently(
          messageId,
          JSON.stringify(content)
        )
        this.emitMessageEdited(messageId, revision, message.parentId)
      }
      try {
        const perms = content.filter(
          (b) => b.type === 'action' && (b as any).action_type === 'tool_call_permission'
        )
        const p = perms.filter((b) => b.status === 'pending').length
        const g = perms.filter((b) => b.status === 'granted').length
        const d = perms.filter((b) => b.status === 'denied').length
        const e = perms.filter((b) => b.status === 'error').length
        this.audit('PERM.update', messageId, 'S1', { perm: { p, g, d, e } })
      } catch {}
      // 同步内存态：确保 resumeStreamCompletion 使用到最新的权限块与工具信息
      try {
        const st = this.generatingMessages.get(messageId)
        if (st) st.message.content = content
      } catch {}
      console.log(`[Permission] Status updated: ${permissionBlock.status}`)

      // 4. 授权/拒绝后执行“总闸检查”
      try {
        // 记住授权（server 级别）
        let serverName =
          (permissionBlock?.extra?.serverName as string) ||
          (permissionBlock.tool_call?.server_name as string) ||
          ''
        // Fallback resolve serverName by tool definition if missing or unknown
        if (granted) {
          try {
            const servers = await this.configPresenter.getMcpServers()
            if (!serverName || !servers[serverName]) {
              try {
                const defs = await presenter.mcpPresenter.getAllToolDefinitions()
                const found = defs.find((d) => d.function.name === permissionBlock.tool_call?.name)
                if (found?.server?.name) serverName = found.server.name as string
              } catch (e) {
                console.warn('[Permission] Fallback resolve serverName failed:', e)
              }
            }
          } catch {}
        }
        if (granted && remember && serverName) {
          try {
            await presenter.mcpPresenter.grantPermission(
              serverName,
              permissionType,
              /* remember */ true,
              permissionBlock.tool_call?.name
            )
          } catch (e) {
            console.warn('[Permission] Persisting server permission failed:', e)
          }
        }
      } catch {}

      // 授权总闸检查
      try {
        const permissionBlocks = content.filter(
          (b) => b.type === 'action' && b.action_type === 'tool_call_permission'
        )
        const pendingCount = permissionBlocks.filter((b) => b.status === 'pending').length
        const grantedCount = permissionBlocks.filter((b) => b.status === 'granted').length
        const deniedCount = permissionBlocks.filter((b) => b.status === 'denied').length

        console.log(`[Permission] Gating counts for message ${messageId}:`, {
          pendingCount,
          grantedCount,
          deniedCount
        })

        if (pendingCount > 0) {
          // 仍有待处理项，等待后续响应
          return
        }

        if (grantedCount >= 1) {
          // 进入统一执行阶段
          await this.executeGrantedToolsAndContinue(messageId)
          return
        }

        // 全部被拒绝：注入说明并触发一次继续作答
        await this.continueAfterAllDenied(messageId)
      } catch (gateError) {
        console.error('[Permission] Gating failed:', gateError)
        throw gateError
      }
    } catch (error) {
      console.error(`[Permission] Failed to handle response:`, error)

      // 确保消息状态正确更新
      try {
        // 先持久化内存中的部分生成内容（若存在）
        await this.persistInMemoryContentBeforeError(messageId)
        let exists = false
        try {
          await this.messageManager.getMessage(messageId)
          exists = true
        } catch {}
        if (exists) {
          const res = await this.messageManager.handleMessageError(messageId, String(error))
          this.emitMessageEdited(messageId, res.revision, res.message.parentId)
        } else {
          console.warn('[Permission] SKIP.updateError: message not found', { messageId })
        }
      } catch (updateError) {
        console.error(`[Permission] Failed to update message error status:`, updateError)
      }

      throw error
    }
  }

  // 在全部被拒绝时，注入说明并触发一次继续作答
  private async continueAfterAllDenied(messageId: string): Promise<void> {
    let message: Message | null = null
    try {
      message = await this.messageManager.getMessage(messageId)
    } catch {
      console.warn('[ThreadPresenter] SKIP.continueAfterAllDenied: message not found', {
        messageId
      })
      return
    }
    if (!message || message.role !== 'assistant') return

    const content = message.content as AssistantMessageBlock[]
    const deniedBlocks = content.filter(
      (b) =>
        b.type === 'action' && b.action_type === 'tool_call_permission' && b.status === 'denied'
    )

    const now = Date.now()
    for (const perm of deniedBlocks) {
      const tc = perm.tool_call
      if (!tc) continue
      let toolBlock = content.find((b) => b.type === 'tool_call' && b.tool_call?.id === tc.id)
      if (!toolBlock) {
        toolBlock = {
          type: 'tool_call',
          content: '',
          status: 'error',
          timestamp: now,
          tool_call: {
            id: tc.id,
            name: tc.name,
            params: tc.params || '',
            server_name: tc.server_name,
            server_icons: tc.server_icons,
            server_description: tc.server_description,
            response: JSON.stringify({ ok: false, error: 'permission_denied' })
          }
        }
        content.push(toolBlock)
      } else {
        toolBlock.status = 'error'
        if (toolBlock.tool_call)
          toolBlock.tool_call.response = JSON.stringify({ ok: false, error: 'permission_denied' })
      }
    }

    {
      const { message, revision } = await this.messageManager.editMessageSilently(
        messageId,
        JSON.stringify(content)
      )
      this.emitMessageEdited(messageId, revision, message.parentId)
    }

    // 同步内存态，保持与 DB 一致
    try {
      const st = this.generatingMessages.get(messageId)
      if (st) st.message.content = content
    } catch {}

    const conversationId = message.conversationId
    if (!this.generatingMessages.get(messageId)) {
      this.generatingMessages.set(messageId, {
        message: message as AssistantMessage,
        conversationId,
        startTime: Date.now(),
        firstTokenTime: null,
        promptTokens: 0,
        reasoningStartTime: null,
        reasoningEndTime: null,
        lastReasoningTime: null,
        __id: ++this.genStateSeq
      })
      // ensure state (quiet)
    }
    this.audit('CONT.start', messageId, 'R2')
    await this.startStreamCompletion(conversationId, messageId, undefined, 'toolcall_continue')
    this.audit('CONT.end', messageId, 'R2')
  }

  // 统一执行 granted 的工具调用，并触发一次“继续作答”
  private async executeGrantedToolsAndContinue(messageId: string): Promise<void> {
    console.log(`[Permission] Executing granted tools and continuing: ${messageId}`)
    let message: Message | null = null
    try {
      message = await this.messageManager.getMessage(messageId)
    } catch (e) {
      console.warn('[ThreadPresenter] SKIP.executeGranted: message not found', {
        messageId
      })
      return
    }
    if (!message || message.role !== 'assistant') {
      console.warn('[ThreadPresenter] SKIP.executeGranted: not an assistant message', {
        messageId
      })
      return
    }

    const content = message.content as AssistantMessageBlock[]
    // 收集已“消耗”的 tool_call：
    // 仅当该调用已经真实执行过（成功或硬错误）才视为已消耗；
    // 对于 permission_denied / permission_required 的占位结果，不视为已执行，允许后续授权后再执行。
    const respondedIds = new Set(
      content
        .filter((b) => b.type === 'tool_call' && b.tool_call?.id?.trim() && b.tool_call?.response)
        .filter((b) => {
          try {
            const env = JSON.parse(b.tool_call!.response as string)
            const ok = env && typeof env === 'object' ? env.ok : undefined
            const err = env && typeof env === 'object' ? env.error : undefined
            if (ok === true) return true
            if (ok === false && typeof err === 'string') {
              return err !== 'permission_denied' && err !== 'permission_required'
            }
            return false
          } catch {
            // 无法解析时不据此判定为已执行，留给 executed 标志兜底
            return false
          }
        })
        .map((b) => b.tool_call!.id)
    )
    // 仅选择“尚未执行/未落地结果”的 granted 权限块
    const grantedBlocks = content.filter(
      (b) =>
        b.type === 'action' &&
        b.action_type === 'tool_call_permission' &&
        b.status === 'granted' &&
        b.tool_call?.id?.trim() &&
        // 跳过已写入结果的调用
        !respondedIds.has(b.tool_call!.id) &&
        // 跳过标记为 executed 的授权块（防御性）
        !(b.extra && (b.extra as any).executed === true)
    )

    const servers = await this.configPresenter.getMcpServers()

    // 并发防护：同一消息的 continue 流不能重入
    const genState = this.generatingMessages.get(messageId)
    // continue check (quiet)
    if (genState?.continuationInProgress) {
      const stateId = (genState as any)?.__id
      this.pendingContinuation.add(messageId)
      console.log('[Continue/Enqueue]', { messageId, stateId })
      return
    }

    // 不再记录执行签名，保持最小流程

    let needsMorePermission = false
    for (const perm of grantedBlocks) {
      const tc = perm.tool_call
      if (!tc || !tc.id || !tc.name) continue
      // 防御性：显式将对应的权限块标记为已授予，避免任何异步合并导致的状态回退
      try {
        if (perm.status !== 'granted') perm.status = 'granted'
      } catch {}
      let serverName = (perm.extra?.serverName as string) || tc.server_name || ''
      let serverCfg = servers[serverName]
      if (!serverName || !serverCfg) {
        try {
          const defs = await presenter.mcpPresenter.getAllToolDefinitions()
          const found = defs.find((d) => d.function.name === tc.name)
          if (found?.server?.name) {
            serverName = found.server.name as string
            serverCfg = servers[serverName]
          }
        } catch (e) {
          console.warn(
            '[Permission] Unable to resolve server for tool, proceeding without server meta:',
            e
          )
        }
      }
      const server = {
        name: serverName,
        icons: (serverCfg?.icons as string) || tc.server_icons || '',
        description: (serverCfg?.descriptions as string) || tc.server_description || ''
      }

      try {
        // Prepare a one-time internal grant for this exact call when server-level autoApprove does not cover it
        const required = (perm.extra?.permissionType as 'read' | 'write' | 'all') || 'write'
        try {
          await presenter.mcpPresenter.grantPermission(
            serverName,
            required,
            /*remember*/ false,
            tc.name
          )
        } catch (e) {
          console.warn('[ThreadPresenter] grantPermission(one-time) failed (will still try):', e)
        }
        console.log(
          `[ThreadPresenter] Prepared one-time internal grant for tool execution, tool: ${tc.name}, server: ${serverName}, required: ${required}`
        )

        // Do NOT inject any approval token into arguments; rely on internal one-time grant
        const effectiveArgs = tc.params || '{}'
        console.log('[ThreadPresenter] Tool request raw', {
          id: tc.id,
          name: tc.name,
          server,
          arguments: effectiveArgs
        })
        const toolRequest = {
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: effectiveArgs
          },
          server
        }
        if (ThreadPresenter.DEBUG_TOOL_IO_LOG) {
          try {
            console.log('[IO/Tool/Request]', {
              messageId,
              toolCallId: tc.id,
              server: server.name,
              name: tc.name,
              arguments: effectiveArgs
            })
          } catch {}
        }
        const result = await presenter.mcpPresenter.callTool(toolRequest)
        if (ThreadPresenter.DEBUG_TOOL_IO_LOG) {
          try {
            const respStr =
              typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
            console.log('[IO/Tool/Response]', {
              messageId,
              toolCallId: tc.id,
              server: server.name,
              name: tc.name,
              isError: Boolean((result as any)?.isError || result.rawData?.isError),
              content: respStr
            })
          } catch {}
        }

        // 若仍需权限（如权限级别不足或一次性授权未命中），回退为 pending 授权并写入错误结果，不进入 R2
        const anyRes: any = result as any
        const requiresPerm = Boolean(
          anyRes?.requiresPermission || anyRes?.rawData?.requiresPermission
        )
        if (requiresPerm) {
          const req = anyRes?.permissionRequest || anyRes?.rawData?.permissionRequest || {}
          const need: 'read' | 'write' | 'all' = (req.permissionType as any) || 'write'

          // 回退授权块为 pending，并升级权限类型
          const permBlock = content.find(
            (b) =>
              b.type === 'action' &&
              b.action_type === 'tool_call_permission' &&
              b.tool_call?.id === tc.id
          )
          if (permBlock) {
            permBlock.status = 'pending'
            permBlock.extra = permBlock.extra || {}
            ;(permBlock.extra as any).permissionType = need
            ;(permBlock.extra as any).needsUserAction = true
            if (req.serverName) (permBlock.extra as any).serverName = req.serverName
            if (req.toolName) (permBlock.extra as any).toolName = req.toolName
          } else {
            // 兜底：若未找到授权块，创建一条新的 pending 授权块
            content.push({
              type: 'action',
              action_type: 'tool_call_permission',
              content: 'Permission required for this operation',
              status: 'pending',
              timestamp: Date.now(),
              tool_call: {
                id: tc.id,
                name: tc.name,
                params: tc.params || '',
                server_name: server.name,
                server_icons: server.icons,
                server_description: server.description
              },
              extra: {
                permissionType: need,
                serverName: server.name,
                toolName: tc.name,
                needsUserAction: true,
                permissionRequest: JSON.stringify({
                  toolName: tc.name,
                  serverName: server.name,
                  permissionType: need,
                  description: `Allow ${tc.name} to perform ${need} operations on ${server.name}?`
                })
              }
            } as AssistantMessageBlock)
          }

          // 为该调用写入/更新错误结果（permission_required）
          let toolBlock = content.find((b) => b.type === 'tool_call' && b.tool_call?.id === tc.id)
          if (!toolBlock) {
            toolBlock = {
              type: 'tool_call',
              content: '',
              status: 'error',
              timestamp: Date.now(),
              tool_call: {
                id: tc.id,
                name: tc.name,
                params: tc.params || '',
                server_name: server.name,
                server_icons: server.icons,
                server_description: server.description,
                response: JSON.stringify({ ok: false, error: 'permission_required', need })
              }
            }
            content.push(toolBlock)
          } else {
            toolBlock.status = 'error'
            if (toolBlock.tool_call) {
              toolBlock.tool_call.response = JSON.stringify({
                ok: false,
                error: 'permission_required',
                need
              })
            }
          }

          // 持久化并标记需要等待授权，暂不进入 R2
          try {
            const st = this.generatingMessages.get(messageId)
            if (st) st.message.content = content
          } catch {}
          {
            const { message, revision } = await this.messageManager.editMessageSilently(
              messageId,
              JSON.stringify(content)
            )
            this.emitMessageEdited(messageId, revision, message.parentId)
          }
          needsMorePermission = true
          continue
        }

        // 更新/创建对应的 tool_call 块（正常成功/错误路径）
        let toolBlock = content.find((b) => b.type === 'tool_call' && b.tool_call?.id === tc.id)
        if (!toolBlock) {
          toolBlock = {
            type: 'tool_call',
            content: '',
            status: 'success',
            timestamp: Date.now(),
            tool_call: {
              id: tc.id,
              name: tc.name,
              params: tc.params || '',
              server_name: server.name,
              server_icons: server.icons,
              server_description: server.description,
              response: ''
            }
          }
          content.push(toolBlock)
        }
        const isErr = Boolean((result as any)?.isError || result.rawData?.isError)
        toolBlock.status = isErr ? 'error' : 'success'
        if (toolBlock.tool_call) {
          const dataPayload = typeof result.content === 'string' ? result.content : result.content
          const envelope = isErr
            ? { ok: false, error: 'tool_execution_error', data: dataPayload }
            : { ok: true, data: dataPayload }
          toolBlock.tool_call.response = JSON.stringify(envelope)
          // 确保服务信息完整
          toolBlock.tool_call.server_name = server.name
          toolBlock.tool_call.server_icons = server.icons
          toolBlock.tool_call.server_description = server.description
        }
        try {
          this.audit('TOOL.result', messageId, 'EXECUTE', {
            tool: { id: tc?.id, ok: !isErr }
          })
        } catch {}
        // 标记对应授权块为已执行（consumed），避免后续重复执行
        try {
          ;(perm.extra as any) = perm.extra || {}
          ;(perm.extra as any).executed = true
          ;(perm.extra as any).executedAt = Date.now()
        } catch {}
      } catch (e) {
        console.error('[ThreadPresenter] Tool execution failed:', e)
        // 标记失败
        let toolBlock = content.find((b) => b.type === 'tool_call' && b.tool_call?.id === tc?.id)
        if (!toolBlock) {
          toolBlock = {
            type: 'tool_call',
            content: '',
            status: 'error',
            timestamp: Date.now(),
            tool_call: {
              id: tc?.id,
              name: tc?.name,
              params: tc?.params || '',
              server_name: serverName,
              server_icons: '',
              server_description: '',
              response: JSON.stringify({
                ok: false,
                error: 'tool_execution_error',
                data: String(e)
              })
            }
          }
          content.push(toolBlock)
        } else {
          toolBlock.status = 'error'
          if (toolBlock.tool_call)
            toolBlock.tool_call.response = JSON.stringify({
              ok: false,
              error: 'tool_execution_error',
              data: String(e)
            })
        }
        // 标记对应授权块为已执行（即使失败也不应重复执行）
        try {
          ;(perm.extra as any) = perm.extra || {}
          ;(perm.extra as any).executed = true
          ;(perm.extra as any).executedAt = Date.now()
        } catch {}
      }
      // 不记录执行签名
    }

    // 持久化 tool_call 结果
    // 先更新载体，再落库（核心顺序约束）
    try {
      const st = this.generatingMessages.get(messageId)
      if (st) st.message.content = content
    } catch {}
    {
      const { message, revision } = await this.messageManager.editMessageSilently(
        messageId,
        JSON.stringify(content)
      )
      this.emitMessageEdited(messageId, revision, message.parentId)
    }
    this.logPermissionSummary(content, 'EXECUTE.results', messageId)
    const conversationId = message.conversationId

    // 确保生成状态存在
    if (!this.generatingMessages.get(messageId)) {
      this.generatingMessages.set(messageId, {
        message: message as AssistantMessage,
        conversationId,
        startTime: Date.now(),
        firstTokenTime: null,
        promptTokens: 0,
        reasoningStartTime: null,
        reasoningEndTime: null,
        lastReasoningTime: null,
        __id: ++this.genStateSeq
      })
      // ensure state (quiet)
    }
    if (needsMorePermission) {
      // 等待用户处理新的权限请求，不进入 R2
      return
    }
    // 触发继续作答
    console.log('[ThreadPresenter] Starting continue stream', {
      conversationId,
      messageId
    })
    {
      const cur = this.generatingMessages.get(messageId)
      if (cur) {
        cur.continuationInProgress = true
        const stateId = (cur as any)?.__id
        console.log('[Continue/State]', { messageId, stateId, set: true })
      }
    }
    try {
      this.audit('CONT.start', messageId, 'R2')
      await this.startStreamCompletion(conversationId, messageId, undefined, 'toolcall_continue')
    } finally {
      {
        const cur = this.generatingMessages.get(messageId)
        if (cur) {
          cur.continuationInProgress = false
          const stateId = (cur as any)?.__id
          console.log('[Continue/State]', { messageId, stateId, set: false })
        }
      }
      this.audit('CONT.end', messageId, 'R2')
      if (this.pendingContinuation.has(messageId)) {
        this.pendingContinuation.delete(messageId)
        console.log('[Continue/Dequeue]', { messageId })
        await this.executeGrantedToolsAndContinue(messageId)
      }
    }
  }

  // 调试：打印权限块摘要
  private logPermissionSummary(
    content: AssistantMessageBlock[] | undefined,
    where: string,
    messageId: string
  ) {
    if (!content) return
    try {
      const perms = content.filter(
        (b) => b.type === 'action' && (b as any).action_type === 'tool_call_permission'
      )
      const pending = perms.filter((b) => b.status === 'pending').length
      const granted = perms.filter((b) => b.status === 'granted').length
      const denied = perms.filter((b) => b.status === 'denied').length
      const error = perms.filter((b) => b.status === 'error').length
      console.log('[Permission/Summary]', { where, messageId, pending, granted, denied, error })
    } catch {}
  }

  /**
   * 为系统提示词添加当前时间信息
   * @param systemPrompt 原始系统提示词
   * @param isImageGeneration 是否为图片生成模型
   * @returns 处理后的系统提示词
   */
  private enhanceSystemPromptWithDateTime(
    systemPrompt: string,
    isImageGeneration: boolean = false
  ): string {
    // 如果是图片生成模型或者系统提示词为空，则直接返回原值
    if (isImageGeneration || !systemPrompt || !systemPrompt.trim()) {
      return systemPrompt
    }

    // 生成当前时间字符串，包含完整的时区信息
    const currentDateTime = new Date().toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
      hour12: false
    })

    return `${systemPrompt}\nToday's date and time is ${currentDateTime}`
  }

  /**
   * 直接处理内容的方法
   */
  private async processContentDirectly(
    eventId: string,
    content: string,
    currentTime: number
  ): Promise<void> {
    const state = this.generatingMessages.get(eventId)
    if (!state) return

    // 检查是否需要分块处理
    if (this.shouldSplitContent(content)) {
      await this.processLargeContentInChunks(eventId, content, currentTime)
    } else {
      await this.processNormalContent(eventId, content, currentTime)
    }
  }

  /**
   * 分块处理大内容
   */
  private async processLargeContentInChunks(
    eventId: string,
    content: string,
    currentTime: number
  ): Promise<void> {
    const state = this.generatingMessages.get(eventId)
    if (!state) return

    console.log(`[ThreadPresenter] Processing large content in chunks: ${content.length} bytes`)

    const lastBlock = state.message.content[state.message.content.length - 1]
    let contentBlock: any

    if (lastBlock && lastBlock.type === 'content') {
      contentBlock = lastBlock
    } else {
      this.finalizeLastBlock(state)
      contentBlock = {
        type: 'content',
        content: '',
        status: 'loading',
        timestamp: currentTime
      }
      state.message.content.push(contentBlock)
    }

    // 直接添加内容，不做复杂分块
    contentBlock.content += content

    // 只更新数据库，不额外发送到渲染器（避免重复发送）
    // 流式阶段不落库，仅通过 RESPONSE 提示 UI
  }
}
