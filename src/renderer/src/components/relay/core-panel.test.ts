import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RelayCoreState } from '../../../../shared/relay/core'
import { RelayCorePanel } from './core-panel'

function render(state?: RelayCoreState, busy = false): string {
  return renderToStaticMarkup(
    createElement(RelayCorePanel, {
      state,
      busy,
      mode: 'rule',
      notice: '',
      onMode: () => {},
      onPrepare: () => {},
      onStart: () => {},
      onStop: () => {}
    })
  )
}
const state: RelayCoreState = {
  phase: 'running',
  mode: 'rule',
  pending: false,
  hasRecord: true,
  owned: true,
  uncertain: false,
  trafficEnabled: false,
  warnings: []
}
describe('Isolated core controls and truthful state presentation', () => {
  it('does not offer an unprepared start or claim normal traffic protection', () => {
    const html = render()
    expect(html).toContain('尚未读取持久配置')
    expect(html).toContain('无代理端口、无DNS/TUN的隔离实例')
    expect(html).toContain('手动本地HTTP代理与动态组')
    expect(html).toMatch(/<button>启动隔离实例/)
    expect(html).not.toContain('已保护')
  })
  it('keeps stop enabled during a pending operation but disables competing starts', () => {
    const html = render({ ...state, phase: 'stopping', pending: true }, true)
    expect(html).toContain('正在等待本次实例退出')
    expect(html).toMatch(/<button>停止本次实例／取消启动/)
    expect(html).toMatch(/<button disabled="">启动隔离实例/)
  })
  it('labels foreign records and uncertain exits without offering PID-based recovery', () => {
    const html = render({ ...state, phase: 'blocked', owned: false, uncertain: true })
    expect(html).toContain('磁盘记录没有本次所有权')
    expect(html).toContain('请保留窗口并重试停止本次实例')
    expect(html).toMatch(/<button disabled="">停止本次实例／取消启动/)
  })
})
