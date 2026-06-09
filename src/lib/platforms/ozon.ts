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
