import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayRemoteBackupPanel } from './backup-remote-panel'

describe('Remote backup UI scope', () => {
  it('does not access accounts on render and discloses Gist exposure, encryption, limits and separate restoration', () => {
    const onBusy = vi.fn()
    const html = renderToStaticMarkup(
      createElement(RelayRemoteBackupPanel, { busy: false, onBusy, onRestoreNotice: vi.fn() })
    )
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain('持有链接者读取')
    expect(html).toContain('必须提供AGE接收者加密')
    expect(html).toContain('512KiB')
    expect(html).toContain('凭据只在本次内存中保留')
    expect(html).toContain('不自动重试')
    expect(html).not.toContain('确认远程传输</button>')
    expect(html).not.toContain('单独确认恢复</button>')
  })
})
