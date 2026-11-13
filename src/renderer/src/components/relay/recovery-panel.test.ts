import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { recoveryFixture, preflightFixture } from '../../../../main/relay/__fixtures__/recovery'
import { RelayRecoveryPanel } from './recovery-panel'

describe('Recovery metadata presentation', () => {
  it('offers only fixed source directory requests and disables missing sources', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayRecoveryPanel, {
        status: recoveryFixture(),
        notice: '',
        busy: false,
        ready: true,
        onRead: () => {},
        onInspect: () => {},
        onOpenDirectory: () => {}
      })
    )
    expect(markup.match(/在 Finder 打开备份目录/g)).toHaveLength(2)
    expect(markup).toContain('<button>在 Finder 打开备份目录</button>')
    expect(markup).toContain('<button disabled="">在 Finder 打开备份目录</button>')
  })
  it('shows separate sources and phases without enabling restore or claiming integrity', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayRecoveryPanel, {
        status: recoveryFixture(),
        notice: '',
        busy: false,
        ready: true,
        onRead: () => {},
        onInspect: () => {}
      })
    )
    expect(markup).toContain('Relay 自有记录')
    expect(markup).toContain('旧助手记录（独立保留）')
    expect(markup).toContain('事务记录要求恢复处理')
    expect(markup).toContain('逐条预检会核对备份摘要')
    expect(markup).toMatch(/<button disabled=""[^>]*>恢复配置<\/button>/)
  })
  it('does not turn an unreadable source into an empty healthy state', () => {
    const status = recoveryFixture()
    status.inventories[1].availability = 'unreadable'
    status.inventories[1].complete = false
    const markup = renderToStaticMarkup(
      createElement(RelayRecoveryPanel, {
        status,
        notice: '',
        busy: false,
        ready: true,
        onRead: () => {},
        onInspect: () => {}
      })
    )
    expect(markup).toContain('不能判断待恢复记录')
    expect(markup).toContain('读取结果不完整')
  })
  it('displays preflight evidence and legacy confirmation separately from restore', () => {
    const preflight = preflightFixture()
    preflight.fileChecksPassed = false
    preflight.version = 1
    preflight.phase = 'legacy'
    preflight.requiresLegacyConfirmation = true
    preflight.targets[0].original = 'unverifiedLegacy'
    preflight.issues = ['legacyConfirmationRequired']
    const markup = renderToStaticMarkup(
      createElement(RelayRecoveryPanel, {
        status: recoveryFixture(),
        preflight,
        notice: '',
        busy: false,
        ready: true,
        onRead: () => {},
        onInspect: () => {}
      })
    )
    expect(markup).toContain('只读预检')
    expect(markup).toContain('旧版原始内容无可信摘要')
    expect(markup).toContain('恢复前请核对备份内容')
    expect(markup).toContain('旧记录摘要或权限不完整')
    expect(markup).toMatch(/<button disabled=""[^>]*>恢复旧版备份（摘要或权限不完整）<\/button>/)
  })
  it('allows only a request for a verified record and keeps changed files blocked', () => {
    const preflight = preflightFixture()
    const render = (): string =>
      renderToStaticMarkup(
        createElement(RelayRecoveryPanel, {
          preflight,
          notice: '',
          busy: false,
          ready: true,
          onRead: () => {},
          onInspect: () => {},
          onRestore: () => {}
        })
      )
    expect(render()).toMatch(/<button title="[^"]*">恢复配置<\/button>/)
    preflight.targets[0].current = 'changed'
    preflight.issues = ['targetChanged']
    preflight.fileChecksPassed = false
    expect(render()).toMatch(/<button disabled=""[^>]*>恢复配置<\/button>/)
  })
})
