import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  readConnectionView,
  RelayConnectionSnapshotTable,
  RelayRuntimeInfoPanel
} from './runtime-info-panel'

vi.mock('@renderer/hooks/use-app-config', () => ({
  useAppConfig: () => ({ appConfig: {}, patchAppConfig: vi.fn() })
}))

describe('Runtime observation entry', () => {
  it('does not read during render and disables close actions until an observed runtime exists', () => {
    const onBusy = vi.fn(),
      html = renderToStaticMarkup(createElement(RelayRuntimeInfoPanel, { busy: false, onBusy }))
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain('正在读取连接')
    expect(html).toContain('暂停刷新')
    expect(html).toMatch(/aria-label="关闭本次实例全部连接" disabled=""/)
    expect(html).toContain('关闭连接会影响使用本次代理的应用')
    expect(html).not.toContain('0 B')
  })
  it('opens log browsing on the Logs route before a snapshot without initiating a read', () => {
    const onBusy = vi.fn(),
      html = renderToStaticMarkup(
        createElement(RelayRuntimeInfoPanel, { busy: false, onBusy, logsFirst: true })
      )
    expect(html).toContain('relay-runtime-logs')
    expect(html).toContain('筛选日志文本')
    expect(html).toContain('自动滚动')
    expect(html).toMatch(/<button type="button" disabled="">清空显示/)
    expect(html).toContain('正在读取日志')
    expect(onBusy).not.toHaveBeenCalled()
  })
  it('renders only selected connection columns with target and scoped row action kept visible', () => {
    const actions = vi.fn(() => createElement('button', null, 'Scoped close'))
    const html = renderToStaticMarkup(
      createElement(RelayConnectionSnapshotTable, {
        rows: [
          {
            id: 'one',
            position: 0,
            target: 'kept.example',
            process: 'private-process',
            route: 'fixed-route',
            upload: 42,
            download: 10,
            uploadRate: 1024
          }
        ],
        columns: ['route', 'upload', 'uploadRate', 'downloadRate'],
        actions
      })
    )
    expect(html).toContain('调整目标列宽')
    expect(html).toContain('调整代理链列宽')
    expect(html).toContain('>42 B</td>')
    expect(html).toContain('调整上传速度列宽')
    expect(html).toContain('>1.0 KiB/s</td>')
    expect(html).toContain('>待采样</td>')
    expect(html).toContain('Scoped close')
    expect(html).not.toContain('private-process')
    expect(html).not.toContain('下载量')
    expect(actions).toHaveBeenCalledOnce()
  })
  it('restores fixed local table widths and bounds values from an existing renderer preference', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => '{"target":1000,"upload":15,"route":"bad","other":300}' }
    })
    try {
      const html = renderToStaticMarkup(
        createElement(RelayConnectionSnapshotTable, {
          rows: [],
          columns: ['upload', 'route']
        })
      )
      expect(html).toContain(
        'aria-label="调整目标列宽" aria-valuemin="80" aria-valuemax="760" aria-valuenow="760"'
      )
      expect(html).toContain(
        'aria-label="调整上传量列宽" aria-valuemin="80" aria-valuemax="760" aria-valuenow="80"'
      )
      expect(html).toContain(
        'aria-label="调整代理链列宽" aria-valuemin="80" aria-valuemax="760" aria-valuenow="180"'
      )
      expect(html).not.toContain('width:300px')
      expect(html).toContain('aria-label="本次自有核心已结束连接"')
      expect(html).not.toContain('>操作<')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('restores connection view, sort and known columns, including an empty column selection', () => {
    const getItem = vi.fn(() =>
      JSON.stringify({
        tableView: true,
        columns: ['downloadRate', 'unknown', 'route', 'downloadRate'],
        connectionOrder: 'downloadRate',
        descending: false,
        watching: true,
        connectionQuery: 'ignored.example'
      })
    )
    expect(readConnectionView({ getItem })).toEqual({
      tableView: true,
      columns: ['route', 'downloadRate']
    })
    expect(getItem).toHaveBeenCalledWith('relay-owned-connections-view-v1')
    getItem.mockReturnValue('{"columns":[],"connectionOrder":"constructor","descending":"false"}')
    expect(readConnectionView({ getItem })).toEqual({
      tableView: false,
      columns: []
    })
  })
})
