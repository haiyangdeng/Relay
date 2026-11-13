import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayBackupAccountPanel, RuntimeGistDiscoveryResults } from './backup-account-panel'

describe('Saved backup account panel initial scope', () => {
  it('performs no account IO or callbacks on render and separates saving from transfer consent', () => {
    const onBusy = vi.fn(),
      onPrepared = vi.fn(),
      onInvalidate = vi.fn()
    const html = renderToStaticMarkup(
      createElement(RelayBackupAccountPanel, {
        busy: false,
        onBusy,
        onPrepared,
        onInvalidate
      })
    )
    expect(onBusy).not.toHaveBeenCalled()
    expect(onPrepared).not.toHaveBeenCalled()
    expect(onInvalidate).not.toHaveBeenCalled()
    expect(html).toContain('本机加密保存')
    expect(html).toContain('不会回填到输入框')
    expect(html).toContain('点击所选操作即执行')
    expect(html).toContain('不自动调度')
    expect(html).toContain('明确使用空密码')
    expect(html).not.toContain('准备运行配置上传')
    expect(html).not.toContain('********')
    expect(html).toContain('本页列表不代表可安全覆盖')
    expect(html).toContain('填入ID不会自动上传、创建或启用同步')
    expect(html).not.toContain('单独确认读取本页运行Gist候选')
  })
  it('renders only unverified page metadata and explicit ID buttons, without selecting or granting writes', () => {
    const onSelect = vi.fn(),
      onNextPage = vi.fn(),
      result = {
        status: 'listed' as const,
        page: 2,
        scanned: 3,
        moreAvailable: true,
        nextPage: 3,
        budgetReached: false,
        checkedAt: 1000,
        account: { id: 'fixture', revision: 'a'.repeat(64) },
        entries: [
          {
            id: 'a'.repeat(32),
            updatedAt: '2026-11-01T00:00:00Z',
            payloadBytes: 128,
            verified: false as const
          }
        ],
        token: 'PRIVATE-token',
        content: 'PRIVATE-body',
        url: 'PRIVATE-url'
      }
    const html = renderToStaticMarkup(
      createElement(RuntimeGistDiscoveryResults, { result, disabled: false, onSelect, onNextPage })
    )
    expect(html).toContain('第2页')
    expect(html).toContain('未验证候选')
    expect(html).toContain('不代表正文、所有权或写权限已验证')
    expect(html).toContain('填入运行配置目标ID')
    expect(html).toContain('填写下一页页码（点击查找时读取）')
    expect(html).not.toContain('PRIVATE')
    expect(html).not.toContain('checked=')
    expect(html).not.toContain('上传确认')
    expect(onSelect).not.toHaveBeenCalled()
    expect(onNextPage).not.toHaveBeenCalled()
    const empty = renderToStaticMarkup(
      createElement(RuntimeGistDiscoveryResults, {
        result: { ...result, entries: [], nextPage: undefined, budgetReached: true },
        disabled: true,
        onSelect,
        onNextPage
      })
    )
    expect(empty).toContain('不会自动新建或继续翻页')
    expect(empty).toContain('仍可能有后续；不能视为已列完')
    expect(empty).not.toContain('<button')
  })
})
