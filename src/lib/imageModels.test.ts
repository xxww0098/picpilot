import { describe, expect, it } from 'vitest'
import { IMAGE_MODELS, getImageModelLabel, isKnownImageModel } from './imageModels'

describe('imageModels', () => {
  it('exposes gpt-image-2 and Grok image models as选项', () => {
    const ids = IMAGE_MODELS.map((model) => model.id)
    expect(ids).toContain('gpt-image-2')
    expect(ids).toContain('grok-imagine-image')
    expect(ids).toContain('grok-imagine-image-quality')
  })

  it('isKnownImageModel 区分清单内外的模型', () => {
    expect(isKnownImageModel('grok-imagine-image')).toBe(true)
    expect(isKnownImageModel('grok-imagine-image-quality')).toBe(true)
    expect(isKnownImageModel('some-custom-model')).toBe(false)
  })

  it('getImageModelLabel 命中清单返回友好名，未命中回退原 id', () => {
    expect(getImageModelLabel('grok-imagine-image')).toBe('Grok Imagine')
    expect(getImageModelLabel('some-custom-model')).toBe('some-custom-model')
  })
})
