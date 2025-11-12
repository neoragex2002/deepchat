# DeepChat Agent 权威文档集 (docs_agent)

欢迎来到 DeepChat Agent 的核心文档集。本目录旨在为项目成员提供一个结构清晰、信息详尽、易于导航的单一真理来源，涵盖 DeepChat Agent 的核心理念、工作流程、实施现状及验证标准。

本文档集采用 **“总览 → 流程 → 进展 → 验证”** 的分层组织结构，确保信息获取的效率与准确性。所有文档均以中文书写，并遵循统一的规范和约定。

---

## 🚀 项目简介与当前状态

DeepChat Agent 是一个基于 LLM 和工具调用的智能体系统，旨在通过构建一个稳定、高效、可控且易于演进的现代化工作流，赋能用户与系统进行更智能、更自然的交互。

**当前项目阶段：**

DeepChat Agent 已成功完成 **Step 0 至 Step 4 的核心架构与功能建设**。这意味着 Agent 的基础工作流、工具调用框架、权限管理、状态同步、取消机制以及 R-prepare 搜索能力均已稳定运行。项目正准备进入 **Step 5，聚焦于 Agent 安全架构的进一步完善。**

## 💡 核心设计理念与原则

本文档集及 DeepChat Agent 的设计与实现，均严格遵循以下核心理念和原则：

1.  **单一真理来源 (Single Source of Truth, SSoT)：**
    *   **核心：** `MESSAGE_EDITED` 事件是 UI 消息内容的**唯一权威更新来源**。所有持久化内容和最终状态的呈现，均以此事件为准。
    *   **目的：** 消除 UI 状态回滚、闪烁和竞态条件，确保前端与后端数据的最终一致性。

2.  **阶段性同步 (Phased Synchronization)：**
    *   **核心：** 技术交互的同步点与业务流程的阶段性强绑定。例如，`stop_reason == "tool_use"` 被定义为一个硬同步屏障。
    *   **目的：** 将复杂异步流程分解为可控的、有序的阶段，确保每个阶段边界处的状态确定性。

3.  **UI 提示与权威提交分离 (Separation of UI Hints and Authoritative State)：**
    *   **核心：** `STREAM_EVENTS` (如文本增量、工具参数解析动画) 仅用于驱动独立的、临时的、非持久化的 **UI Hint Layer**。它们绝不修改消息的权威持久化状态。
    *   **目的：** 优化用户感知延迟，同时保护底层数据不被临时性、非权威信息污染。

4.  **Provider 角色收敛 (Collect-Only)：**
    *   **核心：** `LLMProviderPresenter` (Provider 层) **仅负责收集** LLM 规划的所有工具调用 (tool_calls)。它不再执行工具、不再裁决权限、不再调度执行。
    *   **目的：** 简化 Provider 职责，将其定位为 LLM 流式输出的标准化适配器。

5.  **Thread 协调中心 (Central Coordination by ThreadPresenter)：**
    *   **核心：** `ThreadPresenter` (TP) 作为会话流程的总控，统一负责配额管理、权限授权、工具执行调度、结果持久化和继续作答流程。
    *   **目的：** 将复杂的业务逻辑和状态机集中管理，确保流程的连贯性、可控性和可审计性。

6.  **`id-only` 精确匹配：**
    *   **核心：** 所有工具调用、权限块、执行结果和回放，均以 `tool_call_id` 作为唯一标识进行原子配对。
    *   **目的：** 杜绝在并行或复杂场景下因名称、时间戳或邻近关系导致的错配问题。

---

## 🗺️ 文档结构与导航

本文档集按照功能和关注点划分为以下几个主要目录和文件。请通过以下链接进行导航：

### 1. `overview/` (项目总览与基础规范)
*   **目的：** 快速了解项目全局，掌握核心概念和通用技术规范。
*   **内容：**
    *   [`overview/summary.md`](overview/summary.md)：项目愿景、当前阶段、核心成果概览及文档导航。
    *   [`overview/concepts.md`](overview/concepts.md)：DeepChat Agent 核心术语、架构原则与通用规范。
    *   [`overview/logging-spec.md`](overview/logging-spec.md)：详尽的日志记录规范（审计日志与 IO 日志）。

### 2. `workflows/` (核心工作流程)
*   **目的：** 深入理解 DeepChat Agent 各项核心功能的 **当前运作方式**。这些文档将多个 Step 的设计融合为一套连贯的系统行为描述。
*   **内容：**
    *   [`workflows/agent-core-flow.md`](workflows/agent-core-flow.md)：DeepChat Agent 从头到尾的完整核心调度与执行流程。
    *   [`workflows/cancellation.md`](workflows/cancellation.md)：全流程统一的取消（ACE）机制。
    *   [`workflows/search.md`](workflows/search.md)：R-prepare 阶段的搜索“迷你阶段”详解。
    *   [`workflows/max-tool-calls.md`](workflows/max-tool-calls.md)：最大工具调用数限制策略（soft_degrade/hard_cut）。
    *   [`workflows/agent-security.md`](workflows/agent-security.md)：Agent 安全架构 (L1 语义权限与 L2 物理守护系统)。

### 3. `progress/` (实施现状与展望)
*   **目的：** 了解项目当前的实施进展、已交付的关键成果、现存的遗留问题以及未来的规划。
*   **内容：**
    *   [`progress/status.md`](progress/status.md)：项目总体实施现状报告，包括已交付亮点、遗留问题和下一步计划 (Step 5)。

### 4. `verification/` (验证与测试)
*   **目的：** 提供 DeepChat Agent 的验证计划、测试用例和验收标准，确保产品质量。
*   **内容：**
    *   [`verification/test-plan.md`](verification/test-plan.md)：全面的测试用例集、环境要求、验收标准和故障排查指南。

### 5. `mapping.md` (旧文档映射)
*   **目的：** 提供 `docs_luy` 目录下的原始文件与 `docs_agent` 新结构中文件的对照关系。
*   **内容：** 一个表格或列表，清晰列出每个旧文件现在对应的新文件或其内容被整合到了哪些新文件中。

---

## 📝 通用规范与约定

为确保文档集的一致性和可读性，请遵循以下规范：

*   **语言统一：** 所有文档内容均使用**中文**书写。
*   **图表工具：** 流程图和时序图统一使用 **Mermaid** 语法。
    *   **配色与泳道：** 建议使用 Mermaid 默认配色。在时序图 (sequenceDiagram) 中，请统一使用以下核心参与者泳道：`User`, `UI` (Renderer/Chat Store), `TP` (ThreadPresenter), `Provider` (LLMProviderPresenter), `DB` (Database), `ToolMgr` (ToolManager/MCP)。
*   **日志路径：** 运行时日志统一落盘至 `logs/audit/` (审计日志) 和 `logs/io/` (IO 详情，可选 `logs/io-detail/`)。
*   **Provider 职责：** 严格遵循 **"Collect-Only"** 原则，Provider 层仅负责工具调用收集，不涉及限流、授权及执行调度。
*   **Thread 职责：** `ThreadPresenter` (TP) 作为会话总控，统一处理配额、授权、工具执行和继续作答流程。
*   **渲染层职责：** `Renderer` (UI) 仅根据 `MESSAGE_EDITED` 事件合并和更新消息内容，`STREAM_EVENTS` 仅作临时提示。
*   **文件名与目录名：** 统一使用**小写字母**和 **`kebab-case`** (单词间用连字符 `-` 连接)。
*   **Markdown 规范：** 遵循常用的 Markdown 语法，标题层级清晰，代码块使用正确的语言高亮。
*   **交叉引用：** 鼓励文档之间通过链接进行相互引用，以方便读者跳转和理解上下文。

---

## 📚 如何使用本文档集

*   **项目概览：** 从 [`overview/summary.md`](overview/summary.md) 开始，了解项目核心和当前状态。
*   **理解核心概念和术语：** 阅读 [`overview/concepts.md`](overview/concepts.md)。
*   **深入核心流程：** 查阅 [`workflows/` 目录](workflows/) 下的各个文档，每个文档都详细描述了一个关键系统流程。
*   **查看项目进展：** 访问 [`progress/status.md`](progress/status.md) 了解最新交付和规划。
*   **进行功能验证：** 参考 [`verification/test-plan.md`](verification/test-plan.md) 进行测试。
*   **查找历史信息：** 访问 [`mapping.md`](mapping.md) 查找旧文档与新文档的映射关系，并前往 `archive/` 目录。
