# 项目总括：DeepChat 智能体工作流

**文档状态：** 当前稳定 (截至 Step 4 完成)

**核心目标：** 在“面向人类的对话体验”与“面向工程的可控执行”之间，建立一个稳定、清晰、可审计的智能体工作流。

---

## 1. 项目摘要 (Executive Summary)

DeepChat Agent 项目旨在将强大的大型语言模型（LLM）与外部工具（如 Shell、搜索）安全、可靠地结合起来，以完成复杂任务。我们面临的核心挑战是：**如何在赋予 Agent 自主性的同时，确保其行为的安全性、可预测性和用户体验的流畅性。**

为应对此挑战，我们设计并实现了一套全新的、基于**“阶段性同步 (Phased Synchronization)”**和**“单一真理来源 (Single Source of Truth, SSoT)”**的智能体工作流。该架构从根本上解决了传统 Agent 流程中常见的竞态条件、UI 状态不一致和流程脆弱性问题，为用户提供了更可靠的交互体验，并为工程师提供了更清晰、更易于维护的开发框架。

目前，项目的核心工作流（Step 0-4）已稳定落地，下一阶段（Step 5）将聚焦于安全架构的进一步加固。

---

## 2. 核心成果与价值 (Core Achievements & Value)

通过 Step 0-4 的迭代，我们为 DeepChat 带来了跨越式的体验提升和工程优化。

#### **面向用户 (For Users)**

*   **可靠且可预测 (Reliable & Predictable)**
    *   通过强大的同步屏障机制，彻底消除了工具调用过程中的 UI 闪烁和状态回退，用户所见即最终所得。
    *   所有工具的执行结果（无论成功、失败或被拒绝）都会被清晰地呈现和解释，Agent 的行为不再是“黑盒”。

*   **流畅且可控 (Seamless & Controllable)**
    *   实现了全流程统一的取消机制（ACE 模型），用户可在任何阶段（包括搜索、工具执行中）**立即中止** Agent 的行为，并获得明确的取消反馈。
    *   通过 R2 回放注入，Agent 能够记住并利用上一步的工具结果，实现连贯的多步骤任务处理，对话体验不中断。

#### **面向工程 (For Engineers)**

*   **坚如磐石的架构 (Rock-Solid Architecture)**
    *   **SSoT + Phased Sync：** 建立了以 `MESSAGE_EDITED` 为唯一权威、以业务阶段为同步点的架构，从根源上消除了竞态条件，使状态管理变得极其简单和可预测。
    *   **职责分离：** `Provider` 层仅负责“收集”工具调用，`Thread` 层作为“总指挥”负责调度，`Renderer` 层仅负责渲染权威状态。模块职责清晰，极大降低了系统复杂度。

*   **卓越的可观测性 (Exceptional Observability)**
    *   建立了覆盖全链路的**审计日志 (Audit LOG)** 和 **IO 日志 (IO LOG)** 体系。任何一次 Agent 的交互、决策和执行过程都可被精确追踪、审计和**一键回放**，问题排查效率呈数量级提升。

*   **模块化与可维护性 (Modular & Maintainable)**
    *   所有关键路径（如工具调用、权限、搜索）均采用 **`id-only`** 严格配对，杜绝了因名称或顺序依赖导致的脆弱性。
    *   清晰的流程文档和代码结构，使得新功能（如 Step 5 的安全模块）的集成变得更加简单和安全。

---

## 3. 项目状态与路线图 (Project Status & Roadmap)

*   **已完成的里程碑 (Step 0-4)**
    1.  **统一工具调用框架：** 确立了 Provider “仅收集、不执行”的模式。
    2.  **SSoT + 阶段性同步架构：** 落地了以 `stop=tool_use` 为屏障的 `DRAIN/ACK` → `MESSAGE_EDITED` → `END` 核心时序。
    3.  **全链路可观测性：** 实现了统一的审计与 IO 日志规范。
    4.  **核心流程能力：**
        *   **取消 (ACE)：** 实现了覆盖所有阶段的统一取消模型。
        *   **搜索 (R-prepare)：** 实现了在 R 阶段前置的“迷你阶段”搜索能力。
        *   **限流：** 建立了 `soft_degrade` 和 `hard_cut` 两种限流模式。
        *   **R2 回放：** 确保了 Agent 在多步任务中的对话连续性。

*   **下一步计划 (Step 5)**
    *   **主题：** Agent 安全架构加固。
    *   **核心目标：** 落地 L1/L2 双层安全模型，以最低成本建立“能用、够安全”的沙盒执行环境，为未来开放更强大的 Agent 能力奠定基础。

---

## 4. 文档导览 (Documentation Guide)

为了帮助不同角色的成员快速找到所需信息，请参考以下导览：

*   **如果你是新成员或想了解基础概念：**
    *   **必读：** [`overview/concepts.md`](./concepts.md) - 学习所有核心术语和架构原则。

*   **如果你是开发者或架构师，想理解系统如何运作：**
    *   **核心流程：** [`workflows/agent-core-flow.md`](../workflows/agent-core-flow.md) - 理解端到端的 Agent 工作流。
    *   **专项流程：** 查阅 `workflows/` 目录下的其他文档，如 `cancellation.md`, `search.md`, `agent-security.md` 等。

*   **如果你是开发者或 QA，需要实现或验证功能：**
    *   **日志规范：** [`overview/logging-spec.md`](./logging-spec.md) - 查阅日志的格式与打点规范。
    *   **测试计划：** [`verification/test-plan.md`](../verification/test-plan.md) - 获取所有功能的标准测试用例和验收标准。

*   **如果你想了解项目的最新进展和未来规划：**
    *   **实施状态：** [`progress/status.md`](../progress/status.md) - 查看已交付亮点、技术债务和下一步计划。

---

## 5. 快速上手 (Developer Quick Start)

*   **环境依赖：**
    *   Node.js: `≥ 20.19`
    *   pnpm: `≥ 10.11`
    *   Windows: 需启用开发者模式以支持符号链接 (symlink)。

*   **安装与运行：**
    ```bash
    # 首次安装
    pnpm install
    pnpm run installRuntime

    # 启动开发环境 (带热重载)
    pnpm run dev

    # 启动预览版
    pnpm start
    ```

*   **快速验证：**
    *   参考 [`verification/test-plan.md`](../verification/test-plan.md) 中的“快速勾检清单”部分，快速验证一次完整的工具调用流程。