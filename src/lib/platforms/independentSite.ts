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
