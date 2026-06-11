import { DEFAULT_AGENT_MAX_TOOL_ROUNDS, DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type AppSettings, type TaskParams } from '../types'
import { DEFAULT_RESPONSES_MODEL } from './apiProfiles'
import { chatModelSupportsHostedImageTool } from './chatModels'
import { getAgentPlatformAssetSlot, getAgentPlatformDefinition } from './platforms/registry'
import type { AgentApiPlatformContext } from './agentApiTypes'

const AGENT_IMAGE_INSTRUCTIONS = [
  'You are an image-generation assistant in a multi-turn gallery app.',
  '',
  '## Progressive Batch Generation',
  'For multi-image requests, use a progressive batching strategy to ensure consistency:',
  '  1. **Base Reference First:** If the images need to share a consistent style, character, or layout (e.g. PPT slides, storyboards), generate ONE primary image first to establish the visual baseline, then call continue_generation to get another round.',
  '  2. **Batch Remaining Tasks:** Once the base reference is available, list all remaining images to be generated. The app will generate them concurrently for you. In your descriptions, explicitly instruct to reference the base image to maintain consistency.',
  '  3. **Independent Images:** If the requested images are completely independent (e.g. "3 different cats"), generate them together in ONE response. Do NOT generate them one by one across multiple responses.',
  'As the turn continues, output a brief progress note before each tool call.',
  'For single-image requests, generate directly without any listing.',
  '',
  '## Generating images',
  '- One image_generation call per distinct image. Never collage.',
  '- Dependent images (a later image needs to reference an earlier one) → generate the prerequisite first, then call continue_generation. The next round will have the result available as `<ref id="..." />`.',
  '- Only generate when explicitly requested; otherwise reply with text.',
  '- Preserve the user\'s original intent faithfully. Never substitute requested subjects for copyright/trademark reasons.',
  '',
  '## Reference tags and generated images in context',
  'NEVER output `<ref>`, `<available_refs>`, `<removed_ref>`, or any XML reference tags in visible assistant text — the system injects them automatically and your raw output will be shown directly to the user.',
  '- Previously generated images are injected as user messages containing the actual image (input_image) followed by a `<ref id="round-N-image-M" prompt="..." />` tag identifying it.',
  '- Deleted images appear as `<removed_ref id="..." />` without an accompanying image — do not reference them.',
  '- In user messages: `<ref id="..." />` may also point to user-attached/cited images.',
  '- In generate_image_batch tool arguments, include matching `<ref id="..." />` tags inside each image prompt when the prompt refers to a reference image. Do not use separate bare reference ids.',
  'Resolve user mentions ("the first image") to the matching id. Only use existing ids in image_generation prompts and generate_image_batch prompts.',
].join('\n')

export function createAgentInstructions(settings: AppSettings, hostedImageTool: boolean, platformContext?: AgentApiPlatformContext) {
  const maxToolRounds = Number.isFinite(settings.agentMaxToolRounds)
    ? Math.max(1, Math.trunc(settings.agentMaxToolRounds))
    : DEFAULT_AGENT_MAX_TOOL_ROUNDS
  const platform = getAgentPlatformDefinition(platformContext?.platformId)
  const targetAssetSlotId = getAgentPlatformAssetSlot(platform?.id, platformContext?.targetAssetSlotId)?.id ?? null
  const platformInstructions = platform?.enabled
    ? [
        '',
        platform.buildInstructions({
          brief: platformContext?.brief,
          assetPlan: platformContext?.assetPlan,
          targetAssetSlotId,
        }),
      ]
    : []
  // 无托管图像工具的对话模型（grok）：所有出图都必须走 generate_image_batch，连单图也是。
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

export const AGENT_TITLE_INSTRUCTIONS = [
  'Generate a concise conversation title from the first user message.',
  'Output exactly one XML element in this form: <title>short title</title>',
  'Do not output markdown, code fences, explanations, attributes, or additional XML elements.',
  'Use the main language of the user message. Chinese titles should be no more than 12 characters. English titles should be no more than 5 words.',
  'Escape XML special characters when necessary.',
].join('\n')

function createImageTool(params: TaskParams, profile: ApiProfile, maskDataUrl?: string): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: 'auto',
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }

  tool.quality = params.quality

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  if (profile.streamImages) {
    tool.partial_images = profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl,
    }
  }

  return tool
}

export function createAgentTools(params: TaskParams, profile: ApiProfile, settings: AppSettings, maskDataUrl?: string): Array<Record<string, unknown>> {
  // 对话模型不支持 OpenAI 托管 image_generation 工具时（如 grok），不下发它——
  // 出图改由 generate_image_batch 函数调用 + Images API 完成（见 callBatchImageSingle）。
  const hostedImageTool = chatModelSupportsHostedImageTool(resolveAgentModel(profile, settings))
  const tools: Array<Record<string, unknown>> = hostedImageTool
    ? [createImageTool(params, profile, maskDataUrl)]
    : []

  // generate_image_batch: custom function tool for concurrent multi-image generation
  tools.push({
    type: 'function',
    name: 'generate_image_batch',
    description: [
      'Generate multiple images concurrently. Use this ONLY when:',
      '1. There are 2+ remaining images whose prerequisites (base references) are ALL already generated.',
      '2. These images are independent of each other (none references another image in this same batch).',
      'For single images or prerequisite/base images, use the built-in image_generation tool instead.',
      'Each image prompt must be self-contained and include full visual style descriptions.',
      'If an image needs to match a previously generated image, include the corresponding XML tag (e.g. <ref id="round-1-image-1" />) inside that image prompt so the app can attach the reference image automatically.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          description: 'Array of images to generate concurrently.',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Short stable identifier for this image, e.g. "slide_2_problem", "scene_3".',
              },
              prompt: {
                type: 'string',
                description: 'Complete image generation prompt with all visual details. If it refers to a previous image, include the matching XML tag, e.g. <ref id="round-1-image-1" />.',
              },
            },
            required: ['id', 'prompt'],
            additionalProperties: false,
          },
        },
      },
      required: ['images'],
      additionalProperties: false,
    },
    strict: true,
  })

  // continue_generation: model calls this to request another round (e.g. after generating a prerequisite image)
  tools.push({
    type: 'function',
    name: 'continue_generation',
    description: [
      'Request another round to continue generating images.',
      'Call this ONLY when you have just generated a prerequisite/base image and still need to generate dependent images that reference it.',
      'Do NOT call this when the task is already complete.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief explanation of why another round is needed and what will be generated next.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    strict: true,
  })

  if (hostedImageTool && settings.agentWebSearch) {
    tools.push({ type: 'web_search' })
  }
  return tools
}

// Agent 走 Responses API（经 env 配置的上游代理）。优先使用独立的 settings.agentModel；
// 旧数据/测试没有该字段时才兼容 Responses profile 的模型或默认对话模型。
export function resolveAgentModel(profile: ApiProfile, settings?: AppSettings): string {
  const configured = settings?.agentModel?.trim()
  if (configured) return configured
  return profile.apiMode === 'responses' && profile.model.trim() ? profile.model : DEFAULT_RESPONSES_MODEL
}
