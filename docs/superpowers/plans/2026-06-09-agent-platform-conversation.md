# Agent Platform Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign PicPilot Agent conversations into platform-specific projects for Ozon and independent sites, with platform brief, asset slots, platform-aware prompts, task attribution, and UI entry points.

**Architecture:** Add platform metadata as first-class persisted Agent state while preserving the existing conversation tree and task model. Platform definitions live in a small registry under `src/lib/platforms/`; orchestration and API prompt code consume helpers instead of embedding platform rules directly in large files. UI changes are split into focused `agentWorkspace` components to keep `AgentWorkspace.tsx` under the 1000-line rule.

**Tech Stack:** TypeScript, React, Zustand store, Vitest, IndexedDB persistence helpers, OpenAI Responses-compatible Agent API.

**Repo rule:** Do not create git commits unless the user explicitly asks. Each task ends with a verification checkpoint instead of a commit step.

---

## File Structure

Create:

- `src/lib/platforms/types.ts`: Platform ids, slot definitions, starter prompt types, validation result types, and `AgentPlatformDefinition`.
- `src/lib/platforms/ozon.ts`: Enabled Ozon platform definition, asset slots, starter prompts, and Ozon prompt instructions.
- `src/lib/platforms/independentSite.ts`: Enabled independent site definition, asset slots, starter prompts, and independent site prompt instructions.
- `src/lib/platforms/amazon.ts`: Disabled Amazon placeholder definition for future extension.
- `src/lib/platforms/shopify.ts`: Disabled Shopify placeholder definition for future extension.
- `src/lib/platforms/registry.ts`: Lookup and normalization helpers.
- `src/lib/platforms/registry.test.ts`: Unit tests for enabled platforms, disabled placeholders, slot lookup, and normalization.
- `src/lib/agentPlatformContext.ts`: Build invisible platform context for API input, derive target slot, summarize asset plan, and assign platform metadata to tasks.
- `src/lib/agentPlatformContext.test.ts`: Unit tests for platform context and slot validation.
- `src/components/agentWorkspace/AgentPlatformBadge.tsx`: Compact platform label used by sidebar/header.
- `src/components/agentWorkspace/AgentPlatformPicker.tsx`: Empty-state platform selector and platform starter prompts.
- `src/components/agentWorkspace/AgentAssetPlanPanel.tsx`: Slot-grouped candidate/approved/rejected image task summary.

Modify:

- `src/types.ts`: Add platform types to Agent conversations, rounds, messages if needed, and tasks.
- `src/lib/agentPersistence.ts`: Normalize and persist platform fields while preserving old conversations as `generic_legacy`.
- `src/lib/agentApi.ts`: Accept platform instructions through a helper and keep generic image/tool policy intact.
- `src/lib/agentOrchestrator.ts`: Set round step/slot metadata, pass platform context to API, and assign platform metadata to created tasks.
- `src/store.ts`: Let `createAgentConversation` accept an optional platform id, add setters for conversation platform and task asset status, preserve draft behavior.
- `src/store.test.ts`: Cover platform conversation creation, persistence integration, round slot metadata, and task attribution.
- `src/lib/agentApi.test.ts`: Cover platform instruction injection without making network calls.
- `src/components/AgentWorkspace.tsx`: Wire new child components only; avoid adding large UI blocks inline.
- `src/components/agentWorkspace/AgentStarterPanel.tsx`: Replace generic starter prompt panel with platform-aware wrapper or delete if superseded.
- `src/components/agentWorkspace/ConversationListItem.tsx`: Show platform badge.
- `src/components/agentWorkspace/AgentConversationSidebar.tsx`: Pass badge data through list item if needed.
- `src/components/agentWorkspace/AgentConversationHeader.tsx`: Show platform and asset plan progress.
- `src/components/agentWorkspace/conversationMetrics.ts`: Include platform text in search and asset plan metrics.
- `src/components/agentWorkspace/assistantBlocks.ts`: No platform logic unless task grouping requires a helper import.

---

### Task 1: Platform Registry And Shared Types

**Files:**

- Modify: `src/types.ts`
- Create: `src/lib/platforms/types.ts`
- Create: `src/lib/platforms/ozon.ts`
- Create: `src/lib/platforms/independentSite.ts`
- Create: `src/lib/platforms/amazon.ts`
- Create: `src/lib/platforms/shopify.ts`
- Create: `src/lib/platforms/registry.ts`
- Test: `src/lib/platforms/registry.test.ts`

- [ ] **Step 1: Write failing registry tests**

Create `src/lib/platforms/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  getAgentPlatformAssetSlot,
  getAgentPlatformDefinition,
  getEnabledAgentPlatforms,
  normalizeAgentPlatformId,
} from './registry'

describe('agent platform registry', () => {
  it('exposes only Ozon and independent site as enabled platforms', () => {
    expect(getEnabledAgentPlatforms().map((platform) => platform.id)).toEqual(['ozon', 'independent_site'])
  })

  it('keeps Amazon and Shopify definitions disabled for future extension', () => {
    expect(getAgentPlatformDefinition('amazon')?.enabled).toBe(false)
    expect(getAgentPlatformDefinition('shopify')?.enabled).toBe(false)
  })

  it('normalizes invalid platform values to generic_legacy', () => {
    expect(normalizeAgentPlatformId('ozon')).toBe('ozon')
    expect(normalizeAgentPlatformId('independent_site')).toBe('independent_site')
    expect(normalizeAgentPlatformId('not-real')).toBe('generic_legacy')
    expect(normalizeAgentPlatformId(null)).toBe('generic_legacy')
  })

  it('looks up asset slots only within their owning platform', () => {
    expect(getAgentPlatformAssetSlot('ozon', 'ozon_main')?.label).toBe('主图')
    expect(getAgentPlatformAssetSlot('ozon', 'site_hero')).toBeNull()
    expect(getAgentPlatformAssetSlot('independent_site', 'site_hero')?.label).toBe('首屏图')
  })
})
```

- [ ] **Step 2: Run registry tests and verify failure**

Run:

```bash
npm test -- src/lib/platforms/registry.test.ts
```

Expected: FAIL because `src/lib/platforms/registry.ts` does not exist.

- [ ] **Step 3: Add platform types to `src/types.ts`**

Insert before `AgentMessageRole`:

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

export type AgentAssetStatus = 'candidate' | 'approved' | 'rejected'

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

export interface AgentPlatformAssetPlanItem {
  slotId: string
  promptHint?: string
  status: 'planned' | 'generating' | 'ready' | 'needs_revision'
  taskIds: string[]
  approvedTaskId?: string
  notes?: string
}
```

Extend `TaskRecord` near Agent fields:

```ts
  /** Agent 平台项目 ID */
  platformId?: AgentPlatformId
  /** Agent 平台资产槽位 ID */
  platformAssetSlotId?: string | null
  /** 平台资产候选状态 */
  assetStatus?: AgentAssetStatus
  /** 平台规则校验提示 */
  validationWarnings?: string[]
```

Extend `AgentRound`:

```ts
  stepType?: AgentRoundStepType
  targetAssetSlotId?: string | null
  platformNotes?: string[]
```

Extend `AgentConversation`:

```ts
  platformId?: AgentPlatformId
  platformBrief?: AgentPlatformBrief
  assetPlan?: AgentPlatformAssetPlanItem[]
```

- [ ] **Step 4: Create `src/lib/platforms/types.ts`**

```ts
import type { AgentPlatformAssetPlanItem, AgentPlatformBrief, AgentPlatformId, TaskRecord } from '../../types'

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

export interface AgentPlatformStarterPrompt {
  id: string
  title: string
  description: string
  prompt: string
  targetAssetSlotId?: string
}

export interface AgentPlatformPromptContext {
  brief?: AgentPlatformBrief
  assetPlan?: AgentPlatformAssetPlanItem[]
  targetAssetSlotId?: string | null
}

export interface AgentPlatformAssetValidationInput {
  task: TaskRecord
  slot: AgentPlatformAssetSlot
}

export interface AgentPlatformValidationResult {
  warnings: string[]
}

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

- [ ] **Step 5: Create platform definitions**

Create `src/lib/platforms/ozon.ts`:

```ts
import type { AgentPlatformDefinition } from './types'

export const ozonPlatform: AgentPlatformDefinition = {
  id: 'ozon',
  label: 'Ozon',
  shortLabel: 'Ozon',
  description: '面向 Ozon 商品卡、主图、附图、信息图和富内容素材。',
  enabled: true,
  assetSlots: [
    { id: 'ozon_main', label: '主图', platformId: 'ozon', description: '商品卡首图，主体清楚，背景干净。', defaultAspectRatio: '3:4', minCount: 1, maxCount: 1, required: true },
    { id: 'ozon_gallery', label: '附图', platformId: 'ozon', description: '展示角度、包装、细节或使用方式。', defaultAspectRatio: '3:4', minCount: 2, maxCount: 8 },
    { id: 'ozon_infographic', label: '信息图', platformId: 'ozon', description: '用克制文字解释关键卖点或规格。', defaultAspectRatio: '3:4', maxCount: 4 },
    { id: 'ozon_rich_content', label: '富内容图', platformId: 'ozon', description: '详情模块中的连续卖点图。', defaultAspectRatio: '3:4', maxCount: 8 },
  ],
  starterPrompts: [
    { id: 'ozon-main', title: 'Ozon 主图', description: '3:4 商品卡首图', targetAssetSlotId: 'ozon_main', prompt: '为这个商品生成 Ozon 主图：3:4 竖图，主体居中，背景干净，材质真实，边缘清晰，不添加水印、联系方式、促销贴纸或无关品牌标识。输出 4 个候选版本。' },
    { id: 'ozon-gallery', title: 'Ozon 附图', description: '角度、包装、细节', targetAssetSlotId: 'ozon_gallery', prompt: '为这个商品规划并生成 Ozon 附图候选：展示不同角度、包装、材质细节和真实使用方式。每张图只服务一个明确展示目的。' },
    { id: 'ozon-infographic', title: 'Ozon 信息图', description: '规格和卖点可视化', targetAssetSlotId: 'ozon_infographic', prompt: '为这个商品生成 Ozon 信息图候选：只保留必要卖点和规格说明，文字克制，避免联系方式、水印、夸张促销和误导性徽章。' },
    { id: 'ozon-rich-content', title: 'Ozon 富内容', description: '详情模块连续图', targetAssetSlotId: 'ozon_rich_content', prompt: '为这个商品生成 Ozon 富内容图方案：拆成连续模块，每个模块突出一个卖点，整体视觉统一，商品可信，不使用无关装饰。' },
  ],
  buildInstructions: ({ targetAssetSlotId }) => [
    '## Platform: Ozon',
    'Treat this conversation as an Ozon listing asset project, not a generic ecommerce task.',
    'Use Ozon-oriented asset slots: main image, gallery images, infographic images, and rich content images.',
    'Prefer 3:4 vertical compositions when the user does not specify another ratio.',
    'Do not add watermarks, contact information, unrelated brand marks, misleading badges, or aggressive promotional stickers.',
    'Main image requests should keep the product clear, centered, realistically lit, and easy to inspect.',
    'Gallery images may show angles, packaging, scale, details, and usage context.',
    'Infographic images should use restrained text only when useful and requested by the task.',
    targetAssetSlotId ? `Current target asset slot: ${targetAssetSlotId}.` : '',
  ].filter(Boolean).join('\n'),
}
```

Create `src/lib/platforms/independentSite.ts`:

```ts
import type { AgentPlatformDefinition } from './types'

export const independentSitePlatform: AgentPlatformDefinition = {
  id: 'independent_site',
  label: '独立站',
  shortLabel: '独立站',
  description: '面向品牌独立站商品页首屏、详情模块、卖点和场景素材。',
  enabled: true,
  assetSlots: [
    { id: 'site_hero', label: '首屏图', platformId: 'independent_site', description: '商品页第一屏视觉，承接品牌和转化入口。', required: true },
    { id: 'site_detail_module', label: '详情模块', platformId: 'independent_site', description: '和页面文案配合的详情段落图片。', minCount: 2, maxCount: 8 },
    { id: 'site_selling_point', label: '卖点图', platformId: 'independent_site', description: '单图表达一个核心卖点。', minCount: 2, maxCount: 6 },
    { id: 'site_lifestyle', label: '场景图', platformId: 'independent_site', description: '目标受众和真实使用情境。', maxCount: 6 },
  ],
  starterPrompts: [
    { id: 'site-hero', title: '独立站首屏', description: '品牌第一印象', targetAssetSlotId: 'site_hero', prompt: '为这个商品生成独立站商品页首屏图：突出品牌质感和购买场景，画面可以有情境，不默认白底。输出 4 个候选方向，并说明各自适合的页面语气。' },
    { id: 'site-detail', title: '详情模块图', description: '连续详情页素材', targetAssetSlotId: 'site_detail_module', prompt: '为这个商品规划独立站详情模块图：按页面叙事拆成 4 个模块，每个模块对应一个卖点或使用理由，视觉保持品牌一致。' },
    { id: 'site-selling-point', title: '卖点图', description: '单图单信息点', targetAssetSlotId: 'site_selling_point', prompt: '为这个商品生成独立站卖点图候选：每张图只表达一个核心卖点，避免信息堆叠，适合搭配短标题和正文。' },
    { id: 'site-lifestyle', title: '场景图', description: '受众和使用情境', targetAssetSlotId: 'site_lifestyle', prompt: '为这个商品生成独立站场景图：围绕目标受众、使用环境和品牌语气设计真实情境，不套用 marketplace 主图规则。' },
  ],
  buildInstructions: ({ targetAssetSlotId }) => [
    '## Platform: Independent site',
    'Treat this conversation as a brand-owned product page asset project, not a marketplace listing task.',
    'Organize assets by product page modules: hero image, detail module images, selling point images, and lifestyle images.',
    'Do not default to white-background marketplace imagery unless the user asks for it.',
    'Keep brand tone, target audience, page narrative, and conversion context consistent across generated assets.',
    'For selling point images, communicate one message per image.',
    targetAssetSlotId ? `Current target asset slot: ${targetAssetSlotId}.` : '',
  ].filter(Boolean).join('\n'),
}
```

Create disabled placeholders:

```ts
// src/lib/platforms/amazon.ts
import type { AgentPlatformDefinition } from './types'

export const amazonPlatform: AgentPlatformDefinition = {
  id: 'amazon',
  label: 'Amazon',
  shortLabel: 'Amazon',
  description: '预留 Amazon 主图、副图、生活方式图、A+ 和广告素材。',
  enabled: false,
  assetSlots: [],
  starterPrompts: [],
  buildInstructions: () => '',
}
```

```ts
// src/lib/platforms/shopify.ts
import type { AgentPlatformDefinition } from './types'

export const shopifyPlatform: AgentPlatformDefinition = {
  id: 'shopify',
  label: 'Shopify',
  shortLabel: 'Shopify',
  description: '预留 Shopify 商品媒体、变体图、集合页图和店铺模块图。',
  enabled: false,
  assetSlots: [],
  starterPrompts: [],
  buildInstructions: () => '',
}
```

- [ ] **Step 6: Create registry**

Create `src/lib/platforms/registry.ts`:

```ts
import type { AgentPlatformId } from '../../types'
import { amazonPlatform } from './amazon'
import { independentSitePlatform } from './independentSite'
import { ozonPlatform } from './ozon'
import { shopifyPlatform } from './shopify'
import type { AgentPlatformAssetSlot, AgentPlatformDefinition } from './types'

const PLATFORM_DEFINITIONS: AgentPlatformDefinition[] = [
  ozonPlatform,
  independentSitePlatform,
  amazonPlatform,
  shopifyPlatform,
]

const PLATFORM_BY_ID = new Map<AgentPlatformId, AgentPlatformDefinition>(
  PLATFORM_DEFINITIONS.map((platform) => [platform.id, platform]),
)

export function normalizeAgentPlatformId(value: unknown): AgentPlatformId {
  return value === 'ozon' || value === 'independent_site' || value === 'amazon' || value === 'shopify'
    ? value
    : 'generic_legacy'
}

export function getAgentPlatformDefinition(platformId: AgentPlatformId | null | undefined): AgentPlatformDefinition | null {
  if (!platformId || platformId === 'generic_legacy') return null
  return PLATFORM_BY_ID.get(platformId) ?? null
}

export function getEnabledAgentPlatforms(): AgentPlatformDefinition[] {
  return PLATFORM_DEFINITIONS.filter((platform) => platform.enabled)
}

export function getAgentPlatformAssetSlot(platformId: AgentPlatformId | null | undefined, slotId: string | null | undefined): AgentPlatformAssetSlot | null {
  if (!slotId) return null
  const platform = getAgentPlatformDefinition(platformId)
  return platform?.assetSlots.find((slot) => slot.id === slotId) ?? null
}
```

- [ ] **Step 7: Run registry tests**

Run:

```bash
npm test -- src/lib/platforms/registry.test.ts
```

Expected: PASS.

- [ ] **Step 8: Typecheck this slice through lint**

Run:

```bash
npm run lint
```

Expected: no new errors. Existing warnings may remain.

---

### Task 2: Persistence Normalization For Platform Conversations

**Files:**

- Modify: `src/lib/agentPersistence.ts`
- Test: add tests in `src/lib/agentPersistence.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Create `src/lib/agentPersistence.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { normalizeAgentConversations, getPersistableAgentConversation } from './agentPersistence'
import type { AgentConversation } from '../types'

function baseConversation(patch: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conversation-a',
    title: '新对话',
    activeRoundId: null,
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    ...patch,
  }
}

describe('agent platform persistence', () => {
  it('normalizes old conversations to generic_legacy without losing content', () => {
    const [conversation] = normalizeAgentConversations([baseConversation({ title: '旧对话' })])

    expect(conversation.platformId).toBe('generic_legacy')
    expect(conversation.title).toBe('旧对话')
    expect(conversation.rounds).toEqual([])
    expect(conversation.messages).toEqual([])
  })

  it('preserves platform brief and asset plan for new conversations', () => {
    const [conversation] = normalizeAgentConversations([
      baseConversation({
        platformId: 'ozon',
        platformBrief: {
          productName: '保温杯',
          sellingPoints: ['316 不锈钢', '长效保温'],
          restrictions: ['不要联系方式'],
        },
        assetPlan: [{
          slotId: 'ozon_main',
          status: 'ready',
          taskIds: ['task-a'],
          approvedTaskId: 'task-a',
          notes: '主图候选',
        }],
      }),
    ])

    expect(conversation.platformId).toBe('ozon')
    expect(conversation.platformBrief?.productName).toBe('保温杯')
    expect(conversation.platformBrief?.sellingPoints).toEqual(['316 不锈钢', '长效保温'])
    expect(conversation.assetPlan?.[0]).toMatchObject({
      slotId: 'ozon_main',
      status: 'ready',
      taskIds: ['task-a'],
      approvedTaskId: 'task-a',
    })
  })

  it('normalizes invalid platform fields and invalid asset plan items', () => {
    const [conversation] = normalizeAgentConversations([
      {
        ...baseConversation(),
        platformId: 'bad-platform',
        platformBrief: { productName: 123, sellingPoints: ['ok', 123] },
        assetPlan: [
          { slotId: 'slot-a', status: 'planned', taskIds: ['task-a', 123] },
          { slotId: '', status: 'bad', taskIds: [] },
        ],
      },
    ])

    expect(conversation.platformId).toBe('generic_legacy')
    expect(conversation.platformBrief).toEqual({ sellingPoints: ['ok'] })
    expect(conversation.assetPlan).toEqual([{ slotId: 'slot-a', status: 'planned', taskIds: ['task-a'] }])
  })

  it('keeps platform fields in persistable conversations', () => {
    const persistable = getPersistableAgentConversation(baseConversation({
      platformId: 'independent_site',
      platformBrief: { productName: '手工灯' },
      assetPlan: [{ slotId: 'site_hero', status: 'planned', taskIds: [] }],
    }))

    expect(persistable.platformId).toBe('independent_site')
    expect(persistable.platformBrief?.productName).toBe('手工灯')
    expect(persistable.assetPlan?.[0]?.slotId).toBe('site_hero')
  })
})
```

- [ ] **Step 2: Run persistence tests and verify failure**

Run:

```bash
npm test -- src/lib/agentPersistence.test.ts
```

Expected: FAIL because platform normalization is not implemented.

- [ ] **Step 3: Implement platform normalization helpers**

Modify `src/lib/agentPersistence.ts` imports:

```ts
import type {
  AgentConversation,
  AgentMessage,
  AgentPlatformAssetPlanItem,
  AgentPlatformBrief,
  AgentRound,
  ResponsesOutputItem,
} from '../types'
import { normalizeAgentPlatformId } from './platforms/registry'
```

Add helpers below `normalizeStringArray`:

```ts
function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  const items = normalizeStringArray(value).map((item) => item.trim()).filter(Boolean)
  return items.length ? items : undefined
}

function normalizeAgentPlatformBrief(value: unknown): AgentPlatformBrief | undefined {
  if (!isRecord(value)) return undefined
  const brief: AgentPlatformBrief = {}
  const productName = normalizeOptionalString(value.productName)
  const category = normalizeOptionalString(value.category)
  const targetMarket = normalizeOptionalString(value.targetMarket)
  const audience = normalizeOptionalString(value.audience)
  const brandTone = normalizeOptionalString(value.brandTone)
  const sourceUrl = normalizeOptionalString(value.sourceUrl)
  const locale = normalizeOptionalString(value.locale)
  const sellingPoints = normalizeOptionalStringArray(value.sellingPoints)
  const restrictions = normalizeOptionalStringArray(value.restrictions)
  if (productName) brief.productName = productName
  if (category) brief.category = category
  if (targetMarket) brief.targetMarket = targetMarket
  if (audience) brief.audience = audience
  if (brandTone) brief.brandTone = brandTone
  if (sourceUrl) brief.sourceUrl = sourceUrl
  if (locale) brief.locale = locale
  if (sellingPoints) brief.sellingPoints = sellingPoints
  if (restrictions) brief.restrictions = restrictions
  return Object.keys(brief).length ? brief : undefined
}

function normalizeAssetPlanStatus(value: unknown): AgentPlatformAssetPlanItem['status'] {
  return value === 'generating' || value === 'ready' || value === 'needs_revision' ? value : 'planned'
}

function normalizeAgentAssetPlan(value: unknown): AgentPlatformAssetPlanItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter(isRecord)
    .map((item): AgentPlatformAssetPlanItem | null => {
      const slotId = normalizeOptionalString(item.slotId)
      if (!slotId) return null
      const promptHint = normalizeOptionalString(item.promptHint)
      const approvedTaskId = normalizeOptionalString(item.approvedTaskId)
      const notes = normalizeOptionalString(item.notes)
      return {
        slotId,
        status: normalizeAssetPlanStatus(item.status),
        taskIds: normalizeStringArray(item.taskIds),
        ...(promptHint ? { promptHint } : {}),
        ...(approvedTaskId ? { approvedTaskId } : {}),
        ...(notes ? { notes } : {}),
      }
    })
    .filter((item): item is AgentPlatformAssetPlanItem => Boolean(item))
  return items.length ? items : undefined
}
```

Extend `normalizeAgentRound`:

```ts
    ...(round.stepType === 'brief' || round.stepType === 'plan' || round.stepType === 'generate' || round.stepType === 'revise' || round.stepType === 'validate' || round.stepType === 'export'
      ? { stepType: round.stepType }
      : {}),
    targetAssetSlotId: typeof round.targetAssetSlotId === 'string' ? round.targetAssetSlotId : null,
    ...(Array.isArray(round.platformNotes) ? { platformNotes: normalizeStringArray(round.platformNotes) } : {}),
```

Extend `normalizeAgentConversations` returned object:

```ts
      const platformBrief = normalizeAgentPlatformBrief(conversation.platformBrief)
      const assetPlan = normalizeAgentAssetPlan(conversation.assetPlan)
      return {
        id: conversation.id,
        title: typeof conversation.title === 'string' && conversation.title.trim() ? conversation.title : '新对话',
        platformId: normalizeAgentPlatformId(conversation.platformId),
        ...(platformBrief ? { platformBrief } : {}),
        ...(assetPlan ? { assetPlan } : {}),
        activeRoundId: typeof conversation.activeRoundId === 'string' && roundIds.has(conversation.activeRoundId) ? conversation.activeRoundId : rounds[rounds.length - 1]?.id ?? null,
        createdAt: typeof conversation.createdAt === 'number' ? conversation.createdAt : Date.now(),
        updatedAt: typeof conversation.updatedAt === 'number' ? conversation.updatedAt : Date.now(),
        rounds,
        messages,
      }
```

- [ ] **Step 4: Run persistence tests**

Run:

```bash
npm test -- src/lib/agentPersistence.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run existing store persistence tests**

Run:

```bash
npm test -- src/store.test.ts -t "agent conversation persistence"
```

Expected: PASS.

---

### Task 3: Store Actions And Platform Conversation Creation

**Files:**

- Modify: `src/store.ts`
- Modify: `src/store.test.ts`

- [ ] **Step 1: Write failing store tests for platform creation**

Add under `describe('agent conversation creation', ...)` in `src/store.test.ts`:

```ts
  it('creates a platform conversation when a platform id is provided', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_000)
    useStore.setState({ agentConversations: [], activeAgentConversationId: null })

    const id = useStore.getState().createAgentConversation('ozon')

    const state = useStore.getState()
    expect(state.activeAgentConversationId).toBe(id)
    expect(state.agentConversations).toHaveLength(1)
    expect(state.agentConversations[0]).toMatchObject({
      id,
      platformId: 'ozon',
      assetPlan: [
        { slotId: 'ozon_main', status: 'planned', taskIds: [] },
        { slotId: 'ozon_gallery', status: 'planned', taskIds: [] },
        { slotId: 'ozon_infographic', status: 'planned', taskIds: [] },
        { slotId: 'ozon_rich_content', status: 'planned', taskIds: [] },
      ],
    })
    now.mockRestore()
  })

  it('does not reuse an empty conversation from a different platform', () => {
    const existing = agentConversation({ id: 'empty-ozon', platformId: 'ozon', createdAt: 1_000, updatedAt: 1_000 })
    useStore.setState({ agentConversations: [existing], activeAgentConversationId: existing.id })

    const id = useStore.getState().createAgentConversation('independent_site')

    const state = useStore.getState()
    expect(id).not.toBe(existing.id)
    expect(state.agentConversations).toHaveLength(2)
    expect(state.agentConversations.find((conversation) => conversation.id === id)?.platformId).toBe('independent_site')
  })
```

Add a new `describe('agent platform task status', ...)`:

```ts
describe('agent platform task status', () => {
  it('marks an agent platform task as approved and rejects siblings in the same slot', () => {
    useStore.setState({
      tasks: [
        task({ id: 'task-a', sourceMode: 'agent', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
        task({ id: 'task-b', sourceMode: 'agent', platformId: 'ozon', platformAssetSlotId: 'ozon_main', assetStatus: 'candidate' }),
        task({ id: 'task-c', sourceMode: 'agent', platformId: 'ozon', platformAssetSlotId: 'ozon_gallery', assetStatus: 'candidate' }),
      ],
    })

    useStore.getState().setAgentTaskAssetStatus('task-b', 'approved')

    expect(useStore.getState().tasks.map((item) => [item.id, item.assetStatus])).toEqual([
      ['task-a', 'rejected'],
      ['task-b', 'approved'],
      ['task-c', 'candidate'],
    ])
  })
})
```

- [ ] **Step 2: Run targeted store tests and verify failure**

Run:

```bash
npm test -- src/store.test.ts -t "agent conversation creation|agent platform task status"
```

Expected: FAIL because `createAgentConversation` does not accept a platform id and `setAgentTaskAssetStatus` is missing.

- [ ] **Step 3: Update store type and creation helper**

Modify imports in `src/store.ts`:

```ts
  AgentAssetStatus,
  AgentPlatformId,
```

Import registry helpers:

```ts
import { getAgentPlatformDefinition, normalizeAgentPlatformId } from './lib/platforms/registry'
```

Replace local `createAgentConversation` with:

```ts
function createDefaultAssetPlan(platformId: AgentPlatformId) {
  const platform = getAgentPlatformDefinition(platformId)
  if (!platform?.enabled) return undefined
  return platform.assetSlots.map((slot) => ({
    slotId: slot.id,
    status: 'planned' as const,
    taskIds: [],
  }))
}

function createAgentConversation(now = Date.now(), platformId?: AgentPlatformId): AgentConversation {
  const normalizedPlatformId = platformId ? normalizeAgentPlatformId(platformId) : 'generic_legacy'
  const assetPlan = createDefaultAssetPlan(normalizedPlatformId)
  return {
    id: genId(),
    title: '新对话',
    platformId: normalizedPlatformId,
    ...(assetPlan ? { assetPlan } : {}),
    activeRoundId: null,
    createdAt: now,
    updatedAt: now,
    rounds: [],
    messages: [],
  }
}
```

Update `AppState`:

```ts
  createAgentConversation: (platformId?: AgentPlatformId) => string
  setAgentTaskAssetStatus: (taskId: string, status: AgentAssetStatus) => void
```

Update store implementation:

```ts
      createAgentConversation: (platformId) => {
        const now = Date.now()
        const normalizedPlatformId = platformId ? normalizeAgentPlatformId(platformId) : 'generic_legacy'
        const latestConversation = getLatestAgentConversation(get().agentConversations)
        if (
          latestConversation &&
          isEmptyAgentConversation(latestConversation) &&
          (latestConversation.platformId ?? 'generic_legacy') === normalizedPlatformId
        ) {
          set((state) => {
            const agentInputDrafts = saveActiveAgentInputDrafts(state)
            const assetPlan = latestConversation.assetPlan ?? createDefaultAssetPlan(normalizedPlatformId)
            return {
              agentConversations: state.agentConversations.map((conversation) =>
                conversation.id === latestConversation.id
                  ? { ...conversation, platformId: normalizedPlatformId, ...(assetPlan ? { assetPlan } : {}), createdAt: now, updatedAt: now }
                  : conversation,
              ),
              activeAgentConversationId: latestConversation.id,
              agentInputDrafts,
              agentSidebarCollapsed: true,
              agentEditingRoundId: null,
              ...restoreAgentInputDraftState(agentInputDrafts, latestConversation.id),
            }
          })
          return latestConversation.id
        }

        const conversation = createAgentConversation(now, normalizedPlatformId)
        set((state) => {
          const agentInputDrafts = saveActiveAgentInputDrafts(state)
          return {
            agentConversations: [...state.agentConversations, conversation],
            activeAgentConversationId: conversation.id,
            agentInputDrafts,
            agentSidebarCollapsed: true,
            agentEditingRoundId: null,
            ...restoreAgentInputDraftState(agentInputDrafts, conversation.id),
          }
        })
        return conversation.id
      },
```

Add task status action near task setters:

```ts
      setAgentTaskAssetStatus: (taskId, status) => set((state) => {
        const target = state.tasks.find((task) => task.id === taskId)
        if (!target?.platformId || !target.platformAssetSlotId) {
          return { tasks: state.tasks.map((task) => task.id === taskId ? { ...task, assetStatus: status } : task) }
        }
        return {
          tasks: state.tasks.map((task) => {
            if (task.id === taskId) return { ...task, assetStatus: status }
            if (
              status === 'approved' &&
              task.platformId === target.platformId &&
              task.platformAssetSlotId === target.platformAssetSlotId &&
              task.assetStatus === 'candidate'
            ) {
              return { ...task, assetStatus: 'rejected' as const }
            }
            return task
          }),
        }
      }),
```

- [ ] **Step 4: Run targeted store tests**

Run:

```bash
npm test -- src/store.test.ts -t "agent conversation creation|agent platform task status"
```

Expected: PASS.

- [ ] **Step 5: Run all store tests**

Run:

```bash
npm test -- src/store.test.ts
```

Expected: PASS.

---

### Task 4: Platform API Context And Prompt Injection

**Files:**

- Create: `src/lib/agentPlatformContext.ts`
- Test: `src/lib/agentPlatformContext.test.ts`
- Modify: `src/lib/agentApi.ts`
- Modify: `src/lib/agentApi.test.ts`

- [ ] **Step 1: Write platform context tests**

Create `src/lib/agentPlatformContext.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { AgentConversation, AgentRound, TaskRecord } from '../types'
import { buildAgentPlatformContextItem, getValidAgentTargetAssetSlotId, withAgentPlatformTaskMetadata } from './agentPlatformContext'

function conversation(patch: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conversation-a',
    title: 'Ozon 项目',
    platformId: 'ozon',
    platformBrief: { productName: '保温杯', sellingPoints: ['保温 12 小时'] },
    assetPlan: [{ slotId: 'ozon_main', status: 'planned', taskIds: ['task-a'] }],
    activeRoundId: 'round-a',
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    ...patch,
  }
}

function round(patch: Partial<AgentRound> = {}): AgentRound {
  return {
    id: 'round-a',
    index: 1,
    parentRoundId: null,
    userMessageId: 'user-a',
    prompt: '生成主图',
    inputImageIds: [],
    outputTaskIds: [],
    status: 'running',
    error: null,
    createdAt: 1,
    finishedAt: null,
    ...patch,
  }
}

function task(patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: {} as TaskRecord['params'],
    inputImageIds: [],
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: 1,
    finishedAt: null,
    elapsed: null,
    ...patch,
  }
}

describe('agent platform context', () => {
  it('builds invisible API context for a platform conversation', () => {
    const item = buildAgentPlatformContextItem(conversation(), round({ targetAssetSlotId: 'ozon_main' }), [task()])

    expect(item).toMatchObject({ role: 'user' })
    expect(JSON.stringify(item)).toContain('Platform: Ozon')
    expect(JSON.stringify(item)).toContain('保温杯')
    expect(JSON.stringify(item)).toContain('ozon_main')
  })

  it('returns null context for legacy conversations', () => {
    expect(buildAgentPlatformContextItem(conversation({ platformId: 'generic_legacy' }), round(), [])).toBeNull()
  })

  it('accepts only target slots from the current platform', () => {
    expect(getValidAgentTargetAssetSlotId('ozon', 'ozon_main')).toBe('ozon_main')
    expect(getValidAgentTargetAssetSlotId('ozon', 'site_hero')).toBeNull()
  })

  it('adds platform metadata to agent tasks', () => {
    expect(withAgentPlatformTaskMetadata(task(), conversation(), round({ targetAssetSlotId: 'ozon_main' }))).toMatchObject({
      platformId: 'ozon',
      platformAssetSlotId: 'ozon_main',
      assetStatus: 'candidate',
    })
  })
})
```

- [ ] **Step 2: Run platform context tests and verify failure**

Run:

```bash
npm test -- src/lib/agentPlatformContext.test.ts
```

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement `agentPlatformContext.ts`**

Create `src/lib/agentPlatformContext.ts`:

```ts
import type { AgentConversation, AgentPlatformId, AgentRound, TaskRecord } from '../types'
import { getAgentPlatformAssetSlot, getAgentPlatformDefinition } from './platforms/registry'

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (Array.isArray(item)) return item.length > 0
    return item != null && item !== ''
  }))
}

export function getValidAgentTargetAssetSlotId(platformId: AgentPlatformId | null | undefined, slotId: string | null | undefined) {
  return getAgentPlatformAssetSlot(platformId, slotId)?.id ?? null
}

export function buildAgentPlatformContextItem(conversation: AgentConversation, round: AgentRound, tasks: TaskRecord[]): Record<string, unknown> | null {
  const platform = getAgentPlatformDefinition(conversation.platformId)
  if (!platform?.enabled) return null
  const targetSlotId = getValidAgentTargetAssetSlotId(platform.id, round.targetAssetSlotId)
  const targetSlot = getAgentPlatformAssetSlot(platform.id, targetSlotId)
  const platformTasks = tasks
    .filter((task) => task.agentConversationId === conversation.id && task.platformId === platform.id)
    .map((task) => compactObject({
      id: task.id,
      slotId: task.platformAssetSlotId,
      status: task.assetStatus,
      prompt: task.prompt,
      outputCount: task.outputImages.length,
    }))

  return {
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: [
          '<platform_context>',
          `Platform: ${platform.label}`,
          `Platform ID: ${platform.id}`,
          conversation.platformBrief ? `Brief: ${JSON.stringify(conversation.platformBrief)}` : '',
          conversation.assetPlan ? `Asset plan: ${JSON.stringify(conversation.assetPlan)}` : '',
          targetSlot ? `Current target slot: ${targetSlot.id} (${targetSlot.label})` : '',
          platformTasks.length ? `Existing platform tasks: ${JSON.stringify(platformTasks)}` : '',
          '</platform_context>',
        ].filter(Boolean).join('\n'),
      },
    ],
  }
}

export function withAgentPlatformTaskMetadata<T extends TaskRecord>(task: T, conversation: AgentConversation, round: AgentRound): T {
  const platform = getAgentPlatformDefinition(conversation.platformId)
  const targetAssetSlotId = getValidAgentTargetAssetSlotId(platform?.id, round.targetAssetSlotId)
  if (!platform?.enabled || !targetAssetSlotId) return task
  return {
    ...task,
    platformId: platform.id,
    platformAssetSlotId: targetAssetSlotId,
    assetStatus: task.assetStatus ?? 'candidate',
  }
}
```

- [ ] **Step 4: Run platform context tests**

Run:

```bash
npm test -- src/lib/agentPlatformContext.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing Agent API prompt tests**

In `src/lib/agentApi.test.ts`, add tests near existing `callAgentResponsesApi` body assertions:

```ts
  it('injects Ozon platform instructions when provided', async () => {
    await callAgentResponsesApi({
      settings: { ...settings, agentModel: DEFAULT_RESPONSES_MODEL },
      profile,
      params,
      input: 'hello',
      platformContext: {
        platformId: 'ozon',
        brief: { productName: '保温杯' },
        assetPlan: [{ slotId: 'ozon_main', status: 'planned', taskIds: [] }],
        targetAssetSlotId: 'ozon_main',
      },
    })

    const body = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string)
    expect(body.instructions).toContain('## Platform: Ozon')
    expect(body.instructions).toContain('Ozon listing asset project')
    expect(body.instructions).toContain('ozon_main')
  })

  it('injects independent site instructions when provided', async () => {
    await callAgentResponsesApi({
      settings: { ...settings, agentModel: DEFAULT_RESPONSES_MODEL },
      profile,
      params,
      input: 'hello',
      platformContext: {
        platformId: 'independent_site',
        brief: { productName: '手工灯' },
        targetAssetSlotId: 'site_hero',
      },
    })

    const body = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string)
    expect(body.instructions).toContain('## Platform: Independent site')
    expect(body.instructions).toContain('brand-owned product page asset project')
    expect(body.instructions).toContain('site_hero')
  })
```

- [ ] **Step 6: Run Agent API tests and verify failure**

Run:

```bash
npm test -- src/lib/agentApi.test.ts -t "platform instructions"
```

Expected: FAIL because `platformContext` is not accepted.

- [ ] **Step 7: Modify `agentApi.ts` to accept platform context**

Import:

```ts
import type { AgentPlatformAssetPlanItem, AgentPlatformBrief, AgentPlatformId } from '../types'
import { getAgentPlatformDefinition } from './platforms/registry'
```

Add option type:

```ts
export interface AgentApiPlatformContext {
  platformId?: AgentPlatformId
  brief?: AgentPlatformBrief
  assetPlan?: AgentPlatformAssetPlanItem[]
  targetAssetSlotId?: string | null
}
```

Replace `createAgentInstructions(settings, hostedImageTool)` with:

```ts
function createAgentInstructions(settings: AppSettings, hostedImageTool: boolean, platformContext?: AgentApiPlatformContext) {
  const maxToolRounds = Number.isFinite(settings.agentMaxToolRounds)
    ? Math.max(1, Math.trunc(settings.agentMaxToolRounds))
    : DEFAULT_AGENT_MAX_TOOL_ROUNDS
  const platform = getAgentPlatformDefinition(platformContext?.platformId)
  const platformInstructions = platform?.enabled
    ? [
        '',
        platform.buildInstructions({
          brief: platformContext?.brief,
          assetPlan: platformContext?.assetPlan,
          targetAssetSlotId: platformContext?.targetAssetSlotId,
        }),
      ]
    : []
  const noHostedToolDirective = hostedImageTool ? [] : [
    '',
    '## IMPORTANT — how to generate images',
    'You do NOT have a built-in image-generation tool. To produce ANY image — including a single image — you MUST call the generate_image_batch function with one or more image entries.',
    'Never draw with HTML/SVG/markdown, never describe an image as a substitute for generating it, and never claim an image tool you do not have.',
  ]
  return [
    AGENT_IMAGE_INSTRUCTIONS,
    ...platformInstructions,
    ...noHostedToolDirective,
    '',
    '## Tool policy',
    `- Current maximum tool-use rounds for this Agent turn: ${maxToolRounds}.`,
    '- Call continue_generation ONLY when you have generated a prerequisite image and need another round to generate dependent images. Do NOT call it when the task is complete.',
    ...(hostedImageTool ? ['- When web_search is available, use it only when current external information would improve the answer or the user asks for research/news/facts.'] : []),
    '- When the requested task is complete, stop calling tools and provide the final response.',
  ].join('\n')
}
```

Extend `callAgentResponsesApi` options:

```ts
  platformContext?: AgentApiPlatformContext
```

Use:

```ts
      instructions: createAgentInstructions(settings, chatModelSupportsHostedImageTool(model), opts.platformContext),
```

- [ ] **Step 8: Run Agent API platform tests**

Run:

```bash
npm test -- src/lib/agentApi.test.ts -t "platform instructions"
```

Expected: PASS.

---

### Task 5: Orchestrator Round Metadata And Task Attribution

**Files:**

- Modify: `src/lib/agentOrchestrator.ts`
- Modify: `src/store.test.ts`

- [ ] **Step 1: Write failing orchestrator/store integration test**

Add to `src/store.test.ts` near Agent submit tests:

```ts
describe('agent platform submit metadata', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: '为 Ozon 生成主图',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      agentConversations: [agentConversation({
        id: 'conversation-platform',
        platformId: 'ozon',
        assetPlan: [{ slotId: 'ozon_main', status: 'planned', taskIds: [] }],
      })],
      activeAgentConversationId: 'conversation-platform',
      agentEditingRoundId: null,
      showToast: vi.fn(),
    })
  })

  it('stores platform step and target slot on submitted rounds', async () => {
    useStore.getState().setAgentTargetAssetSlotId('ozon_main')

    await submitAgentMessage()

    const conversation = useStore.getState().agentConversations.find((item) => item.id === 'conversation-platform')
    expect(conversation?.rounds[0]).toMatchObject({
      stepType: 'generate',
      targetAssetSlotId: 'ozon_main',
    })
    expect(callAgentResponsesApi).toHaveBeenCalledWith(expect.objectContaining({
      platformContext: expect.objectContaining({
        platformId: 'ozon',
        targetAssetSlotId: 'ozon_main',
      }),
    }))
  })
})
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm test -- src/store.test.ts -t "agent platform submit metadata"
```

Expected: FAIL because target slot state and platform context are not wired.

- [ ] **Step 3: Add target slot state to store**

Modify `AppState`:

```ts
  agentTargetAssetSlotId: string | null
  setAgentTargetAssetSlotId: (slotId: string | null) => void
```

Initial state:

```ts
      agentTargetAssetSlotId: null,
```

Action:

```ts
      setAgentTargetAssetSlotId: (agentTargetAssetSlotId) => set({ agentTargetAssetSlotId }),
```

Clear it when switching conversations and after submit:

```ts
agentTargetAssetSlotId: null,
```

- [ ] **Step 4: Wire platform helpers in orchestrator**

Modify `src/lib/agentOrchestrator.ts` imports:

```ts
import { buildAgentPlatformContextItem, getValidAgentTargetAssetSlotId, withAgentPlatformTaskMetadata } from './agentPlatformContext'
```

Extend `AppStateSlice`:

```ts
  agentTargetAssetSlotId: string | null
  setAgentTargetAssetSlotId: (id: string | null) => void
```

In `submitAgentMessage`, derive target slot:

```ts
  const targetAssetSlotId = getValidAgentTargetAssetSlotId(conversation.platformId, state.agentTargetAssetSlotId)
```

Add to `round`:

```ts
    stepType: targetAssetSlotId ? 'generate' : undefined,
    targetAssetSlotId,
```

After clearing editing state:

```ts
  state.setAgentTargetAssetSlotId(null)
```

In `buildAgentApiInput`, inject context before current user item:

```ts
  const platformContextItem = buildAgentPlatformContextItem(conversation, currentRound, tasks)
  if (platformContextItem) input.push(platformContextItem)
```

In `executeAgentRound`, pass platform context:

```ts
        platformContext: {
          platformId: conversation.platformId,
          brief: conversation.platformBrief,
          assetPlan: conversation.assetPlan,
          targetAssetSlotId: round.targetAssetSlotId,
        },
```

When creating any `TaskRecord` for Agent output, wrap before storing:

```ts
      const taskWithPlatform = withAgentPlatformTaskMetadata(task, conversation, round)
      getState().setTasks([taskWithPlatform, ...getState().tasks])
      await putTask(taskWithPlatform)
```

Apply this in:

- `ensureStreamingAgentTask`
- built-in image result fallback task creation

- [ ] **Step 5: Run platform submit metadata test**

Run:

```bash
npm test -- src/store.test.ts -t "agent platform submit metadata"
```

Expected: PASS.

- [ ] **Step 6: Run Agent-related tests**

Run:

```bash
npm test -- src/store.test.ts src/lib/agentApi.test.ts src/lib/agentPlatformContext.test.ts
```

Expected: PASS.

---

### Task 6: Platform-Aware Agent UI

**Files:**

- Create: `src/components/agentWorkspace/AgentPlatformBadge.tsx`
- Create: `src/components/agentWorkspace/AgentPlatformPicker.tsx`
- Create: `src/components/agentWorkspace/AgentAssetPlanPanel.tsx`
- Modify: `src/components/AgentWorkspace.tsx`
- Modify: `src/components/agentWorkspace/AgentConversationHeader.tsx`
- Modify: `src/components/agentWorkspace/AgentConversationSidebar.tsx`
- Modify: `src/components/agentWorkspace/ConversationListItem.tsx`
- Modify: `src/components/agentWorkspace/conversationMetrics.ts`
- Modify: `src/components/agentWorkspace/AgentStarterPanel.tsx` or remove its usage

- [ ] **Step 1: Add focused UI unit test for platform picker**

Create `src/components/agentWorkspace/AgentPlatformPicker.test.tsx` using the existing `@testing-library/react` setup:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentPlatformPicker from './AgentPlatformPicker'

afterEach(() => cleanup())

describe('AgentPlatformPicker', () => {
  it('shows enabled platforms and hides disabled future platforms', () => {
    const onSelectPlatform = vi.fn()
    render(<AgentPlatformPicker onSelectPlatform={onSelectPlatform} />)

    expect(screen.getByRole('button', { name: /Ozon/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /独立站/ })).not.toBeNull()
    expect(screen.queryByText('Amazon')).toBeNull()
    expect(screen.queryByText('Shopify')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Ozon/ }))
    expect(onSelectPlatform).toHaveBeenCalledWith('ozon')
  })
})
```

- [ ] **Step 2: Create platform badge**

Create `src/components/agentWorkspace/AgentPlatformBadge.tsx`:

```tsx
import type { AgentPlatformId } from '../../types'
import { getAgentPlatformDefinition } from '../../lib/platforms/registry'

export default function AgentPlatformBadge({ platformId }: { platformId?: AgentPlatformId | null }) {
  const platform = getAgentPlatformDefinition(platformId ?? 'generic_legacy')
  const label = platform?.shortLabel ?? '旧对话'
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-md border border-gray-200 bg-white px-1.5 text-[11px] font-medium text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-400">
      {label}
    </span>
  )
}
```

- [ ] **Step 3: Create platform picker**

Create `src/components/agentWorkspace/AgentPlatformPicker.tsx`:

```tsx
import type { AgentPlatformId } from '../../types'
import { getEnabledAgentPlatforms } from '../../lib/platforms/registry'

export default function AgentPlatformPicker({
  onSelectPlatform,
}: {
  onSelectPlatform: (platformId: AgentPlatformId) => void
}) {
  const platforms = getEnabledAgentPlatforms()
  return (
    <div className="mx-auto flex min-h-[46vh] w-full max-w-3xl flex-col justify-start px-4 pb-[calc(var(--input-bar-clearance,12rem)+2rem)] pt-2 sm:pt-4 lg:pt-5">
      <h2 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">选择平台项目</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">不同平台使用不同素材槽位、生成策略和校验规则。</p>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        {platforms.map((platform) => (
          <button
            key={platform.id}
            type="button"
            onClick={() => onSelectPlatform(platform.id)}
            className="min-h-[6rem] rounded-xl border border-gray-200 bg-white px-4 py-3 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:border-blue-400/30 dark:hover:bg-blue-500/10"
          >
            <span className="block text-sm font-semibold text-gray-900 dark:text-white">{platform.label}</span>
            <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-gray-400">{platform.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Refactor starter panel to platform prompts**

Replace static `AGENT_STARTER_PROMPTS` in `src/components/agentWorkspace/AgentStarterPanel.tsx` with props:

```tsx
import type { AgentPlatformStarterPrompt } from '../../lib/platforms/types'
import { WrenchIcon } from '../icons'

export default function AgentStarterPanel({
  label,
  title,
  description,
  starterPrompts,
  onApplyPrompt,
}: {
  label: string
  title: string
  description: string
  starterPrompts: readonly AgentPlatformStarterPrompt[]
  onApplyPrompt: (prompt: string, targetAssetSlotId?: string) => void
}) {
  return (
    <div className="mx-auto flex min-h-[46vh] w-full max-w-3xl flex-col justify-start px-4 pb-[calc(var(--input-bar-clearance,12rem)+2rem)] pt-2 sm:pt-4 lg:pt-5">
      <div className="mb-5 inline-flex w-fit items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400">
        <WrenchIcon className="h-4 w-4 text-blue-500" />
        {label}
      </div>
      <h2 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">{description}</p>
      <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {starterPrompts.map((starter) => (
          <button
            key={starter.id}
            type="button"
            onClick={() => onApplyPrompt(starter.prompt, starter.targetAssetSlotId)}
            className="min-h-[4.5rem] rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/40 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:border-blue-400/30 dark:hover:bg-blue-500/10"
          >
            <span className="block text-sm font-semibold text-gray-900 dark:text-white">{starter.title}</span>
            <span className="mt-1 block truncate text-xs leading-5 text-gray-500 dark:text-gray-400">{starter.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Create asset plan panel**

Create `src/components/agentWorkspace/AgentAssetPlanPanel.tsx`:

```tsx
import type { AgentConversation, TaskRecord } from '../../types'
import { getAgentPlatformAssetSlot, getAgentPlatformDefinition } from '../../lib/platforms/registry'

export default function AgentAssetPlanPanel({
  conversation,
  tasks,
  onSetTaskAssetStatus,
}: {
  conversation: AgentConversation | null
  tasks: TaskRecord[]
  onSetTaskAssetStatus: (taskId: string, status: 'candidate' | 'approved' | 'rejected') => void
}) {
  const platform = getAgentPlatformDefinition(conversation?.platformId)
  if (!conversation || !platform?.enabled || !conversation.assetPlan?.length) return null

  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  return (
    <section className="border-b border-gray-200/70 px-4 py-3 dark:border-white/[0.08]">
      <div className="mb-2 text-xs font-semibold text-gray-500 dark:text-gray-400">平台资产</div>
      <div className="grid gap-2 lg:grid-cols-2">
        {conversation.assetPlan.map((item) => {
          const slot = getAgentPlatformAssetSlot(platform.id, item.slotId)
          const slotTasks = item.taskIds.map((taskId) => tasksById.get(taskId)).filter(Boolean) as TaskRecord[]
          return (
            <div key={item.slotId} className="rounded-xl border border-gray-200 bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.03]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-gray-900 dark:text-white">{slot?.label ?? item.slotId}</span>
                <span className="text-[11px] text-gray-400">{slotTasks.length} 个候选</span>
              </div>
              {slotTasks.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {slotTasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => onSetTaskAssetStatus(task.id, task.assetStatus === 'approved' ? 'candidate' : 'approved')}
                      className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                        task.assetStatus === 'approved'
                          ? 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300'
                          : task.assetStatus === 'rejected'
                          ? 'bg-gray-100 text-gray-400 dark:bg-white/[0.05] dark:text-gray-500'
                          : 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
                      }`}
                    >
                      {task.assetStatus === 'approved' ? '已选' : task.assetStatus === 'rejected' ? '已排除' : '候选'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
```

- [ ] **Step 6: Wire UI in `AgentWorkspace.tsx`**

Import new helpers/components:

```tsx
import AgentAssetPlanPanel from './agentWorkspace/AgentAssetPlanPanel'
import AgentPlatformPicker from './agentWorkspace/AgentPlatformPicker'
import { getAgentPlatformDefinition } from '../lib/platforms/registry'
```

Read store:

```tsx
  const setAgentTargetAssetSlotId = useStore((s) => s.setAgentTargetAssetSlotId)
  const setAgentTaskAssetStatus = useStore((s) => s.setAgentTaskAssetStatus)
```

Add handlers:

```tsx
  const handleSelectPlatform = useCallback((platformId: AgentPlatformId) => {
    createConversation(platformId)
  }, [createConversation])

  const handleApplyPlatformPrompt = useCallback((prompt: string, targetAssetSlotId?: string) => {
    if (targetAssetSlotId) setAgentTargetAssetSlotId(targetAssetSlotId)
    useStore.getState().setPrompt(prompt)
  }, [setAgentTargetAssetSlotId])
```

In empty state rendering:

```tsx
const activePlatform = getAgentPlatformDefinition(activeConversation?.platformId)
if (!activeConversation || activeConversation.platformId === 'generic_legacy') {
  return <AgentPlatformPicker onSelectPlatform={handleSelectPlatform} />
}
return (
  <AgentStarterPanel
    label={activePlatform?.label ?? '平台项目'}
    title={`${activePlatform?.label ?? '平台'}素材生成`}
    description={activePlatform?.description ?? ''}
    starterPrompts={activePlatform?.starterPrompts ?? []}
    onApplyPrompt={handleApplyPlatformPrompt}
  />
)
```

Place `AgentAssetPlanPanel` near the conversation header or above the message list:

```tsx
<AgentAssetPlanPanel
  conversation={activeConversation}
  tasks={tasks}
  onSetTaskAssetStatus={setAgentTaskAssetStatus}
/>
```

- [ ] **Step 7: Add platform badge to sidebar and header**

In `ConversationListItem.tsx`, import and render:

```tsx
import AgentPlatformBadge from './AgentPlatformBadge'
```

Near title:

```tsx
<span className="flex min-w-0 items-center gap-1.5">
  <span className={`block truncate text-sm ${isActive ? 'font-semibold text-gray-950 dark:text-white' : 'font-medium text-gray-700 dark:text-gray-300'}`}>{item.title || '新对话'}</span>
  <AgentPlatformBadge platformId={item.platformId} />
</span>
```

In `AgentConversationHeader.tsx`, add prop:

```tsx
platformId?: AgentPlatformId | null
assetPlanProgress?: string
```

Render `AgentPlatformBadge` beside status and append `assetPlanProgress` in meta row.

In `conversationMetrics.ts`, include platform in search:

```ts
import { getAgentPlatformDefinition } from '../../lib/platforms/registry'

const platform = getAgentPlatformDefinition(conversation.platformId)
return [
  conversation.title,
  platform?.label,
  platform?.shortLabel,
  ...
]
```

Add asset progress helper:

```ts
export function getConversationAssetPlanProgress(conversation: AgentConversation | null) {
  const items = conversation?.assetPlan ?? []
  if (items.length === 0) return ''
  const ready = items.filter((item) => item.taskIds.length > 0 || item.approvedTaskId).length
  return `${ready}/${items.length} 槽位`
}
```

- [ ] **Step 8: Run UI/type verification**

Run:

```bash
npm run lint
npm test -- src/lib/platforms/registry.test.ts src/lib/agentPlatformContext.test.ts src/store.test.ts
```

Expected: no new errors.

---

### Task 7: Asset Plan Updates And Final Verification

**Files:**

- Modify: `src/lib/agentOrchestrator.ts`
- Modify: `src/lib/agentPlatformContext.ts`
- Modify: `src/store.test.ts`
- Optional modify: `README.md` if user-facing docs need to mention platform Agent mode.

- [ ] **Step 1: Write failing test for asset plan task ids**

Add to the `agent platform submit metadata` describe block:

```ts
  it('adds generated platform task ids to the matching asset plan slot', async () => {
    const apiMock = vi.mocked(callAgentResponsesApi)
    apiMock.mockResolvedValueOnce({
      responseId: 'response-a',
      text: '已生成 Ozon 主图。',
      images: [{ toolCallId: 'tool-a', dataUrl: 'data:image/png;base64,out', revisedPrompt: '主图 prompt' }],
      outputItems: [],
      rawResponsePayload: '{}',
    })
    useStore.setState({ agentTargetAssetSlotId: 'ozon_main' })

    await submitAgentMessage()
    await vi.waitFor(() => {
      const conversation = useStore.getState().agentConversations.find((item) => item.id === 'conversation-platform')
      expect(conversation?.assetPlan?.find((item) => item.slotId === 'ozon_main')?.taskIds.length).toBe(1)
    })
  })
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm test -- src/store.test.ts -t "adds generated platform task ids"
```

Expected: FAIL because asset plan is not updated when tasks attach.

- [ ] **Step 3: Add asset plan update helper**

In `src/lib/agentPlatformContext.ts`, add:

```ts
import type { AgentPlatformAssetPlanItem } from '../types'

export function addTaskToAgentAssetPlan(
  assetPlan: AgentPlatformAssetPlanItem[] | undefined,
  slotId: string | null | undefined,
  taskId: string,
): AgentPlatformAssetPlanItem[] | undefined {
  if (!slotId) return assetPlan
  const existing = assetPlan ?? [{ slotId, status: 'planned' as const, taskIds: [] }]
  let matched = false
  const next = existing.map((item) => {
    if (item.slotId !== slotId) return item
    matched = true
    return {
      ...item,
      status: 'generating' as const,
      taskIds: item.taskIds.includes(taskId) ? item.taskIds : [...item.taskIds, taskId],
    }
  })
  if (matched) return next
  return [...next, { slotId, status: 'generating', taskIds: [taskId] }]
}
```

In `agentOrchestrator.ts`, import `addTaskToAgentAssetPlan`.

In `attachTaskToAgentRound`, update conversation asset plan:

```ts
        assetPlan: addTaskToAgentAssetPlan(current.assetPlan, current.rounds.find((item) => item.id === roundId)?.targetAssetSlotId, taskId),
```

When finalizing a done round, mark matching asset plan items ready:

```ts
        assetPlan: current.assetPlan?.map((item) =>
          item.taskIds.some((taskId) => taskIds.includes(taskId))
            ? { ...item, status: 'ready' as const }
            : item,
        ),
```

- [ ] **Step 4: Run asset plan test**

Run:

```bash
npm test -- src/store.test.ts -t "adds generated platform task ids"
```

Expected: PASS.

- [ ] **Step 5: Run focused platform suite**

Run:

```bash
npm test -- src/lib/platforms/registry.test.ts src/lib/agentPersistence.test.ts src/lib/agentPlatformContext.test.ts src/lib/agentApi.test.ts src/store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm run lint
npm test
npm run build
```

Expected:

- `npm run lint`: no errors. Existing warnings are acceptable only if they existed before this work.
- `npm test`: all tests pass.
- `npm run build`: production build succeeds.

- [ ] **Step 7: Browser verification for UI behavior**

Start dev server:

```bash
npm run dev -- --host 0.0.0.0
```

Open the reported local URL and verify:

- Agent empty state shows `Ozon` and `独立站`.
- It does not show `Amazon` or `Shopify`.
- Selecting `Ozon` creates an Ozon conversation and shows Ozon starter prompts.
- Selecting `独立站` creates an independent site conversation and shows independent site starter prompts.
- Sidebar conversation rows show platform badges.
- Header shows platform badge and asset plan progress.
- Starter prompts populate the input and target the expected asset slot.
- Existing old conversations still open and are labeled `旧对话`.

Stop dev server after verification.

---

## Self-Review Checklist

- Spec coverage:
  - Ozon and independent site platform ids: Task 1.
  - Amazon/Shopify disabled placeholders: Task 1.
  - Platform brief and asset plan persistence: Task 2.
  - New platform conversation creation: Task 3.
  - Platform prompt injection: Task 4.
  - Round target slot and task metadata: Task 5.
  - Platform picker, starter prompts, badges, and asset panel: Task 6.
  - Asset plan updates and final lint/test/build/browser verification: Task 7.
- Placeholder scan:
  - No placeholder tokens or vague future steps remain.
- Type consistency:
  - `AgentPlatformId`, `AgentPlatformBrief`, `AgentPlatformAssetPlanItem`, `AgentRoundStepType`, and `AgentAssetStatus` are introduced before use.
  - Store methods referenced by UI are introduced before UI task.
  - Platform registry helpers are introduced before persistence, context, and UI tasks consume them.
