import { describe, expect, it } from 'vitest'
import { getTaskStreamPreviewItems, getTaskStreamPreviewSummary } from './streamPreviews'

describe('stream preview helpers', () => {
  it('returns stable preview items sorted by request slot', () => {
    expect(getTaskStreamPreviewItems({
      taskOutputCount: 4,
      streamPreviewSrc: 'data:image/png;base64,last',
      streamPreviewSlots: {
        2: 'data:image/png;base64,c',
        0: 'data:image/png;base64,a',
        1: '',
      },
    })).toEqual([
      { index: 0, src: 'data:image/png;base64,a' },
      { index: 1, src: '' },
      { index: 2, src: 'data:image/png;base64,c' },
      { index: 3, src: '' },
    ])
  })

  it('summarizes received previews without counting fallback-only slots', () => {
    expect(getTaskStreamPreviewSummary({
      taskOutputCount: 3,
      streamPreviewSrc: 'data:image/png;base64,last',
      streamPreviewSlots: {
        0: 'data:image/png;base64,a',
        2: 'data:image/png;base64,c',
      },
    })).toEqual({
      received: 2,
      total: 3,
      primarySrc: 'data:image/png;base64,c',
    })
  })
})
