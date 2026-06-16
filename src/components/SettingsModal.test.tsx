// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/shared/apiProfiles'
import { useStore } from '../store'
import SettingsModal from './SettingsModal'

describe('SettingsModal', () => {
  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      settingsTabRequest: null,
      showSettings: true,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
    })
  })

  afterEach(() => {
    cleanup()
    useStore.setState({ showSettings: false })
  })

  it('keeps upstream channel selection out of settings', () => {
    render(<SettingsModal />)

    expect(screen.getByText('当前连接配置')).toBeTruthy()
    expect(screen.queryByRole('group', { name: '上游通道' })).toBeNull()
  })
})
