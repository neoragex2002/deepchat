# 日志规范：审计与 IO

**文档状态：** 当前稳定 (截至 Step 4 完成)

**核心目标：** 在 DeepChat Agent “工具调用收集 → 授权总闸 → 统一执行 → 模型继续作答”的新范式下，建立一套稳定、清晰、低噪且可审计的日志体系，为问题排查、性能分析和系统回放提供坚实的数据基础。

---

## 1. 摘要与核心理念

随着 DeepChat Agent 工作流的日益复杂，我们需要一个强大的可观测性系统来理解其内部的“思考”与“行动”。为此，我们设计了一套**双轨日志系统**，将高信噪比的**审计日志 (Audit Log)** 与高信息密度的**IO 日志 (IO Log)** 分离，以满足不同场景下的分析需求。

#### **核心理念**

*   **审计日志 (Audit Log) - 飞行记录仪 (Flight Recorder)**
    *   **使命：** 记录 Agent 工作流中的**关键决策、状态转换和性能指标**。
    *   **特点：** 轻量、高信噪比、结构化、人类可读。它描绘了从用户请求到最终响应的**因果链**。
    *   **用途：** 快速复盘流程、排查逻辑错误、分析性能瓶颈。**这是 90% 的日常问题排查的首选。**

*   **IO 日志 (IO Log) - 驾驶舱语音/数据记录仪 (Cockpit Data Recorder)**
    *   **使命：** 完整记录 Agent 与外部世界（LLM、工具）的**原始输入/输出**。
    *   **特点：** 详尽、原始、包含大量载荷（payload）。它提供了事件发生时的**完整现场快照**。
    *   **用途：** 深度调试、模型行为分析、系统精确回放、以及在审计日志无法定位问题时的最终手段。

---

## 2. 统一结构与日志位置

#### **2.1. 日志位置**

所有日志均按 `eventId`（即助手消息的 `messageId`）进行归档，确保一次 Agent 交互的所有相关日志都集中存放。

| 日志类型 | 路径 | 格式 | 描述 |
| :--- | :--- | :--- | :--- |
| **审计日志** | `logs/audit/<eventId>.jsonl` | JSONL | 权威流程摘要，一行一条 JSON 记录。 |
| **IO 聚合日志** | `logs/io/<eventId>.json` | JSON Array | 聚合的 LLM/工具 I/O 摘要，便于一次性回放。 |
| **IO 详情日志** | `logs/io-detail/<eventId>.jsonl` | JSONL | 逐行的原始 I/O 细节，如 SSE 帧（需开关启用 `LOG_IO_DETAIL=true`）。 |

#### **2.2. 通用字段**

所有日志记录（无论类型）都必须包含以下两个通用字段，以提供基础的时间和事件上下文：

*   `ts`: `number` - 毫秒级时间戳 (`Date.now()`)。
*   `eventId`: `string` - 本轮事件 ID，即助手消息的 `messageId`，全链路唯一主键。

---

## 3. 审计日志 (Audit Log) 规范

审计日志是理解 Agent 行为逻辑的主线。

### 3.1. 审计日志结构

除通用字段外，每条审计日志包含：

*   `kind`: `string` - 日志类别的领域（见下方矩阵）。
*   `action`: `string` - 该领域下的具体动作（见下方矩阵）。
*   `...rest`: `object` - 与该 `action` 相关的、轻量级的附加上下文信息。

### 3.2. 类别与动作矩阵 (Kind & Action Matrix)

| Kind | 职责 | Actions |
| :--- | :--- | :--- |
| **STREAM** | **流式生成阶段管理** | `start`, `end`, `error`, `iteration` |
| **BARRIER** | **同步屏障管理 (stop=tool_use 后)** | `sent`, `ack`, `timeout`, `gate_on`, `gate_off`, `cancelled` |
| **ME** | **权威提交 (Message Edited)** | `emit`, `finalize` |
| **PERM** | **授权全生命周期** | `plan`, `inject`, `user_action`, `persist`, `status`, `decide`, `denied` |
| **EXEC** | **工具执行与继续作答** | `tool_start`, `tool_result`, `tool_error`, `continue_start`, `continue_state`, `continue_end`, `context_mode`, `context_pick`, `budget`, `supports_fc`, `context_summary` |
| **LIMIT** | **工具调用限流** | `soft_degrade`, `hard_cut` |
| **SEARCH** | **R-prepare 搜索迷你阶段** | `begin`, `rewrite_scope`, `rewrite_result`, `reading`, `success`, `error`, `attachment_saved`, `gate`, `gate_decision` |
| **CANCEL** | **统一取消 (ACE) 流程** | `start`, `done`, `end_fallback_used` |
| **PROVIDER** | **底层 LLM Provider 状态** | `stop_reason`, `usage_agg`, `error` |
| **UI** | **渲染端关键镜像事件** | `drain_ack`, `fence_set`, `fence_cleared`, `downgrade_drop` |

*注：详细的 `action` 及其携带的字段见附录 A。*

### 3.3. 控制台输出 (Console Output)

为了在开发和调试时提供简洁的实时反馈，审计日志也支持控制台输出摘要。

*   **样式：** `AUD|<kind>|<action> ev=<eventId> k=v k=v ...`
    *   短键映射（如 `sseqLast→sseq`, `waitedMs→wait`, `durationMs→ms`）
    *   布尔值压缩（`true→1`, `false→0`）
    *   长字符串截断（>60 字符以 `…` 省略）
    *   数组打印为 `[len]`；对象打印为 `{id:xxxx}` 或 `{name:xxxx}` 或 `{…}`
*   **目的：** 与历史风格区分，节省 token，便于 `grep` ；落盘 JSONL 保持全量详细不变。
*   **关闭：** 可通过配置 `LOG_AUDIT_CONSOLE='off'` 完全关闭控制台摘要。

**示例：**
*   `AUD|BARRIER|ack ev=93... sseq=42 wait=32`
*   `AUD|EXEC|tool_result ev=93... tc=call_bFK ok=1 ms=95`
*   `AUD|SEARCH|rewrite_result ev=93... qry=天气 北京 明天... no=0`

### 3.4. 关键场景解读

通过串联审计日志，我们可以清晰地复盘 Agent 的行为。

**场景：一次成功的工具调用**

1.  **`STREAM.start`**: Agent 开始流式生成。
2.  **`PROVIDER.stop_reason`** (`reason: "tool_use"`): LLM 决定使用工具，S 阶段结束。
3.  **`BARRIER.gate_on`**: 系统进入同步屏障，准备隔离 STREAM 和 ME。
4.  **`BARRIER.sent`**: 向 UI 发送 `DRAIN` 信号，要求排干流式渲染队列。
5.  **`UI.drain_ack`** 或 **`BARRIER.ack`**: UI 确认渲染完毕，屏障解除。
6.  **`PERM.plan`**: 系统规划出需要授权的工具。
7.  **`PERM.user_action`** (`decision: "grant"`): 用户批准了工具的执行。
8.  **`EXEC.tool_start`**: 工具开始执行。
9.  **`EXEC.tool_result`** (`ok: true`): 工具成功执行完毕。
10. **`ME.emit`**: 将工具结果作为权威状态提交。
11. **`EXEC.continue_start`**: 启动 R2 阶段，让模型继续作答。
12. **`STREAM.end`** (`final: true`): R2 阶段结束，整个 Agent 交互轮次完成。
13. **`BARRIER.gate_off`**: 关闭屏障门控。

---

## 4. IO 日志 (IO Log) 规范

IO 日志是进行深度调试和精确回放的基石。

### 4.1. IO 日志结构与类型

IO 日志通过 `type` 字段来区分不同的记录类型。

| Type | 职责 |
| :--- | :--- |
| `llm_request` | LLM API 请求的完整内容。 |
| `llm_sse_frame` | LLM API 响应的每一帧 SSE 数据（仅详情模式）。 |
| `llm_final_text` | LLM 最终生成的完整文本。 |
| `llm_stop_reason` | LLM 停止生成的原因。 |
| `llm_usage_agg` | LLM token 使用量。 |
| `tool_definitions` | 提供给 LLM 的完整工具定义（仅详情模式）。 |
| `tool_request` | 调用工具时的完整入参。 |
| `tool_response` | 工具返回的完整出参（包括原始和结构化内容）。 |
| `tool_exec` | 工具执行的聚合摘要。 |

### 4.2. 聚合与详情模式

*   **IO 聚合 (`logs/io/<eventId>.json`)**
    *   **结构：** JSON 数组，每个元素代表一次相位/阶段（如 LLM 请求响应、工具执行）。
    *   **LLM 聚合：** 每个 LLM 请求响应相位包含 `phaseIndex`, `request` (meta, body), `response` (meta, status, reconstructed, error?, planned_tool_calls?)。
        *   `reconstructed`: 包含模型重构的助手消息 (`role:'assistant'`, `content`, `tool_calls[]`, `stop_reason?`, `usage?`)。
        *   `sseRaw`/`frames` 仅在 `LOG_IO_DETAIL=true` 时写入。
    *   **工具执行聚合：** 追加元素 `{ type:'tool_exec', ok:boolean, meta:{ tool_call_id, server, tool, timestamp } }`。成功与失败路径均写一条。

*   **IO 详情 (`logs/io-detail/<eventId>.jsonl`)**
    *   当 `LOG_IO_DETAIL=true` 时启用，逐行记录最细粒度的 I/O 信息。
    *   **LLM 详情：**
        *   `llm_iteration` { phase:'begin'|'end' }
        *   `llm_request` { provider, model, messageCount }
        *   `llm_sse_frame` { frame }
        *   `llm_usage_agg` { prompt_tokens, completion_tokens, total_tokens, context_length }
        *   `llm_stop_reason` { reason }
        *   `llm_final_text` { text }
    *   **工具详情：**
        *   `tool_definitions` { tools:[…] } // 原始工具定义
        *   `tool_request` { tool_call_id, tool, server, arguments }
        *   `tool_response` { tool_call_id, ok, content, structured }

*   **脱敏/截断：** 暂不启用（仅用于开发调试）。

---

## 5. 配置与控制

以下开关位于 `src/main/logger/config.ts`，用于控制日志系统的行为：

*   `LOG_AUDIT = true`: **[默认开启]** 是否记录审计日志。
*   `LOG_AUDIT_CONSOLE = 'summary'`: **[默认摘要]** 控制台输出审计日志的级别。可选值为 `'summary'` (极简摘要), `'off'` (关闭)。
*   `LOG_IO = true`: **[默认开启]** 是否记录 IO 聚合日志。
*   `LOG_IO_DETAIL = false`: **[默认关闭]** 是否记录 IO 详情日志（包含 SSE 帧）。**注意：开启此项会产生大量日志，仅在需要深度调试时启用。**

**清理与替换：**
*   移除 `DEBUG.TP_AUDIT_LOG`（由 `LOG_AUDIT`/`LOG_AUDIT_CONSOLE` 取代）。
*   移除 `DEBUG_ROLLBACK_MIN`（UI 降级丢弃统一纳入审计 `UI.downgrade_drop`）。
*   合并 `DEBUG_STEP_LOG` / `DEBUG_LLM_IO_LOG` / `DEBUG_LLM_IO_DETAIL` / `DEBUG_TOOL_IO_LOG` 到上述 4 个总开关。

---

## 6. 实施指南与最佳实践

*   **写盘职责：** 日志的写盘操作应由主进程统一负责，以避免多进程并发写入导致的文件损坏。渲染层的 UI 事件应以轻量级消息回传主进程后落盘。
*   **冗余控制：**
    *   大型载荷（payload）一律进入 IO 日志；审计日志仅记录摘要和关键标识。
    *   同义信息不重复记录。例如，`final: true` 仅在 `STREAM.end` 中出现一次。
    *   `gate_on/gate_off` 单阶段首尾各一次；`iteration` 仅低频起止。
*   **目录切换：** 即日起统一使用 `logs/audit` 与 `logs/io`；旧 `logs/runtime-events` 废弃。
*   **系统噪音：** 窗口焦点/快捷键注册等“系统/环境噪音”不纳入审计。
*   **代码参考：**
    *   审计落盘：`src/main/logger/audit.ts`
    *   IO 聚合：`src/main/logger/aggregate.ts`
    *   IO 详情：`src/main/logger/io.ts`
    *   Provider 相位聚合：`src/main/presenter/llmProviderPresenter/llmTrace.ts`

---

## 附录 A：审计日志动作字段说明

以下为“审计 LOG”的动作字段说明（除 `ts`、`eventId`、`kind`、`action` 通用键外）。可选字段以 `?` 标注：

*   **BARRIER** (屏障)
    *   `sent` { `sseqLast`: number }
    *   `ack` { `sseqLast`: number, `waitedMs`: number }
    *   `timeout` { `sseqLast`: number, `waitedMs`: number }
    *   `gate_on` {}
    *   `gate_off` {}
    *   `cancelled` {}

*   **STREAM** (流阶段)
    *   `start` {}
    *   `end` { `final`: boolean } // final=true 才解除“生成中”
    *   `error` { `error`: string }
    *   `iteration` { `phase`: 'begin'|'end' } // 仅保留低频起止

*   **ME** (权威提交)
    *   `emit` { `revision`: number, `s_to_submit_latency_ms`?: number } // 首发可带 s→submit 延迟
    *   `finalize` { `hasPendingPermissions`?: boolean }

*   **LIMIT** (工具调用限流)
    *   `soft_degrade` { `limit`: number, `prev`: number, `batch`: number }
    *   `hard_cut` { `limit`: number, `prev`: number, `batch`: number }

*   **PERM** (授权全生命周期)
    *   `plan` { `planned`: number }
    *   `inject` { `pending`: number, `granted`: number, `denied`: number }
    *   `user_action` { `tool_call_id`: string, `decision`: 'grant'|'deny', `permission`: 'read'|'write'|'all', `remember`?: boolean }
    *   `persist` { `scope`: 'server'|'tool'|'internal_grant', `permission`: 'read'|'write'|'all', `remember`?: boolean, `server`?: string, `tool`?: string }
    *   `status` { `pending`: number, `granted`: number, `denied`: number, `error`: number }
    *   `decide` { `server`: string, `tool`: string, `required`: 'read'|'write'|'all', `decision`: 'AUTO_GRANT'|'REQUIRE_USER_PERMISSION' }
    *   `denied` (MCP 层镜像) { `server`: string, `tool`: string, `required`: 'read'|'write'|'all' }

*   **EXEC** (执行与继续)
    *   `tool_start` { `tool_call_id`: string, `server`: string, `tool`: string }
    *   `tool_result` { `tool_call_id`: string, `ok`: boolean, `durationMs`?: number }
    *   `tool_error` { `tool_call_id`: string, `error`: string }
    *   `continue_start` {}
    *   `continue_state` { `set`: boolean, `stateId`: number }
    *   `continue_end` {}
    *   `context_mode` { `mode`: 'toolcall_continue'|'msg_retry' }
    *   `context_pick` { `step`: 'begin'|'use_current'|'injected_assistant'|'final', `queryMsgId`?: string, `resolvedUserMsgId`?: string, `baseContextCount`?: number, `assistantId`?: string, `variant`?: 'main'|'variant', `injectedId`?: string, `newContextCount`?: number, `injectedAssistantAppended`?: boolean, `selectedCount`?: number }
    *   `budget` { `injectedTokens`: number, `remainingContextLength`: number, `adjustedBudget`: number }
    *   `supports_fc` { `tool_call_id`: string, `name`?: string, `paramsLength`: number, `responseLength`: number }
    *   `context_summary` { `supportsFunctionCall`: boolean, `assistantToolCalls`: string[], `toolMessages`: string[], `missingPairs`: string[], `totalMessages`: number, `promptTokens`: number }

*   **SEARCH** (R‑prepare 迷你阶段)
    *   `begin` {}
    *   `rewrite_scope` { `useBoundary`: boolean, `boundaryUserId`?: string, `contextLimit`: number }
    *   `rewrite_result` { `optimizedQuery`: string, `noSearch`: boolean }
    *   `reading` {}
    *   `success` { `total`: number }
    *   `error` { `error`: string }
    *   `attachment_saved` { `total`: number }
    *   `gate` { `contextMode`: string, `isRPrepare`: boolean, `gateAllow`: boolean, `userSearchFlag`: boolean, `willSearch`: boolean, `webSearchCfg`: boolean }
    *   `gate_decision` { `gateAllow`: boolean, `userSearchFlag`: boolean, `willSearch`: boolean }

*   **CANCEL** (ACE)
    *   `start` {}
    *   `done` { `revision`: number, `placeholdersWritten`?: number, `cancel_to_submit_latency_ms`?: number }
    *   `end_fallback_used` { `fallbackMs`: number }

*   **PROVIDER** (底层 Provider 态)
    *   `stop_reason` { `reason`: string }
    *   `usage_agg` { `prompt_tokens`: number, `completion_tokens`: number, `total_tokens`: number, `context_length`: number }
    *   `error` { `error`: string }

*   **UI** (渲染端镜像)
    *   `drain_ack` { `sseqLast`: number }
    *   `fence_set` { `sseqLast`: number }
    *   `fence_cleared` {}
    *   `downgrade_drop` { `block`: 'tool'|'perm', `from`: string|number, `to`: string|number }