import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { renderMaintenancePreview, writeMaintenancePreview } from './maintenance-preview'

describe('Static maintenance render without GUI or native imports', () => {
  it('uses the current panels, identifies fixture data and disables all actions', async () => {
    const html = await renderMaintenancePreview()
    expect(html).toContain('data-sample="true"')
    expect(html).toContain('演示数据，不代表本机状态')
    expect(html).toContain('系统扩展状态：未查询')
    expect(html).toContain('Code 与专用浏览器配置')
    expect(html).toContain('Claude 桌面专用登录')
    expect(html).toContain('Edge 策略与描述文件')
    expect(html).toContain('自有核心：隔离运行控制')
    expect(html).toContain('本地配置导入')
    expect(html).toContain('订阅快照导入')
    expect(html).toContain('订阅来源与版本')
    expect(html).toContain('规则与地理资源 · 私有快照')
    expect(html).toContain('节点提供者 · 私有资源快照')
    expect(html).toContain('节点／代理组与隔离配置检查')
    expect(html).toContain('手动本地HTTP代理')
    expect(html).toContain('只开启127.0.0.1上的HTTP端口，程序需手动接入')
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(8)
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true)
    expect(html).not.toMatch(/<script|<iframe|<form|<link\b|<img\b/iu)
    expect(html).toContain('default-src &#x27;none&#x27;'.replaceAll('&#x27;', "'"))
    expect(html).toContain("form-action 'none'")
  })
  it('exports a private HTML artifact and refuses overwrite, non-HTML and symlink destinations', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'relay-static-render-')))
    try {
      const target = join(directory, 'sample.html')
      await writeMaintenancePreview(target)
      expect((await stat(target)).mode & 0o777).toBe(0o600)
      const before = await readFile(target, 'utf8')
      await expect(writeMaintenancePreview(target)).rejects.toThrow()
      expect(await readFile(target, 'utf8')).toBe(before)
      await expect(writeMaintenancePreview(join(directory, 'settings.json'))).rejects.toThrow()
      const other = join(directory, 'keep.html'),
        link = join(directory, 'link.html')
      await writeFile(other, 'keep')
      await symlink(other, link)
      await expect(writeMaintenancePreview(link)).rejects.toThrow()
      expect(await readFile(other, 'utf8')).toBe('keep')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
