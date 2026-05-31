import { z } from 'zod'

// 仅用于「不可信边界」的薄校验层：只验证结构/形状，不做深层语义。
// 字段的强制/兜底仍由 apiProfiles.ts 的 normalize* 负责。这里不替代它们。

// 通知 metadata（gallery_revoked）的形状。持久化的自由 JSON，全部字段可选，
// 未知字段保留（loose），仅用于安全地读取 reason / actor 等已知字段，替代不安全的 as 断言。
// 每个字段单独 .catch(undefined)：某个字段类型不符时只丢弃该字段，不让整条 metadata
// 解析失败，从而保留原先「逐字段 typeof 检查」的宽容度（如 reason 是数字但 actor 合法时仍显示 actor）。
export const galleryRevokedMetaSchema = z.looseObject({
  image_id: z.string().optional().catch(undefined),
  prompt_excerpt: z.string().optional().catch(undefined),
  reason: z.string().nullish().catch(undefined),
  actor_display_name: z.string().nullish().catch(undefined),
  actor_username: z.string().nullish().catch(undefined),
})

export type GalleryRevokedMetaParsed = z.infer<typeof galleryRevokedMetaSchema>

/**
 * 安全解析通知 metadata：成功返回结构化对象，失败（形状不符）返回 null，
 * 调用方据此降级（不显示 reason / actor），不再冒险做 `as` 断言。
 */
export function parseGalleryRevokedMeta(value: unknown): GalleryRevokedMetaParsed | null {
  const parsed = galleryRevokedMetaSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

// 配置导入信封：识别两种被接受的顶层形状——
//   (a) 包裹结构 { customProviders?: unknown[], profiles?: unknown[] }
//   (b) 单个服务商 Manifest 对象 { name?, submit?, ... }
// 二者都先归一为「非 null 的对象」，与导入逻辑既有的「JSON 根节点必须是对象」门闸一致。
// 这是一个纯结构性预检：通过/拒绝的输入集合必须与现有 normalize 行为完全一致，
// 真正的字段归一仍交给 normalizeCustomProviderDefinition(s) / normalizeApiProfile。
const importWrapperSchema = z.object({
  customProviders: z.array(z.unknown()).optional(),
  profiles: z.array(z.unknown()).optional(),
})

const importManifestSchema = z.object({
  name: z.string().optional(),
  submit: z.unknown().optional(),
})

// 接受 (a) 或 (b)；二者都是 z.object，即「非 null、非数组的对象」。
export const importEnvelopeSchema = z.union([importWrapperSchema, importManifestSchema])

export type ImportEnvelopeShape = 'object' | 'array' | 'invalid'

/**
 * 判定导入根节点的结构类别，复刻现有 `if (!parsed || typeof parsed !== 'object')` 门闸：
 * - 'object'：非 null、非数组的对象（信封识别的两种形状均落在此）
 * - 'array'：数组（旧代码同样放行到 normalize，再由其返回「无法识别」）
 * - 'invalid'：null / 原始类型（旧代码在此抛「JSON 根节点必须是对象」）
 * 调用方据此决定抛哪条既有中文错误，Zod 不改变成功/失败的输入集合。
 */
export function classifyImportEnvelope(value: unknown): ImportEnvelopeShape {
  if (Array.isArray(value)) return 'array'
  if (importEnvelopeSchema.safeParse(value).success) return 'object'
  return 'invalid'
}
