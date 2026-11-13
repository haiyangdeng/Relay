import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { defaultEditDocument } from '../../../../shared/relay/configuration-edit'
import { updateSmartOverride } from '../../../../shared/relay/smart-override'
import { RelaySmartOverrideDraft } from './smart-override-draft'

describe('Smart override draft controls', () => {
  it('initially leaves model and data collection off and requires a user supplied health URL', () => {
    const onChange = vi.fn(),
      html = renderToStaticMarkup(
        createElement(RelaySmartOverrideDraft, {
          draft: JSON.stringify(defaultEditDocument()),
          disabled: false,
          onChange
        })
      )
    expect(onChange).not.toHaveBeenCalled()
    expect(html).not.toContain(' checked=""')
    expect(html).toContain('value="100"')
    expect(html).toContain('全局草稿未启用标准Smart覆写')
    expect(html).toContain('新Smart组测速URL')
    expect(html).toMatch(/<button disabled="">从全局草稿移除标准Smart覆写/)
  })

  it('can display existing exact script content without modifying a saved draft', () => {
    const document = updateSmartOverride(defaultEditDocument(), {
        useLightGBM: true,
        collectData: false,
        collectorSizeMiB: 100,
        healthURL: 'http://127.0.0.1:19002/health'
      }),
      onChange = vi.fn(),
      html = renderToStaticMarkup(
        createElement(RelaySmartOverrideDraft, {
          draft: JSON.stringify(document),
          disabled: false,
          onChange
        })
      )
    expect(onChange).not.toHaveBeenCalled()
    expect(html).toContain('全局草稿已有标准Smart覆写')
    expect(html).toContain('当前Smart覆写内容')
    expect(html).toMatch(/readonly=""/iu)
    expect(html).toContain('group.uselightgbm = true')
    expect(html).toContain('group.collectdata = false')
  })

  it.each([
    { disabled: true, draft: '{}' },
    { disabled: false, draft: '{invalid' }
  ])('retains invalid/busy draft without generating a script: %j', ({ disabled, draft }) => {
    const onChange = vi.fn(),
      html = renderToStaticMarkup(
        createElement(RelaySmartOverrideDraft, { draft, disabled, onChange })
      )
    expect(onChange).not.toHaveBeenCalled()
    expect(html).toMatch(/<button disabled="">生成并写入标准Smart覆写草稿/)
  })
})
