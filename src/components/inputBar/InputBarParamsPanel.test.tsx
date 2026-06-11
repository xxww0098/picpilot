// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../../types'
import InputBarParamsPanel, { type InputBarParamsPanelProps } from './InputBarParamsPanel'

afterEach(() => {
  cleanup()
})

function renderPanel(overrides: Partial<InputBarParamsPanelProps> = {}) {
  return render(
    <InputBarParamsPanel
      cols="grid-cols-6"
      params={DEFAULT_PARAMS}
      setParams={() => {}}
      settings={{ codexCli: false }}
      provider="openai"
      displaySize="auto"
      qualityOptions={[
        { label: '自动', value: 'auto' },
        { label: '低', value: 'low' },
      ]}
      compressionDisabled={false}
      agentAutoImageCount={false}
      outputImageLimit={4}
      nLimitHintText="数量提示"
      streamConcurrentByN={false}
      outputCompressionInput=""
      setOutputCompressionInput={() => {}}
      commitOutputCompression={() => {}}
      nInput="1"
      setNInputFocused={() => {}}
      handleNInputChange={() => {}}
      commitN={() => {}}
      handleNLimitIncreaseAttempt={() => {}}
      showAgentNHint={() => {}}
      hideNLimitHint={() => {}}
      startAgentNHintTouch={() => {}}
      clearAgentNHintTouchTimer={() => {}}
      setShowSizePicker={() => {}}
      qualityHint={{ visible: false, show: () => {}, hide: () => {}, startTouch: () => {}, clearTimer: () => {} }}
      compressionHint={{ visible: false, show: () => {}, hide: () => {}, startTouch: () => {}, clearTimer: () => {} }}
      nLimitHint={{ visible: false, show: () => {}, hide: () => {}, startTouch: () => {}, clearTimer: () => {} }}
      {...overrides}
    />,
  )
}

describe('InputBarParamsPanel', () => {
  it('shows JPEG above PNG in the output format menu', () => {
    const { getByText, container } = renderPanel()

    fireEvent.click(getByText('PNG'))

    const options = Array.from(container.querySelectorAll('[data-option-value]')).map((node) =>
      (node as HTMLElement).dataset.optionValue,
    )

    expect(options.slice(0, 3)).toEqual(['jpeg', 'png', 'webp'])
  })

  it('only shows output formats allowed by the team policy', () => {
    const { getByText, container } = renderPanel({
      params: { ...DEFAULT_PARAMS, output_format: 'jpeg' },
      allowedOutputFormats: ['jpeg'],
    })

    fireEvent.click(getByText('JPEG'))

    const options = Array.from(container.querySelectorAll('[data-option-value]')).map((node) =>
      (node as HTMLElement).dataset.optionValue,
    )

    expect(options).toEqual(['jpeg'])
  })
})
