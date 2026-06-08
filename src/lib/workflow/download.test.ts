import { describe, expect, it } from 'vitest'
import { inferExtFromDataUrl, workflowImageFilename } from './download'

describe('inferExtFromDataUrl', () => {
  it('maps known mimes', () => {
    expect(inferExtFromDataUrl('data:image/png;base64,AAAA')).toBe('png')
    expect(inferExtFromDataUrl('data:image/jpeg;base64,AAAA')).toBe('jpg')
    expect(inferExtFromDataUrl('data:image/webp;base64,AAAA')).toBe('webp')
  })
  it('falls back to subtype or png', () => {
    expect(inferExtFromDataUrl('data:image/avif;base64,AAAA')).toBe('avif')
    expect(inferExtFromDataUrl('not-a-data-url')).toBe('png')
  })
})

describe('workflowImageFilename', () => {
  it('keeps Chinese labels and is 1-indexed', () => {
    expect(workflowImageFilename('主图 Banner', 0, 'data:image/webp;base64,A')).toBe('picpilot-主图_Banner-1.webp')
  })
  it('sanitizes unsafe characters and empty labels', () => {
    expect(workflowImageFilename('a/b\\c:*', 2, 'data:image/png;base64,A')).toBe('picpilot-a_b_c-3.png')
    expect(workflowImageFilename('', 0, 'data:image/png;base64,A')).toBe('picpilot-image-1.png')
  })
})
