# PicPilot Agent 平台项目对话模型设计

日期：2026-06-09

## 背景

当前 Agent 模式是“多轮对话 + 图片任务”的通用画廊助手：

- `AgentConversation` 保存标题、活动轮次、轮次数组和消息数组。
- `AgentRound` 通过 `parentRoundId` 形成分支树，并绑定输入图、遮罩、输出任务和 Responses 输出。
- 图片结果通过 `TaskRecord` 关联回 Agent 会话、轮次、消息和工具调用。
- 系统提示词描述为通用 `multi-turn gallery app`，starter prompt 仍使用泛化“电商主图/详情页”表达。

用户明确要求“不要笼统的电商，按平台区分开”。因此本设计把 Agent 从通用聊天改成“平台项目对话”：每个会话都有明确平台、商品 brief、平台资产计划、平台校验和图片产物。

## 参考结论

平台侧参考：

- Ozon 将商品图片按平台规则管理，包含商品图片、主图/附图要求、尺寸比例、文件大小、禁止水印/联系方式/误导内容等约束。PicPilot 的 Ozon 对话必须按 Ozon 槽位和规则生成、校验，而不是泛称电商图。
- 独立站没有单一平台规范，核心约束来自品牌、详情页结构、转化场景和连续叙事。它需要和 Ozon 分开，因为它更重视页面模块和品牌一致性。
- Amazon 和 Shopify 可以作为后续平台目标，但首版不交付完整平台工作流，避免入口可见但行为不完整。

开源/AI 产品侧参考：

- Dify 将会话变量和 workflow 状态从聊天文本中分离。
- LangGraph 通过 thread/checkpoint 保存可恢复的 Agent 状态。
- Open WebUI 将 workspace、knowledge、prompts、model presets 分开管理。
- LibreChat 将 agents、artifacts、RAG、image generation 等能力分层组织。

共同结论：PicPilot 不应只把平台信息写进 prompt，而应把平台上下文、资产槽位、工具产物和校验结果作为持久结构存储。

## 目标

1. 首版支持两个平台项目类型：`ozon` 和 `independent_site`。
2. Agent 新会话必须有平台语义，UI 不再用泛化“电商”入口文案。
3. 会话持久保存平台 brief 和资产计划，后续轮次可继承上下文。
4. 图片任务可归属到平台资产槽位，例如 Ozon 主图、Ozon 附图、独立站首屏图、独立站卖点图。
5. Agent prompt 根据平台注册表注入平台规则、槽位、生成策略和校验指令。
6. 保留现有对话分支树，但在平台项目里将分支解释为某个步骤或资产槽位的候选路径。
7. 保持旧会话可读、可继续使用；旧数据默认进入 `generic_legacy` 兼容路径，用户可手动转换为 `ozon` 或 `independent_site`，不丢失历史图片任务。

## 非目标

1. 首版不完整实现 Amazon/Shopify 的 UI 和 prompt 工作流，只预留类型与注册表扩展点。
2. 首版不直接发布到 Ozon 或独立站后台，不做 API 上架。
3. 首版不重写图片生成底层工具链，继续复用现有 Responses API、`generate_image_batch`、`continue_generation`、任务卡片和并发队列。
4. 首版不引入复杂工作流画布；平台项目对话仍在 Agent 模式内完成。
5. 首版不做严格像素级图像检测，只做结构化规则提示、人工可见校验项和可扩展的元数据校验。

## 核心概念

### 平台

平台是 Agent 会话的一级维度，不是标签。平台决定：

- 输入 brief 需要哪些字段。
- starter prompts 显示哪些任务。
- 可生成哪些资产槽位。
- 系统 prompt 注入哪些平台规则。
- 结果区如何分组。
- 校验面板展示哪些风险。

首版平台：

- `ozon`：面向 Ozon 商品卡和富内容素材。
- `independent_site`：面向独立站商品页和品牌详情页素材。

预留平台：

- `amazon`：后续支持 Amazon 主图、副图、生活方式图、A+ 图、广告图。
- `shopify`：后续支持 Shopify 商品媒体、变体图、集合页图、店铺模块图。

### 商品 Brief

`platformBrief` 是会话级上下文，记录平台项目需要持续继承的信息。

建议字段：

```ts
export interface AgentPlatformBrief {
  productName?: string
  category?: string
  targetMarket?: string
  audience?: string
  brandTone?: string
  sellingPoints?: string[]
  restrictions?: string[]
  sourceUrl?: string
  locale?: string
}
```

Ozon 可以优先使用 `productName`、`category`、`targetMarket`、`sellingPoints`、`restrictions`。独立站可以更重视 `brandTone`、`audience`、`sourceUrl`、`sellingPoints`。

### 资产槽位

资产槽位描述一个平台项目需要交付的图片类型。

```ts
export interface AgentPlatformAssetSlot {
  id: string
  label: string
  platformId: AgentPlatformId
  description: string
  defaultAspectRatio?: string
  minCount?: number
  maxCount?: number
  required?: boolean
}
```

Ozon 首版槽位：

- `ozon_main`: 主图。
- `ozon_gallery`: 附图/图库图。
- `ozon_infographic`: 信息图。
- `ozon_rich_content`: 富内容图。

独立站首版槽位：

- `site_hero`: 商品页首屏图。
- `site_detail_module`: 详情模块图。
- `site_selling_point`: 卖点图。
- `site_lifestyle`: 场景图。

### 资产计划

`assetPlan` 是会话级计划，记录当前平台项目准备生成哪些槽位、每个槽位的状态和候选任务。

```ts
export interface AgentPlatformAssetPlanItem {
  slotId: string
  promptHint?: string
  status: 'planned' | 'generating' | 'ready' | 'needs_revision'
  taskIds: string[]
  approvedTaskId?: string
  notes?: string
}
```

## 数据模型设计

### 类型扩展

在 `src/types.ts` 添加平台相关类型：

```ts
export type AgentPlatformId =
  | 'ozon'
  | 'independent_site'
  | 'amazon'
  | 'shopify'
  | 'generic_legacy'

export type AgentRoundStepType =
  | 'brief'
  | 'plan'
  | 'generate'
  | 'revise'
  | 'validate'
  | 'export'
```

扩展 `AgentConversation`：

```ts
export interface AgentConversation {
  id: string
  title: string
  platformId?: AgentPlatformId
  platformBrief?: AgentPlatformBrief
  assetPlan?: AgentPlatformAssetPlanItem[]
  activeRoundId?: string | null
  createdAt: number
  updatedAt: number
  rounds: AgentRound[]
  messages: AgentMessage[]
}
```

扩展 `AgentRound`：

```ts
export interface AgentRound {
  id: string
  index: number
  parentRoundId?: string | null
  stepType?: AgentRoundStepType
  targetAssetSlotId?: string | null
  platformNotes?: string[]
  userMessageId: string
  assistantMessageId?: string
  prompt: string
  inputImageIds: string[]
  maskTargetImageId?: string | null
  maskImageId?: string | null
  outputTaskIds: string[]
  responseId?: string
  responseOutput?: ResponsesOutputItem[]
  status: AgentRoundStatus
  error: string | null
  createdAt: number
  finishedAt: number | null
}
```

扩展 `TaskRecord`：

```ts
export interface TaskRecord {
  platformId?: AgentPlatformId
  platformAssetSlotId?: string | null
  assetStatus?: 'candidate' | 'approved' | 'rejected'
  validationWarnings?: string[]
}
```

### 兼容策略

旧会话没有 `platformId`：

- 读取时保留旧数据，不丢消息、轮次和任务。
- 如果用户继续旧会话，默认以 `generic_legacy` 兼容模式运行，UI 显示“旧对话”。
- 用户可以手动选择平台，将旧会话转为 `ozon` 或 `independent_site`。
- 新建会话必须选择平台，默认建议 `independent_site`，但 UI 不把它叫“电商”。

旧任务没有平台字段：

- 继续按现有 round/task 关系展示。
- 只有新平台会话生成的任务写入平台资产槽位。

## 平台注册表

新增目录：

```txt
src/lib/platforms/
  registry.ts
  types.ts
  ozon.ts
  independentSite.ts
  amazon.ts
  shopify.ts
```

注册表接口：

```ts
export interface AgentPlatformDefinition {
  id: AgentPlatformId
  label: string
  shortLabel: string
  description: string
  enabled: boolean
  assetSlots: AgentPlatformAssetSlot[]
  starterPrompts: AgentPlatformStarterPrompt[]
  buildInstructions: (context: AgentPlatformPromptContext) => string
  validateAsset?: (asset: AgentPlatformAssetValidationInput) => AgentPlatformValidationResult
}
```

`registry.ts` 提供：

- `getAgentPlatformDefinition(platformId)`
- `getEnabledAgentPlatforms()`
- `getAgentPlatformAssetSlot(platformId, slotId)`
- `normalizeAgentPlatformId(value)`

### Ozon 定义

Ozon prompt 必须强调：

- 按 Ozon 商品卡素材规划，不写泛化“电商图”。
- 主图优先展示商品主体，背景干净，主体比例稳定。
- 附图可以展示角度、包装、细节、使用场景。
- 信息图只在用户需要时生成，文案要克制，避免把无关促销和联系方式放进图里。
- 富内容图强调连贯模块、卖点拆分和商品可信度。
- 不生成平台禁止或高风险元素，例如水印、联系方式、误导性徽章、无关品牌标识。

### 独立站定义

独立站 prompt 必须强调：

- 按商品页模块组织素材，不套用 marketplace 主图规则。
- 首屏图服务于品牌第一印象和转化入口。
- 详情模块图要能和文案/卖点连续配合。
- 卖点图强调单图一个信息点。
- 场景图强调目标受众、使用情境和品牌语气。
- 不默认白底，不默认平台化主图比例；按 brief 和用户输入决定。

### Amazon/Shopify 预留

`amazon.ts` 和 `shopify.ts` 可以导出 `enabled: false` 定义，用于类型、测试和未来扩展，不在首版 UI 平台选择里展示。

## Agent Prompt 与工具链

### Prompt 构建

当前 `agentApi.ts` 中 `createAgentInstructions` 只接收 settings 和工具能力。首版应改为接收可选平台上下文：

```ts
function createAgentInstructions(opts: {
  settings: AppSettings
  hostedImageTool: boolean
  platform?: AgentPlatformDefinition
  brief?: AgentPlatformBrief
  assetPlan?: AgentPlatformAssetPlanItem[]
})
```

平台说明通过 `platform.buildInstructions()` 拼入系统指令。通用图像工具策略仍保留，包括：

- progressive batch generation。
- reference tags。
- `generate_image_batch`。
- `continue_generation`。
- web search policy。

平台指令不能替代用户意图，只能约束“如何为该平台组织和校验素材”。

### API 输入

`buildAgentApiInput` 应在当前轮次输入前注入平台上下文摘要，建议使用内部 user/system-like item，而不是把上下文混进用户可见消息。

上下文摘要包含：

- 平台名称。
- 商品 brief。
- 当前资产计划。
- 当前目标槽位。
- 已生成并归属的资产。

### 工具结果归属

图片任务创建时，如果当前轮次有 `targetAssetSlotId`，则写入：

- `task.platformId`
- `task.platformAssetSlotId`
- `task.assetStatus = 'candidate'`

如果模型一次生成多个槽位，首版允许只归属到当前轮次槽位。跨槽位批量归属留到后续通过 `generate_image_batch` schema 扩展解决。

## UI 设计

### 新会话入口

Agent 空状态从通用 starter 改为平台选择：

- Ozon：商品卡素材、主图/附图/信息图/富内容。
- 独立站：首屏图、详情模块、卖点图、场景图。

选择平台后，显示该平台 starter prompts。

### 会话侧边栏

`ConversationListItem` 显示平台 badge：

- `Ozon`
- `独立站`
- `旧对话`

搜索应覆盖平台 label、会话标题和消息文本。

### 会话头

`AgentConversationHeader` 显示：

- 平台名称。
- 商品名称或类目摘要。
- 当前资产计划进度，例如 `2/4 槽位有候选图`。

### 结果区

现有 active path 仍展示消息流，但生成图区域增加平台槽位分组：

- 当前轮次直接输出的任务仍在助手消息下可见。
- 会话级结果面板按资产槽位汇总候选图。
- 用户可将某个候选标记为 approved/rejected。

首版不需要复杂拖拽排序，避免超出范围。

## 状态流

### 新建 Ozon 会话

1. 用户进入 Agent 空状态。
2. 选择 `Ozon`。
3. 系统创建会话，写入 `platformId: 'ozon'` 和空 brief。
4. 用户选择 starter 或输入需求。
5. 提交时创建 round，`stepType` 默认为 `generate` 或由输入意图推断。
6. prompt 注入 Ozon 注册表规则。
7. 图片任务写入 Ozon 资产槽位。
8. 结果区按 Ozon 槽位展示候选。

### 新建独立站会话

流程同上，但：

- prompt 注入独立站规则。
- starter prompts 围绕页面模块和品牌叙事。
- 默认不套用 Ozon 主图限制。

### 旧会话继续

1. 旧会话读取为 `generic_legacy`。
2. UI 显示“旧对话”。
3. 继续提交时不强制平台槽位。
4. 用户选择平台后，后续轮次写入平台字段。

## 错误处理

- 平台 id 无效：读取时归一化为 `generic_legacy`，新建时不允许无效平台。
- 槽位 id 不属于当前平台：提交前清空 `targetAssetSlotId`，并使用 `showAppToast` 提示。
- 平台定义缺失：回退到 `generic_legacy` 指令，记录 logger error，不阻断旧会话展示。
- 校验警告不阻断生成，只作为结果提示展示。
- 不使用 `window.alert`、`window.confirm`、`window.prompt`；所有交互提示继续走 `src/lib/dialog.ts` 和 store toast。

## 文件边界

需要避免继续膨胀大文件：

- `src/components/AgentWorkspace.tsx` 当前已接近 1000 行，新增 UI 必须拆到 `src/components/agentWorkspace/` 下的新组件。
- `src/lib/agentOrchestrator.ts` 已超过 1000 行，平台逻辑应放入 `src/lib/agentPlatform*.ts` 或 `src/lib/platforms/`。
- `src/lib/agentApi.ts` 已超过 1000 行，prompt 拼装应抽出到独立 helper，避免继续堆系统指令。

建议新增文件：

```txt
src/lib/platforms/types.ts
src/lib/platforms/registry.ts
src/lib/platforms/ozon.ts
src/lib/platforms/independentSite.ts
src/lib/platforms/amazon.ts
src/lib/platforms/shopify.ts
src/lib/agentPlatformContext.ts
src/lib/agentPlatformPersistence.ts
src/components/agentWorkspace/AgentPlatformPicker.tsx
src/components/agentWorkspace/AgentPlatformBadge.tsx
src/components/agentWorkspace/AgentAssetPlanPanel.tsx
```

## 测试计划

### 单元测试

新增或扩展：

- `src/lib/platforms/registry.test.ts`
  - enabled 平台只返回 Ozon 和独立站。
  - Amazon/Shopify 定义存在但 disabled。
  - 无效平台 id 归一化为 `generic_legacy`。

- `src/lib/agentPersistence.test.ts`
  - 旧会话无平台字段仍可 normalize。
  - 新会话平台字段、brief、assetPlan 可持久化。
  - running round 恢复为 error 的现有行为不被破坏。

- `src/lib/agentApi.test.ts`
  - Ozon 会话注入 Ozon 指令。
  - 独立站会话注入独立站指令。
  - 无平台旧会话不注入 Ozon/独立站规则。

- `src/lib/agentPlatformContext.test.ts`
  - 平台 brief 和 assetPlan 能构造成 API 上下文摘要。
  - 目标槽位只接受当前平台定义内的槽位。

### Store/Orchestrator 测试

扩展 `src/store.test.ts` 或拆新测试：

- 新建平台会话写入 `platformId`。
- 提交指定槽位的 Agent 消息后，round 写入 `targetAssetSlotId`。
- 生成任务绑定 `platformId` 和 `platformAssetSlotId`。
- 旧会话继续提交不强制平台。

### 组件测试

根据现有测试栈添加：

- 平台选择入口显示 Ozon 和独立站，不显示 Amazon/Shopify。
- starter prompts 随平台变化。
- 会话列表展示平台 badge。
- 资产计划面板按槽位聚合任务。

### 验证命令

实现完成后至少运行：

```bash
npm run lint
npm test
npm run build
```

如果 UI 改动较大，应启动 dev server 并用浏览器检查 Agent 空状态、新建 Ozon 会话、新建独立站会话和旧会话展示。

## 交付顺序

1. 添加平台类型、注册表和测试。
2. 扩展持久化 normalize/merge，保证旧数据兼容。
3. 扩展会话创建和提交链路，写入 platform/slot/step metadata。
4. 抽出平台 prompt/context helper，并接入 Agent API。
5. 拆 Agent UI 组件，添加平台选择、badge、starter prompts 和资产计划展示。
6. 补齐任务归属、approved/rejected 状态和校验警告展示。
7. 全量验证 lint/test/build。

## 验收标准

1. 新建 Agent 会话时用户能选择 Ozon 或独立站。
2. Ozon 会话 starter、prompt 指令、资产槽位和结果分组都使用 Ozon 语义。
3. 独立站会话 starter、prompt 指令、资产槽位和结果分组都使用独立站语义。
4. UI 不再把首版入口笼统称作“电商”。
5. 历史 Agent 会话仍可打开、搜索、继续，不丢轮次和图片任务。
6. 新生成的图片任务能追溯到平台和资产槽位。
7. 代码没有新增 `window.alert`、`window.confirm`、`window.prompt`。
8. 未继续扩大 `AgentWorkspace.tsx`、`agentOrchestrator.ts`、`agentApi.ts` 的职责；新增逻辑有清晰模块边界。
9. `npm run lint`、`npm test`、`npm run build` 通过。

## 明确取舍

- 首版只做 Ozon 和独立站，因为用户明确要求按平台区分，且前一轮已经新增 Ozon 支持。Amazon/Shopify 只预留结构，避免半成品平台入口。
- 平台规则先以 prompt/context/metadata 约束为主，不做图像内容自动判定，避免引入不稳定视觉审核链路。
- 资产槽位先服务于 PicPilot 内部组织和人工选择，不做直接发布。
- 保留对话树和现有任务卡片，减少迁移风险，把重设计集中在平台上下文和资产模型上。
