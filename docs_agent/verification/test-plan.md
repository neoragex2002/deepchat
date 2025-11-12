# **验证与测试计划 (Verification & Test Plan)**

**受众：** QA 工程师, 开发者

**目的：** 本文档提供一套完整的、可执行的测试用例集，旨在系统性地验证 DeepChat Agent 在 Step 0-4 重构后，其核心架构原则（SSoT、阶段性同步、ACE 取消、L1/L2 安全）和关键工作流程（同步屏障、限流、取消、搜索、权限处理）的正确性、鲁棒性和一致性。

**核心验证原则：**
*   **单一真理来源 (SSoT)：** 验证 UI 的最终内容和状态**仅由** `MESSAGE_EDITED` 事件驱动，`STREAM` 事件只作为临时提示，绝不覆盖权威状态。
*   **阶段性同步 (Phased Synchronization)：** 验证 `stop=tool_use` 同步屏障 (`BARRIER.sent/ack`) 能有效隔离 S 阶段（流式提示）和纯 ME 阶段（权威提交），杜绝乱序和状态回退。
*   **日志可观测性：** 验证所有关键流程节点都在 `logs/audit` 和 `logs/io` 中留下了清晰、准确、可供排查的记录。
*   **id-only 配对：** 验证所有工具调用、权限块和执行结果均通过 `tool_call_id` 进行唯一且原子性的配对，避免名称/邻近匹配导致的错乱。

---

### **1. 环境与准备 (Environment & Preparation)**

*   **运行命令：** `pnpm dev` (开发模式) 或 `pnpm start` (预览模式)。
*   **日志路径：**
    *   **审计日志：** `logs/audit/<eventId>.jsonl` (记录关键流程与决策节点)。
    *   **IO 日志 (聚合)：** `logs/io/<eventId>.json` (记录 LLM/工具的原始 I/O 细节，数组结构，每个元素代表一个 Step/Phase)。
    *   **IO 日志 (详情)：** `logs/io-detail/<eventId>.jsonl` (逐行详情，需开启 `LOG_IO_DETAIL=true`，记录 SSE 帧、工具定义原文等，用于深度调试)。
*   **默认 Agent 策略：**
    *   **工具调用限流：** `mode: 'soft_degrade'`, `max: 2` (在一次请求中，允许最多2个工具调用被规划)。
    *   **权限决策：**
        *   `Inspect`: `AUTOGRANT`
        *   `Read`: `CONFIRM` (需手动点击允许)
        *   `Write`: `CONFIRM` (需手动点击允许)
        *   `Network`: `AUTODENY` (默认完全禁网)
*   **前置操作：**
    *   建议在开始测试前，清理 `logs/` 目录以避免干扰。
    *   为确保权限场景可复现，建议在 MCP 设置中清除所有针对 `shell` 工具的“记住授权”配置。
    *   确保 `wsl` 环境已安装，且 `deepchat` 项目路径在 WSL 中可访问 (例如 `/mnt/c/dev/deepchat`)。

---

### **2. 快速勾检清单 (Smoke Test)**

*   **用例 ID：** `TC-SMOKE-01`
*   **目的：** 快速验证一次包含并行工具调用的端到端“快乐路径”，确保核心流程（Collect-Only → 屏障 → 权限 → 执行 → R2）畅通。
*   **操作步骤：**
    1.  启动应用。
    2.  发送以下 Prompt：
        ```
        你用shell工具，在wsl的/mnt/c/dev/deepchat下写2个文件：
        1、文件名为smoke-1.txt, 内容是File 1 content
        2、文件名为smoke-2.txt, 内容是File 2 content
        注意必须使用“wsl bash -lc …”形式，并在一次请求里发起2次独立工具调用。
        ```
    3.  在 UI 弹出的两个权限请求块上，均点击“允许”（Allow）。
*   **预期结果：**
    *   **UI 表现：**
        1.  模型思考并流式输出文本（例如“我来创建文件...”）。
        2.  流结束后，UI 出现两个独立的“写权限”请求块，每个块都有明确的 `tool_call_id`。
        3.  点击“允许”后，两个工具块依次显示“执行中”状态，最终都显示成功。
        4.  模型继续作答（R2），输出确认性文本（例如“文件已成功创建”）。
    *   **关键审计日志 (`logs/audit/<eventId>.jsonl`) 序列及内容：**
        1.  `STREAM.start{}`
        2.  `PROVIDER.stop_reason{reason:'tool_use'}`
        3.  `BARRIER.sent{sseqLast: <N>}`
        4.  `BARRIER.ack{sseqLast: <N>, waitedMs: <M>}` (或 `BARRIER.timeout`)
        5.  `BARRIER.gate_on{}`
        6.  `PERM.plan{planned:2}`
        7.  `PERM.user_action{tool_call_id: 'call_id_1', decision:'grant', permission:'write'}` (两次，对应两个 tool_call_id)
        8.  `EXEC.tool_start{tool_call_id: 'call_id_1', ...}`
        9.  `EXEC.tool_result{tool_call_id: 'call_id_1', ok:true, durationMs: <D>}`
        10. `EXEC.tool_start{tool_call_id: 'call_id_2', ...}`
        11. `EXEC.tool_result{tool_call_id: 'call_id_2', ok:true, durationMs: <D>}`
        12. `ME.emit{revision:<R>}` (多次，对应权限块注入、权限状态更新、工具结果写回)
        13. `EXEC.continue_start{}`
        14. `BARRIER.gate_off{}`
        15. `STREAM.end{final:true}`
    *   **关键 IO 日志 (`logs/io/<eventId>.json`)：**
        1.  第一个相位的 `response.planned_tool_calls` 数组长度为 2，包含两个工具调用的 `id`, `name`, `arguments`。
        2.  日志末尾包含两个 `type:'tool_exec', ok:true` 的条目，其 `tool_call_id` 与 `PERM.user_action` 中的 `tool_call_id` 严格对应。

---

### **3. 核心功能验证用例 (Core Functionality Test Cases)**

#### **3.1. 无工具流 (S-Only) - `TC-CORE-01`**
*   **验证原则：** SSoT, Phased Sync, 日志可观测性。
*   **目的：** 验证最简单的文本生成流程，确保无工具调用时不触发任何与工具相关的复杂机制。
*   **操作步骤：** 发送一个简单问候，如“你好，请问你是谁？”。
*   **预期结果：**
    *   **UI：** 模型直接流式输出回答，结束后“生成中”状态消失。无任何权限块、工具块、搜索块。
    *   **审计日志：** 仅包含 `STREAM.start` 和 `STREAM.end{final:true}`。**绝不应**包含任何 `BARRIER`, `PERM`, `EXEC`, `LIMIT`, `SEARCH`, `CANCEL` 相关日志。
    *   **IO 日志：** `response.stop_reason` 为 `complete` 或 `end_turn`，`planned_tool_calls` 数组为空或不存在。

#### **3.2. 普通工具流 (Tool Use Flow) - `TC-CORE-02`**
*   **验证原则：** SSoT, Phased Sync, id-only 配对, Provider Collect-Only, TP Authority。
*   **目的：** 验证读写类型工具的端到端流程，包括屏障、权限注入、执行和 R2。
*   **操作步骤：**
    1.  **读文件：** 发送 Prompt：“请在 wsl 下打印 `/mnt/c/dev/deepchat/status.md` 的全文”（要求使用 `wsl bash -lc` 形式）。在权限请求上点击“允许”。
    2.  **写文件：** 发送 Prompt：“请在 wsl 的 `/mnt/c/dev/deepchat` 下创建 `temp.md` 文件，内容为 `hello, DeepChat Agent`”（要求使用 `wsl bash -lc` 形式）。在权限请求上点击“允许”。
*   **预期结果：**
    *   **UI：**
        1.  **读文件：** END 后注入一个 `read` 权限块。点击允许后，工具块显示成功，并输出 `status.md` 的内容。R2 输出总结。
        2.  **写文件：** END 后注入一个 `write` 权限块。点击允许后，工具块显示成功。R2 输出总结。
    *   **审计日志 (读文件)：** 序列与 `TC-SMOKE-01` 类似，但 `PERM.user_action` 中的 `permission` 为 `read`。`EXEC.tool_result{ok:true}`。
    *   **审计日志 (写文件)：** 序列与 `TC-SMOKE-01` 类似，但 `PERM.user_action` 中的 `permission` 为 `write`。`EXEC.tool_result{ok:true}`。
    *   **IO 日志：** 对应的 `tool_exec` 条目 `ok:true`，且 `content` 包含文件内容（读）或成功信息（写）。

#### **3.3. 权限处理场景 (Permission Handling) - `TC-PERM-01` 到 `TC-PERM-03`**
*   **验证原则：** L1 语义权限, L2 物理守护, TP Authority, SSoT。
*   **目的：** 验证 Agent 对工具权限请求的正确处理，包括用户拒绝、物理层拒绝和待授权静止状态。

*   **TC-PERM-01: 用户拒绝**
    *   **操作步骤：** 发送写文件请求，在 UI 弹出的权限块上点击“拒绝”（Deny）。
    *   **预期结果：**
        *   **UI：** 权限块状态变为 `denied`。工具块显示错误 `ok:false`，且 `error` 字段为 `permission_denied`。模型继续作答（R2）并说明因权限被拒而无法执行。
        *   **审计日志：** 包含 `PERM.user_action{tool_call_id: <ID>, decision:'deny', permission:'write'}`。**不应**包含 `EXEC.tool_start`。
        *   **IO 日志：** 包含 `type:'tool_exec', ok:false` 且 `error:'permission_denied'` 的条目。

*   **TC-PERM-02: L2 物理层拒绝 (权限不足)**
    *   **前置条件：** (模拟) 配置 `shell` 工具的 `autoApprove` 仅含 `read` 权限，或通过 L2 `AppArmor` 策略阻止 `write` 操作。
    *   **操作步骤：** 发送一个需要 `write` 权限的写文件请求。
    *   **预期结果：**
        *   **UI：** 不会弹出权限请求块（因为 L1 语义层根据 Prompt 判断为 `write`，但 `autoApprove` 策略未覆盖）。工具块直接显示执行失败，错误信息应明确指向权限不足，例如 `Permission denied`。模型在 R2 阶段解释失败原因。
        *   **审计日志：** 包含 `PERM.decide{server:'shell-server', tool:'shell', required:'write', decision:'REQUIRE_USER_PERMISSION'}` (如果 UI 允许配置) 或 `PERM.decide{decision:'AUTO_DENY'}`。`EXEC.tool_result{ok:false, error:'tool_execution_error'}`。
        *   **IO 日志：** `tool_response` 的 `structured_content` 中应包含 L2 返回的权限不足错误信息，例如 `exit_code` 非零，或 `stderr` 包含 `Permission denied`。

*   **TC-PERM-03: 待授权静止态 (Pending State)**
    *   **目的：** 验证在用户未处理权限请求时，Agent 流程会正确暂停，等待用户交互。
    *   **操作步骤：** 发送写文件请求，UI 弹出权限块后**不进行任何操作**。
    *   **预期结果：**
        *   **UI：** END 事件已发送（`STREAM.end{final:true}`），UI 解除“生成中”状态。权限块保持 `pending` 状态，可交互。**不应**进入 R2。
        *   **审计日志：** 包含 `PERM.plan{planned:1}`。**不应**包含 `EXEC.tool_start` 或 `EXEC.continue_start`。

#### **3.4. 限流策略 (Rate Limiting) - `TC-LIMIT-01` 到 `TC-LIMIT-02`**
*   **验证原则：** TP Authority, Phased Sync, SSoT。
*   **目的：** 验证最大工具调用数限制策略在 `soft_degrade` 和 `hard_cut` 模式下的行为。

*   **TC-LIMIT-01: `soft_degrade` 模式 (默认)**
    *   **操作步骤：** 确保限流模式为 `soft_degrade`，发送一个触发 ≥3 个工具调用的请求（例如，一次性创建 3 个文件）。
    *   **预期结果：**
        *   **UI：** 前 2 个工具调用正常处理并执行。从第 3 个开始，工具块直接显示错误，错误内容为 `tool_call_limit_exceeded`。模型继续作答（R2），并可能对未完成的任务进行说明。可能出现一个全局的“已达上限”提示块。
        *   **审计日志：** 包含 `LIMIT.soft_degrade{limit:2, prev:<P>, batch:3}`。`STREAM.end{final:false}` (在限流后)。
        *   **IO 日志：** 第 3 个及以后的 `tool_exec` 条目为 `ok:false`，并包含 `error:'tool_call_limit_exceeded'`。

*   **TC-LIMIT-02: `hard_cut` 模式**
    *   **前置条件：** 修改代码常量，将限流模式设置为 `hard_cut`。
    *   **操作步骤：** 发送一个触发 ≥3 个工具调用的请求。
    *   **预期结果：**
        *   **UI：** UI 显示一个全局错误块，内容为 `tool_call_limit_turn_terminated`。整个消息的状态变为 `error`。**不应**进入 R2。
        *   **审计日志：** 包含 `LIMIT.hard_cut{limit:2, prev:<P>, batch:3}`。消息状态审计为 `ME.emit{...status:'error'}`，且 `STREAM.end{final:true}`。
        *   **IO 日志：** 第 3 个及以后的 `tool_exec` 条目为 `ok:false`，并包含 `error:'tool_call_limit_turn_terminated'`。

---

### **4. 专项流程验证用例 (Specialized Workflow Test Cases)**

#### **4.1. 取消机制 (ACE) - `TC-CANCEL-01` 到 `TC-CANCEL-03`**
*   **验证原则：** ACE (Abort → Commit → End), SSoT, Phased Sync, 核心不变量。
*   **目的：** 验证 DeepChat Agent 在不同阶段的用户取消行为。

*   **TC-CANCEL-01: S 流式阶段取消**
    *   **操作步骤：** 在模型正在流式输出文本时（例如，刚开始流，Prompt 尚未完全生成），快速点击“取消”按钮。
    *   **预期结果：**
        *   **UI：** 文本流立即停止，UI 插入一个“用户已取消”的错误块。整个消息状态变为 `error`。
        *   **审计日志：** 序列为 `CANCEL.start{phase:'S', ...}` → `CANCEL.done{...}` → `STREAM.end{fallback:true}`。
        *   **IO 日志：** `response.stop_reason` 为 `user_cancelled`。

*   **TC-CANCEL-02: 屏障等待阶段取消**
    *   **操作步骤：** 触发工具调用，在 `BARRIER.sent` 日志出现后、权限块出现前，快速点击“取消”按钮。
    *   **预期结果：**
        *   **UI：** 不会再出现权限块，直接显示“用户已取消”错误块。整个消息状态变为 `error`。
        *   **审计日志：** 包含 `BARRIER.cancelled{}` 日志，后续序列同 `TC-CANCEL-01`。
        *   **IO 日志：** `response.stop_reason` 为 `user_cancelled`。

*   **TC-CANCEL-03: X (工具执行) 阶段取消**
    *   **目的：** 验证在工具执行期间取消，系统能正确处理已执行和未执行的工具。
    *   **操作步骤：** 触发两个并行工具调用（如 `TC-SMOKE-01`），在第一个工具**执行中**（UI 显示“执行中”或日志出现 `EXEC.tool_start` 但未出现 `EXEC.tool_result`）时，点击“取消”按钮。
    *   **预期结果：**
        *   **UI：** 已完成的工具显示成功，未完成的工具显示“用户已取消”错误。UI 插入一个“用户已取消”错误块。整个消息状态变为 `error`。
        *   **审计日志：** 包含 `CANCEL.start{phase:'EXEC', ...}`。未完成的工具调用对应的 `EXEC.tool_result` 记录 `ok:false, error:'user_cancelled'`。
        *   **IO 日志：** 对应的 `tool_exec` 条目显示 `ok:false, error:'user_cancelled'`。

#### **4.2. 搜索“迷你阶段” (R-prepare) - `TC-SEARCH-01`**
*   **验证原则：** SSoT, Phased Sync (ME-驱动), TP Authority。
*   **目的：** 验证搜索功能作为 R-prepare 子流程的正确性，以及其 ME-驱动的更新方式。
*   **操作步骤：**
    1.  在用户消息输入框旁，开启“搜索”开关。
    2.  发送一个需要搜索的查询，如“北京明天天气和穿搭”。
*   **预期结果：**
    *   **UI：** 出现一个搜索块，其状态依次经历 `loading → optimizing → reading → success` 的变化。每次状态变化都伴随 UI 的更新。最终模型基于搜索结果进行回答。
    *   **审计日志：** 包含 `SEARCH.begin`, `SEARCH.rewrite_scope`, `SEARCH.rewrite_result`, `SEARCH.reading`, `SEARCH.success` 等一系列 `SEARCH` 日志。**不应**包含 `BARRIER` 日志，且所有 `SEARCH` 状态更新都由 `ME.emit` 驱动。
    *   **IO 日志：** `planned_tool_calls` 数组为空或不存在。

---

### **5. 鲁棒性与边界验证 (Robustness & Edge Case Verification)**

#### **5.1. 同步屏障与围栏验证 - `TC-ROBUST-01`**
*   **验证原则：** Phased Sync, SSoT。
*   **目的：** 验证 `stop=tool_use` 后的屏障机制能有效防止 `STREAM` 帧覆盖 `ME` 提交，确保状态一致性。
*   **操作步骤：** 运行 `TC-SMOKE-01`，密切观察 UI。可在网络条件较差或系统负载高时重复。
*   **预期结果：**
    *   **UI：** 在权限块或工具结果块出现后，UI **绝不**会因任何晚到的 `STREAM` 帧而发生内容闪烁或状态回退。`MESSAGE_EDITED` 提交的内容始终是 UI 的唯一权威。
    *   **审计日志：** `BARRIER.ack` 或 `BARRIER.timeout` 必须在任何 `PERM.plan` 或 `EXEC.tool_start` 之前。所有 `ME.emit` 日志的时间戳必须在 `BARRIER.gate_on` 和 `BARRIER.gate_off` 之间。

#### **5.2. `id-only` 配对与 `revision` 护栏 - `TC-ROBUST-02`**
*   **验证原则：** id-only 配对, SSoT (revision)。
*   **目的：** 验证所有工具/权限块严格按 `tool_call_id` 配对，且 UI 仅接受更高 `revision` 的 `MESSAGE_EDITED`。
*   **操作步骤：**
    1.  **同名工具并发：** 触发两个 `shell` 工具调用（例如 `TC-SMOKE-01`），确保两个调用紧邻出现。
    2.  **乱序/回放模拟：** 触发一个读或写工具调用，模拟在 `tool_call: end` 提示态先于 `MESSAGE_EDITED` 到达（通常会短暂发生）。
*   **预期结果：**
    *   **UI：**
        1.  两个工具块的权限状态与结果分别只绑定到各自的 `tool_call_id`。**不应**出现“旧 pending 挤到新调用旁边”或状态错乱。
        2.  UI 不会出现“最终显示 pending/旧状态”的回退。`MESSAGE_EDITED` 的 `revision` 严格递增；后到的低 `revision`（若发生）被丢弃。
    *   **审计日志：** Console（渲染进程）中，`mergeAssistantMessage` **不应**再以 `name` 合并。

#### **5.3. 多窗口/多 Tab 并发 - `TC-ROBUST-03` (可选)**
*   **验证原则：** Phased Sync, SSoT, `eventId` 唯一性。
*   **目的：** 验证多窗口或多 Tab 下，Agent 流程状态的一致性和屏障 ACK 机制的正确性。
*   **操作步骤：**
    1.  打开两个浏览器窗口/Tab，均导航到同一 DeepChat 会话。
    2.  在一个窗口中触发一个工具调用，使其进入屏障等待阶段 (`BARRIER.sent` 出现)。
    3.  在**另一个窗口**中处理权限请求（点击“允许”）。
*   **预期结果：**
    *   **UI：** 两个窗口的 UI 状态保持一致，权限块和工具执行结果在两个窗口中同步更新。
    *   **审计日志：** `BARRIER.ack` 仅被第一个响应的窗口发出，TP 仅处理一次。`ME.emit` 广播至所有窗口，按 `revision` 去重合并，确保状态同步。

---

### **6. 观察点与验收标准 (Observation Points & Acceptance Criteria)**

#### **6.1. UI 行为**
*   **STREAM 仅为提示层：** Renderer 在 `tool_call end/error` 事件中**不得**设置工具块的最终态（即不应显示 `success` 或 `error`），而应保持 `loading` 或 `running` 状态。最终态**仅由** `MESSAGE_EDITED` 决定。
*   **`MESSAGE_EDITED` 为唯一权威：** UI 所有的内容更新和最终状态展示（包括权限卡、工具卡、文本内容）都必须由 `MESSAGE_EDITED` 事件驱动。
*   **id-only 绑定：** 权限卡/工具卡必须按 `tool_call_id` 进行严格配对，不依赖 `name` 或邻近关系。
*   **R2 强制回放：** R2 阶段的模型输入必须包含上一阶段的“调用 + 结果”对。
*   **无 id 提示不合并：** 无 `tool_call_id` 的临时提示块（如 `running` 状态）不应与权威消息合并，避免错配。
*   **权限卡交互：** 权限卡在 `END(final=true)` 后仍可交互，但在消息状态变为 `error` 或 `cancel` 后应禁用。

#### **6.2. 日志验证**
*   **审计日志 (`logs/audit/<eventId>.jsonl`)：**
    *   **序列完整性：** 关键流程（如工具流、取消流）的审计日志序列必须完整且符合预期（例如 `BARRIER.sent → ack|timeout → gate_on → (ME.emit...) → gate_off → END.sent`）。
    *   **关键字检查：** `grep` 关键字 `BARRIER|STREAM|PERM|EXEC|LIMIT|SEARCH|CANCEL|PROVIDER` 以快速定位。
    *   **`final` 字段：** `STREAM.end{final:true}` 表示 Turn 结束，`STREAM.end{final:false}` 表示阶段结束但 Turn 继续（如 `soft_degrade` 后 R2）。
*   **IO 聚合日志 (`logs/io/<eventId>.json`)：**
    *   **`planned_tool_calls`：** 每个 LLM 相位（Step）的 `response` 中，若有工具调用规划，必须包含 `planned_tool_calls` 数组。
    *   **`tool_exec` 条目：** 每次工具执行（成功或失败）都必须追加一个 `type:'tool_exec'` 条目，记录 `tool_call_id`, `ok`, `content/error` 等信息。
    *   **R2 上下文：** R2 相位的 `request.messages` 中必须包含 `assistant.tool_calls + role='tool'` 的回放对。

#### **6.3. 权限错误口径**
*   **用户拒绝：** 最终工具块显示 `ok:false, error:'permission_denied'`。
*   **L2 权限不足：** 最终工具块显示 `ok:false, error:'tool_execution_error'`，且 `data` 或 `message` 中明确指明权限不足（例如 `Permission denied`），**不应**回退到 `pending` 状态或产生 `permission_required`。

#### **6.4. 限流占位**
*   **`soft_degrade`：** 超限工具块显示 `ok:false, error:'tool_call_limit_exceeded'`。
*   **`hard_cut`：** 超限工具块显示 `ok:false, error:'tool_call_limit_turn_terminated'`，且消息状态为 `error`。

---

### **7. 故障排查 (Troubleshooting)**

*   **现象：** UI 在 `STREAM` 阶段出现工具块 `success/error` 最终态，或权限卡/工具卡状态闪烁。
    *   **排查：**
        1.  检查 Renderer `handleStreamResponse` 中是否仍在 `tool_call end/error` 分支直接修改 `AssistantMessageBlock` 的最终状态。应仅作提示。
        2.  检查 `MESSAGE_EDITED` 事件是否被正确发出，并且 `revision` 是否递增。
    *   **预期：** UI 的最终态应由 `MESSAGE_EDITED` 驱动，而不是 `STREAM`。

*   **现象：** 屏障后 (DRAIN/ACK 结束后) 仍有 `STREAM.RESPONSE` 帧渲染到 UI，导致 UI 闪烁或状态混乱。
    *   **排查：**
        1.  检查 TP 收到 `stop=tool_use` 后是否立即停止了对 Provider `STREAM` 帧的转发。
        2.  检查 `BARRIER.sent/ack` 日志序列是否正确，`sseqLast` 是否与实际最后一帧对齐。
        3.  确认 `BARRIER.gate_on/gate_off` 日志是否正确记录了屏障的开启和关闭。
    *   **预期：** `STREAM.RESPONSE` 在 `BARRIER.gate_on` 之后不应再被转发。

*   **现象：** 权限路径与口径不一致，例如执行期回退 `pending` 或出现 `permission_required`。
    *   **排查：**
        1.  检查 `ToolManager` 的 `decidePermission` 逻辑，确保 L1 语义权限的分类器正确。
        2.  确认执行路径中 L2 物理层拒绝时，是否直接返回错误，而不是回退 `pending`。
        3.  检查 `EXEC.tool_result` 的 `ok:false` 是否带有正确的 `error` 字段（`permission_denied` 或 L2 拒绝信息）。
    *   **预期：** L2 权限不足应直接返回错误，无二次确认与回退 `pending`。

*   **现象：** 多个工具调用，但权限或结果配对错误。
    *   **排查：**
        1.  检查 `tool_call_id` 的生成和传递是否在全链路中保持唯一和稳定。
        2.  检查 Renderer `mergeAssistantMessage` 或相关合并逻辑是否严格遵循 `id-only` 配对原则。
    *   **预期：** 严格 `id-only` 配对，不依赖 `name` 或邻近关系。
