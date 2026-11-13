import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayWebdavBackupSchedulerPanel } from './webdav-backup-scheduler-panel'

describe('WebDAV session scheduler explicit authorization UI', () => {
  it('performs no initial IO and separates saved accounts, session authorization and credential validity', () => {
    const onBusy = vi.fn()
    const html = renderToStaticMarkup(
      createElement(RelayWebdavBackupSchedulerPanel, { busy: false, onBusy })
    )
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain('调度默认关闭')
    expect(html).toContain('保存账号不等于授权')
    expect(html).toContain('点击开启后应用当前设置')
    expect(html).toContain('不自动恢复授权')
    expect(html).toContain('不执行Gist自动同步')
    expect(html).toContain('不停止代理核心')
    expect(html).toContain('不会自动联网、解密凭据或开启调度')
    expect(html).toMatch(/<button disabled="">授权本次会话定时备份/)
    expect(html).toContain('value="60"')
    expect(html).toContain('保留清理默认关闭')
    expect(html).toContain('本机持久已确认上传记录（跨会话）')
    expect(html).toContain('持久回执不会自动开启调度或续期删除授权')
    expect(html).toMatch(/value="session-owned" selected=""/)
    expect(html).toMatch(/<select aria-label="保留清理回执范围" disabled=""/)
    expect(html).not.toContain('name="history"')
    expect(html).toContain('旧会话和目录中其他文件不纳入此清理')
    expect(html).toContain('不继承旧授权文件')
    expect(html).toMatch(/type="checkbox"\s*\/>/)
    expect(html).toContain('min="1" max="100" step="1" disabled="" value="10"')
  })
})
