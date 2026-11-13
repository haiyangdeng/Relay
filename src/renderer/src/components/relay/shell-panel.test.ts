import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayShellPanel } from './shell-panel'

describe('Window settings require an observed record', () => {
  it('does not register shortcuts or apply defaults on render and disables saving before a read', () => {
    const onBusy = vi.fn(),
      html = renderToStaticMarkup(createElement(RelayShellPanel, { busy: false, onBusy }))
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain('尚未读取')
    expect(html).toMatch(/<button disabled="">保存并应用窗口设置/)
    expect(html).toContain('快捷键冲突时保留原绑定')
    expect(html).toContain('系统代理恢复／准备（需具体确认）')
    expect(html).toContain('本次TUN停用／准备（需具体确认）')
    expect(html).toContain('复制自有代理环境变量')
    expect(html).toContain('切换Direct模式')
    expect(html).toMatch(/<button disabled="">重启Relay…/)
    expect(html).toContain('后台运行（保留本次核心）')
    expect(html).toMatch(/<button disabled="">后台运行（保留本次核心）/)
    expect(html).toContain('关闭主窗口时收起到托盘')
    expect(html).toMatch(/<button disabled="">开启登录后启动…/)
    expect(html).toMatch(/<button disabled="">关闭登录后启动…/)
    expect(html).toContain('备份恢复不会自动添加登录项')
    expect(html).toContain('在Dock中显示Relay（隐藏前保留托盘入口）')
    expect(html).toContain('组名后显示当前代理（读取记录）')
    expect(html).toContain('官方在线主题')
    expect(html).toMatch(/<button disabled="">获取官方主题候选…/)
    expect(html).toContain('主题方案库')
    expect(html).toContain('最多16项、合计32KiB')
    expect(html).toContain('托盘复制格式（按保存顺序）')
    expect(html).toContain('复制快捷键默认格式')
    expect(html).toMatch(/<button disabled="">复制 原有格式/)
  })
})
