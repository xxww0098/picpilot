import type { ResponsesOutputItem } from '../../types'

type AgentNoImageFallbackCheck = {
  prompt: string
  outputTaskCount: number
  outputImageCount: number
  responseOutput?: ResponsesOutputItem[] | null
}

const CHINESE_IMAGE_GENERATION_INTENT_RE = new RegExp([
  '(只生成|生成\\s*\\d*\\s*张|出图|生图|新图)',
  '(生成|出图|生图|画|绘制|创建|制作|做一张|做张|输出).{0,16}(图|图片|图像|照片|主图|海报|插画|渲染)',
  '(基于|参考|照着|把|将|让|给|用).{0,36}(图|图片|照片|上一张|前一张|这张).{0,36}(修改|改成|改为|换成|替换|去掉|增加|微调|修复|重绘|重做|编辑)',
  '(修改|编辑|修图|改图|重绘|重做|换背景|抠图).{0,24}(图|图片|照片|上一张|前一张|这张|新图)',
].join('|'), 'i')

const ENGLISH_IMAGE_GENERATION_INTENT_RE = /\b(generate|create|make|render|draw|produce)\b.{0,48}\b(image|photo|picture|render|product shot|poster|illustration)\b|\b(edit|modify|change|replace|remove|add|retouch|recreate|regenerate)\b.{0,72}\b(image|photo|picture|previous|last|reference)\b/i
const NO_IMAGE_GENERATION_INTENT_RE = /(不要|不用|无需|别).{0,8}(生成|出图|生图).{0,8}(图|图片|图像|照片|新图)|\bdo not (generate|create|make|render)\b.{0,24}\b(image|photo|picture)\b/i
const ASSISTANT_CLAIMS_IMAGE_DONE_RE = /(已生成|正在生成|生成了|generated|created|rendered).{0,24}(图|图片|图像|照片|image|photo|picture)/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseOutputText(output?: ResponsesOutputItem[] | null) {
  if (!Array.isArray(output)) return ''
  const chunks: string[] = []
  for (const item of output) {
    if (!isRecord(item)) continue
    const content = item.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (isRecord(part) && typeof part.text === 'string') chunks.push(part.text)
    }
  }
  return chunks.join('\n')
}

function hasExplicitImageGenerationIntent(prompt: string) {
  if (NO_IMAGE_GENERATION_INTENT_RE.test(prompt)) return false
  return CHINESE_IMAGE_GENERATION_INTENT_RE.test(prompt) || ENGLISH_IMAGE_GENERATION_INTENT_RE.test(prompt)
}

export function shouldRunAgentNoImageFallback(check: AgentNoImageFallbackCheck) {
  if (check.outputTaskCount > 0 || check.outputImageCount > 0) return false
  const prompt = check.prompt.trim()
  if (!prompt) return false
  if (hasExplicitImageGenerationIntent(prompt)) return true
  const assistantText = responseOutputText(check.responseOutput)
  return ASSISTANT_CLAIMS_IMAGE_DONE_RE.test(assistantText) && hasExplicitImageGenerationIntent(`${prompt}\n${assistantText}`)
}
