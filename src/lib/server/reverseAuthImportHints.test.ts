import { describe, expect, it } from 'vitest'
import { getCpaBaseUrlHint, getCpaManagementKeyHint } from './reverseAuthImportHints'

describe('reverseAuthImportHints', () => {
  it('warns when cliproxy hostname is used instead of cliproxyapi', () => {
    expect(getCpaBaseUrlHint('http://cliproxy:8317')).toContain('cliproxyapi')
  })

  it('warns when localhost is used from inside docker', () => {
    expect(getCpaBaseUrlHint('http://127.0.0.1:8317')).toContain('cliproxyapi')
  })

  it('warns when sk- api key is used as management token', () => {
    expect(getCpaManagementKeyHint('sk-test', false)).toContain('secret-key')
  })
})