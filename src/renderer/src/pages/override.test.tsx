import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayOverrideLibraryManager } from './override'

vi.mock('@renderer/components/base/base-page', () => ({ default: () => null }))
vi.mock('@renderer/components/base/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))
vi.mock('@renderer/hooks/use-override-config', () => ({
  useOverrideConfig: vi.fn(() => {
    throw new Error('Legacy hook must not be mounted')
  })
}))
vi.mock('@renderer/components/override/override-item', () => ({ default: () => null }))
vi.mock('@renderer/hooks/use-relay-override-config', () =>
  vi.importActual('../hooks/use-relay-override-config')
)
vi.mock('@renderer/components/base/base-editor', () => ({ BaseEditor: () => null }))
vi.mock('@renderer/utils/ipc', () => ({
  getFilePath: vi.fn(),
  readTextFile: vi.fn(),
  openFile: vi.fn(),
  mihomoHotReloadConfig: vi.fn(),
  getOverride: vi.fn(),
  setOverride: vi.fn(),
  isAlwaysOnTop: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  getOverrideConfig: vi.fn(),
  setOverrideConfig: vi.fn(),
  addOverrideItem: vi.fn(),
  removeOverrideItem: vi.fn(),
  updateOverrideItem: vi.fn()
}))
vi.mock('@renderer/utils/init', () => ({ platform: 'darwin' }))

describe('Relay original override manager adapter', () => {
  it('renders the reused manager without reading a library, file path or invoking a core action', () => {
    const onBusy = vi.fn(),
      changed = vi.fn()
    const html = renderToStaticMarkup(
      createElement(RelayOverrideLibraryManager, {
        busy: false,
        onBusy,
        onBindingsChanged: changed
      })
    )
    expect(onBusy).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(html).toContain('覆写管理')
    expect(html).toContain('刷新')
    expect(html).toContain('添加来源')
    expect(html).toContain('筛选覆写')
    expect(html).toContain('<summary>远端来源选项：名称、类型与代理端口</summary>')
    expect(html).toContain('高级：配置关联与执行顺序')
    expect(html).toContain('被全局遮蔽的旧引用仍保留')
    expect(html).not.toContain('单独确认获取覆写缓存')
    expect(html).not.toContain('PRIVATE')
  })
})
