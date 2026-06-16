// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HeaderImageModelControl, type HeaderImageModelSelection } from './Header'

describe('HeaderImageModelControl', () => {
  it('shows GPT API, GPT reverse, and Grok generation choices', () => {
    const onSelect = vi.fn()

    render(<HeaderImageModelControl selection="grok" onSelect={onSelect} />)

    expect(screen.getByRole('radio', { name: 'GPT API' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('radio', { name: 'GPT 逆向' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('radio', { name: 'Grok' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'GPT 逆向' }))

    expect(onSelect).toHaveBeenCalledWith('gpt-reverse' satisfies HeaderImageModelSelection)
  })
})
