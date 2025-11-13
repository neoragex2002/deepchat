# **取消机制（ACE 模型）**

**受众：** 实施者、QA 工程师、架构师

**目的：** 提供 DeepChat Agent 全流程统一的取消（ACE）机制的权威规范，确保在任何阶段都能实现一致、可预测、可观测的终止行为。

**指导原则：** 以 ACE（Abort→Commit→End）为骨架，覆盖 R‑prepare、R、S、屏障等待、授权、执行 X、R2/S2 等所有核心阶段的取消时序；明确核心不变量、关键日志、配置项和排查指南。本文已对齐当前代码实现（ThreadPresenter / Renderer / LLMProviderPresenter），对尚未实现的功能在文末“增强项”中标注。

---

## 1. ACE 模型核心定义

ACE 模型是将“取消”这一复杂操作解构为三个原子且有序的步骤，旨在确保在 Agent 工作流的任何阶段都能实现一致、可预测、可观测的终止行为。

  * **A - Abort (中止源头)**

      * **目的：** **立即停止所有正在进行或即将开始的数据生成和处理**。这是取消机制的“快速反应”部分。
      * **实施步骤：**
        1.  **设置取消标志：** 在 TP 侧，将 `state.isCancelled` 标志置为 `true`。这是所有后续中止逻辑的唯一依据。
        2.  **记录逻辑屏障 (Fence)：**
              * `revFence`：记录当前消息的最新版本号 (`lastAppliedRevision(messageId)`)。所有低于此版本号的 `MESSAGE_EDITED` 更新将被 UI 忽略。
              * `sseqFence`：记录当前 STREAM 阶段已处理的最后一个流序列号 (`lastStreamSeq(eventId)`)。所有序列号高于此值的 STREAM 帧将在收到 END 前被 UI 丢弃（在屏障建立后丢弃“晚到帧”）。
              * 现状说明：取消路径未显式发送新的 DRAIN/屏障指令，主要依赖 Provider 终止与 UI 侧缓存清理来抑制晚到帧；屏障期通过 `STREAM.DRAIN/STREAM.DRAIN_ACK` 建立逻辑屏障。
        3.  **终止上游数据源：** TP 向相应模块发出中止指令，尽最大努力停止上游的数据产出。
              * **LLM Provider：** 调用 `llmProviderPresenter.stopStream(eventId)`。
              * **SearchManager：** 调用 `searchManager.stopSearch(conversationId)`。
              * **ToolManager (工具执行)：** 调用 `ToolExec.cancel(toolId)` (若工具支持)。
              * **内部等待：** 中断 TP 内部的等待机制（如 `Promise.race` 对 `DRAIN_ACK` 的等待）。
      * **机制：** 逻辑屏障机制用于**隔离和丢弃**任何在取消信号之后到达的 STREAM 帧或工具结果。

  * **C - Commit (提交最终状态)**

      * **目的：** **定义取消后的最终状态**。通过一次 `MESSAGE_EDITED` 事件，将取消的最终结果作为单一步骤完整写入数据库并通知 UI，确保 SSoT（单一真理来源）。
      * **实施步骤：**
        1.  **更新消息内容：** TP 在内存中构建消息的最终内容，包括：
              * **追加取消块：** 向消息中追加一个 `{ type:'error', content:'common.error.userCanceledGeneration', status:'cancel' }` 块（渲染层标题使用 `common.error.userCanceledTitle`）。
              * **设置消息顶层状态：** 将消息的顶层 `status` 置为 `'error'`。
              * **块状态最终处理：** 普通内容/搜索等提示类块的 `loading/reading/optimizing` 状态统一处理为 `success`（消除动画残留，不影响最终含义）。
              * **工具占位（以实现为准）：** 为已存在且未完成的工具调用块写入统一错误占位符（`{ ok:false, error:'user_cancelled', message:'用户已取消本轮生成。', partial?:true }`）。对“尚未显示为界面块的 planned 调用”当前不写入占位符（增强项）。
        2.  **持久化到数据库：** TP 调用 `messageManager.editMessageSilently()` 将上述更新作为单一步骤完整持久化到数据库。
        3.  **通知 UI：** **由 TP 自己**发出 `CONVERSATION_EVENTS.MESSAGE_EDITED { messageId, revision }` 事件，通知 UI 读取最新的最终状态。
      * **机制：** 确保 UI 能够从数据库中加载到最终的、一致的取消状态。

  * **E - End (技术清层)**

      * **目的：** 技术上的收尾步骤，主要目的是**清理 UI 的临时状态**并释放后端 TP 侧的资源。此步骤**必须在 C (Commit) 之后**执行。
      * **实施步骤：**
        1.  **发送 `STREAM.END`：** TP 发送 `STREAM.END { eventId, final: true }` 事件。若在 `cancel.endFallbackMs` 内未收到 Provider 的 END，TP 会在超时后发送一个补充的 END（当前默认开启）。
        2.  **UI 侧清理：** UI 监听到 `STREAM.END` 后，执行以下操作：
              * 清理所有相关的提示层状态（如打字机效果、“生成中”指示器、取消按钮的显示状态等）。
              * 根据 `MESSAGE_EDITED` 提交的最终内容渲染消息。
        3.  **TP 侧清理：** TP 清理当前消息相关的内部状态：
              * 从 `generatingMessages` 中删除当前 `messageId` 的 `GeneratingMessageState`。
              * 从 `searchingMessages` 中删除当前 `messageId`。
              * 清理 `pendingContinuation` 和 `continuationInProgress` 标志，避免取消后再触发 R2。
              * 清理 `generatingThreadIds` (UI 侧的标志)。

---

## 2. 核心不变量与验收标准

这些不变量是验证取消功能是否正确的金标准，必须在任何取消场景下得到满足。

1.  **取消块恰一次；消息 `status='error'`：** 无论用户点击多少次取消，最终消息中只应存在一个由系统生成的取消块，其 `status` 为 `'cancel'`。消息的顶层 `status` 必须最终置为 `'error'`。
2.  **取消后不再推进到后续阶段：** 一旦取消，Agent 的工作流必须完全停止。不得进入授权后的执行、执行后的 R2 继续作答等后续阶段。所有后到的工具结果或 STREAM 帧都将被逻辑屏障机制丢弃。
3.  **S 期与屏障期恰一次 `STREAM.END { final: true }`：** 在涉及 STREAM 的阶段取消，必须确保最终有且仅有一次 `STREAM.END { final: true }` 事件被发送，以可靠地清理 UI 状态。在 Provider 未能及时发送 `END` 时，TP 必须在 `cancel.endFallbackMs` 后发送补充的 END。
4.  **UI 状态不回退 (SSoT)：** 最终的取消状态（由 `MESSAGE_EDITED` 提交）绝不能被任何后续到达的、旧的 STREAM 帧或低版本 `MESSAGE_EDITED` 事件所覆盖。UI 的合并逻辑必须严格遵守 `revision` 单调递增原则，且 `sseqFence` 确保序列号高于屏障的 STREAM 帧被丢弃。
5.  **错误占位符准确并可解释（以实现为准）：** 在执行（X）期取消时，已存在且未完成的工具调用块会被写入带有正确 `tool_call_id` 的错误占位符（`{ ok:false, error:'user_cancelled', ... }`）。对“尚未显示为界面块的 planned 调用”当前不写入占位符（增强项）。

---

## 3. 通用配置项（当前实现）

这些配置项控制着取消行为的一些细节和超时机制。

  * **`cancel.endFallbackMs`** (默认 `~300ms`)
      * **作用：** 在 S 期取消后，TP 等待 Provider 发送 `STREAM.END` 的最大超时时间。如果 Provider 在此时间内未能发送 `END`，TP 将主动发送补充的 STREAM.END { final: true }\`。
  * **`cancel.shortCircuitOnUserStop`** (默认 `true`)
      * **作用：** 在 `handleLLMAgentEnd` 逻辑中，如果检测到 `userStop` 且 `state.isCancelled` 为真，则会跳过消息的“最终处理”逻辑，防止状态被意外修改。
  * **`cancel.toolResultDiscard`** (默认 `true`)
      * **作用：** 开启逻辑屏障机制，在取消后，所有后到的工具执行结果将被 TP 在数据层丢弃，不会写入数据库。
  * **`cancel.barrierAckTimeoutMs`** (默认 `~300ms`)
      * **作用：** TP 在发送 `STREAM.DRAIN` 后，等待 UI 返回 `STREAM.DRAIN_ACK` 的超时时间。超时后 TP 将继续执行后续流程（Commit），不会阻塞。
  * **`cancel.userCanceledTitleEnabled`** (默认 `true`)
      * **作用：** 控制是否启用 `common.error.userCanceledTitle` 作为取消块的标题，而非通用的 `common.error.requestFailed`。

---

## 4. 分阶段取消流程详解

本节详细阐述 ACE 模型在 DeepChat Agent 各个核心阶段的具体应用和行为。

### 4.1 R‑prepare (搜索) 阶段取消

  * **阶段特性：** 发生在向模型提交 R 输入之前，不涉及 STREAM。搜索进度通过多次 `MESSAGE_EDITED` 提交最终状态。
  * **ACE 应用：**
    1.  **A - Abort：**
          * TP 设置 `state.isCancelled=true`，记录 `revFence`。
          * 调用 `SearchManager.stopSearch(conversationId)` 立即关闭所有搜索窗口和进程。
    2.  **C - Commit：**
          * TP 在内存中更新消息内容，添加取消块，并将消息顶层 `status` 置为 `'error'`。
          * 调用 `messageManager.editMessageSilently()` 持久化。
          * 发送 `CONVERSATION_EVENTS.MESSAGE_EDITED { messageId, revision }` 通知 UI 读取最新的最终状态。
    3.  **E - End：**
          * TP 发送 `STREAM.END { eventId, final: true }`（作为技术性 END，确保 UI 清理）。
          * TP 侧清理 `searchingMessages` 和 `generatingMessages` 中与该消息相关的状态。
  * **时序图：**
    ```mermaid
    sequenceDiagram
      autonumber
      participant User
      participant UI
      participant TP
      participant SearchManager as SM
      participant DB

      User->>UI: 触发搜索（R‑prepare）
      UI->>TP: 开始搜索
      note over TP: TP 提交搜索子阶段进度 (MESSAGE_EDITED)
      
      User-->>TP: 取消
      note right of TP: 1. A - Abort
      TP->>SM: stopSearch(conversationId)
      TP-->>TP: 设置 state.isCancelled=true, 记录 revFence
      
      note right of TP: 2. C - Commit
      TP->>DB: editMessageSilently(添加取消块, status='error')
      TP-->>UI: MESSAGE_EDITED { messageId, revision }
      
      note right of TP: 3. E - End
      TP->>UI: STREAM.END { eventId, final=true }
      TP-->>TP: 清理 searchingMessages, generatingMessages
    ```
  * **关键日志（以实现为准）：** `CANCEL.start`、`CANCEL.done{revision}`、`STREAM|end{final:true}`、`SEARCH.error`。
  * **验收标准：**
      * UI 立即显示取消状态，搜索窗口关闭。
      * DB 中消息状态为 `error`，包含取消块。
      * 日志序列符合预期。
  * **常见偏差：** 取消后，`SearchManager` 仍在后台运行或 UI 仍显示搜索进度。

### 4.2 S (STREAM) 阶段取消

  * **阶段特性：** LLM 正在流式生成文本或工具调用参数。
  * **ACE 应用：**
    1.  **A - Abort：**
          * TP 设置 `state.isCancelled=true`，记录 `revFence` 和 `sseqFence`。
          * 调用 `llmProviderPresenter.stopStream(eventId)` 终止 Provider 的流。
    2.  **C - Commit：**
          * TP 在内存中更新消息内容，添加取消块，并将消息顶层 `status` 置为 `'error'`。
          * TP 调用 `finalizeLastBlock()`，将“普通内容/阅读类块”的 `loading/reading/optimizing` 状态统一处理为 `success`，但**跳过** `tool_call` 和 `tool_call_permission` 块。
          * 为已存在且未完成的工具块写入 `user_cancelled` 占位符。
          * 调用 `messageManager.editMessageSilently()` 持久化。
          * 发送 `CONVERSATION_EVENTS.MESSAGE_EDITED { messageId, revision }` 通知 UI 读取最新的最终状态。
    3.  **E - End：**
          * TP 等待 Provider 的 `STREAM.END` 事件。若在 `cancel.endFallbackMs` 内未收到，TP 将主动发送补充的 `STREAM.END { eventId, final: true }`。
          * 取消跳过：当 `handleLLMAgentEnd()` 收到 `userStop && state.isCancelled` 时，直接发送 `END(final=true)` 清理界面，不再执行“最终处理”。
          * TP 侧清理 `generatingMessages` 中与该消息相关的状态。
  * **时序图：**
    ```mermaid
    sequenceDiagram
      autonumber
      participant User
      participant UI
      participant TP
      participant Provider
      participant DB

      User->>UI: 发送消息
      UI->>TP: startStreamCompletion()
      TP->>Provider: 开始流
      Provider-->>TP: STREAM.RESPONSE (文本/tool_call_update)
      TP-->>UI: STREAM.RESPONSE (UI Hints)
      
      User-->>TP: 取消
      note right of TP: 1. A - Abort
      TP-->>TP: 设置 state.isCancelled=true, 记录 revFence, sseqFence
      TP->>Provider: stopStream(eventId)
      
      note right of TP: 2. C - Commit
      TP->>DB: editMessageSilently(添加取消块, status='error', 并处理内容块状态)
      TP-->>UI: MESSAGE_EDITED { messageId, revision }
      
      note right of TP: 3. E - End (带补充机制)
      alt Provider 及时响应 (例如因 stopStream)
          Provider-->>TP: STREAM.END { eventId }
          TP->>UI: STREAM.END { eventId, final=true }
      else 超时 (cancel.endFallbackMs)
          TP->>UI: STREAM.END { eventId, final=true } (TP 主动发送)
      end
      TP-->>TP: 清理 generatingMessages
    ```
  * **关键日志（以实现为准）：** `CANCEL.start`、`CANCEL.done{revision}`、`CANCEL.end_fallback_used{fallbackMs}`（若触发补充 END）、`STREAM|end{final:true}`。
  * **验收标准：**
      * UI 立即停止流式渲染，显示取消块，取消按钮消失。
      * DB 中消息状态为 `error`，包含取消块。
      * 日志序列符合预期。
      * Provider 侧不再有新的 STREAM 帧发出。
  * **常见偏差：** 取消后仍有文本继续流出；`MESSAGE_EDITED` 提交的取消状态被后续的 STREAM 帧覆盖。

### 4.3 屏障等待期取消 (DRAIN/ACK 期间)

  * **阶段特性：** `stop=tool_use` 触发屏障，TP 等待 UI 确认所有 STREAM 帧已消费 (`DRAIN_ACK`)，才进入纯 ME 阶段。
  * **ACE 应用：**
    1.  **A - Abort：**
          * TP 设置 `state.isCancelled=true`，记录 `revFence` 和 `sseqFence`。
          * 取消信号会立即中断 TP 对 `STREAM.DRAIN_ACK` 的等待（`drainWaiters` 中的 `resolve` 和 `timer` 会被清理）。
    2.  **C - Commit：**
          * TP 在内存中更新消息内容，添加取消块，并将消息顶层 `status` 置为 `'error'`。
          * 调用 `messageManager.editMessageSilently()` 持久化。
          * 发送 `CONVERSATION_EVENTS.MESSAGE_EDITED { messageId, revision }` 通知 UI 读取最新的最终状态。
    3.  **E - End：**
          * TP 立即发送 `STREAM.END { eventId, final: true }`，确保 UI 清理。
          * TP 侧清理 `pendingContinuation`, `continuationInProgress` 和 `generatingMessages` 中与该消息相关的状态。
  * **时序图：**
    ```mermaid
    sequenceDiagram
      autonumber
      participant UI
      participant TP
      participant DB

      TP->>UI: STREAM.DRAIN { eventId, sseqLast }
      note over UI, TP: TP 等待 DRAIN_ACK (或超时)

      UI-->>TP: 取消
      note right of TP: 1. A - Abort
      TP-->>TP: 设置 state.isCancelled=true, 记录 revFence, sseqFence
      TP-->>TP: 立即终止 ACK 等待 (清理 drainWaiters)
      
      note right of TP: 2. C - Commit
      TP->>DB: editMessageSilently(添加取消块, status='error')
      TP-->>UI: MESSAGE_EDITED { messageId, revision }
      
      note right of TP: 3. E - End
      TP->>UI: STREAM.END { eventId, final=true }
      TP-->>TP: 清理 pendingContinuation, continuationInProgress, generatingMessages
    ```
  * **关键日志（以实现为准）：** `BARRIER.sent`、`CANCEL.start`、`BARRIER.cancelled`、`CANCEL.done{revision}`、`STREAM|end{final:true}`。
  * **验收标准：**
      * 取消信号立即生效，无需等待 `barrierAckTimeoutMs`。
      * UI 显示取消块，消息状态为 `error`。
      * 日志中包含 `BARRIER.cancelled` 记录。
  * **常见偏差：** 取消后，TP 仍然等待屏障超时，导致取消响应延迟。

### 4.4 授权期 (pending 权限) 取消

  * **阶段特性：** 屏障之后，纯 ME 阶段。UI 显示 `pending` 权限块，等待用户交互。TP 已发送 `END(final=true)`，UI 已解除“生成中”。
  * **ACE 应用：**
    1.  **A - Abort：**
          * TP 设置 `state.isCancelled=true`，记录 `revFence`。
          * 此阶段无活动的数据源或流，此步主要为空操作。
    2.  **C - Commit：**
          * TP 在内存中更新消息内容，添加取消块，并将消息顶层 `status` 置为 `'error'`。
          * 调用 `messageManager.editMessageSilently()` 持久化。
          * 发送 `CONVERSATION_EVENTS.MESSAGE_EDITED { messageId, revision }` 通知 UI。UI (`MessageBlockPermissionRequest.vue`) 必须根据消息的 `status='error'` 禁用权限块交互。
    3.  **E - End：**
          * TP 发送 `STREAM.END { eventId, final: true }` 清理 UI（确保 `generatingThreadIds` 被清理）。
          * TP 侧清理 `generatingMessages` 中与该消息相关的状态。
  * **时序图：**
    ```mermaid
    sequenceDiagram
      autonumber
      participant UI
      participant TP
      participant DB

      TP-->>UI: 显示权限块 (pending), MESSAGE_EDITED 已提交
      
      UI-->>TP: 取消
      note right of TP: 1. A - Abort
      TP-->>TP: 设置 state.isCancelled=true, 记录 revFence (无活动数据源，空操作)
      
      note right of TP: 2. C - Commit
      TP->>DB: editMessageSilently(写入取消块, status='error')
      TP-->>UI: MESSAGE_EDITED { messageId, revision }
      
      note right of TP: 3. E - End
      TP->>UI: STREAM.END { eventId, final=true }
      TP-->>TP: 清理 generatingMessages
    ```
  * **关键日志（以实现为准）：** `CANCEL.start`、`CANCEL.done{revision}`、`STREAM|end{final:true}`。
  * **验收标准：**
      * UI 权限块立即被禁用，显示取消块。
      * 不会进入工具执行阶段。
  * **常见偏差：** 取消后，UI 权限块仍然可以交互；意外进入工具执行。

### 4.5 X (执行) 期取消

  * **阶段特性：** 纯 ME 阶段。TP (`executeGrantedToolsAndContinue`) 正在串行执行已授权的工具。
  * **ACE 应用：**
    1.  **A - Abort：**
          * TP 设置 `state.isCancelled=true`，记录 `revFence`。
          * TP 尽力向 `ToolManager` 发出工具中止指令（`ToolExec.cancel(toolId)`) (增强项，当前未实现)。
          * TP 立即终止后续工具的调度和执行（`isCancelled` 标志会在 `executeGrantedToolsAndContinue` 的循环中被检查）。
    2.  **C - Commit：**
          * TP 在内存中更新消息内容，添加取消块，并将消息顶层 `status` 置为 `'error'`。
          * 为所有**未完成**（正在运行但被中止，或计划中但未开始）的工具调用写入统一的错误占位符（`{ ok:false, error:'user_cancelled', message:'用户已取消本轮生成。', partial:true/false }`），并带上各自的 `tool_call_id`。
          * 调用 `messageManager.editMessageSilently()` 持久化。
          * 发送 `CONVERSATION_EVENTS.MESSAGE_EDITED { messageId, revision }` 通知 UI。
    3.  **E - End：**
          * TP 发送 `STREAM.END { eventId, final: true }` 清理 UI。
          * TP 侧清理 `pendingContinuation`, `continuationInProgress` 和 `generatingMessages` 中与该消息相关的状态。
  * **时序图：**
    ```mermaid
    sequenceDiagram
      autonumber
      participant UI
      participant TP
      participant ToolMgr
      participant DB

      TP->>ToolMgr: 执行 granted 工具 (call_A)
      
      UI-->>TP: 取消
      note right of TP: 1. A - Abort
      TP-->>TP: 设置 state.isCancelled=true, 记录 revFence
      TP->>ToolMgr: cancel(call_A) (尽力中止)
      TP-->>TP: 终止后续工具 (call_B, call_C) 执行调度
      
      note right of TP: 2. C - Commit
      TP->>DB: editMessageSilently(为 call_A/B/C 写入错误占位, 添加取消块, status='error')
      TP-->>UI: MESSAGE_EDITED { messageId, revision }
      
      note right of TP: 3. E - End
      TP->>UI: STREAM.END { eventId, final=true }
      TP-->>TP: 清理 pendingContinuation, continuationInProgress, generatingMessages
    ```
  * **关键日志（以实现为准）：** `CANCEL.start`、`CANCEL.done{revision, placeholdersWritten:N}`、`STREAM|end{final:true}`。
  * **验收标准：**
      * 所有未完成的工具调用（包括正在运行和尚未开始的）都应在 UI 上显示为取消错误。
      * DB 中记录了错误占位符和取消块。
      * 不会进入 R2 继续作答。
  * **常见偏差：** 工具实际执行完成，结果覆盖了取消占位（`cancel.toolResultDiscard` 标志应阻止此行为）；未对所有未完成工具写入占位。

### 4.6 R2/S2 阶段取消

  * **阶段特性：** 屏障和执行结束后，Agent 再次进入 LLM 交互循环，可能再次进入 STREAM 阶段 (S2) 或执行阶段 (X2)。
  * **ACE 应用：**
      * **R2 (提交前)：** 行为与 R‑prepare 阶段类似，但通常不涉及搜索。直接 Abort → Commit → End。
      * **S2 (STREAM 中)：** 行为与 S (STREAM) 阶段完全相同。
      * **X2 (执行中)：** 行为与 X (执行) 阶段完全相同。
  * **时序图：** (此处以 S2 为例，与 S 阶段取消图相同，仅起始点略有不同)
    ```mermaid
    sequenceDiagram
      autonumber
      participant User
      participant UI
      participant TP
      participant Provider
      participant DB

      TP-->>Provider: 继续生成 (R2/S2)
      Provider-->>TP: STREAM.RESPONSE (提示层)
      TP-->>UI: STREAM.RESPONSE (UI Hints)

      User-->>TP: 取消
      note right of TP: 行为与 S (STREAM) 阶段取消相同
      TP-->>TP: 设置 state.isCancelled=true, 记录 revFence, sseqFence
      TP->>Provider: stopStream(eventId)
      TP->>DB: editMessageSilently(添加取消块, status='error', 并处理内容块状态)
      TP-->>UI: MESSAGE_EDITED { messageId, revision }
      alt Provider 及时响应
          Provider-->>TP: STREAM.END
          TP->>UI: STREAM.END { eventId, final=true }
      else 超时 (cancel.endFallbackMs)
          TP->>UI: STREAM.END { eventId, final=true } (TP 主动发送)
      end
      TP-->>TP: 清理 generatingMessages
    ```
  * **验收标准：** 确保取消逻辑在循环的各个迭代中保持一致性。

---

## 5. 取消后重新进入会话 (新 Turn)

  * **目的：** 明确取消操作不会影响后续独立会话的正常启动。
  * **流程：**
    1.  当前 Turn 的取消流程通过 `STREAM.END { final: true }` 完全结束后，UI (`chat.ts`) 清理 `generatingThreadIds`，返回到空闲状态，取消按钮消失。
    2.  用户发送新消息，将触发一个**全新的 Turn**。这意味着所有与上一个 Turn 相关的取消标志 (`isCancelled` 等) 都已被重置或清除（因为 `generatingMessages` 中对应的 state 已被删除）。
    3.  系统将按照正常的 Agent 核心工作流开始处理新消息。
  * **时序图：**
    ```mermaid
    sequenceDiagram
      autonumber
      participant User
      participant UI
      participant TP
      participant Provider

      TP-->>UI: 上一个 Turn 取消完成 (UI 处于空闲状态，取消按钮隐藏)
      
      User->>UI: 发送新消息
      UI->>TP: startStreamCompletion()
      note right of TP: 开启一个全新的 Turn，所有取消状态已重置
      TP->>Provider: 开启新流
      Provider-->>TP: 正常流程
    ```
  * **指导原则：** 确保取消操作的清理工作（E - End）足够彻底，不会将状态影响到下一个独立的 Turn 中，导致不可预测的行为。实现中在 `END(final=true)` 后会移除生成缓存与工作状态标志。

---

## 6. 通用验收清单与故障排查

### 6.1 通用验收清单

  * **UI 表现：**
      * 取消按钮在 `generatingThreadIds` 为真时显示，取消后立即消失。
      * UI 立即停止流式渲染/进度显示，显示取消块。
      * 取消块标题使用 `common.error.userCanceledTitle` (如果配置)。
      * 消息顶层显示为 `error` 状态。
      * `pending` 状态的权限块在取消后被禁用，无法交互。
  * **日志验证（以实现为准）：**
      * **审计日志 (`logs/audit/<eventId>.jsonl`)：**
          * `CANCEL.start { eventId }`：取消开始。
          * `CANCEL.done { eventId, revision }`：提交最终状态完成。
          * `CANCEL.end_fallback_used { fallbackMs }`：S 期未及时收到 Provider END 时触发（使用了补充 END）。
          * `BARRIER.sent/ack/timeout/gate_on/gate_off`：屏障链路打点；屏障期取消含 `BARRIER.cancelled`。
          * `STREAM|end { final:true }`：技术清层事件。
      * **IO 聚合日志 (`logs/io/<eventId>.json`)：** 出现本相位响应记录，`status` 为 `aborted`，确保取消后不再有新的 `ok` 响应。
  * **DB 验证：**
      * 消息在 DB 中状态为 `error`。
      * `content` 包含 `common.error.userCanceledGeneration` 块。
      * X 期取消时，已存在的工具调用块包含 `user_cancelled` 的错误占位符（计划中的调用当前不写入占位符）。
  * **不变量检查：** 核对第 2 节列出的 5 个不变量是否全部满足。

### 6.2 常见偏差与反模式 (故障排查)

  * **UI 在 `MESSAGE_EDITED` 后仍被 STREAM 覆盖：**
      * **定位：** 检查 UI (`chat.ts`) 的 `mergeAssistantMessage` 逻辑是否严格遵守 `revision` 递增。确认 `sseqFence` (即 `drainFenceSseqLast`) 是否在 `handleStreamResponse` 中生效，阻止了晚到帧。
  * **屏障后仍有流帧渲染：**
      * **定位：** 检查 `drainFenceSseqLast` 是否正确设置；检查 TP 侧的 `sendStreamResponse` 逻辑是否在 `submitWindow` (屏障期) 生效。
  * **取消后仍然继续推进到执行/R2：**
      * **定位：** 检查 TP 侧的 `isCancelled` 标志是否被正确传递和检查，并确保在 `executeGrantedToolsAndContinue` 和 `continueAfterAllDenied` 的入口处有检查此标志的保护机制。
  * **在 STREAM 中写入取消“最终状态”：**
      * **定位：** STREAM 仅作提示，不应直接修改消息内容。最终状态必须经由 `MESSAGE_EDITED` 提交。
  * **ACK 竞争与超时：**
      * **定位：** 屏障期取消会立即中断对 `DRAIN_ACK` 的等待 (通过清理 `drainWaiters`)，并记录 `BARRIER.cancelled`。
  * **取消后权限块仍可交互：**
      * **定位：** UI 侧 (`MessageBlockPermissionRequest.vue`) 应根据消息的顶层 `messageStatus === 'error'` 禁用权限交互。
  * **工具取消占位符缺失或不准确：**
      * **定位：** 检查 `stopMessageGeneration` 中 C (Commit) 阶段的逻辑，确保为所有未完成工具调用块写入了正确的错误占位符和 `tool_call_id`。

---

## 7. 代码参考

  * **核心取消逻辑：** `src/main/presenter/threadPresenter/index.ts` (特别是 `stopMessageGeneration` 函数及其调用的内部方法，如 `flushAdaptiveBuffer`, `cleanupContentBuffer`, `handleLLMAgentEnd` 的跳过逻辑)
  * **日志打点：** `src/main/logger/audit.ts` (查找 `CANCEL.*`、`BARRIER.*`、`STREAM|end` 等)
  * **UI 状态清理：** `src/renderer/src/stores/chat.ts` (在 `handleStreamEnd` 中清理 `generatingThreadIds` 等)
  * **取消块 UI：** `src/renderer/src/components/message/MessageBlockError.vue` (渲染取消块)
  * **取消按钮 UI：** `src/renderer/src/components/message/MessageList.vue` (控制取消按钮显示)
  * **配置来源：** 通过 `ConfigPresenter` 设置项读取（`cancel.endFallbackMs`、`cancel.shortCircuitOnUserStop`、`cancel.toolResultDiscard`、`cancel.barrierAckTimeoutMs`）。默认值定义于 `threadPresenter`。
  * **搜索中止：** `src/main/presenter/threadPresenter/searchManager.ts`
  * **Provider 中止：** `src/main/presenter/llmProviderPresenter/index.ts` (`stopStream`)

---

## 8. 配置项（以实现为准）

  - `cancel.endFallbackMs`（默认 300）：S 期取消后，若 Provider 未在该超时内产出 END，则由 TP 发送补充 END。
  - `cancel.shortCircuitOnUserStop`（默认 true）：`handleLLMAgentEnd()` 检测 `userStop && state.isCancelled` 时跳过 finalize (最终处理)，直接 `END(final=true)` 清层。
  - `cancel.toolResultDiscard`（默认 true）：取消后丢弃后到工具结果（由 `executeGrantedToolsAndContinue` 循环中的 `isCancelled` 标志检查）。
  - `cancel.barrierAckTimeoutMs`（默认 300）：屏障期 `DRAIN_ACK` 等待超时时间。
  - 说明：`cancel.emitTechnicalEndOnRPrepare` 尚未实现为独立开关（当前 R-prepare 取消路径会发送技术性 END）。

---

## 9. 增强项与后续工作

  - **X 期“计划中但未显示”的工具调用统一占位：** 为 planned 但未执行/未显示为界面块的调用写入 `{ ok:false, error:'user_cancelled' }` 占位，以便审计与 UI 统一处理。（当前仅为已显示的 loading 块写入占位）
  - **工具级中止：** 为工具执行（`mcpPresenter.callTool`）注入 `AbortSignal` 并对接取消，以缩短等待与资源占用。
  - **统一日志链路：** 确保所有取消路径（包括 R-prepare）都能在审计日志中清晰体现其 ACE 步骤，特别是 `CANCEL.start` -> `CANCEL.done` -> `STREAM|end{final:true}` 的完整链路。
