// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentPlatformPicker from './AgentPlatformPicker'

afterEach(() => {
  cleanup()
})

describe('AgentPlatformPicker', () => {
  it('shows only enabled platforms and selects Ozon', () => {
    const onSelectPlatform = vi.fn()

    render(<AgentPlatformPicker onSelectPlatform={onSelectPlatform} />)

    expect(screen.getByText('Ozon')).toBeTruthy()
    expect(screen.getByText('独立站')).toBeTruthy()
    expect(screen.queryByText('Amazon')).toBeNull()
    expect(screen.queryByText('Shopify')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Ozon/ }))

    expect(onSelectPlatform).toHaveBeenCalledWith('ozon')
  })
})
