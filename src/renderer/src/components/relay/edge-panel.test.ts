import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { edgeFixture } from '../../../../main/relay/__fixtures__/edge'
import { RelayEdgePanel } from './edge-panel'

describe('Edge workflow presentation', () => {
  it('keeps installation distinct from opening and shows all fixed entries', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayEdgePanel, {
        report: { ...edgeFixture(), evidenceId: 'fixture' },
        notice: '',
        busy: false,
        ready: true,
        onInspect: () => {},
        onOpen: () => {},
        onEntry: () => {}
      })
    )
    expect(markup).toContain('安装仍需在系统设置确认')
    expect(markup).toContain('打开设备管理')
    expect(markup).toContain('在 Edge 查看 policy')
    expect(markup).toContain('127.0.0.1:17890')
    expect(markup).not.toContain('已安装')
    expect(markup.match(/<button/g)).toHaveLength(4)
  })
  it('disables all controls while busy and refuses ready wording on override conflicts', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayEdgePanel, {
        report: {
          ...edgeFixture(),
          evidenceId: 'fixture',
          status: 'blocked',
          canOpenProfile: false,
          reviewKeys: ['WebRtcIPHandlingUrl']
        },
        notice: '',
        busy: true,
        ready: true,
        onInspect: () => {},
        onOpen: () => {},
        onEntry: () => {}
      })
    )
    expect(markup).toContain('暂停打开描述文件')
    expect(markup).toContain('WebRtcIPHandlingUrl')
    expect(markup.match(/<button disabled=""/g)).toHaveLength(4)
  })
})
