import { defineStore } from 'pinia'
import { ref, computed, onMounted } from 'vue'
import type {
  UserMessageContent,
  AssistantMessageBlock,
  AssistantMessage,
  UserMessage,
  Message
} from '@shared/chat'
import type { CONVERSATION, CONVERSATION_SETTINGS } from '@shared/presenter'
import { usePresenter } from '@/composables/usePresenter'
import { CONVERSATION_EVENTS, DEEPLINK_EVENTS, MEETING_EVENTS } from '@/events'
import router from '@/router'
import { useI18n } from 'vue-i18n'
import { useSoundStore } from './sound'
import { DEBUG_ROLLBACK_MIN } from '@shared/debug'
import sfxfcMp3 from '/sounds/sfx-fc.mp3?url'
import sfxtyMp3 from '/sounds/sfx-typing.mp3?url'

// 定义会话工作状态类型
export type WorkingStatus = 'working' | 'error' | 'completed' | 'none'

export const useChatStore = defineStore('chat', () => {
  const threadP = usePresenter('threadPresenter')
  const windowP = usePresenter('windowPresenter')
  const notificationP = usePresenter('notificationPresenter')
  const tabP = usePresenter('tabPresenter')
  const { t } = useI18n()

  const soundStore = useSoundStore()

  // 状态
  const activeThreadIdMap = ref<Map<number, string | null>>(new Map())
  const threads = ref<
    {
      dt: string
      dtThreads: CONVERSATION[]
    }[]
  >([])

  // NOTE: messagesMap stores the RAW message objects fetched from the main process.
  // For assistant messages, the `content` field holds the original main content,
  // and the `variants` array contains all possible variations.
  // This raw structure is ESSENTIAL for operations like deleting a specific variant.
  // For displaying content, use the `variantAwareMessages` computed property instead.
  const messagesMap = ref<Map<number, AssistantMessage[] | UserMessage[]>>(new Map())

  const generatingThreadIds = ref(new Set<string>())
  const isSidebarOpen = ref(false)
  const isMessageNavigationOpen = ref(false)

  // 使用Map来存储会话工作状态
  const threadsWorkingStatusMap = ref<Map<number, Map<string, WorkingStatus>>>(new Map())

  // 添加消息生成缓存
  const generatingMessagesCacheMap = ref<
    Map<number, Map<string, { message: AssistantMessage | UserMessage; threadId: string }>>
  >(new Map())

  // track max observed revision per message to prevent rollback merges
  const messageRevisions = ref<Map<string, number>>(new Map())

  // 对话配置状态
  const chatConfig = ref<CONVERSATION_SETTINGS>({
    systemPrompt: '',
    temperature: 0.7,
    contextLength: 32000,
    maxTokens: 8000,
    providerId: '',
    modelId: '',
    artifacts: 0,
    enabledMcpTools: [],
    thinkingBudget: undefined,
    enableSearch: undefined,
    forcedSearch: undefined,
    searchStrategy: undefined,
    reasoningEffort: undefined,
    verbosity: undefined,
    selectedVariantsMap: {}
  })

  // Deeplink 消息缓存
  const deeplinkCache = ref<{
    msg?: string
    modelId?: string
    systemPrompt?: string
    autoSend?: boolean
    mentions?: string[]
  } | null>(null)

  // 用于管理当前激活会话的 selectedVariantsMap
  const selectedVariantsMap = ref<Map<string, string>>(new Map())

  // Getters
  const getTabId = () => window.api.getWebContentsId()
  const getActiveThreadId = () => activeThreadIdMap.value.get(getTabId()) ?? null
  const setActiveThreadId = (threadId: string | null) => {
    activeThreadIdMap.value.set(getTabId(), threadId)
  }
  const getMessages = () => messagesMap.value.get(getTabId()) ?? []
  const setMessages = (msgs: AssistantMessage[] | UserMessage[]) => {
    messagesMap.value.set(getTabId(), msgs)
  }
  const getCurrentThreadMessages = () => {
    const activeThreadId = getActiveThreadId()
    if (!activeThreadId) return []
    return getMessages()
  }
  const getThreadsWorkingStatus = () => {
    if (!threadsWorkingStatusMap.value.has(getTabId())) {
      threadsWorkingStatusMap.value.set(getTabId(), new Map())
    }
    return threadsWorkingStatusMap.value.get(getTabId())!
  }
  const getGeneratingMessagesCache = () => {
    if (!generatingMessagesCacheMap.value.has(getTabId())) {
      generatingMessagesCacheMap.value.set(getTabId(), new Map())
    }
    return generatingMessagesCacheMap.value.get(getTabId())!
  }

  const activeThread = computed(() => {
    return threads.value.flatMap((t) => t.dtThreads).find((t) => t.id === getActiveThreadId())
  })

  // NOTE: This computed property dynamically combines messages from `messagesMap` with
  // the user's choices in `selectedVariantsMap`. It produces a "view-ready" list
  // where each assistant message's content reflects the currently selected variant.
  // ALWAYS use this for rendering or any logic that needs the displayed content.
  const variantAwareMessages = computed(() => {
    const messages = getMessages()
    const currentSelectedVariants = selectedVariantsMap.value

    if (currentSelectedVariants.size === 0) {
      return messages
    }

    return messages.map((msg) => {
      if (msg.role === 'assistant' && currentSelectedVariants.has(msg.id)) {
        const selectedVariantId = currentSelectedVariants.get(msg.id)

        if (!selectedVariantId) {
          return msg
        }

        const selectedVariant = (msg as AssistantMessage).variants?.find(
          (v) => v.id === selectedVariantId
        )

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
    }) as AssistantMessage[] | UserMessage[]
  })

  // Actions
  const createNewEmptyThread = async () => {
    try {
      await clearActiveThread()
    } catch (error) {
      console.error('Failed to clear active thread and load first page:', error)
      throw error
    }
  }

  const createThread = async (title: string, settings: Partial<CONVERSATION_SETTINGS>) => {
    try {
      const threadId = await threadP.createConversation(title, settings, getTabId())
      // 因为 createConversation 内部已经调用了 setActiveConversation
      // 并且可以确定是为当前tab激活，所以在这里可以直接、安全地更新本地状态
      // 以确保后续的 sendMessage 能正确获取 activeThreadId。
      setActiveThreadId(threadId)
      return threadId
    } catch (error) {
      console.error('Failed to create thread:', error)
      throw error
    }
  }

  const setActiveThread = async (threadId: string) => {
    // 不在渲染进程进行逻辑判定（查重）和决策，只向主进程发送意图。
    // 主进程会处理“防重”逻辑，并通过 'ACTIVATED' 事件来通知UI更新。
    // 如果主进程决定切换到其他tab，当前tab不会收到此事件，状态也就不会被错误地更新。
    const tabId = getTabId()
    await threadP.setActiveConversation(threadId, tabId)
  }

  const clearActiveThread = async () => {
    const tabId = getTabId()
    if (!getActiveThreadId()) return
    await threadP.clearActiveThread(tabId)
    setActiveThreadId(null)
    selectedVariantsMap.value.clear()
  }

  // 处理消息的 extra 信息
  const enrichMessageWithExtra = async (message: Message): Promise<Message> => {
    if (
      Array.isArray((message as AssistantMessage).content) &&
      (message as AssistantMessage).content.some((block) => block.extra)
    ) {
      const attachments = await threadP.getMessageExtraInfo(message.id, 'search_result')
      // 更新消息中的 extra 信息
      ;(message as AssistantMessage).content = (message as AssistantMessage).content.map(
        (block) => {
          if (block.type === 'search' && block.extra) {
            return {
              ...block,
              extra: {
                ...block.extra,
                pages: attachments.map((attachment) => ({
                  title: attachment.title,
                  url: attachment.url,
                  content: attachment.content,
                  description: attachment.description,
                  icon: attachment.icon
                }))
              }
            }
          }
          return block
        }
      )
      // 处理变体消息的 extra 信息
      const assistantMessage = message as AssistantMessage
      if (assistantMessage.variants && assistantMessage.variants.length > 0) {
        assistantMessage.variants = await Promise.all(
          assistantMessage.variants.map((variant) => enrichMessageWithExtra(variant))
        )
      }
    }

    return message
  }

  const loadMessages = async () => {
    if (!getActiveThreadId()) return

    try {
      const result = await threadP.getMessages(getActiveThreadId()!, 1, 100)
      // 合并数据库消息和缓存中的消息
      const mergedMessages = [...result.list]

      // 查找当前会话的缓存消息
      for (const [, cached] of getGeneratingMessagesCache()) {
        if (cached.threadId === getActiveThreadId()) {
          const message = cached.message
          if (message.is_variant && message.parentId) {
            // 如果是变体消息，找到父消息并添加到其 variants 数组中
            const parentMsg = mergedMessages.find((m) => m.parentId === message.parentId)
            if (parentMsg) {
              if (!parentMsg.variants) {
                parentMsg.variants = []
              }
              const existingVariantIndex = parentMsg.variants.findIndex((v) => v.id === message.id)
              if (existingVariantIndex !== -1) {
                parentMsg.variants[existingVariantIndex] = await enrichMessageWithExtra(message)
              } else {
                parentMsg.variants.push(await enrichMessageWithExtra(message))
              }
            }
          } else {
            // 如果是非变体消息，直接更新或添加到消息列表
            const existingIndex = mergedMessages.findIndex((m) => m.id === message.id)
            if (existingIndex !== -1) {
              mergedMessages[existingIndex] = await enrichMessageWithExtra(message)
            } else {
              mergedMessages.push(await enrichMessageWithExtra(message))
            }
          }
        }
      }

      // 处理所有消息的 extra 信息（并与现有消息进行合并，避免状态/结果被回退）
      const enrichedNew = (await Promise.all(
        mergedMessages.map((msg) => enrichMessageWithExtra(msg))
      )) as AssistantMessage[] | UserMessage[]

      const existing = getMessages()
      const existingMap = new Map<string, AssistantMessage | UserMessage>()
      for (const m of existing as (AssistantMessage | UserMessage)[]) existingMap.set(m.id, m)

      const finalMessages = enrichedNew.map((nm) => {
        const old = existingMap.get(nm.id)
        if (old && old.role === 'assistant' && nm.role === 'assistant') {
          return mergeAssistantMessage(old, nm)
        }
        return nm
      }) as AssistantMessage[] | UserMessage[]

      setMessages(finalMessages)
    } catch (error) {
      console.error('Failed to load messages:', error)
      throw error
    }
  }

  // 合并助手消息，避免异步顺序导致的状态/结果回退
  const mergeAssistantMessage = (
    currentMsg: AssistantMessage | UserMessage,
    updatedMsg: AssistantMessage | UserMessage
  ): AssistantMessage | UserMessage => {
    if (currentMsg.role !== 'assistant' || updatedMsg.role !== 'assistant') return updatedMsg
    const cur = currentMsg as AssistantMessage
    const nxt = updatedMsg as AssistantMessage
    if (!Array.isArray(cur.content) || !Array.isArray(nxt.content)) return updatedMsg

    // Merge keys are strictly id-only for tool/permission blocks.
    // If the model/provider did not produce an id, treat the block as
    // non-mergeable (keyed by type+timestamp) to avoid wrong matches.
    const keyOf = (b: AssistantMessageBlock) => {
      if (b.type === 'tool_call' && b.tool_call) {
        if (b.tool_call.id) return `tool:${b.tool_call.id}`
        return `other:tool_call:${b.timestamp}`
      }
      if (b.type === 'action' && (b as any).action_type === 'tool_call_permission' && b.tool_call) {
        if (b.tool_call.id) return `perm:${b.tool_call.id}`
        return `other:perm:${b.timestamp}`
      }
      return `other:${b.type}:${b.timestamp}`
    }

    const curMap = new Map<string, AssistantMessageBlock>()
    for (const b of cur.content) curMap.set(keyOf(b), b)

    const mergedBlocks: AssistantMessageBlock[] = []
    const lastAcceptedMap = (messageRevisions as any).value as Map<string, number>
    const lastAcceptedRevision = lastAcceptedMap.get((currentMsg as any).id) || 0
    // Source markers for minimal rollback diagnostics
    const incomingEvent = (window as any).__incomingEvent || 'UNKNOWN'
    const incomingRevision = (window as any).__incomingRevision ?? null
    for (const nb of nxt.content as AssistantMessageBlock[]) {
      const k = keyOf(nb)
      const ob = curMap.get(k)
      if (!ob) {
        mergedBlocks.push(nb)
        continue
      }
      if (nb.type === 'tool_call' && nb.tool_call && ob.type === 'tool_call' && ob.tool_call) {
        const merged: AssistantMessageBlock = JSON.parse(JSON.stringify(nb))
        // 防回退：若旧块已完成/失败，且新块状态更低（loading），保持旧状态
        const from = ob.status
        const to = nb.status
        const isDowngrade =
          ((from === 'success' || from === 'error') && to === 'loading') ||
          // 追加：若旧块为 error 而新块为 success，保持 error（如超限后不被流内 end 覆盖）
          (from === 'error' && to === 'success')
        if (isDowngrade) {
          merged.status = ob.status
          if (DEBUG_ROLLBACK_MIN)
            window.api?.debugLog?.('UI.Downgrade', {
              messageId: (currentMsg as any).id,
              toolCallId: ob.tool_call.id,
              block: 'tool',
              from,
              to,
              lastAcceptedRevision,
              incomingEvent,
              incomingRevision,
              decision: 'drop'
            })
        }
        // 若新块缺少响应而旧块已有，保留旧响应
        if (!nb.tool_call.response && ob.tool_call.response) {
          merged.tool_call!.response = ob.tool_call.response
        }
        // 元信息补全
        merged.tool_call!.server_name = nb.tool_call.server_name || ob.tool_call.server_name
        merged.tool_call!.server_icons = nb.tool_call.server_icons || ob.tool_call.server_icons
        merged.tool_call!.server_description =
          nb.tool_call.server_description || ob.tool_call.server_description
        mergedBlocks.push(merged)
        continue
      }
      if (
        nb.type === 'action' &&
        (nb as any).action_type === 'tool_call_permission' &&
        ob.type === 'action' &&
        (ob as any).action_type === 'tool_call_permission'
      ) {
        const merged: AssistantMessageBlock = JSON.parse(JSON.stringify(nb))
        const score = (s?: string) =>
          s === 'granted' || s === 'denied' ? 3 : s === 'error' ? 2 : s === 'pending' ? 1 : 0
        const from = ob.status
        const to = nb.status
        const isDowngrade = score(from) > score(to)
        if (isDowngrade) {
          merged.status = ob.status
          if (DEBUG_ROLLBACK_MIN)
            window.api?.debugLog?.('UI.Downgrade', {
              messageId: (currentMsg as any).id,
              toolCallId: ob.tool_call?.id,
              block: 'perm',
              from,
              to,
              lastAcceptedRevision,
              incomingEvent,
              incomingRevision,
              decision: 'drop'
            })
        }
        if (merged.extra) {
          merged.extra.needsUserAction =
            Boolean(merged.extra.needsUserAction) && merged.status === 'pending'
        }
        mergedBlocks.push(merged)
        continue
      }
      mergedBlocks.push(nb)
    }
    // 旧消息存在但新消息缺失的关键块，补入（仅 tool_call / permission 且必须有 id），避免“闪现后消失”
    for (const [k, ob] of curMap.entries()) {
      if (!mergedBlocks.find((b) => keyOf(b) === k)) {
        if (
          (ob.type === 'tool_call' && (ob as any).tool_call?.id) ||
          (ob.type === 'action' &&
            (ob as any).action_type === 'tool_call_permission' &&
            (ob as any).tool_call?.id)
        ) {
          mergedBlocks.push(ob)
        }
      }
    }
    const out = JSON.parse(JSON.stringify(nxt)) as AssistantMessage
    out.content = mergedBlocks
    return out
  }

  const sendMessage = async (content: UserMessageContent | AssistantMessageBlock[]) => {
    if (!getActiveThreadId() || !content) return

    try {
      generatingThreadIds.value.add(getActiveThreadId()!)
      // 设置当前会话的workingStatus为working
      updateThreadWorkingStatus(getActiveThreadId()!, 'working')
      const aiResponseMessage = await threadP.sendMessage(
        getActiveThreadId()!,
        JSON.stringify(content),
        'user'
      )

      // 将消息添加到缓存
      getGeneratingMessagesCache().set(aiResponseMessage.id, {
        message: aiResponseMessage,
        threadId: getActiveThreadId()!
      })

      await loadMessages()
      await threadP.startStreamCompletion(
        getActiveThreadId()!,
        undefined,
        Object.fromEntries(selectedVariantsMap.value)
      )
    } catch (error) {
      console.error('Failed to send message:', error)
      throw error
    }
  }

  const retryMessage = async (messageId: string) => {
    if (!getActiveThreadId()) return
    try {
      const aiResponseMessage = await threadP.retryMessage(messageId, chatConfig.value.modelId)
      // 将消息添加到缓存
      getGeneratingMessagesCache().set(aiResponseMessage.id, {
        message: aiResponseMessage,
        threadId: getActiveThreadId()!
      })
      await loadMessages()
      generatingThreadIds.value.add(getActiveThreadId()!)
      // 设置当前会话的workingStatus为working
      updateThreadWorkingStatus(getActiveThreadId()!, 'working')
      await threadP.startStreamCompletion(
        getActiveThreadId()!,
        messageId,
        Object.fromEntries(selectedVariantsMap.value),
        'msg_retry'
      )
    } catch (error) {
      console.error('Failed to retry message:', error)
      throw error
    }
  }

  const regenerateFromUserMessage = async (userMessageId: string) => {
    if (!getActiveThreadId()) return
    try {
      generatingThreadIds.value.add(getActiveThreadId()!)
      updateThreadWorkingStatus(getActiveThreadId()!, 'working')

      const aiResponseMessage = await threadP.regenerateFromUserMessage(
        getActiveThreadId()!,
        userMessageId,
        Object.fromEntries(selectedVariantsMap.value)
      )

      getGeneratingMessagesCache().set(aiResponseMessage.id, {
        message: aiResponseMessage,
        threadId: getActiveThreadId()!
      })

      await loadMessages()
    } catch (error) {
      console.error('Failed to regenerate from user message:', error)
      throw error
    }
  }

  // 创建会话分支（从指定消息开始fork一个新会话）
  const forkThread = async (messageId: string, forkTag: string = '(fork)') => {
    if (!getActiveThreadId()) return

    try {
      // 获取当前会话信息
      const currentThread = await threadP.getConversation(getActiveThreadId()!)

      // 创建分支会话标题
      const newThreadTitle = `${currentThread.title} ${forkTag}`

      // 调用main层的forkConversation方法
      const newThreadId = await threadP.forkConversation(
        getActiveThreadId()!,
        messageId,
        newThreadTitle,
        currentThread.settings,
        Object.fromEntries(selectedVariantsMap.value)
      )

      // 切换到新会话
      await setActiveThread(newThreadId)

      return newThreadId
    } catch (error) {
      console.error('Failed to create thread branch:', error)
      throw error
    }
  }

  const handleStreamResponse = (msg: {
    eventId: string
    content?: string
    reasoning_content?: string
    tool_call_id?: string
    tool_call_name?: string
    tool_call_params?: string
    maximum_tool_calls_reached?: boolean
    tool_call_server_name?: string
    tool_call_server_icons?: string
    tool_call_server_description?: string
    tool_call?: 'start' | 'end' | 'error' | 'update' | 'running'
    totalUsage?: {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
    }
    image_data?: {
      data: string
      mimeType: string
    }
    rate_limit?: {
      providerId: string
      qpsLimit: number
      currentQps: number
      queueLength: number
      estimatedWaitTime?: number
    }
  }) => {
    // 从缓存中查找消息
    const cached = getGeneratingMessagesCache().get(msg.eventId)
    if (cached) {
      const curMsg = cached.message as AssistantMessage
      if (curMsg.content) {
        // 提取一个可复用的保护逻辑
        const finalizeLastBlock = () => {
          const lastBlock =
            curMsg.content.length > 0 ? curMsg.content[curMsg.content.length - 1] : undefined
          if (lastBlock) {
            // 仅在不是正在进行的工具调用、且不是权限请求块时，才将其标记为成功
            if (
              !(lastBlock.type === 'tool_call' && lastBlock.status === 'loading') &&
              !(
                lastBlock.type === 'action' &&
                (lastBlock as any).action_type === 'tool_call_permission'
              )
            ) {
              lastBlock.status = 'success'
            }
          }
        }

        // 处理工具调用达到最大次数的情况
        if (msg.maximum_tool_calls_reached) {
          // 作为 STREAM UI hint：仅内存态提示，不带继续按钮
          finalizeLastBlock()
          curMsg.content.push({
            type: 'action',
            content: 'common.error.maximumToolCallsReached',
            status: 'success',
            timestamp: Date.now(),
            action_type: 'maximum_tool_calls_reached'
          } as any)
        } else if (msg.tool_call) {
          if (msg.tool_call === 'start') {
            try {
              console.log('[Renderer/ToolCallStream/START]', {
                messageId: curMsg.id,
                toolCallId: msg.tool_call_id,
                name: msg.tool_call_name
              })
            } catch {}
            // 严格依赖 id；无 id 不创建提示块，避免错配
            if (msg.tool_call_id) {
              // 若已存在同 id 的已完成块，则忽略重复 START（R2/回注场景去重）
              const existingDone = curMsg.content.find(
                (block) =>
                  block.type === 'tool_call' &&
                  block.tool_call?.id === msg.tool_call_id &&
                  (block.status === 'success' || block.status === 'error')
              )
              if (!existingDone) {
                // 工具调用开始解析参数 - 创建新的工具调用块
                finalizeLastBlock() // 使用保护逻辑
                playToolcallSound()
                curMsg.content.push({
                  type: 'tool_call',
                  content: '',
                  status: 'loading', // 使用loading状态表示正在解析参数
                  timestamp: Date.now(),
                  tool_call: {
                    id: msg.tool_call_id,
                    name: msg.tool_call_name,
                    params: msg.tool_call_params || '',
                    server_name: msg.tool_call_server_name,
                    server_icons: msg.tool_call_server_icons,
                    server_description: msg.tool_call_server_description
                  }
                })
              }
            }
          } else if (msg.tool_call === 'update') {
            // 实时更新工具调用参数
            const existingToolCallBlock = curMsg.content.find(
              (block) =>
                block.type === 'tool_call' &&
                msg.tool_call_id &&
                block.tool_call?.id === msg.tool_call_id &&
                block.status === 'loading'
            )
            try {
              console.log('[Renderer/ToolCallStream/UPDATE]', {
                found: Boolean(existingToolCallBlock),
                toolCallId: msg.tool_call_id,
                name: msg.tool_call_name
              })
            } catch {}
            if (
              existingToolCallBlock &&
              existingToolCallBlock.type === 'tool_call' &&
              existingToolCallBlock.tool_call
            ) {
              // 更新参数内容
              existingToolCallBlock.tool_call.params = msg.tool_call_params || ''
            }
          } else if (msg.tool_call === 'running') {
            // 工具开始执行 - 查找对应的工具调用块并更新状态
            const existingToolCallBlock = curMsg.content.find(
              (block) =>
                block.type === 'tool_call' &&
                msg.tool_call_id &&
                block.tool_call?.id === msg.tool_call_id &&
                block.status === 'loading'
            )
            try {
              console.log('[Renderer/ToolCallStream/RUNNING]', {
                found: Boolean(existingToolCallBlock),
                toolCallId: msg.tool_call_id,
                name: msg.tool_call_name
              })
            } catch {}
            if (existingToolCallBlock && existingToolCallBlock.type === 'tool_call') {
              // 保持loading状态，但可以添加执行中的标识
              existingToolCallBlock.status = 'loading'
              if (existingToolCallBlock.tool_call) {
                // 确保参数是最新的
                existingToolCallBlock.tool_call.params =
                  msg.tool_call_params || existingToolCallBlock.tool_call.params
              }
            } else {
              // 严格依赖 id；无 id 不创建新块，避免错配
            }
          } else if (msg.tool_call === 'end' || msg.tool_call === 'error') {
            // 查找对应的工具调用块
            let existingToolCallBlock = curMsg.content.find(
              (block) =>
                block.type === 'tool_call' &&
                msg.tool_call_id &&
                block.tool_call?.id === msg.tool_call_id &&
                block.status === 'loading'
            )
            try {
              console.log('[Renderer/ToolCallStream/END_OR_ERROR]', {
                foundLoading: Boolean(existingToolCallBlock),
                toolCallId: msg.tool_call_id,
                name: msg.tool_call_name,
                status: msg.tool_call
              })
            } catch {}
            // 如果未找到 loading 块，但存在同 id/name 的已完成块，也允许补写响应（容错）
            if (!existingToolCallBlock && msg.tool_call_id) {
              existingToolCallBlock = curMsg.content.find(
                (block) =>
                  block.type === 'tool_call' &&
                  block.tool_call?.id === msg.tool_call_id &&
                  (block.status === 'success' || block.status === 'error')
              )
            }
            if (existingToolCallBlock && existingToolCallBlock.type === 'tool_call') {
              // In collect-only mode, provider does not execute tools.
              // Do not override an existing error with a later 'end' success.
              const incomingStatus = msg.tool_call === 'error' ? 'error' : 'success'
              if (existingToolCallBlock.status === 'error' && incomingStatus === 'success') {
                // keep error (e.g., limit reached authoritative result)
              } else {
                existingToolCallBlock.status = incomingStatus
              }
            }
          }
        }
        // 处理图像数据
        else if (msg.image_data) {
          finalizeLastBlock() // 使用保护逻辑
          curMsg.content.push({
            type: 'image',
            content: 'image',
            status: 'success',
            timestamp: Date.now(),
            image_data: {
              data: msg.image_data.data,
              mimeType: msg.image_data.mimeType
            }
          })
        }
        // 处理速率限制
        else if (msg.rate_limit) {
          finalizeLastBlock() // 使用保护逻辑
          curMsg.content.push({
            type: 'action',
            content: 'chat.messages.rateLimitWaiting',
            status: 'loading',
            timestamp: Date.now(),
            action_type: 'rate_limit',
            extra: {
              providerId: msg.rate_limit.providerId,
              qpsLimit: msg.rate_limit.qpsLimit,
              currentQps: msg.rate_limit.currentQps,
              queueLength: msg.rate_limit.queueLength,
              estimatedWaitTime: msg.rate_limit.estimatedWaitTime ?? 0
            }
          })
        }
        // 处理普通内容
        else if (msg.content) {
          const lastContentBlock = curMsg.content[curMsg.content.length - 1]
          if (lastContentBlock && lastContentBlock.type === 'content') {
            lastContentBlock.content += msg.content
            playTypewriterSound()
          } else {
            finalizeLastBlock() // 使用统一保护逻辑，避免错误改写权限块/工具块状态
            curMsg.content.push({
              type: 'content',
              content: msg.content,
              status: 'loading',
              timestamp: Date.now()
            })
            playTypewriterSound()
          }
        }

        // 处理推理内容
        if (msg.reasoning_content) {
          const lastReasoningBlock = curMsg.content[curMsg.content.length - 1]
          if (lastReasoningBlock && lastReasoningBlock.type === 'reasoning_content') {
            lastReasoningBlock.content += msg.reasoning_content
          } else {
            finalizeLastBlock() // 使用统一保护逻辑
            curMsg.content.push({
              type: 'reasoning_content',
              content: msg.reasoning_content,
              status: 'loading',
              timestamp: Date.now()
            })
          }
        }
      }

      // 处理使用情况统计
      if (msg.totalUsage) {
        curMsg.usage = {
          ...curMsg.usage,
          total_tokens: msg.totalUsage.total_tokens,
          input_tokens: msg.totalUsage.prompt_tokens,
          output_tokens: msg.totalUsage.completion_tokens
        }
      }

      // 如果是当前激活的会话，更新显示
      if (cached.threadId === getActiveThreadId()) {
        const msgIndex = getMessages().findIndex((m) => m.id === msg.eventId)
        if (msgIndex !== -1) {
          getMessages()[msgIndex] = curMsg
        }
      }
    }
  }

  const handleStreamEnd = async (msg: { eventId: string }) => {
    // Do not merge content on END. Only clear caches + working status.
    const cached = getGeneratingMessagesCache().get(msg.eventId)
    if (!cached) return

    // Clear generating state for this message/thread
    getGeneratingMessagesCache().delete(msg.eventId)
    generatingThreadIds.value.delete(cached.threadId)

    // Update working status without touching message content
    if (getActiveThreadId() === cached.threadId) {
      getThreadsWorkingStatus().delete(cached.threadId)
    } else {
      updateThreadWorkingStatus(cached.threadId, 'completed')
    }
  }

  const handleStreamError = async (msg: { eventId: string }) => {
    // Do not merge content on ERROR. Only clear caches + working status.
    const cached = getGeneratingMessagesCache().get(msg.eventId)
    if (!cached) return

    // Optional: lightweight user notification without DB reads
    try {
      const wid = window.api.getWindowId() || 0
      const isFocused = await windowP.isMainWindowFocused(wid)
      if (!isFocused) {
        await notificationP.showNotification({
          id: `error-${msg.eventId}`,
          title: t('chat.notify.generationError'),
          body: t('chat.notify.generationError')
        })
      }
    } catch (e) {
      console.error('Failed to send error notification:', e)
    }

    // Clear generating state for this message/thread
    getGeneratingMessagesCache().delete(msg.eventId)
    generatingThreadIds.value.delete(cached.threadId)

    // Update working status without touching message content
    if (getActiveThreadId() === cached.threadId) {
      getThreadsWorkingStatus().delete(cached.threadId)
    } else {
      updateThreadWorkingStatus(cached.threadId, 'error')
    }
  }

  const renameThread = async (threadId: string, title: string) => {
    await threadP.renameConversation(threadId, title)
  }

  const toggleThreadPinned = async (threadId: string, isPinned: boolean) => {
    await threadP.toggleConversationPinned(threadId, isPinned)
  }

  // 配置相关的方法
  const loadChatConfig = async () => {
    if (!getActiveThreadId()) return
    try {
      const conversation = await threadP.getConversation(getActiveThreadId()!)
      const threadToUpdate = threads.value
        .flatMap((thread) => thread.dtThreads)
        .find((t) => t.id === getActiveThreadId())
      if (threadToUpdate) {
        Object.assign(threadToUpdate, conversation)
      }
      if (conversation) {
        chatConfig.value = { ...conversation.settings }
        // Populate the in-memory map from the loaded settings
        if (conversation.settings.selectedVariantsMap) {
          selectedVariantsMap.value = new Map(
            Object.entries(conversation.settings.selectedVariantsMap)
          )
        } else {
          selectedVariantsMap.value.clear()
        }
      }
    } catch (error) {
      console.error('Failed to load conversation config:', error)
      throw error
    }
  }

  const saveChatConfig = async () => {
    if (!getActiveThreadId()) return
    try {
      await threadP.updateConversationSettings(getActiveThreadId()!, chatConfig.value)
    } catch (error) {
      console.error('Failed to save conversation config:', error)
      throw error
    }
  }

  const updateChatConfig = async (newConfig: Partial<CONVERSATION_SETTINGS>) => {
    chatConfig.value = { ...chatConfig.value, ...newConfig }
    await saveChatConfig()
    await loadChatConfig() // 加载对话配置
  }

  const deleteMessage = async (messageId: string) => {
    const activeThreadId = getActiveThreadId()
    if (!activeThreadId) return

    try {
      const messages = getMessages()
      let parentMessage: AssistantMessage | undefined
      let parentIndex = -1
      const mainMsgIndex = messages.findIndex((m) => m.id === messageId)
      if (mainMsgIndex !== -1 && (messages[mainMsgIndex] as AssistantMessage).is_variant === 0) {
        if (selectedVariantsMap.value.has(messageId)) {
          selectedVariantsMap.value.delete(messageId)
          await updateSelectedVariant(messageId, null)
        }
      } else {
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i] as AssistantMessage
          if (msg.role === 'assistant' && msg.variants?.some((v) => v.id === messageId)) {
            parentMessage = msg
            parentIndex = i
            break
          }
        }

        if (parentMessage && parentIndex !== -1) {
          const remainingVariants = parentMessage.variants?.filter((v) => v.id !== messageId) || []
          parentMessage.variants = remainingVariants
          messages[parentIndex] = { ...parentMessage }
          const newSelectedVariantId =
            remainingVariants.length > 0 ? remainingVariants[remainingVariants.length - 1].id : null
          await updateSelectedVariant(parentMessage.id, newSelectedVariantId)
        }
      }

      await threadP.deleteMessage(messageId)
      await loadMessages()
    } catch (error) {
      console.error('Failed to delete message:', error)
      await loadMessages()
    }
  }

  const clearAllMessages = async (threadId: string) => {
    if (!threadId) return
    try {
      await threadP.clearAllMessages(threadId)
      // 清空本地消息列表
      if (threadId === getActiveThreadId()) {
        setMessages([])
      }
      // 清空生成缓存中的相关消息
      const cache = getGeneratingMessagesCache()
      for (const [messageId, cached] of cache.entries()) {
        if (cached.threadId === threadId) {
          cache.delete(messageId)
        }
      }
      generatingThreadIds.value.delete(threadId)
      // 从状态Map中移除会话状态
      getThreadsWorkingStatus().delete(threadId)
    } catch (error) {
      console.error('Failed to clear messages:', error)
      throw error
    }
  }

  const cancelGenerating = async (threadId: string) => {
    if (!threadId) return
    try {
      // 找到当前正在生成的消息
      const cache = getGeneratingMessagesCache()
      const generatingMessage = Array.from(cache.entries()).find(
        ([, cached]) => cached.threadId === threadId
      )
      if (generatingMessage) {
        const [messageId] = generatingMessage
        await threadP.stopMessageGeneration(messageId)
        // 从缓存中移除消息
        cache.delete(messageId)
        generatingThreadIds.value.delete(threadId)
        // 设置会话的workingStatus为completed
        if (getActiveThreadId() === threadId) {
          getThreadsWorkingStatus().delete(threadId)
        } else {
          updateThreadWorkingStatus(threadId, 'completed')
        }
        // 获取更新后的消息
        const updatedMessage = await threadP.getMessage(messageId)
        // 更新消息列表中的对应消息
        const messageIndex = getMessages().findIndex((msg) => msg.id === messageId)
        if (messageIndex !== -1) {
          getMessages()[messageIndex] = updatedMessage
        }
      }
    } catch (error) {
      console.error('Failed to cancel generation:', error)
    }
  }
  const continueStream = async (conversationId: string, messageId: string) => {
    if (!conversationId || !messageId) return
    try {
      generatingThreadIds.value.add(conversationId)
      // 设置会话的workingStatus为working
      updateThreadWorkingStatus(conversationId, 'working')

      // 创建一个新的助手消息
      const aiResponseMessage = await threadP.sendMessage(
        conversationId,
        JSON.stringify({
          text: 'continue',
          files: [],
          links: [],
          search: false,
          think: false,
          continue: true
        }),
        'user'
      )

      if (!aiResponseMessage) {
        console.error('Failed to create assistant message')
        return
      }

      // 将消息添加到缓存
      getGeneratingMessagesCache().set(aiResponseMessage.id, {
        message: aiResponseMessage,
        threadId: conversationId
      })

      await loadMessages()
      await threadP.continueStreamCompletion(
        conversationId,
        messageId,
        Object.fromEntries(selectedVariantsMap.value)
      )
    } catch (error) {
      console.error('Failed to continue generation:', error)
      throw error
    }
  }

  // 新增：监听来自主进程的初始化并发送消息的指令
  window.electron.ipcRenderer.on(
    'command:send-initial-message',
    async (_, data: { userInput: string }) => {
      // 确保当前有活动的会话
      if (!getActiveThreadId()) {
        console.error('Received send-initial-message command but no active thread is set.')
        return
      }

      try {
        // 调用已有的 sendMessage 方法，这将复用所有现有逻辑
        await sendMessage({
          text: data.userInput,
          files: [],
          links: [],
          think: false,
          search: false
        })
      } catch (error) {
        console.error('Failed to handle send-initial-message command:', error)
      }
    }
  )

  const handleMessageEdited = async (msgId: string) => {
    // 首先检查是否在生成缓存中
    const cached = getGeneratingMessagesCache().get(msgId)
    if (cached) {
      // 如果在缓存中，获取最新的消息
      const updatedMessage = await threadP.getMessage(msgId)
      // 处理 extra 信息
      const enrichedMessage = await enrichMessageWithExtra(updatedMessage)

      // 更新缓存（合并以避免状态/结果回退）
      cached.message = mergeAssistantMessage(
        cached.message as AssistantMessage | UserMessage,
        enrichedMessage as AssistantMessage | UserMessage
      )

      // 如果是当前会话的消息，也更新显示
      if (cached.threadId === getActiveThreadId()) {
        const msgIndex = getMessages().findIndex((m) => m.id === msgId)
        if (msgIndex !== -1) {
          const merged = mergeAssistantMessage(
            getMessages()[msgIndex] as AssistantMessage | UserMessage,
            enrichedMessage as AssistantMessage | UserMessage
          )
          getMessages()[msgIndex] = merged
        }
      }
    } else if (getActiveThreadId()) {
      // 如果不在缓存中，先尝试获取主消息
      const mainMessage = await threadP.getMainMessageByParentId(getActiveThreadId()!, msgId)
      if (mainMessage) {
        // 如果找到主消息，说明当前消息是变体消息
        const enrichedMainMessage = await enrichMessageWithExtra(mainMessage)
        const mainMsgIndex = getMessages().findIndex((m) => m.id === mainMessage.id)
        if (mainMsgIndex !== -1) {
          const merged = mergeAssistantMessage(
            getMessages()[mainMsgIndex] as AssistantMessage | UserMessage,
            enrichedMainMessage as AssistantMessage | UserMessage
          )
          getMessages()[mainMsgIndex] = merged
        }
      } else {
        // 如果不是变体消息，直接更新当前消息
        const msgIndex = getMessages().findIndex((m) => m.id === msgId)
        if (msgIndex !== -1) {
          const updatedMessage = await threadP.getMessage(msgId)
          const enrichedMessage = await enrichMessageWithExtra(updatedMessage)
          const merged = mergeAssistantMessage(
            getMessages()[msgIndex] as AssistantMessage | UserMessage,
            enrichedMessage as AssistantMessage | UserMessage
          )
          getMessages()[msgIndex] = merged
        }
      }
    }
  }

  /////////////////////////////////////////////////////////////////////////////////////////////////////////
  // 更新和持久化变体选择
  const updateSelectedVariant = async (mainMessageId: string, selectedVariantId: string | null) => {
    const activeThreadId = getActiveThreadId()
    if (!activeThreadId) return

    // 更新内存中的 Map
    if (selectedVariantId && selectedVariantId !== mainMessageId) {
      selectedVariantsMap.value.set(mainMessageId, selectedVariantId)
    } else {
      selectedVariantsMap.value.delete(mainMessageId)
    }

    // 同步更新 chatConfig 内的 selectedVariantsMap
    if (chatConfig.value) {
      chatConfig.value.selectedVariantsMap = Object.fromEntries(selectedVariantsMap.value)
    }

    // 持久化到后端
    try {
      await threadP.updateConversationSettings(activeThreadId, {
        selectedVariantsMap: Object.fromEntries(selectedVariantsMap.value)
      })
    } catch (error) {
      console.error('Failed to update selected variant:', error)
    }
  }

  /////////////////////////////////////////////////////////////////////////////////////////////////////////
  let typewriterAudio: HTMLAudioElement | null = null
  let toolcallAudio: HTMLAudioElement | null = null

  let lastSoundTime = 0
  const soundInterval = 120

  const initAudio = () => {
    if (!typewriterAudio) {
      typewriterAudio = new Audio(sfxtyMp3)
      typewriterAudio.volume = 0.6
      typewriterAudio.load()
    }
    if (!toolcallAudio) {
      toolcallAudio = new Audio(sfxfcMp3)
      toolcallAudio.volume = 1
      toolcallAudio.load()
    }
  }

  initAudio()

  const playTypewriterSound = () => {
    const now = Date.now()
    if (!soundStore.soundEnabled || !typewriterAudio) return
    if (now - lastSoundTime > soundInterval) {
      typewriterAudio.currentTime = 0
      typewriterAudio.play().catch(console.error)
      lastSoundTime = now
    }
  }

  const playToolcallSound = () => {
    if (!soundStore.soundEnabled || !toolcallAudio) return
    toolcallAudio.currentTime = 0
    toolcallAudio.play().catch(console.error)
  }

  /////////////////////////////////////////////////////////////////////////////////////////////////////////
  // 注册 deeplink 事件处理
  window.electron.ipcRenderer.on(DEEPLINK_EVENTS.START, async (_, data) => {
    console.log(`[Renderer] Tab ${getTabId()} received DEEPLINK_EVENTS.START:`, data)
    // 确保路由正确
    const currentRoute = router.currentRoute.value
    if (currentRoute.name !== 'chat') {
      await router.push({ name: 'chat' })
    }
    // 如果存在活动会话，创建新会话
    if (getActiveThreadId()) {
      await clearActiveThread()
    }
    // 存储 deeplink 数据到缓存
    if (data) {
      deeplinkCache.value = {
        msg: data.msg,
        modelId: data.modelId,
        systemPrompt: data.systemPrompt,
        autoSend: data.autoSend,
        mentions: data.mentions
      }
    }
  })

  // 清理 Deeplink 缓存
  const clearDeeplinkCache = () => {
    deeplinkCache.value = null
  }

  // 新增更新会话workingStatus的方法
  const updateThreadWorkingStatus = (threadId: string, status: WorkingStatus) => {
    // 如果是活跃会话，且状态为completed或error，直接从Map中移除
    if (getActiveThreadId() === threadId && (status === 'completed' || status === 'error')) {
      // console.log(`活跃会话状态移除: ${threadId}`)
      getThreadsWorkingStatus().delete(threadId)
      return
    }

    // 记录状态变更
    const oldStatus = getThreadsWorkingStatus().get(threadId)
    if (oldStatus !== status) {
      // console.log(`会话状态变更: ${threadId} ${oldStatus || 'none'} -> ${status}`)
      getThreadsWorkingStatus().set(threadId, status)
    }
  }

  // 获取会话工作状态的方法
  const getThreadWorkingStatus = (threadId: string): WorkingStatus | null => {
    return getThreadsWorkingStatus().get(threadId) || null
  }

  /**
   * 新增: 处理来自主进程的会议指令
   * @param data 包含指令文本的对象
   */
  const handleMeetingInstruction = async (data: { prompt: string }) => {
    // 确保当前有活动的会话，否则指令无法执行
    if (!getActiveThreadId()) {
      console.warn('Received meeting command, but no active session. Command ignored.')
      return
    }
    try {
      // 将收到的指令作为用户输入，调用已有的sendMessage方法
      // 这样可以完全复用UI的加载状态、消息显示等所有逻辑
      await sendMessage({
        text: data.prompt,
        files: [],
        links: [],
        think: false,
        search: false,
        content: [{ type: 'text', content: data.prompt }]
      })
    } catch (error) {
      console.error('Error occurred while processing meeting command:', error)
    }
  }

  const setupEventListeners = () => {
    // 新增：监听来自主进程的会议指令
    window.electron.ipcRenderer.on(MEETING_EVENTS.INSTRUCTION, (_, data) => {
      handleMeetingInstruction(data)
    })

    // 监听：主进程推送的完整会话列表
    window.electron.ipcRenderer.on(
      CONVERSATION_EVENTS.LIST_UPDATED,
      (_, updatedGroupedList: { dt: string; dtThreads: CONVERSATION[] }[]) => {
        console.log('Received full thread list update from main process.')

        // 1. 获取当前活动会话ID，在列表更新前
        const currentActiveId = getActiveThreadId()

        // 2. 用主进程推送的最新、完整的、已格式化好的列表直接替换本地状态
        threads.value = updatedGroupedList

        // 3. 检查列表更新之前的活动会话是否还存在于新列表中
        if (currentActiveId) {
          const flatList = updatedGroupedList.flatMap((g) => g.dtThreads)
          const activeThreadExists = flatList.some((thread) => thread.id === currentActiveId)

          // 如果活动会话不存在了（如在其他窗口被删除），只清空当前tab的活动状态，待其他流程处理
          if (!activeThreadExists) {
            clearActiveThread()
          }
        }
      }
    )

    // 监听：定向的会话激活事件
    window.electron.ipcRenderer.on(CONVERSATION_EVENTS.ACTIVATED, async (_, msg) => {
      // 确保是发给当前Tab的事件
      if (msg.tabId !== getTabId()) {
        return
      }

      // 如果是当前tab或新激活的会话在当前窗口中，则正常处理
      activeThreadIdMap.value.set(getTabId(), msg.conversationId)

      // 如果存在状态为completed或error的会话，从Map中移除
      if (msg.conversationId) {
        const status = getThreadsWorkingStatus().get(msg.conversationId)
        if (status === 'completed' || status === 'error') {
          getThreadsWorkingStatus().delete(msg.conversationId)
        }
      }

      await loadChatConfig() // 加载对话配置
      await loadMessages()

      // 新增：在会话激活处理完成后，通过usePresenter发送确认信号
      tabP.onRendererTabActivated(msg.conversationId)
    })

    window.electron.ipcRenderer.on(CONVERSATION_EVENTS.MESSAGE_EDITED, (_, payload: any) => {
      try {
        if (typeof payload === 'string') {
          // 始终处理字符串载荷（用于父消息刷新 variants[] 等场景）
          handleMessageEdited(payload)
          return
        }
        const { messageId, revision } = payload || {}
        if (!messageId) return // 标注来源（用于最小回退打点）
        ;(window as any).__incomingEvent = 'MESSAGE_EDITED'
        ;(window as any).__incomingRevision = revision ?? null
        // 对象载荷仅接受更高 revision（去重/防乱序）
        const map = (messageRevisions as any).value as Map<string, number>
        const prev = map.get(messageId) || 0
        if (typeof revision === 'number') {
          if (revision <= prev) {
            return
          }
          map.set(messageId, revision)
        }
        handleMessageEdited(messageId)
      } catch (e) {
        console.error('Failed to handle MESSAGE_EDITED payload:', e)
      }
    })

    window.electron.ipcRenderer.on(CONVERSATION_EVENTS.DEACTIVATED, (_, msg) => {
      if (msg.tabId !== getTabId()) {
        return
      }
      setActiveThreadId(null)
    })
  }

  onMounted(() => {
    console.log(`[Chat Store] Tab ${getTabId()} is mounted. Setting up event listeners.`)

    // store现在是被动的，等待主进程推送数据
    setupEventListeners()

    // 在 store 初始化完成后，通过usePresenter发送就绪信号
    console.log(`[Chat Store] Tab ${getTabId()} sending ready signal`)
    tabP.onRendererTabReady(getTabId())
  })

  /**
   * 导出会话内容
   * @param threadId 会话ID
   * @param format 导出格式
   */
  const exportThread = async (
    threadId: string,
    format: 'markdown' | 'html' | 'txt' = 'markdown'
  ) => {
    try {
      // 直接使用主线程导出
      return await exportWithMainThread(threadId, format)
    } catch (error) {
      console.error('Failed to export thread:', error)
      throw error
    }
  }

  /**
   * 主线程导出
   */
  const exportWithMainThread = async (threadId: string, format: 'markdown' | 'html' | 'txt') => {
    const result = await threadP.exportConversation(threadId, format)

    // 触发下载
    const blob = new Blob([result.content], {
      type: getContentType(format)
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = result.filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    return result
  }

  /**
   * 获取内容类型
   */
  const getContentType = (format: string): string => {
    switch (format) {
      case 'markdown':
        return 'text/markdown;charset=utf-8'
      case 'html':
        return 'text/html;charset=utf-8'
      case 'txt':
        return 'text/plain;charset=utf-8'
      default:
        return 'text/plain;charset=utf-8'
    }
  }

  /**
   * 显示 provider 选择器（触发事件让界面显示选择器）
   */
  const showProviderSelector = () => {
    // 触发事件让 ChatInput 组件显示 provider 选择器
    window.dispatchEvent(new CustomEvent('show-provider-selector'))
  }

  return {
    renameThread,
    // 状态
    createNewEmptyThread,
    isSidebarOpen,
    isMessageNavigationOpen,
    activeThreadIdMap,
    threads,
    messagesMap,
    generatingThreadIds,
    selectedVariantsMap,
    // Getters
    activeThread,
    variantAwareMessages,
    // Actions
    createThread,
    setActiveThread,
    loadMessages,
    sendMessage,
    handleStreamResponse,
    handleStreamEnd,
    handleStreamError,
    handleMessageEdited,
    // 导出配置相关的状态和方法
    chatConfig,
    updateChatConfig,
    retryMessage,
    deleteMessage,
    clearActiveThread,
    cancelGenerating,
    clearAllMessages,
    continueStream,
    deeplinkCache,
    clearDeeplinkCache,
    forkThread,
    updateThreadWorkingStatus,
    getThreadWorkingStatus,
    threadsWorkingStatusMap,
    toggleThreadPinned,
    getActiveThreadId,
    getGeneratingMessagesCache,
    getMessages,
    getCurrentThreadMessages,
    exportThread,
    showProviderSelector,
    regenerateFromUserMessage,
    updateSelectedVariant
  }
})
