## **DeepChat Agent 文档结构重构映射文档**

**目标：** 将现有 `docs_luy/` 目录下的零散文档，系统性地迁移、整合至新的 `docs_agent/` 结构，实现文档的精简、聚焦、有条理和易于维护。

**新的目标目录结构：**

```
docs_agent/
├── overview/
│   ├── summary.md
│   ├── concepts.md
│   └── logging-spec.md
├── workflows/
│   ├── agent-core-flow.md
│   ├── cancellation.md
│   ├── search.md
│   ├── max-tool-calls.md
│   └── agent-security.md
├── progress/
│   └── status.md
├── verification/
│   └── test-plan.md
└── archive/
```

---

### **映射详情**

#### **1. `docs_agent/overview/` 目录**

**1.1 `docs_agent/overview/summary.md` (项目总括)**
*   **来源文件：**
    *   `docs_luy/progress_step_1.md` (部分内容)
    *   `docs_luy/progress_step_2.md` (部分内容)
    *   `docs_luy/step-3/progress.md` (部分内容)
    *   所有 Step 文档中的“目标”或“摘要”部分
*   **内容整合：**
    *   **项目愿景与价值：** 提炼 DeepChat Agent 的核心目标和带来的关键能力提升。
    *   **当前项目阶段：** 明确项目已完成 Step 0-4，核心工作流已稳定，Step 5（安全架构）待启动。
    *   **核心成果列表：** 从上述来源文件中，高度概括 Step 0-4 带来的主要能力提升和架构改进，例如：
        *   统一的工具调用框架与调度机制。
        *   SSoT (单一真理来源) 与 Phased Sync (阶段性同步) 架构的落地。
        *   全流程统一取消 (ACE) 机制。
        *   R-prepare 搜索能力的集成。
        *   Agent 安全 L1/L2 框架的基础设计。
    *   **文档导航：** 提供指向 `overview/concepts.md`、`overview/logging-spec.md` 以及 `workflows/` 目录下各核心流程文档的**重要链接**。

**1.2 `docs_agent/overview/concepts.md` (核心概念与原则)**
*   **来源文件：**
    *   `docs_luy/background/terminology.md`
    *   `docs_luy/step-3/plan_v2.md` (架构原则部分)
    *   `docs_luy/step-3/progress.md` (核心范式与约定部分)
    *   `docs_luy/progress_step_2.md` (术语定义、核心范式部分)
*   **内容整合：**
    *   **核心术语（Terminology）：** 完整提取 `docs_luy/background/terminology.md` 中的所有术语定义 (Conversation, Turn, Step, R, S, X, stop_reason, planned_tool_calls 等)。补充 `ME (MESSAGE_EDITED)` 和 `STREAM` 的概念。
    *   **架构原则（Architectural Principles）：**
        *   **单一真理来源 (SSoT)：** 明确 `MESSAGE_EDITED` 作为 UI 内容唯一权威更新源，UI 仅接受更高 `revision`。
        *   **阶段性同步 (Phased Synchronization)：** 描述业务流程阶段性（如 `stop=tool_use`）如何作为技术同步点，强调“先权威提交 → 再发送 `STREAM.END`”。
        *   **UI 提示状态与权威提交分离：** 明确 `STREAM_EVENTS` 仅用于临时提示（打字机、参数解析动画），不修改持久化状态。
        *   **Provider “仅收集” (Collect-Only) 模式：** 阐述 Provider 不再执行工具、限流、授权及调度执行，仅收集工具调用并随 `END` 事件返回。
        *   **`id-only` 配对原则：** 明确所有权限块、工具结果、回放均以 `tool_call_id` 为唯一标识。
    *   **指导原则：** 该文档是项目内所有技术讨论和设计的基础语言。

**1.3 `docs_agent/overview/logging-spec.md` (日志规范)**
*   **来源文件：** `docs_luy/background/logging-spec.md`
*   **内容整合：** **直接迁移** `docs_luy/background/logging-spec.md` 的全部内容，无需修改。
*   **指导原则：** 保持其作为一份独立、完整的技术规范文档。

#### **2. `docs_agent/workflows/` 目录**

**2.1 `docs_agent/workflows/agent-core-flow.md` (Agent 核心工作流)**
*   **来源文件：**
    *   `docs_luy/step-2/gemini.md` (核心重构方案)
    *   `docs_luy/step-3/plan_v2.md` (阶段性同步架构)
    *   `docs_luy/step-4/plan.md` (屏障 + 纯 ME 阶段实施方案)
    *   `docs_luy/step-2/codex.md` (旧重构方案，提取“背景与问题陈述”中的问题描述)
    *   `docs_luy/step-1/problem_2.md` (授权与复述问题分析)
    *   `docs_luy/step-4/notes.md` (屏障 Corner Cases 与外溢性影响)
    *   `docs_luy/progress_step_2.md` (现状基线与重构目标)
*   **内容整合：**
    *   **高层流程图：** **必须包含**一个**详细的 Mermaid sequence diagram**，清晰展示从用户输入→LLMProviderPresenter (collect-only)→ThreadPresenter (屏障/限流/授权/执行)→R2 (继续作答) 的完整 Agent 循环。图例应标明 UI, TP, Provider, DB 等模块，以及 `STREAM_EVENTS`, `MESSAGE_EDITED` 等关键事件交互。
    *   **核心问题背景：** 简要提及旧模式的痛点（如“遇权限即打断”、“授权即复述”），作为引入新架构的理由。
    *   **核心架构与原则：** 简要重申 SSoT, Phased Sync, Collect-Only 等核心原则，并说明它们如何驱动此流程。
    *   **各阶段详述：**
        *   **S 阶段 (STREAM 提示)：** 描述 Provider 如何“仅收集”工具调用，TP 如何转发 STREAM 作为 UI Hints，以及 `tool_call:end` 的非最终态语义。
        *   **同步屏障 (stop=tool_use)：** 详细阐述 `STREAM.DRAIN/ACK` 机制的流程、TP 如何等待 ACK（短超时），以及其在确保 STREAM 与 ME 阶段隔离中的作用。
        *   **纯 ME 阶段：** 描述屏障后，TP 如何统一处理配额、授权、工具执行，并通过 `MESSAGE_EDITED` 进行权威提交，包括：
            *   **权限总闸与 Auth Decider：** 如何进行授权决策 (AUTO_GRANT, AUTO_DENY, REQUIRE_USER_PERMISSION)，以及如何管理 `authStates`。
            *   **工具执行：** 串行执行已授权工具，汇总结果。
            *   **上下文注入策略：** 原生 FC 和非原生 FC 如何将工具执行结果注入上下文。
        *   **R2 (继续作答) 与可重入性：** 描述工具结果如何注入上下文以驱动模型继续生成，以及流程如何实现可重入以支持多轮工具调用。
    *   **关键不变量与鲁棒性：** 提及多窗口并发、渲染端崩溃/重载、取消等 Corner Cases 在此流程中的处理方式。
    *   **日志与可观测性：** 简要提及关键日志打点，如 `BARRIER.sent/ack/timeout`。
*   **指导原则：** 此文档是**DeepChat Agent 核心行为的权威描述**，应将所有相关 Step 的最终设计方案整合为一套连贯、统一、当前有效的系统行为描述。

**2.2 `docs_agent/workflows/cancellation.md` (取消机制)**
*   **来源文件：**
    *   `docs_luy/step-4/ace.md`
    *   `docs_luy/step-4/cancel.md`
*   **内容整合：**
    *   **ACE 模型定义：** 详细解释 Abort（Fence + Terminate）→ Commit（一次权威提交）→ End（技术清层）三步，并说明其设计目标（极简心智、严格有序、简单可观测）。
    *   **分阶段应用与时序图：**
        *   **必须包含**多个 Mermaid sequence diagram，分别展示 ACE 模型在 R-prepare、R、S、屏障等待、X（执行）、R2/S2 等不同阶段的具体实现步骤、日志输出和事件时序。
        *   每个阶段应详细描述 Abort、Commit、End 的具体动作。
    *   **核心不变量：** 列出取消流程必须遵守的 5 个不变量（例如：取消块恰一次、消息 `status='error'`、取消后不再推进、S 期恰一次 END、状态清理完成、UI 不回退）。
    *   **工具错误占位：** 描述取消时，正在运行或未执行的工具调用如何写入统一错误占位（`user_cancelled`）。
    *   **API 与配置：** 简要说明统一的取消 API (`tp.cancelTurn()`) 和相关配置项。
    *   **日志示例：** 提供 S 期和 Barrier 期取消的样例 JSON 日志。
*   **指导原则：** 整合 `step-4/ace.md` 和 `step-4/cancel.md` 的所有关键细节，使其成为关于取消功能的完整且操作性强的文档。

**2.3 `docs_agent/workflows/search.md` (搜索流程)**
*   **来源文件：** `docs_luy/step-4/search.md`
*   **内容整合：**
    *   **阶段定位与目标：** 明确搜索属于 R-prepare 阶段，用于补强 R 输入，且不触发 STREAM 屏障。
    *   **触发条件与配置：** 阐述搜索的触发时机（仅限首轮 R 和 msg_retry）和相关配置。
    *   **端到端时序与时序图：** **必须包含**一个 Mermaid sequence diagram，详细描述从 `loading → optimizing → reading → success/error` 的多次 `MESSAGE_EDITED` 提交过程，并展示其与 R 提交、S 阶段的衔接。
    *   **与 Agent Core Flow 的关系：** 明确搜索与 STREAM/工具路径不并发，职责边界清晰。
    *   **关键处理：** 查询重写、抓取执行、附件持久化、Prompt 注入。
    *   **取消路径：** 描述搜索过程中用户取消的处理方式。
    *   **并发与资源管理：** 简要提及 `maxConcurrentSearches` 和 `AbortController`。
*   **指导原则：** 整合 `step-4/search.md` 的所有关键细节，使其成为关于搜索功能的独立、完整的说明。

**2.4 `docs_agent/workflows/max-tool-calls.md` (限流策略)**
*   **来源文件：**
    *   `docs_luy/max_fc_calls/max_fc_calls.md` (策略概述，但需明确其“回退”状态)
    *   `docs_luy/step-3/progress.md` (关于配额卡策略升级和 Provider/TP 职责边界的部分)
    *   `docs_luy/step-4/plan.md` (关于限流决策与写库的细节)
*   **内容整合：**
    *   **策略概述：** 明确当前 DeepChat Agent 针对最大工具调用数的限制策略已从最初的“三选一”方案简化，并说明其演进背景。
    *   **模式详述：** 详细描述 `soft_degrade` 和 `hard_cut` 两种模式下的行为：
        *   **计数口径和上限判断时机：** 明确 `toolCallsTotal` 的累计方式和在 END 同步点、权限注入前的判定。
        *   **超限时行为：** 描述两种模式下，系统如何写入错误占位（包括 `error:'tool_call_limit_exceeded'` 等），以及对消息状态和流程继续（R2）的影响。
    *   **Provider/TP 职责：** 明确 Provider 不再有最大调用数硬守卫，仅作软提示；TP 作为唯一权威进行配额累计/判定、K 计算、权限注入、占位和何时 Finalize。
    *   **UI 交互：** 简要提及 UI 如何展示限流提示（STREAM 提示）和错误块（ME 权威）。
    *   **i18n 键与文案：** 列出限流相关的 i18n 键和文案对照表。
*   **指导原则：** 整合上述来源文件中的最新、最权威的决策和实现细节，明确当前生效的限流策略。

**2.5 `docs_agent/workflows/agent-security.md` (Agent 安全架构)**
*   **来源文件：** `docs_luy/step-5/agent_security.md`
*   **内容整合：**
    *   **摘要与设计结论：** 概述采用“纵深防御”模型，解耦 L1 语义权限系统和 L2 内核级物理守护系统。
    *   **核心设计原则：** 阐述“信任但要验证”、“Chatbot 极简性”、“Agent 高效率”、“成本可控”等原则。
    *   **L1 语义权限系统：** 详细描述动作空间 (`Inspect`, `Read`, `Write`, `Network`)、选项空间 (`AUTOGRANT`, `AUTODENY`, `CONFIRM`)，以及确定性动作分类器的工作原理。
    *   **L2 内核级物理守护系统：** 详细描述杜绝 `shell` 注入的执行器、`rbash` 和 `AppArmor` + `ulimits` 的配置。
    *   **L1 与 L2 的桥接：** 阐述“启动时交底 + 可靠的 JIT-Refresh (基于退出码)”如何实现可靠的能力发现。
    *   **流程图：** **必须包含**一个 Mermaid graph diagram，清晰地展示 L1 和 L2 双层防御模型，以及一个工具调用请求如何流经这两层。
*   **指导原则：** 直接使用 `step-5/agent_security.md` 的内容，作为 Agent 安全设计的权威文档。

**3. `progress/` 目录 (实施进展)**
*   **职责：** 提供项目整体的实施进展概览，强调已交付的关键成果和未来的方向。

*   **`progress/status.md` (总体实施现状)**
    *   **目的：** 作为项目当前交付状态的最新报告和未来工作规划的参考。
    *   **内容要求：**
        1.  **已交付功能亮点：** 总结 Step 0-4 中已交付的最核心、最有影响力的功能和改进点。应与 `overview/summary.md` 形成呼应，但可以包含更多技术实现的细节和代码路径引用。
            *   可从 `docs_luy/progress_step_1.md`，`docs_luy/progress_step_2.md`，`docs_luy/step-1/status.md`，`docs_luy/step-3/progress.md` 等文件中提炼**最终结论和已完成的功能列表**。
        2.  **当前遗留问题/技术债务：** 简洁列出当前仍存在的、需要关注的少数核心问题或已知的技术债务（例如，从 `docs_luy/step-1/problem.md` 和 `docs_luy/step-1/problem_3.md` 中筛选**尚未解决的**）。
        3.  **下一步计划与展望：** 明确指出 Step 5 是下一主要阶段，核心目标是 Agent 安全架构的落地和进一步完善。可以提及短期的优化方向。
    *   **指导原则：** 定期更新，确保反映项目最新实施状态和规划。

**4. `verification/` 目录 (验证计划)**
*   **职责：** 集中存放 DeepChat Agent 的验证计划、测试用例和验收标准，是确保产品质量的基石。

*   **`verification/test-plan.md` (验证与测试计划)**
    *   **目的：** 提供一套完整的、可执行的测试用例集，用于验证 Agent 的功能正确性、鲁棒性和一致性。
    *   **内容要求：**
        1.  **环境与准备：** 明确测试所需的环境配置（pnpm dev）、日志目录（`logs/audit/`, `logs/io/`，可选 `logs/io-detail/`）和默认配置（如 `soft_degrade`）。
        2.  **快速勾检清单：** 提供一次完整工具流的快速验证步骤。
        3.  **精炼用例（按功能模块）：**
            *   无工具流 (S-only)
            *   普通工具流 (tool_use → 屏障 → 权限 → 执行 → R2)
            *   权限场景： 用户拒绝、L2 权限不足、待授权静止态。
            *   限流： `soft_degrade`、`hard_cut`。
            *   取消 (ACE)： S 期、屏障等待、X 期取消。
            *   搜索迷你阶段 (R-prepare)
            *   围栏与门控验证（不变量）： 运行时顺序、UI 无闪烁/状态回退。
            *   多窗口 ACK：不适用（DeepChat 单窗口绑定同一会话）。
        4.  **观察点与验收标准：** 针对每个用例或整体流程，明确 UI 表现、日志输出、合并规则、权限错误口径等验收标准。
        5.  **故障排查：** 提供常见偏差及其定位指引。
    *   **指导原则：** 整合 `docs_luy/testcases.md` 和 `docs_luy/testcases-2.md` 的所有测试用例，确保其与 `workflows/` 下的流程描述严格对应。此文档应是 QA 和开发者进行功能验证的唯一标准。
