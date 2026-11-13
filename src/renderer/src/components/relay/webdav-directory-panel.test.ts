import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayWebdavDirectoryPanel } from './webdav-directory-panel'

describe('explicit saved-account WebDAV directory UI', () => {
  it('renders without IO or secret/path inputs and separates one-shot creation from backup or scheduling', () => {
    const onBusy = vi.fn(),
      html = renderToStaticMarkup(createElement(RelayWebdavDirectoryPanel, { busy: false, onBusy }))
    expect(onBusy).not.toHaveBeenCalled()
    for (const text of [
      '父目录必须已存在',
      '仅创建末层目录',
      '不递归创建、不覆盖已有内容',
      '不会自动执行此操作',
      '点击创建后核对本机范围并执行',
      '不回填密码',
      '初始渲染不读取账号、不解密密码、不联网'
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('确认并执行本次目录创建')
    expect(html).toMatch(/<button disabled="">创建账号目录末层/)
  })
})
