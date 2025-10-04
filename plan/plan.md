# **DeepChat 消息变体上下文修复项目 - 实施方案 (V1.4)**

## **一、方案概述 (Overview)**

本项目旨在以最小化的架构和代码修改，系统性地解决 DeepChat 应用中后端构建 LLM 上下文时忽略用户所选消息变体的问题。

核心修复策略是：**前端负责收集并传递用户的变体选择意图，后端在接收到此意图后，在构建 LLM 上下文的“预处理”阶段，动态地将消息内容及其相关元数据替换为用户所选变体的内容和元数据。**

数据的持久化（永固化）将通过**利用 `CONVERSATION` 表中一个已存在但未被使用的 `context_chain` 字段**来实现，以确保方案的简洁、高效、内聚和向后兼容性。

## **二、修改原则 (Guiding Principles)**

所有实施步骤均需严格遵守以下原则：

1.  **零数据库 Schema 变更 (Zero DB Schema Change):** 不新增、不修改任何数据库表的结构，以保证最高的稳定性和最简的部署。此为最高优先级原则。
2.  **最小化修改 (Minimal Modification):** 优先利用和扩展现有逻辑，避免大规模重构。修改应集中、内聚，不应扩散到不相关的模块。
3.  **完全向后兼容 (Full Backward Compatibility):** 确保新版应用能处理旧版数据库的数据（例如，旧数据中 `context_chain` 字段为 `NULL` 或 `[]` 时能优雅处理），旧版应用也能在不报错的情况下处理新版数据库的数据（旧版 App 会忽略 `context_chain` 字段的内容）。
4.  **数据驱动，逻辑分离 (Data-Driven, Logic-Separated):** 核心上下文构建逻辑（`selectContextMessages` 等）保持不变，其行为由传入的数据（经过预处理的消息列表）驱动，而非修改其内部实现。
5.  **用户意图的准确传递与持久化：** 确保用户在前端 UI 上对消息变体的选择，能够被准确地传递给后端，并得到可靠的持久化，以提供连贯的用户体验。
6.  **内容与元数据一致性 (Content & Metadata Consistency):** 只要上下文或显示逻辑使用了用户选择的变体内容，那么与之语义相关的元数据（如 `usage`, `model_id`, `model_provider` 等）也应同步到该变体的值。

## **三、实施阶段 (Implementation Phases)**

### **阶段一：后端基础与接口契约定义 (Backend Foundation & API Contract Definition)**

*   **目标：** 建立数据持久化的基础，并定义前后端通信的新契约。此阶段不实现核心的“内容替换”逻辑，仅让后端能够“知道”并“存储”变体选择信息。

*   **事项 (Items)：**
    1.  **接口定义更新 (Shared Interface Update)：**
        *   在共享代码（`src/shared/presenter.d.ts`）中，扩展 `CONVERSATION_SETTINGS` 接口。
        *   新增一个可选属性 `selectedVariantsMap?: Record<string, string>;`。
            *   **理由：** 这是应用层的数据结构，便于前后端类型统一。使用 `Record<string, string>` 类型是为了与 JSON 序列化/反序列化兼容，避免 JavaScript `Map` 对象无法直接序列化的问题。
    2.  **后端方法签名扩展 (Backend Method Signature Extension)：**
        *   修改 `ThreadPresenter` 中所有需要构建 LLM 上下文的入口方法的签名，增加一个可选参数 `selectedVariantsMap?: Record<string, string>`。
        *   **受影响的方法**：`startStreamCompletion`, `continueStreamCompletion`, `forkConversation`, `regenerateFromUserMessage`。
        *   **理由：** 定义前后端通信的新契约，使前端能够将用户意图传递给后端。可选参数保证了对现有调用方的向后兼容性。
    3.  **持久化逻辑实现 (Persistence Logic Implementation)：**
        *   利用**闲置的 `context_chain` 字段**来存储 `selectedVariantsMap`。
        *   修改 `src/main/presenter/sqlitePresenter/tables/conversations.ts`：
            *   在 `create()` 方法中：当 `settings.selectedVariantsMap` 存在时，将其 `JSON.stringify` 后的结果存入 `context_chain` 列。
            *   在 `update()` 方法中：当 `data.settings.selectedVariantsMap` 存在时，增加对 `context_chain` 列的更新逻辑。
            *   在 `get()` 和 `list()` 方法中：从 `context_chain` 列读取数据，`JSON.parse` 后填充到返回的 `CONVERSATION` 对象的 `settings.selectedVariantsMap` 属性上。需处理 `context_chain` 为 `NULL` 或无效 JSON 的情况，优雅降级为空对象。
        *   修改 `ThreadPresenter` 中的 `updateConversationSettings` 方法，确保它能正确地将 `selectedVariantsMap` 的更新传递给 `conversationsTable.update`。

*   **理由 (Phase Rationale)：**
    *   此方案通过复用闲置字段 `context_chain`，严格遵守了“零数据库 Schema 变更”的核心原则。
    *   这是最安全、风险最小的第一步。它首先定义了数据应该是什么样子，以及它如何在系统中存储，为后续的功能实现铺平了道路。

*   **预期成果 (Expected Outcome)：**
    *   后端能够接收 `selectedVariantsMap` 数据，并将其作为 JSON 字符串正确地存入和读出 `conversations.context_chain` 字段。
    *   `CONVERSATION` 对象在应用层能正确地包含 `settings.selectedVariantsMap`。
    *   前后端之间有了明确的、可供调用的新 API 契约。
    *   系统功能无回归（regression）。

---

### **阶段二：前端状态管理与数据传递 (Frontend State Management & Data Passing)**

*   **目标：** 让前端能够收集用户的变体选择，管理这个状态，并通过阶段一建立的新契约将其传递给后端。

*   **事项 (Items)：**
    1.  **`chatStore` 状态扩展 (Extend `chatStore` State)：**
        *   在 `src/renderer/src/stores/chat.ts` 中增加一个内存状态 `selectedVariantsMap = ref<Map<string, string>>(new Map())`，用于管理当前激活会话的变体选择。
    2.  **用户交互同步 (User Interaction Synchronization)：**
        *   在 `MessageItemAssistant.vue` 中，当用户通过变体切换器切换变体时（`handleAction('prev'/'next')`），调用 `chatStore` 的新方法 `updateSelectedVariant(mainMessageId: string, selectedVariantId: string | null)` 来更新 `chatStore` 内存中的 `selectedVariantsMap`。
        *   **`selectedVariantsMap` 存储规则：** 此映射表**只存储用户明确选择了“非主消息变体”的记录**。如果用户选择的是主消息本身，则 `updateSelectedVariant` 方法应确保该主消息的 ID **从内存 `Map` 中被移除**。
            *   **理由：** 保持存储的简洁性和语义的清晰性，简化后端的处理逻辑。
    3.  **数据持久化触发 (Data Persistence Trigger)：**
        *   `chatStore` 中的 `updateSelectedVariant` 方法在更新内存 `selectedVariantsMap` 后，应立即调用 `threadP.updateConversationSettings`，将转换后的 `selectedVariantsMap`（`Record` 类型）传递给后端进行持久化。
            *   **理由：** 确保用户每次切换变体后，其选择都能被及时持久化。
    4.  **API 调用更新 (API Call Update)：**
        *   在 `chatStore` 中，修改所有调用阶段一扩展的后端方法的地方（`sendMessage`, `retryMessage`, `regenerateFromUserMessage`, `forkThread`, `continueStream`）。
        *   在调用 `threadP` 的方法时，**将 `chatStore` 内存中 `selectedVariantsMap` 转换为 `Record<string, string>` 对象**（`Object.fromEntries(selectedVariantsMap.value)`），作为新参数传递给 `threadP`。
    5.  **状态加载逻辑 (State Loading Logic)：**
        *   在 `chatStore` 的 `loadChatConfig` 或处理会话激活的逻辑中，从 `conversation.settings.selectedVariantsMap`（一个 `Record<string, string>` 对象）中读取持久化的数据，并用 `new Map(Object.entries(record))` 的方式填充到 `chatStore` 内存中的 `Map<string, string>` 状态中。
    6.  **消息删除时的数据清理 (Data Cleanup on Message Deletion)：**
        *   在 `chatStore` 的 `deleteMessage` action 中，增加逻辑：
            *   如果被删除的消息是一个**主助手消息**，则同时从 `chatStore` 内存中的 `selectedVariantsMap` 中移除该消息的条目，并触发后端持久化。
            *   如果被删除的消息是一个**变体消息**，则找到其父消息，并将选择切换到剩余变体中的**最后一个**；如果无剩余变体，则回退到主消息。
            *   **理由：** 维持数据一致性，避免 `selectedVariantsMap` 中存在无效记录，并遵循预设的设计行为。

*   **理由 (Phase Rationale)：**
    *   此阶段将用户的操作（意图）转化为实际的数据，并打通了意图从前端到后端的传递通道。
    *   将状态管理集中在 `chatStore`，使得逻辑内聚，便于维护。

*   **预期成果 (Expected Outcome)：**
    *   用户的变体选择能够被实时捕获并持久化到数据库的 `context_chain` 字段。
    *   当需要构建 LLM 上下文时，包含变体选择的 `selectedVariantsMap` 数据能够被准确地发送到后端。
    *   此时，核心问题仍未解决，但数据流已经准备就绪。

---

### **阶段三：后端核心逻辑实现与问题修复 (Backend Core Logic Implementation & Fix)**

*   **目标：** 在后端利用前端传递的数据，实现“变体内容及其元数据替换”逻辑，从根本上修复所有受影响的场景。

*   **事项 (Items)：**
    1.  **实现“变体内容和元数据替换”预处理 (Implement Variant Content & Metadata Pre-processing)：**
        *   在 `ThreadPresenter` 的 `prepareConversationContext` 方法内部，在获取到原始 `contextMessages` 列表之后，但在将其传递给 LLM 上下文筛选和格式化函数之前，插入核心“变体内容和元数据替换”逻辑。
        *   **逻辑细节：**
            *   遍历 `contextMessages` 列表中的每个 `Message` 对象。
            *   如果 `msg.role === 'assistant'` 且传入的 `selectedVariantsMap` 中包含 `msg.id` 作为键。
            *   获取 `selectedVariantsMap` 中对应的 `selectedVariantId`。
            *   从 `msg.variants` 数组中查找 `selectedVariantId` 对应的变体对象。
            *   如果找到了选定的变体，则创建一个新的 `Message` 对象副本（深拷贝）。
            *   将该副本的 `content` 属性设置为选定变体的 `content`。同时，将其 `usage`、`model_id` 和 `model_provider` 属性也替换为选定变体的对应值。
            *   将 `contextMessages` 列表中的原始 `Message` 对象替换为这个带有新 `content` 和元数据的副本。
            *   **理由：** 确保核心上下文构建逻辑在读取 `message.content`、`message.usage` 等属性时，读到的是用户期望的变体内容和其对应的元数据，实现内容与元数据的高度一致性，无需修改核心逻辑。
    2.  **修复 `forkConversation` (Fix `forkConversation`)：**
        *   在 `forkConversation` 方法内部，当获取到待复制的 `messageHistory` 后，在循环插入新消息之前，应用相同的“变体内容和元数据替换”逻辑。
        *   **逻辑细节：** 遍历 `messageHistory`，对于每一条助手消息 `msg`：
            *   如果传入的 `selectedVariantsMap` 中有为 `msg.id` 指定的 `selectedVariantId`，并且该变体存在，则后续用于创建新消息的源对象 `finalMsg` **应直接替换为该变体对象**。
            *   这将确保新会话中对应的消息的 `content`、`usage`、`model_id`、`model_provider` **都将完全继承自 `selectedVariantId` 对应的变体**。
            *   新会话中这条消息的 `is_variant` 属性应设为 `0`（它在新会话中将成为独立的非变体主消息），并且**不再带有 `variants` 数组**（“扁平化”分支）。
        *   **新会话的 `settings` 处理：** 作为设计选择，为了实现历史快照的“扁平化”，在创建新的分叉会话的配置中，**其 `settings` 对象内的 `selectedVariantsMap` 属性被显式初始化为空对象 `{}`**。
    3.  **增加防御性代码 (Add Defensive Code)：**
        *   在所有需要处理 `selectedVariantsMap` 的后端逻辑中，增加对 `selectedVariantsMap` 参数是否为 `undefined` 或空，以及其中 `variantId` 是否有效（即在消息的 `variants` 数组中是否存在）的检查。
        *   如果 `selectedVariantId` 对应的变体对象不存在，则**静默地回退到使用原始主消息的 `content`、`usage`、`model_id` 和 `model_provider`**，并可以记录警告日志，但不能中断流程。

*   **理由 (Phase Rationale)：**
    *   这是直接解决问题的核心步骤。通过一个集中的“预处理”步骤，我们影响了所有依赖 `prepareConversationContext` 的功能，实现了“一处修改，处处生效”。
    *   对 `forkConversation` 的特殊处理确保了该功能的语义正确性。
    *   确保了内容与元数据的一致性，使得 LLM 上下文的语义更加准确和完整。

*   **预期成果 (Expected Outcome)：**
    *   所有在 `bugs.md` 中描述的场景（新消息、重试、分叉等）下，LLM 接收到的历史上下文均包含用户选择的正确变体内容及其对应的元数据。
    *   核心缺陷被完全修复。

---

### **阶段四：UI/UX 同步与体验优化 (UI/UX Synchronization & Experience Optimization)**

*   **目标：** 确保前端 UI 能准确反映持久化的用户选择，完善整个功能的闭环体验。

*   **事项 (Items)：**
    1.  **UI 状态同步 (UI State Synchronization)：**
        *   **验证并完善** `MessageItemAssistant.vue` 中的 `currentVariantIndex` 计算属性。
        *   **当前实现（已部分修复）：** `currentVariantIndex` 已是一个 `computed` 属性，它依赖于 `chatStore.selectedVariantsMap`。
        *   **验证要点：**
            *   确保当 `chatStore.selectedVariantsMap` 中**没有** `props.message.id` 的记录时，`currentVariantIndex` 正确返回 `0`（主消息）。
            *   确保当 `chatStore.selectedVariantsMap` 中记录的 `selectedVariantId` 在 `allVariants` 数组中找不到时，UI 能优雅地回退到显示主消息（`currentVariantIndex` 返回 `0`）。
            *   **理由：** 确保 UI 能够准确反映持久化后的选择，包括对主消息的选择，并在数据不一致时有可靠的回退机制。
    2.  **UI 交互闭环 (UI Interaction Loop Closure)：**
        *   在 `MessageItemAssistant.vue` 的 `handleAction` 方法中，当用户点击“上一个/下一个”变体按钮时，**必须调用 `chatStore.updateSelectedVariant` 方法**，将新的变体选择（或 `null`，如果切回主消息）通知 `chatStore`，从而触发持久化。
    3.  **新变体生成时的用户体验：**
        *   确认当 `retryMessage` 或 `regenerateFromUserMessage` 成功生成一个新变体并被添加到 `message.variants` 数组后，UI 会自动切换到显示最新变体。
        *   在 `MessageItemAssistant.vue` 中，通过 `watch` 监听 `allVariants.value.length` 的变化。当新变体被添加时，自动调用 `chatStore.updateSelectedVariant`，将用户的选择持久化为最新的变体。
        *   **理由：** 这是一个符合直觉的用户体验：用户请求重试，系统自动展示并“选择”最新的结果。

*   **理由 (Phase Rationale)：**
    *   此阶段确保了“所见即所得”的完整闭环。用户不仅在操作时能影响后端，在重新加载应用或会话时，也能看到自己之前的选择。
    *   完善了数据生命周期管理，提高了系统的健壮性。

*   **预期成果 (Expected Outcome)：**
    *   重启应用或切换会话后，用户之前选择的变体能够被正确地显示在 UI 上。
    *   整个变体选择功能在数据、逻辑和表现上完全一致。

---

### **阶段五：全面测试与验证 (Comprehensive Testing & Validation)**

*   **目标：** 验证修复的有效性，并确保没有引入新的问题。

*   **事项 (Items)：**
    1.  **功能验证 (Functional Validation)：**
        *   逐一复现 `bugs.md` 中提到的所有六个场景，确认问题已完全解决。
        *   验证在每个场景下，LLM 的行为是否符合预期（基于用户选择的变体内容及其元数据）。
    2.  **持久化验证 (Persistence Validation)：**
        *   测试在进行变体选择后，检查数据库 `conversations` 表的 `context_chain` 字段是否已更新为正确的 JSON 字符串。
        *   重启 DeepChat 应用，重新加载会话，确认用户选择的变体是否能被正确恢复。
        *   测试切换不同会话，然后切回，变体选择是否能被正确恢复。
    3.  **向后兼容性测试 (Backward Compatibility Testing)：**
        *   **新版应用读取旧版数据库：** 使用一个 `context_chain` 为 `NULL` 或 `[]` 的旧数据库，确保新版应用能正常启动，旧会话能优雅处理（默认显示主消息），且不会导致崩溃。
        *   **旧版应用读取新版数据库：** （如果可行）部署旧版应用，使用一个已被新版应用修改过 `context_chain` 的数据库，确保旧版应用能正常运行，且不会崩溃。
    4.  **回归测试 (Regression Testing)：**
        *   对应用的其他核心功能（如普通对话、工具调用、搜索、文件上传、消息编辑等）进行回归测试，确保本次修改没有引入副作用。
    5.  **边缘情况测试 (Edge Case Testing)：**
        *   增加专门的测试用例，验证当 `selectedVariantsMap` 中记录的 `selectedVariantId` 指向一个已不存在的变体时，前后端的回退逻辑是否按预期工作（即优雅地回退到主消息）。
        *   测试在变体生成过程中切换变体选择的行为。
        *   测试删除主助手消息或变体消息后，`selectedVariantsMap` 是否被正确清理，并且数据库中的 `context_chain` 字段也得到更新。
    6.  **性能测试 (Performance Testing)：**
        *   进行基本的性能测试，确保引入的 `Map` 转换和 JSON 序列化/反序列化没有在处理长对话历史时引起明显的性能下降。

*   **理由 (Phase Rationale)：**
    *   确保修复的质量和稳定性，避免引入新的问题，保障用户体验。
    *   验证所有设计决策在实际运行中的正确性。

### **相关源代码**

*   `C:\dev\deepchat\src\main\presenter\sqlitePresenter\index.ts`
*   `C:\dev\deepchat\src\main\presenter\threadPresenter\index.ts`
*   `C:\dev\deepchat\src\main\presenter\threadPresenter\messageManager.ts`
*   `C:\dev\deepchat\src\renderer\src\components\message\MessageItemAssistant.vue`
*   `C:\dev\deepchat\src\renderer\src\components\message\MessageItemUser.vue`
*   `C:\dev\deepchat\src\renderer\src\components\message\MessageList.vue`
*   `C:\dev\deepchat\src\renderer\src\stores\chat.ts`
*   `C:\dev\deepchat\src\shared\chat.d.ts`
*   `C:\dev\deepchat\src\shared\presenter.d.ts`
*   `C:\dev\deepchat\src\shared\types\index.d.ts`
*   `C:\dev\deepchat\src\shared\types\presenters\legacy.presenters.d.ts`
*   `C:\dev\deepchat\src\main\presenter\sqlitePresenter\tables\conversations.ts`
*   `C:\dev\deepchat\src\main\presenter\sqlitePresenter\tables\messages.ts`
