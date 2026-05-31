import { describe, expect, it } from 'vitest'
import { classifyImportEnvelope, parseGalleryRevokedMeta } from './schemas'

describe('parseGalleryRevokedMeta', () => {
  it('parses a well-formed gallery_revoked metadata object', () => {
    expect(parseGalleryRevokedMeta({
      image_id: 'img-1',
      prompt_excerpt: 'a cat',
      reason: 'spam',
      actor_display_name: 'Alice',
      actor_username: 'alice',
    })).toMatchObject({
      reason: 'spam',
      actor_display_name: 'Alice',
      actor_username: 'alice',
    })
  })

  it('accepts null reason / actor fields', () => {
    expect(parseGalleryRevokedMeta({ reason: null, actor_display_name: null, actor_username: 'bob' }))
      .toMatchObject({ reason: null, actor_username: 'bob' })
  })

  it('falls back to null for non-object metadata', () => {
    expect(parseGalleryRevokedMeta(null)).toBeNull()
    expect(parseGalleryRevokedMeta('nope')).toBeNull()
    expect(parseGalleryRevokedMeta(42)).toBeNull()
    expect(parseGalleryRevokedMeta([1, 2, 3])).toBeNull()
  })

  it('drops only the malformed field instead of failing the whole metadata', () => {
    // reason 类型错误应被丢弃，但合法的 actor 字段仍保留（沿用旧逐字段宽容度）
    const meta = parseGalleryRevokedMeta({ reason: 123, actor_username: 'carol' })
    expect(meta).not.toBeNull()
    expect(meta?.reason).toBeUndefined()
    expect(meta?.actor_username).toBe('carol')
  })

  it('keeps unknown fields (loose) without rejecting', () => {
    expect(parseGalleryRevokedMeta({ unexpected: true, reason: 'x' }))
      .toMatchObject({ reason: 'x' })
  })
})

describe('classifyImportEnvelope', () => {
  it('classifies the wrapper and manifest object shapes as object', () => {
    expect(classifyImportEnvelope({ customProviders: [{}], profiles: [{}] })).toBe('object')
    expect(classifyImportEnvelope({ name: 'x', submit: {} })).toBe('object')
    expect(classifyImportEnvelope({})).toBe('object')
    expect(classifyImportEnvelope({ anything: 1 })).toBe('object')
  })

  it('classifies arrays as array (preserving legacy flow-through)', () => {
    expect(classifyImportEnvelope([])).toBe('array')
    expect(classifyImportEnvelope([1, 2])).toBe('array')
  })

  it('classifies null and primitives as invalid', () => {
    expect(classifyImportEnvelope(null)).toBe('invalid')
    expect(classifyImportEnvelope(undefined)).toBe('invalid')
    expect(classifyImportEnvelope('s')).toBe('invalid')
    expect(classifyImportEnvelope(123)).toBe('invalid')
  })
})
